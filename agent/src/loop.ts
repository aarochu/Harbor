/**
 * The deploy loop.
 *
 * Code sequences the seven steps; the model judges. Everything with a known
 * right answer — clone, profile, provision, deploy, poll, probe — runs
 * deterministically, and the model is consulted only where there is real
 * judgement to exercise: whether a diagnosis is worth acting on, and when to
 * stop and ask a human.
 *
 * That split is a cost and reliability decision, not a safety one. The
 * allowlist, budget and redaction sit at the boundary and do not care who is
 * calling; but a run costs roughly a dollar against a fixed credit balance, and
 * a model re-deriving "call triggerDeploy next" fifteen times per run spends
 * that balance on a conclusion the code already knows.
 *
 * The seam is `Advisor`. The default implementation is rule-based, so the whole
 * loop is testable — and demonstrable — with no model call at all. A
 * Strands-backed advisor drops into the same interface.
 *
 * Every dependency is injected, so the loop runs end to end against stubs.
 */
import { BudgetExceededError, RunBudget } from './budget.js'
import { diagnose } from './diagnose/classify.js'
import type { Diagnosis, FailureClass } from './diagnose/types.js'
import { isActionable } from './diagnose/types.js'
import type { EventBus } from './events.js'
import { trackStep } from './events.js'
import { FixNotApplicableError, planFix } from './fix/apply.js'
import type { FixPlan } from './fix/apply.js'
import { checkHealth } from './health.js'
import type { HealthResult } from './health.js'
import { buildProfileFromFiles } from './repo/profile.js'
import type { RepoProfile } from './repo/types.js'
import type { RepoFiles } from './repo/workspace.js'
import { waitForDeploy } from './render/poll.js'
import type {
  CreatePostgresInput,
  CreateWebServiceInput,
  Deploy,
  PostgresConnectionInfo,
  PostgresInstance,
  Runtime,
  Service,
} from './render/types.js'

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The subset of RenderClient the loop uses. RenderClient satisfies it. */
export interface DeployTarget {
  findOrCreateWebService: (
    input: CreateWebServiceInput,
  ) => Promise<{ service: Service; created: boolean; deployId?: string }>
  setEnvVar: (serviceId: string, key: string, value: string) => Promise<void>
  triggerDeploy: (serviceId: string) => Promise<Deploy>
  getDeploy: (serviceId: string, deployId: string) => Promise<Deploy>
  getService?: (serviceId: string) => Promise<Service>
  /**
   * Point the service at a different branch.
   *
   * Optional because a target that cannot switch branches is still usable for
   * a clean deploy — but without it a fix committed to Harbor's branch is
   * never built, and the loop would judge its own repair a failure.
   */
  updateServiceBranch?: (serviceId: string, branch: string) => Promise<Service>
  createPostgres: (input: CreatePostgresInput) => Promise<PostgresInstance>
  getPostgresConnectionInfo: (postgresId: string) => Promise<PostgresConnectionInfo>
}

/** The repository, already cloned. */
export interface RepoSource {
  open: (repoUrl: string, branch?: string) => Promise<{ branch: string; commit: string }>
  files: RepoFiles
}

/**
 * Committing a fix.
 *
 * Separate from the loop so the GitHub half can arrive later without touching
 * sequencing, and so tests can run a full self-heal against an in-memory writer.
 */
export interface RepoWriter {
  commitFix: (input: {
    branch: string
    message: string
    edits: { path: string; after: string }[]
  }) => Promise<{ commit: string }>
}

export type AdvisorAction = 'apply' | 'escalate'

export interface AdvisorVerdict {
  action: AdvisorAction
  /** Shown in the activity stream and stored on the incident. */
  rationale: string
}

/** Where the model plugs in. */
export interface Advisor {
  reviewDiagnosis: (input: {
    diagnosis: Diagnosis
    attempt: number
    attemptsRemaining: number
    profile: RepoProfile
  }) => Promise<AdvisorVerdict>
}

/**
 * The no-model advisor.
 *
 * Defers entirely to `isActionable`, which already encodes the confidence floor
 * and the secret/human-required rules. A model advisor may override this
 * towards caution, but never away from it — `applyFix` re-checks independently
 * through `planFix`, which refuses anything flagged `requiresHuman`.
 */
