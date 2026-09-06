/**
 * The run registry.
 *
 * Holds every run started in this process, so the UI has something to observe.
 * The direction of that relationship is the point: the registry starts runs and
 * publishes what happened, and readers only read. Nothing a viewer does can
 * steer an agent.
 *
 * Storage is in memory. Events already carry the monotonic `seq` a reconnecting
 * client resumes from, so moving this to Postgres later changes where the
 * history lives without changing how it is read.
 */
import type { RunStore } from './db/store.js'
import { nullRunStore } from './db/store.js'
import { EventBus } from './events.js'
import type { HarborEvent } from './events.js'
import type { RunResult } from './loop.js'

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'escalated'

export interface RunRecord {
  id: string
  repoUrl: string
  status: RunStatus
  startedAt: string
  endedAt?: string
  result?: RunResult
  error?: string
}

/** A run as the UI sees it: no host paths, no internals. */
export interface RunSummary {
  id: string
  repoUrl: string
  status: RunStatus
  startedAt: string
  endedAt?: string
  serviceUrl?: string
  issuesResolved: number
  /** Present when the run stopped for a human. */
  escalation?: string
  lastSeq: number
}

interface Entry {
  record: RunRecord
  bus: EventBus
  /**
   * Serialises this run's database writes.
   *
   * activity_events has a foreign key to deployments, so an event written
   * before the run row exists is rejected. Firing both without ordering lost
   * the first events of every run to a constraint violation that was logged and
   * swallowed — the history looked complete until someone counted it.
   */
  writes: Promise<void>
}

export class RunRegistry {
  readonly #runs = new Map<string, Entry>()
  readonly #limit: number
  readonly #store: RunStore

  constructor(options: { limit?: number; store?: RunStore } = {}) {
    this.#limit = options.limit ?? 50
    this.#store = options.store ?? nullRunStore
  }

  /**
   * Persistence must not be able to fail a deployment.
   *
   * A run that succeeded but could not be written down is still a run that
   * succeeded, so a store error is reported and dropped rather than thrown into
   * the loop that was mid-deploy.
   */
  #persist(entry: Entry, what: string, write: () => Promise<void>): void {
    entry.writes = entry.writes.then(write).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[harbor] could not persist ${what}: ${message}`)
    })
  }

  /** Wait for a run's queued writes. Tests and shutdown need this; the loop does not. */
  async flush(id: string): Promise<void> {
    await this.#runs.get(id)?.writes
  }

  /**
   * Register a run and hand back its bus.
   *
   * The caller drives the deployment; the registry only records it. Keeping the
   * loop out of here is what lets a run be driven by the CLI, a test, or the
   * server without three copies of the same wiring.
   */
  start(id: string, repoUrl: string): { record: RunRecord; bus: EventBus } {
    if (this.#runs.has(id)) throw new Error(`Run ${id} already exists`)

    const record: RunRecord = {
      id,
      repoUrl,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    const bus = new EventBus(id)
    const entry: Entry = { record, bus, writes: Promise.resolve() }
    this.#runs.set(id, entry)

    // Queued in this order and never overlapping, so the run row is committed
    // before the first event that references it.
    this.#persist(entry, `run ${id}`, () => this.#store.saveRun(record))
    bus.subscribe((event) => {
      this.#persist(entry, `event ${id}#${String(event.seq)}`, () =>
        this.#store.saveEvent(id, event),
      )
    })

    // Oldest first, and never evict something still running.
    while (this.#runs.size > this.#limit) {
      const stale = [...this.#runs.values()].find((entry) => entry.record.status !== 'running')
      if (!stale) break
      this.#runs.delete(stale.record.id)
    }

    return { record, bus }
  }

  finish(id: string, result: RunResult): void {
    const entry = this.#runs.get(id)
    if (!entry) return
    entry.record.status = result.status
    entry.record.result = result
    entry.record.endedAt = new Date().toISOString()
    this.#persist(entry, `run ${id}`, () => this.#store.updateRun(entry.record))
  }

  fail(id: string, error: string): void {
    const entry = this.#runs.get(id)
    if (!entry) return
    entry.record.status = 'failed'
    entry.record.error = error
    entry.record.endedAt = new Date().toISOString()
    this.#persist(entry, `run ${id}`, () => this.#store.updateRun(entry.record))
  }

  get(id: string): RunRecord | undefined {
    return this.#runs.get(id)?.record
  }

  bus(id: string): EventBus | undefined {
    return this.#runs.get(id)?.bus
  }

  /** Events after `afterSeq`. The reconnect path. */
  since(id: string, afterSeq = 0): HarborEvent[] {
    return this.#runs.get(id)?.bus.since(afterSeq) ?? []
  }

  summary(id: string): RunSummary | undefined {
    const entry = this.#runs.get(id)
    return entry === undefined ? undefined : toSummary(entry)
  }

  /** Newest first, for the history list. */
  list(): RunSummary[] {
    return [...this.#runs.values()]
      .map(toSummary)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /**
   * History across restarts.
   *
   * In-memory runs win on id: a live run's status is current, while the stored
   * row for it is whatever was last written and may say `running` for something
   * that finished a moment ago.
   */
  async listAll(limit = 50): Promise<RunSummary[]> {
    const live = this.list()
    const stored = await this.#store.listRuns(limit).catch(() => [])
    const seen = new Set(live.map((run) => run.id))

    return [...live, ...stored.filter((run) => !seen.has(run.id))]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
  }

  /** Events for a run this process no longer holds. */
  async replay(id: string): Promise<HarborEvent[]> {
    const bus = this.#runs.get(id)?.bus
    if (bus !== undefined) return [...bus.history]
    return this.#store.loadEvents(id).catch(() => [])
  }

  async summaryOrStored(id: string): Promise<RunSummary | undefined> {
    const live = this.summary(id)
    if (live !== undefined) return live
    const stored = await this.#store.listRuns(200).catch(() => [])
    return stored.find((run) => run.id === id)
  }

  get size(): number {
    return this.#runs.size
  }
}

function toSummary(entry: Entry): RunSummary {
  const { record, bus } = entry
  const escalation = record.result?.escalation?.reason ?? record.error

  return {
    id: record.id,
    repoUrl: record.repoUrl,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.result?.serviceUrl === undefined
      ? {}
      : { serviceUrl: record.result.serviceUrl }),
    issuesResolved: record.result?.issuesResolved ?? 0,
    ...(escalation === undefined ? {} : { escalation }),
    lastSeq: bus.lastSeq,
  }
}
