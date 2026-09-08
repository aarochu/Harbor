/**
 * Wiring for a run against real Render and GitHub.
 *
 * One definition, used by both the CLI and the server. The approval gate lives
 * here, and a second copy of it drifting is exactly the kind of mistake that
 * ends with a paid resource provisioned by whichever entry point forgot.
 */
import { createModelAdvisor } from './advisor.js'
import { RunBudget } from './budget.js'
import type { EventBus } from './events.js'
import type { LoopDeps } from './loop.js'
import { RepoSession } from './repo/tools.js'
import { GitWriter, fixBranchFor } from './repo/writer.js'
import { RenderClient } from './render/client.js'

export interface LiveOptions {
  bus: EventBus
  runId: string
  /**
   * Allow provisioning a managed database.
   *
   * Defaults to false. A database is a paid resource, so it is opt-in per run
   * and silence is a refusal.
   */
  allowDatabase?: boolean
  onApproval?: (request: { action: string; detail: string }, approved: boolean) => void
  /**
   * Consult a model on whether a diagnosis is worth acting on.
   *
   * Defaults to on when a provider is configured. Turning it off leaves the
   * rule-based advisor, which is what the run falls back to anyway whenever the
   * model is unreachable — so a run costs nothing and still works with no model
   * at all.
   */
  useModel?: boolean
}

export interface LiveRun {
  deps: LoopDeps
  session: RepoSession
  ownerId: string
  fixBranch: string
}

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingCredentialsError'
  }
}

export function createLiveRun(options: LiveOptions): LiveRun {
  const apiKey = process.env.RENDER_API_KEY
  const ownerId = process.env.RENDER_OWNER_ID
  if (!apiKey || !ownerId) {
    throw new MissingCredentialsError(
      'RENDER_API_KEY and RENDER_OWNER_ID must be set. See agent/.env.example.',
    )
  }

  const githubToken = process.env.GITHUB_TOKEN
  const session = new RepoSession(githubToken === undefined ? {} : { token: githubToken })
  const fixBranch = fixBranchFor(options.runId)

  const budget = new RunBudget({ bus: options.bus })

  // A provider is configured when either an Anthropic key or AWS credentials
  // are present. With neither, the model advisor would fail on every call and
  // fall back anyway, so it is simply not installed.
  const hasProvider =
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.AWS_PROFILE) ||
    Boolean(process.env.AWS_ACCESS_KEY_ID)
  const useModel = options.useModel ?? hasProvider

  const deps: LoopDeps = {
    target: new RenderClient({ apiKey }),
    repo: session,
    writer: new GitWriter({
      workdir: () => session.workdir,
      ...(githubToken === undefined ? {} : { token: githubToken }),
    }),
    bus: options.bus,
    budget,
    ...(useModel ? { advisor: createModelAdvisor({ bus: options.bus, budget }) } : {}),
    fixBranch,
    approve: (request) => {
      const approved = request.action === 'configure_database' && options.allowDatabase === true
      options.onApproval?.(request, approved)
      return Promise.resolve(approved)
    },
  }

  return { deps, session, ownerId, fixBranch }
}