export const ruleBasedAdvisor: Advisor = {
  reviewDiagnosis: ({ diagnosis }) =>
    Promise.resolve(
      isActionable(diagnosis)
        ? {
            action: 'apply',
            rationale: `${diagnosis.failureClass} at ${String(
              Math.round(diagnosis.confidence * 100),
            )}% confidence, with a fix Harbor can apply itself.`,
          }
        : {
            action: 'escalate',
            rationale:
              diagnosis.failureClass === 'unknown'
                ? 'No recognised failure class; a speculative fix would cost an attempt and change the repository for nothing.'
                : 'The proposed fix needs a human — a secret to invent, or no safe alternative to apply.',
          },
    ),
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface Incident {
  attempt: number
  failureClass: FailureClass
  symptom: string
  diagnosis: string
  fixApplied?: string
  outcome: 'resolved' | 'escalated' | 'open'
}

export interface RunResult {
  status: 'succeeded' | 'failed' | 'escalated'
  serviceUrl?: string
  serviceId?: string
  /** The line the UI shows: "Harbor automatically resolved N issues". */
  issuesResolved: number
  incidents: Incident[]
  profile?: RepoProfile
  budget: ReturnType<RunBudget['snapshot']>
  /** Present when status is not 'succeeded'. */
  escalation?: { reason: string; diagnosis?: Diagnosis }
}

export interface RunInput {
  repoUrl: string
  branch?: string
  /** Render workspace id. */
  ownerId: string
  serviceName?: string
  /**
   * Path the health probe requests.
   *
   * Must match a route the application actually serves. Probing the site root
   * looks reasonable and is wrong for any service that does not define one:
   * the root 404s, the probe reads that as unreachable, and Harbor diagnoses a
   * dead service that is in fact answering perfectly on its real route.
   */
  healthCheckPath?: string
}

export interface LoopDeps {
  target: DeployTarget
  repo: RepoSource
  writer: RepoWriter
  bus: EventBus
  budget?: RunBudget
  advisor?: Advisor
  /** Gate for paid resources. Absent means "never approve". */
  approve?: (request: { action: string; detail: string }) => Promise<boolean>
  checkHealthImpl?: typeof checkHealth
  sleepImpl?: (ms: number) => Promise<void>
  /** Cap on waiting for one deploy to reach a terminal state. */
  deployWaitMs?: number
  deployPollMs?: number
  /**
   * Branch Harbor commits fixes to. Give this a run-scoped name in production
   * so a retry never has to force-push over an earlier run's branch.
   */
  fixBranch?: string
}

const HARBOR_BRANCH = 'harbor/auto-fix'
const DEFAULT_HEALTH_PATH = '/health'

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runDeployment(input: RunInput, deps: LoopDeps): Promise<RunResult> {
  const bus = deps.bus
  const budget = deps.budget ?? new RunBudget()
  const advisor = deps.advisor ?? ruleBasedAdvisor
  const probe = deps.checkHealthImpl ?? checkHealth
  const fixBranch = deps.fixBranch ?? HARBOR_BRANCH
  const healthCheckPath = input.healthCheckPath ?? DEFAULT_HEALTH_PATH

  const incidents: Incident[] = []
  let issuesResolved = 0
  let profile: RepoProfile | undefined
  let service: Service | undefined
  let branch = input.branch ?? 'main'
  // Deliberately empty until the clone lands. A real RepoSource exposes
  // `files` as a getter that throws before a clone, so reading it here would
  // fail the run on its first line.
  let files: RepoFiles = new Map()

  bus.emit('run_started', `Deploying ${input.repoUrl}`, { repoUrl: input.repoUrl })

  const finish = (
    status: RunResult['status'],
    escalation?: RunResult['escalation'],
  ): RunResult => ({
    status,
    ...(service?.serviceDetails?.url === undefined
      ? {}
      : { serviceUrl: service.serviceDetails.url }),
    ...(service === undefined ? {} : { serviceId: service.id }),
    issuesResolved,
    incidents,
    ...(profile === undefined ? {} : { profile }),
    budget: budget.snapshot(),
    ...(escalation === undefined ? {} : { escalation }),
  })

  try {
    // --- 1. Understand the repository ------------------------------------
    profile = await trackStep(bus, 'Inspect repository', async () => {
      const clone = await deps.repo.open(input.repoUrl, input.branch)
      branch = clone.branch
      files = deps.repo.files
      return buildProfileFromFiles(files, {
        repoUrl: input.repoUrl,
        branch: clone.branch,
        workdir: '',
        commit: clone.commit,
      })
    })

    if (profile.detection.framework === 'unknown') {
      return escalate(
        bus,
        finish,
        'Harbor could not identify the framework, and deploying an unrecognised stack is a human decision.',
      )
    }

    const buildCommand = profile.suggestedBuildCommand
    const startCommand = profile.suggestedStartCommand
    if (buildCommand === undefined || startCommand === undefined) {
      return escalate(
        bus,
        finish,
        'No build or start command could be derived from the repository.',
      )
    }

    bus.emit('plan_created', 'Deployment plan ready', {
      framework: profile.detection.framework,
      buildCommand,
      startCommand,
      databaseRequired: profile.database.required,
    })

    // --- 2. Provision a database, if one is needed -----------------------
    const serviceName = input.serviceName ?? deriveServiceName(input.repoUrl)
    let databaseUrl: string | undefined

    if (profile.database.required) {
      // A managed database is a paid resource, so it never happens unattended.
      const approved =
        (await deps.approve?.({
          action: 'configure_database',
          detail: `Provision a Postgres instance for ${serviceName}`,
        })) ?? false

      if (!approved) {
        return escalate(
          bus,
          finish,
          'This application needs a database. Provisioning one is a paid action and needs approval.',
        )
      }

      databaseUrl = await trackStep(bus, 'Provision database', async () => {
        const instance = await deps.target.createPostgres({
          name: `${serviceName}-db`,
          ownerId: input.ownerId,
          plan: 'free',
        })
        const info = await deps.target.getPostgresConnectionInfo(instance.id)
        const url = info.internalConnectionString ?? info.externalConnectionString
        if (url === undefined) {
          throw new Error('Render returned no connection string for the new database')
        }
        return url
      })
    }

    // --- 3. Create the service -------------------------------------------
    const created = await trackStep(bus, 'Create service', async () =>
      deps.target.findOrCreateWebService({
        name: serviceName,
        ownerId: input.ownerId,
        repo: input.repoUrl,
        branch,
        runtime: runtimeFor(profile?.detection.runtime ?? 'unknown'),
        buildCommand,
        startCommand,
        healthCheckPath,
      }),
    )
    service = created.service
    const serviceId = service.id

    // --- 4. Configure it --------------------------------------------------
    if (databaseUrl !== undefined) {
      const variable = profile.database.connectionVar ?? 'DATABASE_URL'
      const value = databaseUrl
      await trackStep(bus, `Set ${variable}`, async () => {
        // The value never reaches a log line; setEnvVar registers it for redaction.
        await deps.target.setEnvVar(serviceId, variable, value)
      })
    }

    // --- 5-7. Deploy, observe, and heal ----------------------------------
    for (;;) {
      budget.startTurn()

      const outcome = await deployAndVerify(
        {
          serviceId,
          profile,
          probe,
          healthCheckPath,
          ...(deps.sleepImpl && { sleepImpl: deps.sleepImpl }),
        },
        deps,
      )

      if (outcome.kind === 'healthy') {
        if (service.serviceDetails === undefined) service.serviceDetails = {}
        service.serviceDetails.url = outcome.url
        bus.emit('run_succeeded', 'Service is live and healthy', {
          url: outcome.url,
          issuesResolved,
          coldStart: outcome.health.coldStart,
        })
        return finish('succeeded')
      }

      // A deploy still building when the clock ran out is an unknown, not a
      // defect. Sending the fix loop after it would burn budget on a healthy
      // build and commit a change nobody needed.
      if (outcome.kind === 'indeterminate') {
        return escalate(bus, finish, outcome.reason)
      }

      const attempt = incidents.length + 1
      const diagnosis = outcome.diagnosis
      bus.emit('incident_opened', diagnosis.symptom, {
        attempt,
        failureClass: diagnosis.failureClass,
        confidence: diagnosis.confidence,
        evidence: diagnosis.evidence,
      })

      const incident: Incident = {
        attempt,
        failureClass: diagnosis.failureClass,
        symptom: diagnosis.symptom,
        diagnosis: diagnosis.reasoning,
        outcome: 'open',
      }
      incidents.push(incident)

      const verdict = await advisor.reviewDiagnosis({
        diagnosis,
        attempt,
        attemptsRemaining: budget.fixAttemptsRemaining,
        profile,
      })

      if (verdict.action === 'escalate') {
        incident.outcome = 'escalated'
        return escalate(bus, finish, verdict.rationale, diagnosis)
      }

      // Throws BudgetExceededError when the fix budget is spent, which is the
      // point: a caller that ignored a boolean would keep spending.
      budget.startFixAttempt()

      // Always the Harbor branch, never `branch` — on the first fix that would
      // still be the repository's default branch, and Harbor must never commit
      // to it.
      const applied = await applyFix(diagnosis, fixBranch, files, deps)
      if (applied === undefined) {
        incident.outcome = 'escalated'
        return escalate(
          bus,
          finish,
          'The proposed fix could not be applied to this repository.',
          diagnosis,
        )
      }

      incident.fixApplied = applied.summary
      incident.outcome = 'resolved'
      issuesResolved++
      branch = fixBranch
      files = applied.files

      // The fix is on Harbor's branch; the service is still building whatever
      // it was created with. Without this the redeploy rebuilds the unfixed
      // code and the loop concludes its own repair did not work.
      if (applied.diff !== '' && deps.target.updateServiceBranch !== undefined) {
        const update = deps.target.updateServiceBranch.bind(deps.target)
        await trackStep(bus, `Point service at ${fixBranch}`, async () => {
          await update(serviceId, fixBranch)
        })
      }

      bus.emit('fix_applied', applied.summary, {
        attempt,
        diff: applied.diff,
        notes: applied.notes,
      })

      // Re-profile so the next diagnosis reasons about the patched repository
      // rather than the one that failed.
      profile = buildProfileFromFiles(files, {
        repoUrl: input.repoUrl,
        branch,
        workdir: '',
      })
    }
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      return escalate(
        bus,
        finish,
        `Run budget exhausted (${error.reason}). Harbor stops rather than spending further.`,
      )
    }

    const message = error instanceof Error ? error.message : String(error)
    bus.emit('run_failed', message)
    return finish('failed', { reason: message })
  }
}

