/**
 * Repository intelligence, exposed as tools.
 *
 * The agent never touches the filesystem directly; it calls these, and the
 * registry enforces the allowlist around them. Three properties are enforced
 * here rather than requested in the prompt:
 *
 *   - Arguments are schema-validated. A model that has read a hostile README
 *     can still only produce arguments that parse, and a path that parses is
 *     still resolved inside the clone by `workspace.ts`.
 *   - `workdir` is stripped from every result. An absolute host path is of no
 *     use to the model and does not belong in a transcript.
 *   - Reads require an open session, so a clone is always the first step and
 *     there is no ambient repository to accidentally inspect.
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tools/registry.js'
import { buildProfileFromFiles } from './profile.js'
import type { RepoProfile } from './types.js'
import type { CloneResult } from './workspace.js'
import { cloneRepo, disposeWorkspace, loadRepoFiles, readFiles } from './workspace.js'

/** Everything the model may see about a profile: the profile minus the host path. */
export type ModelRepoProfile = Omit<RepoProfile, 'workdir'>

export function toModelProfile(profile: RepoProfile): ModelRepoProfile {
  const { workdir: _workdir, ...rest } = profile
  return rest
}

/**
 * One run's working copy.
 *
 * Held as session state rather than passed through every tool call so that the
 * clone happens exactly once. Re-cloning per tool would be slow, would multiply
 * temp directories, and would let two tools disagree about what the repo says.
 */
export class RepoSession {
  #clone: CloneResult | undefined
  #files: Map<string, string> | undefined
  readonly #token: string | undefined

  constructor(options: { token?: string } = {}) {
    this.#token = options.token
  }

  get workdir(): string | undefined {
    return this.#clone?.workdir
  }

  get files(): ReadonlyMap<string, string> {
    if (!this.#files) throw new Error('No repository has been cloned yet')
    return this.#files
  }

  async open(repoUrl: string, branch?: string): Promise<CloneResult> {
    // A second open in the same run replaces the first; leaving the old clone
    // behind would leak a temp directory per retry.
    if (this.#clone) await this.dispose()

    this.#clone = await cloneRepo(repoUrl, {
      ...(branch === undefined ? {} : { branch }),
      ...(this.#token === undefined ? {} : { token: this.#token }),
    })
    this.#files = await loadRepoFiles(this.#clone.workdir)
    return this.#clone
  }

  profile(): RepoProfile {
    const clone = this.#clone
    const files = this.#files
    if (!clone || !files) throw new Error('No repository has been cloned yet')

    return buildProfileFromFiles(files, {
      repoUrl: clone.url,
      branch: clone.branch,
      workdir: clone.workdir,
      commit: clone.commit,
    })
  }

  async dispose(): Promise<void> {
    if (this.#clone) await disposeWorkspace(this.#clone.workdir)
    this.#clone = undefined
    this.#files = undefined
  }
}

const cloneInput = z.object({
  repo_url: z.string().min(1),
  branch: z.string().min(1).optional(),
})

const readInput = z.object({
  paths: z.array(z.string().min(1)).min(1).max(25),
})

/**
 * Tool definitions for M1.
 *
 * None are marked `mutating`: this milestone only reads. The mutating repo
 * tools arrive with M4, and keeping the read set free of them means a run that
 * only profiles cannot change anything, whatever it is asked to do.
 */
export function createRepoTools(session: RepoSession): ToolDefinition[] {
  return [
    {
      name: 'github_clone_repo',
      run: async (input: unknown) => {
        const { repo_url: repoUrl, branch } = cloneInput.parse(input)
        const clone = await session.open(repoUrl, branch)
        return {
          url: clone.url,
          branch: clone.branch,
          commit: clone.commit,
          fileCount: session.files.size,
        }
      },
    },
    {
      name: 'github_read_files',
      run: async (input: unknown) => {
        const { paths } = readInput.parse(input)
        const workdir = session.workdir
        if (workdir === undefined) throw new Error('Clone a repository before reading from it')

        const reads = await readFiles(workdir, paths)
        const missing = paths.filter((path) => !reads.some((read) => read.path === path))
        return { files: reads, missing }
      },
    },
    {
      name: 'detect_framework',
      run: () => toModelProfile(session.profile()),
    },
    {
      name: 'inspect_environment',
      run: () => {
        const profile = session.profile()
        return {
          environment: profile.environment,
          database: profile.database,
          port: profile.port,
        }
      },
    },
  ]
}

/** The M1 allowlist. Read-only by construction. */
export const REPO_TOOL_NAMES = [
  'github_clone_repo',
  'github_read_files',
  'detect_framework',
  'inspect_environment',
] as const
