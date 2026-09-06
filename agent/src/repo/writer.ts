/**
 * Committing a fix to GitHub.
 *
 * Works inside the clone Harbor already has, rather than through the Contents
 * API, so a multi-file fix is one commit and the diff Harbor logged is exactly
 * the diff that lands.
 *
 * Three rules are enforced here rather than trusted to the caller:
 *
 *   1. **Never the default branch.** The target branch is checked against the
 *      repository's own default and refused if they match.
 *   2. **Never force-push.** A plain push is used, so a diverged remote branch
 *      fails loudly instead of silently discarding someone's commit. Callers
 *      avoid the collision by using a run-scoped branch name.
 *   3. **The token never reaches argv or .git/config.** It goes in through
 *      GIT_CONFIG_* the same way `cloneRepo` does, and is registered for
 *      redaction before the first command runs.
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { registerSecret } from '../redact.js'
import { resolveInside } from './workspace.js'

const run = promisify(execFile)

export class CommitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommitError'
  }
}

export interface GitWriterOptions {
  /** The clone to commit in. Resolved lazily: the clone happens mid-run. */
  workdir: () => string | undefined
  /** Personal access token with contents:write. Passed via the environment. */
  token?: string
  authorName?: string
  authorEmail?: string
  /** Push to the remote. False leaves the commit local, for a dry run. */
  push?: boolean
}

export interface CommitResult {
  commit: string
}

export class GitWriter {
  readonly #options: GitWriterOptions

  constructor(options: GitWriterOptions) {
    if (options.token !== undefined) registerSecret(options.token)
    this.#options = options
  }

  async commitFix(input: {
    branch: string
    message: string
    edits: { path: string; after: string }[]
  }): Promise<CommitResult> {
    const workdir = this.#options.workdir()
    if (workdir === undefined) {
      throw new CommitError('No clone is open; a repository must be cloned before committing')
    }
    if (input.edits.length === 0) {
      throw new CommitError('Refusing to create an empty commit')
    }

    const git = async (args: string[]): Promise<string> => {
      const { stdout } = await run('git', ['-C', workdir, ...args], { env: this.#env() })
      return stdout.trim()
    }

    await this.#guardDefaultBranch(git, input.branch)

    // -B so a re-run of the same branch name resets it locally rather than
    // failing; the remote is still protected by the no-force rule below.
    await git(['checkout', '-B', input.branch])

    for (const edit of input.edits) {
      const target = resolveInside(workdir, edit.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, edit.after, 'utf8')
    }

    await git(['add', '--', ...input.edits.map((edit) => edit.path)])

    const staged = await git(['diff', '--cached', '--name-only'])
    if (staged === '') {
      throw new CommitError('The fix produced no change against the current tree')
    }

    await git([
      '-c',
      `user.name=${this.#options.authorName ?? 'Harbor'}`,
      '-c',
      `user.email=${this.#options.authorEmail ?? 'harbor@users.noreply.github.com'}`,
      'commit',
      '-m',
      input.message,
    ])

    const commit = await git(['rev-parse', 'HEAD'])

    if (this.#options.push !== false) {
      try {
        // No --force, ever. A rejected push is a real conflict to surface.
        await git(['push', '--set-upstream', 'origin', input.branch])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CommitError(`Push of ${input.branch} was rejected: ${message}`)
      }
    }

    return { commit }
  }

  /**
   * Refuse to commit to the branch the repository treats as canonical.
   *
   * Checked against the remote's own HEAD rather than a hardcoded list, because
   * plenty of repositories still use `master` or something else entirely.
   */
  async #guardDefaultBranch(
    git: (args: string[]) => Promise<string>,
    branch: string,
  ): Promise<void> {
    // e.g. "refs/remotes/origin/main". A shallow clone often has no
    // origin/HEAD, so fall back to whatever is checked out.
    const head =
      (await tryGit(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])) ??
      (await tryGit(git, ['rev-parse', '--abbrev-ref', 'HEAD'])) ??
      ''

    const defaultBranch = head.replace(/^refs\/remotes\/origin\//, '').trim()
    if (defaultBranch !== '' && defaultBranch === branch) {
      throw new CommitError(
        `Refusing to commit to "${branch}", which is this repository's default branch`,
      )
    }
  }

  #env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    const token = this.#options.token

    if (token !== undefined) {
      // Out of band, so it never appears in argv, in .git/config, or in an
      // error message from a failed push.
      env.GIT_CONFIG_COUNT = '1'
      env.GIT_CONFIG_KEY_0 = `url.https://x-access-token:${token}@github.com/.insteadOf`
      env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    }
    return env
  }
}

async function tryGit(
  git: (args: string[]) => Promise<string>,
  args: string[],
): Promise<string | undefined> {
  try {
    return await git(args)
  } catch {
    return undefined
  }
}

/** A branch name unique to one run, so a push never collides with an earlier one. */
export function fixBranchFor(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)
  return `harbor/fix-${safe === '' ? 'run' : safe}`
}