// ---------------------------------------------------------------------------
// Deploy, poll, probe, diagnose
// ---------------------------------------------------------------------------

type VerifyOutcome =
  | { kind: 'healthy'; url: string; health: HealthResult }
  | { kind: 'broken'; diagnosis: Diagnosis }
  | { kind: 'indeterminate'; reason: string }

async function deployAndVerify(
  context: {
    serviceId: string
    profile: RepoProfile
    probe: typeof checkHealth
    healthCheckPath: string
    sleepImpl?: (ms: number) => Promise<void>
  },
  deps: LoopDeps,
): Promise<VerifyOutcome> {
  const bus = deps.bus

  const deploy = await trackStep(bus, 'Trigger deploy', async () =>
    deps.target.triggerDeploy(context.serviceId),
  )

  const waited = await waitForDeploy(deps.target, context.serviceId, deploy.id, {
    bus,
    ...(context.sleepImpl === undefined ? {} : { sleepImpl: context.sleepImpl }),
    ...(deps.deployWaitMs === undefined ? {} : { timeoutMs: deps.deployWaitMs }),
    ...(deps.deployPollMs === undefined ? {} : { intervalMs: deps.deployPollMs }),
  })

  if (waited.outcome === 'timed_out') {
    return {
      kind: 'indeterminate',
      reason:
        `The deploy was still ${waited.status} when the wait timed out. Harbor does not ` +
        'know whether it is broken, and will not guess.',
    }
  }

  if (waited.outcome === 'failed') {
    return {
      kind: 'broken',
      diagnosis: diagnose({
        phase: 'build',
        buildSucceeded: false,
        buildLogs: describeDeploy(waited.deploy),
        profile: context.profile,
      }),
    }
  }

  const url = await resolveServiceUrl(context.serviceId, deps)
  if (url === undefined) {
    return { kind: 'indeterminate', reason: 'The service has no public URL to probe yet.' }
  }

  // Probe the route the application serves, not the site root.
  const probeUrl = `${url.replace(/\/+$/, '')}${context.healthCheckPath}`

  const health = await trackStep(bus, `Health check ${context.healthCheckPath}`, async () =>
    context.probe(
      probeUrl,
      context.sleepImpl === undefined ? {} : { sleepImpl: context.sleepImpl },
    ),
  )

  if (health.status === 'healthy') return { kind: 'healthy', url, health }

  return {
    kind: 'broken',
    diagnosis: diagnose({
      phase: 'health',
      buildSucceeded: true,
      health: {
        status: health.status,
        ...(health.httpStatus === undefined ? {} : { httpStatus: health.httpStatus }),
      },
      runtimeLogs: health.detail,
      profile: context.profile,
    }),
  }
}

