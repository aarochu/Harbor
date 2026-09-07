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
  /** Attempts for a transient push failure. Default 3. */
  maxPushAttempts?: number
  sleepImpl?: (ms: number) => Promise<void>
}

/**
 * Whether another attempt could plausibly succeed.
 *
 * Deliberately a allowlist of transient conditions rather than "retry unless
 * it looks fatal": a non-fast-forward means someone else moved the branch, and
 * hammering it neither resolves the conflict nor surfaces it any sooner.
 */
export function isRetryablePush(message: string): boolean {
  const text = message.toLowerCase()

  if (/non-fast-forward|fetch first|rejected|denied|not permitted|forbidden/.test(text)) {
    return false
  }
  return /rate limit|timed out|timeout|connection|network|could not resolve|reset by peer|502|503|504|temporarily unavailable|early eof|rpc failed/.test(
    text,
  )
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
      await this.#push(git, input.branch)
    }

    return { commit }
  }

  /**
   * Push, retrying only what retrying can fix.
   *
   * A rate limit or a dropped connection is worth another attempt; a rejected
   * non-fast-forward is a real conflict and repeating it just fails slower.
   * The push itself stays idempotent because it is never forced — a repeat
   * either lands or reports the branch already up to date.
   */
  async #push(git: (args: string[]) => Promise<string>, branch: string): Promise<void> {
    const attempts = this.#options.maxPushAttempts ?? 3
    const sleep = this.#options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    let last = ''

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // No --force, ever. A rejected push is a real conflict to surface.
        await git(['push', '--set-upstream', 'origin', branch])
        return
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)

        if (!isRetryablePush(last) || attempt === attempts) {
          throw new CommitError(`Push of ${branch} was rejected: ${last}`)
        }
        await sleep(500 * 2 ** (attempt - 1))
      }
    }

    throw new CommitError(`Push of ${branch} failed after ${String(attempts)} attempts: ${last}`)
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

/**
 * A branch name unique to one run, so a push never collides with an earlier one.
 *
 * Trailing and leading separators are trimmed after sanitising: an id made
 * entirely of punctuation collapsed to a single dash and produced
 * "harbor/fix--", which is a degenerate ref rather than a name.
 */
export function fixBranchFor(runId: string): string {
  const safe = runId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 40)
    .replace(/[-._]+$/, '')

  return `harbor/fix-${safe === '' ? 'run' : safe}`
}
