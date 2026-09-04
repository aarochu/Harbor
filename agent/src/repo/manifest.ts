/**
 * Manifest inspection: package.json, Python requirements, Dockerfile.
 *
 * These are pure functions over an in-memory file map rather than filesystem
 * readers, which is what makes M4's failure classes testable. "Package `httpx`
 * is imported but absent from requirements.txt" is a claim about two parsed
 * manifests, and it needs to be provable from a fixture, not from a live deploy.
 *
 * Parsing is deliberately tolerant. A repo that Harbor cannot fully parse is
 * still a repo it may be able to deploy, so a malformed section produces a
 * warning and partial data rather than an exception.
 */
import { findAll, makeEvidence } from './evidence.js'
import type {
  DockerfileDetection,
  Evidence,
  NodeManifest,
  PackageManager,
  PythonManifest,
} from './types.js'
import type { RepoFiles } from './workspace.js'

/** Lockfile -> package manager. Checked in priority order. */
const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
]

/**
 * The lockfile is the ground truth, not the `packageManager` field.
 *
 * A repo can declare pnpm and ship a package-lock.json; running the declared
 * manager then resolves a different tree than the author ever tested. Harbor
 * follows whichever lockfile is actually committed.
 */
export function detectPackageManager(files: RepoFiles): PackageManager {
  for (const [lockfile, manager] of LOCKFILES) {
    if (files.has(lockfile)) return manager
  }

  const raw = files.get('package.json')
  if (raw !== undefined) {
    const parsed = parseJson(raw)
    const declared =
      typeof parsed?.packageManager === 'string' ? parsed.packageManager : undefined
    if (declared?.startsWith('pnpm')) return 'pnpm'
    if (declared?.startsWith('yarn')) return 'yarn'
    if (declared?.startsWith('bun')) return 'bun'
    return 'npm'
  }

  return 'unknown'
}

export function inspectPackageJson(files: RepoFiles): NodeManifest | undefined {
  const raw = files.get('package.json')
  if (raw === undefined) return undefined

  const parsed = parseJson(raw)
  if (!parsed) {
    // A package.json that will not parse is itself a deployable finding: the
    // build is going to fail on it. Report the file exists, with nothing in it.
    return {
      packageManager: detectPackageManager(files),
      scripts: {},
      dependencies: {},
      devDependencies: {},
    }
  }

  const engines = asRecord(parsed.engines)

  return {
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    packageManager: detectPackageManager(files),
    scripts: asStringRecord(parsed.scripts),
    dependencies: asStringRecord(parsed.dependencies),
    devDependencies: asStringRecord(parsed.devDependencies),
    ...(typeof engines?.node === 'string' ? { nodeVersion: engines.node } : {}),
  }
}

/** requirements.txt / pyproject.toml, whichever the repo actually uses. */
export function inspectPythonManifest(files: RepoFiles): PythonManifest | undefined {
  const pyproject = files.get('pyproject.toml')
  if (pyproject !== undefined) {
    const poetry = /^\s*\[tool\.poetry\]/m.test(pyproject)
    return {
      packageManager: poetry ? 'poetry' : 'pip',
      dependencies: parsePyprojectDependencies(pyproject),
      ...pythonVersionOf(pyproject),
      source: 'pyproject.toml',
    }
  }

  const requirements = files.get('requirements.txt')
  if (requirements !== undefined) {
    return {
      packageManager: 'pip',
      dependencies: parseRequirements(requirements),
      source: 'requirements.txt',
    }
  }

  return undefined
}

function pythonVersionOf(pyproject: string): { pythonVersion?: string } {
  const match = /^\s*(?:requires-)?python(?:_requires)?\s*=\s*["']([^"']+)["']/m.exec(pyproject)
  return match?.[1] ? { pythonVersion: match[1] } : {}
}

