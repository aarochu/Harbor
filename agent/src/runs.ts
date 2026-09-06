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
}

export class RunRegistry {
  readonly #runs = new Map<string, Entry>()
  readonly #limit: number

  constructor(options: { limit?: number } = {}) {
    this.#limit = options.limit ?? 50
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
    this.#runs.set(id, { record, bus })

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
  }

  fail(id: string, error: string): void {
    const entry = this.#runs.get(id)
    if (!entry) return
    entry.record.status = 'failed'
    entry.record.error = error
    entry.record.endedAt = new Date().toISOString()
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
