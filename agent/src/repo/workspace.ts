/**
 * The filesystem boundary for repository intelligence.
 *
 * Everything the agent learns about a repository comes through here, so this is
 * where the action-security guardrails for reading live:
 *
 *   1. Clone arguments are never assembled into a shell string. git is spawned
 *      with an argv array, and the URL is validated against a host allowlist
 *      first. `git clone --upload-pack=...` is a documented remote-execution
 *      vector, and the repo URL is attacker-influenced input in the threat model
 *      Harbor actually has: the operator pastes a link they did not write.
 *   2. Reads are scoped to the clone. A path is resolved and then checked to be
 *      inside the workdir, so a traversal — however it got into the model's
 *      arguments — reads nothing.
 *   3. Size is capped and truncation is reported. A 4 MB lockfile silently
 *      eating the context window is a failure mode too.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { registerSecret } from '../redact.js'

const run = promisify(execFile)

/** Hosts Harbor will clone from. Anything else is refused, not attempted. */
const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com'])

/** Per-file read cap. Large enough for a real source file, small enough to be safe. */
export const MAX_FILE_BYTES = 128 * 1024

/** Files never worth reading: build output, dependencies, VCS internals. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'coverage',
  '.turbo',
])

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mp3|wasm|so|dll|dylib|pyc)$/i

export class RepoAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepoAccessError'
  }
}

/**
 * Reject anything that is not a plain https GitHub URL.
 *
 * Deliberately strict: ssh remotes, git:// and file:// schemes, and any URL
 * whose path is not owner/repo are refused. Harbor's MVP only ever needs public
 * https GitHub clones, so every additional shape accepted here is attack surface
 * bought for nothing.
 */
export function normalizeRepoUrl(repoUrl: string): {
  url: string
  owner: string
  repo: string
} {
  let parsed: URL
  try {
    parsed = new URL(repoUrl)
  } catch {
    throw new RepoAccessError(`Not a valid URL: ${repoUrl}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new RepoAccessError(
      `Only https:// repository URLs are allowed, got ${parsed.protocol}//`,
    )
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new RepoAccessError(`Host not allowed: ${parsed.hostname}`)
  }
  if (parsed.username || parsed.password) {
    // Credentials belong in the git credential helper, not in a URL that gets
    // logged, persisted, and shown in the activity stream.
    throw new RepoAccessError('Repository URL must not embed credentials')
  }

  const segments = parsed.pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new RepoAccessError(
      `Expected a github.com/owner/repo URL, got ${parsed.pathname}`,
    )
  }

  const [owner, repo] = segments as [string, string]
  return { url: `https://github.com/${owner}/${repo}.git`, owner, repo }
}

export interface CloneResult {
  workdir: string
  commit: string
  branch: string
  url: string
}

export interface CloneOptions {
  branch?: string
  /** Parent directory for the isolated clone. Defaults to the OS temp dir. */
  parentDir?: string
  /** Token for private repositories. Passed via the environment, never the URL. */
  token?: string
  timeoutMs?: number
}

/**
 * Shallow-clone into a fresh isolated directory.
 *
 * `--depth 1` because Harbor never needs history, and a hackathon demo should
 * not wait on a large repo's full log.
 */