async function resolveServiceUrl(
  serviceId: string,
  deps: LoopDeps,
): Promise<string | undefined> {
  if (deps.target.getService === undefined) return undefined
  const service = await deps.target.getService(serviceId)
  return service.serviceDetails?.url
}

/** A deploy object is all Harbor has until build logs are wired (M3). */
function describeDeploy(deploy: Deploy): string {
  return [
    `Deploy ${deploy.id} finished with status ${deploy.status}`,
    deploy.commit?.message === undefined ? '' : `commit: ${deploy.commit.message}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

// ---------------------------------------------------------------------------
// Applying a fix
// ---------------------------------------------------------------------------

interface AppliedFix {
  summary: string
  diff: string
  notes: string[]
  files: RepoFiles
}

/**
 * Plan the fix, commit it, and return the patched file map.
 *
 * The diff comes back so it can be emitted on `fix_applied` before anything
 * else happens — that event is what the operator reads to check the change.
 */
async function applyFix(
  diagnosis: Diagnosis,
  branch: string,
  files: RepoFiles,
  deps: LoopDeps,
): Promise<AppliedFix | undefined> {
  const fix = diagnosis.proposedFix
  if (fix === undefined) return undefined

  let plan: FixPlan
  try {
    plan = planFix(fix, files)
  } catch (error) {
    if (error instanceof FixNotApplicableError) {
      deps.bus.emit('reasoning', `Fix rejected: ${error.message}`)
      return undefined
    }
    throw error
  }

  // A platform-side fix changes configuration rather than code. Render does not
  // redeploy on an env var change by itself; the loop's next turn redeploys,
  // which is what makes it take effect.
  if (plan.edits.length === 0) {
    const action = plan.platformAction
    if (action?.kind !== 'set_env_var' || action.envVarName === undefined) return undefined

    return { summary: plan.summary, diff: '', notes: plan.notes, files }
  }

  const patched = new Map(files)
  for (const edit of plan.edits) patched.set(edit.path, edit.after)

  await deps.writer.commitFix({
    branch,
    message: `harbor: ${plan.summary}`,
    edits: plan.edits.map((edit) => ({ path: edit.path, after: edit.after })),
  })

  return { summary: plan.summary, diff: plan.diff, notes: plan.notes, files: patched }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escalate(
  bus: EventBus,
  finish: (status: RunResult['status'], escalation?: RunResult['escalation']) => RunResult,
  reason: string,
  diagnosis?: Diagnosis,
): RunResult {
  bus.emit('escalated', reason, diagnosis === undefined ? undefined : { diagnosis })
  return finish('escalated', {
    reason,
    ...(diagnosis === undefined ? {} : { diagnosis }),
  })
}

function runtimeFor(runtime: RepoProfile['detection']['runtime']): Runtime {
  return runtime === 'python' ? 'python' : 'node'
}

/** Render service names are lowercase and dash-separated. */
export function deriveServiceName(repoUrl: string): string {
  const last = repoUrl.replace(/\.git$/, '').split('/').pop() ?? 'harbor-app'
  const cleaned = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned === '' ? 'harbor-app' : cleaned
}
