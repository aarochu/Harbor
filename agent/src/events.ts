/**
 * Structured event emitter.
 *
 * Every reasoning step and tool call becomes an event. The mission-control UI
 * renders these, the state store persists them, and a dropped SSE connection
 * resumes from them — so the event log, not the console, is the record of what
 * the agent did.
 *
 * Redaction happens here, once, at the boundary. Anything that reaches an event
 * has already been masked, so no downstream consumer can leak a credential.
 */
import { redactDeep } from './redact.js'

export type EventType =
  | 'run_started'
  | 'plan_created'
  | 'step_started'
  | 'step_succeeded'
  | 'step_failed'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'incident_opened'
  | 'fix_applied'
  | 'escalated'
  | 'run_succeeded'
  | 'run_failed'
  | 'budget_warning'

export interface HarborEvent {
  /** Monotonic within a run. The SSE resume cursor. */
  seq: number
  /** ISO-8601 UTC, e.g. 2026-09-04T19:00:00.000Z */
  at: string
  runId: string
  type: EventType
  /** Human-readable line for the activity stream. */
  message: string
  /** Structured payload; redacted like everything else. */
  detail?: Record<string, unknown>
  /** Milliseconds, on step/tool completion events. */
  durationMs?: number
}

export type EventListener = (event: HarborEvent) => void

/** Events are dropped from memory past this point; the store keeps the rest. */
const DEFAULT_HISTORY_LIMIT = 1000

export class EventBus {
  readonly runId: string
  #seq = 0
  #history: HarborEvent[] = []
  #listeners = new Set<EventListener>()
  readonly #limit: number

  constructor(runId: string, options: { historyLimit?: number } = {}) {
    this.runId = runId
    this.#limit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  }

  emit(
    type: EventType,
    message: string,
    detail?: Record<string, unknown>,
    durationMs?: number,
  ): HarborEvent {
    const event: HarborEvent = {
      seq: ++this.#seq,
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      message: redactDeep(message),
      ...(detail ? { detail: redactDeep(detail) } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    }

    this.#history.push(event)
    if (this.#history.length > this.#limit) this.#history.shift()

    // A broken listener must not abort the run that is emitting to it.
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Intentionally swallowed: listener failure is not run failure.
      }
    }

    return event
  }

  /** Subscribe to future events. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Events after `afterSeq`. Used to resume a dropped SSE stream. */
  since(afterSeq = 0): HarborEvent[] {
    return this.#history.filter((event) => event.seq > afterSeq)
  }

  get history(): readonly HarborEvent[] {
    return this.#history
  }

  get lastSeq(): number {
    return this.#seq
  }
}

/** Time an async step and emit started/succeeded/failed around it. */
export async function trackStep<T>(
  bus: EventBus,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  bus.emit('step_started', label)

  try {
    const result = await run()
    bus.emit('step_succeeded', label, undefined, Date.now() - startedAt)
    return result
  } catch (error) {
    bus.emit(
      'step_failed',
      label,
      { error: error instanceof Error ? error.message : String(error) },
      Date.now() - startedAt,
    )
    throw error
  }
}
