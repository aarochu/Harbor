/**
 * Run budget: turn cap, wall-clock cap, fix budget, and credit burn.
 *
 * These are one concern, not four. Harbor runs on a fixed $100 credit balance
 * and takes real actions against real infrastructure, so an unbounded loop is
 * simultaneously the largest safety risk and the largest spend risk. The loop
 * asks this object for permission before every turn.
 *
 * Cost figures use Bedrock on-demand rates. They are estimates for telemetry
 * and warnings, not billing truth — AWS is the authority on what was spent.
 */
import type { EventBus } from './events.js'

export interface BudgetLimits {
  /** Model turns per run. */
  maxTurns: number
  /** Wall-clock ceiling for the whole run. */
  maxWallClockMs: number
  /** Self-heal attempts before escalating to a human. */
  maxFixAttempts: number
  /** Soft ceiling per run; crossing it warns, it does not abort. */
  softCostCeilingUsd: number
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxTurns: 40,
  maxWallClockMs: 15 * 60 * 1000,
  maxFixAttempts: 3,
  softCostCeilingUsd: 2,
}

/** USD per million tokens, Bedrock on-demand. */
const RATES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

const FALLBACK_RATE = RATES['claude-sonnet-4-6']!

export interface BudgetSnapshot {
  turns: number
  elapsedMs: number
  fixAttempts: number
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
}

export type BudgetStopReason = 'turn_cap' | 'wall_clock' | 'fix_budget'

export class BudgetExceededError extends Error {
  readonly reason: BudgetStopReason
  readonly snapshot: BudgetSnapshot

  constructor(reason: BudgetStopReason, snapshot: BudgetSnapshot) {
    super(`Run budget exhausted: ${reason}`)
    this.name = 'BudgetExceededError'
    this.reason = reason
    this.snapshot = snapshot
  }
}

export class RunBudget {
  readonly limits: BudgetLimits
  readonly #startedAt: number
  readonly #now: () => number
  readonly #bus: EventBus | undefined

  #turns = 0
  #fixAttempts = 0
  #inputTokens = 0
  #outputTokens = 0
  #costUsd = 0
  #warned = false

  constructor(
    options: {
      limits?: Partial<BudgetLimits>
      bus?: EventBus
      /** Injectable clock, so wall-clock behaviour is testable. */
      now?: () => number
    } = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#now = options.now ?? Date.now
    this.#bus = options.bus
    this.#startedAt = this.#now()
  }

  get elapsedMs(): number {
    return this.#now() - this.#startedAt
  }

  /**
   * Claim a turn. Throws rather than returning false: a caller that ignores a
   * boolean keeps spending, and silent overrun is the failure being prevented.
   */
  startTurn(): void {
    if (this.#turns >= this.limits.maxTurns) {
      throw new BudgetExceededError('turn_cap', this.snapshot())
    }
    if (this.elapsedMs >= this.limits.maxWallClockMs) {
      throw new BudgetExceededError('wall_clock', this.snapshot())
    }
    this.#turns++
  }

  /** Claim a self-heal attempt. Exhaustion means escalate, not retry. */
  startFixAttempt(): void {
    if (this.#fixAttempts >= this.limits.maxFixAttempts) {
      throw new BudgetExceededError('fix_budget', this.snapshot())
    }
    this.#fixAttempts++
  }

  get fixAttemptsRemaining(): number {
    return Math.max(0, this.limits.maxFixAttempts - this.#fixAttempts)
  }

  /** Record token usage reported by the model provider. */
  recordUsage(usage: {
    inputTokens?: number
    outputTokens?: number
    modelId?: string
  }): void {
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    this.#inputTokens += input
    this.#outputTokens += output

    const rate = rateFor(usage.modelId)
    this.#costUsd += (input / 1_000_000) * rate.input
    this.#costUsd += (output / 1_000_000) * rate.output

    if (!this.#warned && this.#costUsd >= this.limits.softCostCeilingUsd) {
      this.#warned = true
      const spent = this.#costUsd.toFixed(2)
      const ceiling = this.limits.softCostCeilingUsd.toFixed(2)
      this.#bus?.emit(
        'budget_warning',
        `Run has spent an estimated $${spent}, over the $${ceiling} soft ceiling`,
        this.snapshot() as unknown as Record<string, unknown>,
      )
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      turns: this.#turns,
      elapsedMs: this.elapsedMs,
      fixAttempts: this.#fixAttempts,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      estimatedCostUsd: Number(this.#costUsd.toFixed(4)),
    }
  }
}

function rateFor(modelId: string | undefined): { input: number; output: number } {
  if (!modelId) return FALLBACK_RATE
  for (const [key, rate] of Object.entries(RATES)) {
    if (modelId.includes(key)) return rate
  }
  return FALLBACK_RATE
}