export async function cloneRepo(
  repoUrl: string,
  options: CloneOptions = {},
): Promise<CloneResult> {
  const { url } = normalizeRepoUrl(repoUrl)
  const parent = options.parentDir ?? tmpdir()
  const workdir = await mkdtemp(join(parent, 'harbor-'))

  const args = ['clone', '--depth', '1', '--single-branch']
  if (options.branch) {
    if (!/^[\w./-]+$/.test(options.branch) || options.branch.startsWith('-')) {
      throw new RepoAccessError(`Unsafe branch name: ${options.branch}`)
    }
    args.push('--branch', options.branch)
  }
  // `--` terminates option parsing, so a URL that survived validation still
  // cannot be reinterpreted as a flag.
  args.push('--', url, workdir)

  const env = { ...process.env }
  // Never sit at an interactive credential prompt inside an unattended run.
  env.GIT_TERMINAL_PROMPT = '0'

  if (options.token) {
    registerSecret(options.token)
    // Supply the credential out of band so it never appears in argv, in the
    // remote URL written to .git/config, or in any error message.
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = `url.https://x-access-token:${options.token}@github.com/.insteadOf`
    env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
  }

  try {
    await run('git', args, { env, timeout: options.timeoutMs ?? 120_000 })
  } catch (error) {
    await disposeWorkspace(workdir)
    const message = error instanceof Error ? error.message : String(error)
    throw new RepoAccessError(`Clone failed for ${url}: ${message}`)
  }

  const commit = await revParse(workdir, ['HEAD'])
  const branch = await revParse(workdir, ['--abbrev-ref', 'HEAD'])

  return { workdir, commit, branch: options.branch ?? branch, url }
}

async function revParse(workdir: string, spec: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', workdir, 'rev-parse', ...spec])
    return stdout.trim()
  } catch {
    return 'unknown'
  }
}

/** Resolve a repo-relative path, refusing anything that escapes the clone. */
export function resolveInside(workdir: string, path: string): string {
  if (isAbsolute(path) || path.includes('\0')) {
    throw new RepoAccessError(`Path must be repository-relative: ${path}`)
  }
  const root = resolve(workdir)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new RepoAccessError(`Path escapes the repository: ${path}`)
  }
  return target
}

export interface FileRead {
  path: string
  content: string
  bytes: number
  truncated: boolean
}

/** Read specific paths, scoped to the clone and capped in size. */
export async function readFiles(
  workdir: string,
  paths: readonly string[],
  maxBytes = MAX_FILE_BYTES,
): Promise<FileRead[]> {
  const reads = paths.map(async (path): Promise<FileRead | undefined> => {
    const target = resolveInside(workdir, path)
    let content: string
    try {
      content = await readFile(target, 'utf8')
    } catch {
      return undefined
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    return bytes > maxBytes
      ? {
          path: toPosix(path),
          content: content.slice(0, maxBytes),
          bytes,
          truncated: true,
        }
      : { path: toPosix(path), content, bytes, truncated: false }
  })

  const results = await Promise.all(reads)
  return results.filter((result): result is FileRead => result !== undefined)
}

/** Repo-relative POSIX path -> file contents. The input every detector reads. */
export type RepoFiles = ReadonlyMap<string, string>

export interface LoadOptions {
  maxFileBytes?: number
  maxFiles?: number
}

/**
 * Walk the clone and load every text file worth inspecting.
 *
 * Detection is cheaper and far easier to test against an in-memory map than
 * against the filesystem, so the walk happens once here and every detector
 * downstream is a pure function of the result.
 */
export async function loadRepoFiles(
  workdir: string,
  options: LoadOptions = {},
): Promise<Map<string, string>> {
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? 2000
  const files = new Map<string, string>()
  const root = resolve(workdir)

  const walk = async (dir: string): Promise<void> => {
    if (files.size >= maxFiles) return
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (files.size >= maxFiles) return
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (BINARY_EXTENSIONS.test(entry.name)) continue

      const info = await stat(full)
      if (info.size > maxFileBytes) continue

      const content = await readFile(full, 'utf8')
      // A NUL byte means this is binary regardless of its extension.
      if (content.includes('\0')) continue

      files.set(toPosix(relative(root, full)), content)
    }
  }

  await walk(root)
  return files
}

/** Delete a clone. Best-effort: a leftover temp dir must not fail a run. */
export async function disposeWorkspace(workdir: string): Promise<void> {
  try {
    await rm(workdir, { recursive: true, force: true })
  } catch {
    // Intentionally ignored: cleanup failure is not run failure.
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
