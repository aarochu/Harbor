/**
 * Wiring for a run against real Render and GitHub.
 *
 * One definition, used by both the CLI and the server. The approval gate lives
 * here, and a second copy of it drifting is exactly the kind of mistake that
 * ends with a paid resource provisioned by whichever entry point forgot.
 */
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

  const deps: LoopDeps = {
    target: new RenderClient({ apiKey }),
    repo: session,
    writer: new GitWriter({
      workdir: () => session.workdir,
      ...(githubToken === undefined ? {} : { token: githubToken }),
    }),
    bus: options.bus,
    budget: new RunBudget({ bus: options.bus }),
    fixBranch,
    approve: (request) => {
      const approved = request.action === 'configure_database' && options.allowDatabase === true
      options.onApproval?.(request, approved)
      return Promise.resolve(approved)
    },
  }

  return { deps, session, ownerId, fixBranch }
}
