/**
 * Diagnosis types.
 *
 * A diagnosis is a claim about why a deployment failed, and Harbor acts on it
 * without asking. So the shape here is built around being wrong safely:
 *
 *   - `confidence` is reported, and a low-confidence diagnosis escalates rather
 *     than applying a fix.
 *   - `evidence` cites the log lines and repo lines the conclusion came from,
 *     so a human reviewing an incident can check the reasoning rather than
 *     taking it on trust.
 *   - `proposedFix` is a described change, not an applied one. Deciding and
 *     doing are separate steps because the fix budget is spent on the doing.
 *
 * The failure classes match SOW §4 and docs/TODO.md M4.
 */
import type { Evidence } from '../repo/types.js'

export type FailureClass =
  /** A: binds a literal port, platform routes to $PORT. Builds green, fails health. */
  | 'port_mismatch'
  /** B: imports a package the manifest does not declare. Fails at build or first import. */
  | 'missing_dependency'
  /** C: reads an env var nobody set. Usually a crash loop on boot. */
  | 'missing_env_var'
  /** D: the start command does not point at anything runnable. Instant exit. */
  | 'bad_start_command'
  /** Nothing matched. Escalate — do not guess. */
  | 'unknown'

/** Where in the lifecycle the failure showed up. */
export type FailurePhase = 'build' | 'runtime' | 'health'

export type FixKind = 'add_dependency' | 'bind_env_port' | 'set_env_var' | 'change_start_command'

/**
 * A change Harbor proposes to make.
 *
 * Deliberately declarative. The applier turns this into a diff, which means the
 * diff can be logged and reviewed before anything is committed, and a fix can
 * be recorded in an incident even when it was never applied.
 */
export interface ProposedFix {
  kind: FixKind
  /** One line, written for a human reading the activity stream. */
  summary: string
  /** Repo-relative path the change lands in, when there is one. */
  file?: string
  /** The package to add, for `add_dependency`. */
  packageName?: string
  /** The import that revealed it, which is not always the package name. */
  importName?: string
  /** For `set_env_var`. */
  envVarName?: string
  /** Existing text being replaced, for a targeted edit. */
  from?: string
  /** Replacement text. */
  to?: string
  /**
   * True when Harbor must not perform this itself — a secret it would have to
   * invent, or a paid resource. The loop escalates instead of applying.
   */
  requiresHuman?: boolean
}

export interface Diagnosis {
  failureClass: FailureClass
  /** 0–1. Below `MIN_ACTIONABLE_CONFIDENCE` the loop escalates. */
  confidence: number
  phase: FailurePhase
  /** What was observed, in the operator's terms. */
  symptom: string
  /** Why this class follows from that observation. */
  reasoning: string
  evidence: Evidence[]
  proposedFix?: ProposedFix
}

/**
 * Below this, Harbor escalates rather than applying a fix.
 *
 * A wrong fix is worse than no fix: it consumes an attempt from the budget,
 * commits a change to the repo, and moves the codebase away from the state the
 * next diagnosis assumes.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.6

export function isActionable(diagnosis: Diagnosis): boolean {
  return (
    diagnosis.failureClass !== 'unknown' &&
    diagnosis.confidence >= MIN_ACTIONABLE_CONFIDENCE &&
    diagnosis.proposedFix !== undefined &&
    diagnosis.proposedFix.requiresHuman !== true
  )
}