/**
 * Distribution names from requirements.txt.
 *
 * Version pins, extras, environment markers and comments are stripped: the
 * question this answers is "is package X declared", never "at what version".
 * `-r` includes and editable installs are skipped rather than followed — the
 * included file is loaded separately if it is in the repo.
 */
export function parseRequirements(content: string): string[] {
  const names = new Set<string>()

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (!line || line.startsWith('-')) continue

    // Strip environment markers, extras, and any version specifier.
    const withoutMarker = line.split(';')[0]?.trim() ?? ''
    const match = /^([A-Za-z0-9._-]+)/.exec(withoutMarker)
    if (match?.[1]) names.add(normalizeDistribution(match[1]))
  }

  return [...names].sort()
}

/** Both PEP 621 `[project] dependencies` and `[tool.poetry.dependencies]`. */
export function parsePyprojectDependencies(content: string): string[] {
  const names = new Set<string>()

  const pep621 = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(content)
  if (pep621?.[1]) {
    for (const entry of pep621[1].split(',')) {
      const quoted = /["']([^"']+)["']/.exec(entry)
      const name = quoted?.[1] ? /^([A-Za-z0-9._-]+)/.exec(quoted[1])?.[1] : undefined
      if (name) names.add(normalizeDistribution(name))
    }
  }

  const poetrySection = /^[ \t]*\[tool\.poetry\.dependencies\][ \t]*\r?\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/m.exec(
    content,
  )
  if (poetrySection?.[1]) {
    for (const rawLine of poetrySection[1].split(/\r?\n/)) {
      const line = rawLine.split('#')[0]?.trim() ?? ''
      const match = /^([A-Za-z0-9._-]+)\s*=/.exec(line)
      // `python` is the interpreter constraint, not an installable dependency.
      if (match?.[1] && match[1].toLowerCase() !== 'python') {
        names.add(normalizeDistribution(match[1]))
      }
    }
  }

  return [...names].sort()
}

/** PEP 503 normalization, so `Flask_SQLAlchemy` and `flask-sqlalchemy` compare equal. */
export function normalizeDistribution(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

const DOCKERFILE_NAMES = ['Dockerfile', 'dockerfile', 'docker/Dockerfile']

export function inspectDockerfile(files: RepoFiles): DockerfileDetection {
  const path = DOCKERFILE_NAMES.find((name) => files.has(name))
  const content = path === undefined ? undefined : files.get(path)

  if (path === undefined || content === undefined) {
    return { present: false, exposedPorts: [], evidence: [] }
  }

  const evidence: Evidence[] = []
  let baseImage: string | undefined
  let startCommand: string | undefined
  const exposedPorts: number[] = []

  // The last FROM wins: in a multi-stage build that is the image that runs.
  for (const { match, evidence: found } of findAll(path, content, /^\s*FROM\s+(\S+)/gim)) {
    baseImage = match[1]
    evidence.push(found)
  }

  for (const { match, evidence: found } of findAll(path, content, /^\s*EXPOSE\s+(.+)$/gim)) {
    for (const token of (match[1] ?? '').split(/\s+/)) {
      const port = Number.parseInt(token, 10)
      if (Number.isInteger(port) && port > 0 && port < 65_536) exposedPorts.push(port)
    }
    evidence.push(found)
  }

  // ENTRYPOINT is only the start command when there is no CMD to override it.
  const cmd = /^\s*CMD\s+(.+)$/im.exec(content) ?? /^\s*ENTRYPOINT\s+(.+)$/im.exec(content)
  if (cmd?.[1]) {
    startCommand = cmd[1].trim()
    evidence.push(makeEvidence(path, content, cmd.index))
  }

  return {
    present: true,
    path,
    ...(baseImage === undefined ? {} : { baseImage }),
    exposedPorts: [...new Set(exposedPorts)],
    ...(startCommand === undefined ? {} : { startCommand }),
    evidence,
  }
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return asRecord(parsed)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) return {}

  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}
