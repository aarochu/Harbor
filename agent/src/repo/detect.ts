/**
 * Detectors: framework, port, environment, database.
 *
 * Every function here is pure over an in-memory file map. That is the point —
 * these are the judgements Harbor bets a deployment on, so they have to be
 * testable against fixtures without a network, a clone, or a model call.
 *
 * Repository content is data. Nothing read here is ever treated as an
 * instruction; it is only ever matched against patterns and turned into
 * structured findings.
 */
import { findAll } from './evidence.js'
import { normalizeDistribution } from './manifest.js'
import type {
  DatabaseDetection,
  DatabaseKind,
  EnvVarRequirement,
  Evidence,
  FrameworkDetection,
  NodeManifest,
  PortDetection,
  PythonManifest,
} from './types.js'
import type { RepoFiles } from './workspace.js'

export const SOURCE_EXTENSIONS = /\.(m?[jt]sx?|cjs|py)$/i

/** Files whose text is worth pattern-matching, including deploy descriptors. */
function sourceFiles(files: RepoFiles): [string, string][] {
  return [...files].filter(
    ([path]) =>
      SOURCE_EXTENSIONS.test(path) ||
      /(^|\/)(Dockerfile|Procfile|docker-compose\.ya?ml)$/i.test(path),
  )
}

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

/**
 * Which of the three supported frameworks this repo is.
 *
 * A declared dependency beats a source import: `next` in package.json is a
 * statement about how the app is built, whereas an import could be in a script
 * or an example. Confidence is reported so the agent can escalate on a guess
 * rather than deploying one.
 */
export function detectFramework(
  files: RepoFiles,
  node?: NodeManifest,
  python?: PythonManifest,
): FrameworkDetection {
  const evidence: Evidence[] = []
  const deps = { ...node?.dependencies, ...node?.devDependencies }
  const pythonDeps = new Set(python?.dependencies ?? [])

  const configFile = [...files.keys()].find((path) =>
    /^next\.config\.(m?[jt]s|cjs)$/.test(path),
  )

  if (deps.next !== undefined || configFile !== undefined) {
    if (deps.next !== undefined) {
      evidence.push({ file: 'package.json', excerpt: `"next": "${deps.next}"` })
    }
    if (configFile !== undefined) {
      evidence.push({ file: configFile, excerpt: 'Next.js config present' })
    }
    return { framework: 'nextjs', runtime: 'node', confidence: 0.95, evidence }
  }

  if (deps.express !== undefined) {
    evidence.push({ file: 'package.json', excerpt: `"express": "${deps.express}"` })
    return { framework: 'express', runtime: 'node', confidence: 0.95, evidence }
  }

  if (pythonDeps.has('fastapi')) {
    evidence.push({
      file: python?.source ?? 'requirements.txt',
      excerpt: 'fastapi declared',
    })
    return { framework: 'fastapi', runtime: 'python', confidence: 0.95, evidence }
  }

  // No declared dependency. Fall back to imports, at lower confidence.
  for (const [path, content] of sourceFiles(files)) {
    const fastapi = findAll(
      path,
      content,
      /\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b|\bFastAPI\s*\(/g,
    )
    if (fastapi[0]) {
      evidence.push(fastapi[0].evidence)
      return { framework: 'fastapi', runtime: 'python', confidence: 0.6, evidence }
    }

    const express = findAll(
      path,
      content,
      /require\(['"]express['"]\)|from\s+['"]express['"]/g,
    )
    if (express[0]) {
      evidence.push(express[0].evidence)
      return { framework: 'express', runtime: 'node', confidence: 0.6, evidence }
    }
  }

  const runtime = node ? 'node' : python ? 'python' : 'unknown'
  return { framework: 'unknown', runtime, confidence: 0, evidence }
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** Anything that reads the platform's assigned port. */
const ENV_PORT_PATTERNS = [
  /process\.env\.PORT\b/g,
  /process\.env\[['"]PORT['"]\]/g,
  /os\.environ\.get\(\s*['"]PORT['"]/g,
  /os\.getenv\(\s*['"]PORT['"]/g,
  /os\.environ\[\s*['"]PORT['"]\s*\]/g,
  /\$\{?PORT\}?/g,
]

/** A fallback beside an env read: `process.env.PORT || 3000`, `getenv("PORT", 8000)`. */
const ENV_PORT_FALLBACK = [
  /process\.env\.PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/g,
  /os\.(?:environ\.get|getenv)\(\s*['"]PORT['"]\s*,\s*['"]?(\d{2,5})/g,
]

/** A port written into the bind call itself. This is the class A defect. */
const LITERAL_BIND_PATTERNS = [
  /\.listen\(\s*(\d{2,5})/g,
  /\bport\s*=\s*(\d{2,5})/gi,
  /--port[\s=]+(\d{2,5})/g,
]

const FRAMEWORK_DEFAULT_PORT: Record<string, number> = {
  nextjs: 3000,
  express: 3000,
  fastapi: 8000,
}

/**
 * How the app chooses its listening port.
 *
 * The distinction that matters is `bindsEnvPort`. A platform assigns a port and
 * routes to it; an app that ignores that assignment builds green and then fails
 * its health check, which looks identical to a dozen other problems. Getting
 * this right is what lets M4 diagnose a port mismatch in one step instead of
 * three.
 */
export function detectPort(files: RepoFiles, framework: string): PortDetection {
  const evidence: Evidence[] = []
  const sources = sourceFiles(files)
  let envRef = false
  let fallbackPort: number | undefined
  let literalPort: number | undefined

  for (const [path, content] of sources) {
    for (const pattern of ENV_PORT_PATTERNS) {
      for (const { evidence: found } of findAll(path, content, pattern)) {
        envRef = true
        if (evidence.length < 8) evidence.push(found)
      }
    }
    for (const pattern of ENV_PORT_FALLBACK) {
      for (const { match } of findAll(path, content, pattern)) {
        const parsed = Number.parseInt(match[1] ?? '', 10)
        if (Number.isInteger(parsed)) fallbackPort ??= parsed
      }
    }
  }

  for (const [path, content] of sources) {
    for (const pattern of LITERAL_BIND_PATTERNS) {
      for (const { match, evidence: found } of findAll(path, content, pattern)) {
        const parsed = Number.parseInt(match[1] ?? '', 10)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) continue
        literalPort ??= parsed
        if (evidence.length < 8) evidence.push(found)
      }
    }
  }

  if (envRef) {
    const port = fallbackPort ?? literalPort
    return {
      ...(port === undefined ? {} : { port }),
      source: fallbackPort === undefined ? 'env' : 'env_with_fallback',
      bindsEnvPort: true,
      evidence,
    }
  }

  if (literalPort !== undefined) {
    return { port: literalPort, source: 'literal', bindsEnvPort: false, evidence }
  }

  const fallback = FRAMEWORK_DEFAULT_PORT[framework]
  return fallback === undefined
    ? { source: 'unknown', bindsEnvPort: false, evidence }
    : { port: fallback, source: 'framework_default', bindsEnvPort: false, evidence }
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

const ENV_REF_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]{1,63})\b/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]{1,63})['"]\]/g,
  /os\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/g,
  /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/g,
  /os\.environ\[\s*['"]([A-Z][A-Z0-9_]{1,63})['"]\s*\]/g,
]

/** Supplied by the platform or the language runtime; not the app's to configure. */
const PLATFORM_PROVIDED = new Set([
  'PORT',
  'NODE_ENV',
  'PATH',
  'HOME',
  'PWD',
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'CI',
  'RENDER',
  'RENDER_EXTERNAL_URL',
])

/** Names Harbor must never invent a value for — it escalates to a human instead. */
const SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|_KEY$|^KEY$|SALT|DSN|ACCESS_KEY)/

/**
 * Required configuration, from `.env.example` plus code references.
 *
 * The two sources answer different questions. `.env.example` is what the author
 * says is needed; code references are what the app will actually read at
 * runtime. A variable referenced in code but missing from the example is the
 * usual cause of failure class C, so both are recorded separately rather than
 * merged into one list.
 */
export function detectEnvironment(files: RepoFiles): EnvVarRequirement[] {
  const found = new Map<string, EnvVarRequirement>()

  const upsert = (name: string): EnvVarRequirement => {
    const existing = found.get(name)
    if (existing) return existing

    const entry: EnvVarRequirement = {
      name,
      declared: false,
      referenced: false,
      secret: SECRET_NAME.test(name),
      evidence: [],
    }
    found.set(name, entry)
    return entry
  }

  for (const path of ['.env.example', '.env.sample', '.env.template']) {
    const content = files.get(path)
    if (content === undefined) continue

    for (const { match, evidence } of findAll(
      path,
      content,
      /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=(.*)$/gm,
    )) {
      const name = match[1]
      if (name === undefined) continue

      const entry = upsert(name)
      entry.declared = true
      entry.evidence.push(evidence)

      // An example file must not carry a real value, but it often carries a
      // usable non-secret default worth reusing.
      const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
      if (value !== '' && !entry.secret) entry.defaultValue = value
    }
  }

  for (const [path, content] of sourceFiles(files)) {
    for (const pattern of ENV_REF_PATTERNS) {
      for (const { match, evidence } of findAll(path, content, pattern)) {
        const name = match[1]
        if (name === undefined || PLATFORM_PROVIDED.has(name)) continue

        const entry = upsert(name)
        entry.referenced = true
        // A few citations per variable are enough to audit; more is noise.
        if (entry.evidence.length < 3) entry.evidence.push(evidence)
      }
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const DB_PACKAGES: [DatabaseKind, string[]][] = [
  ['postgres', ['pg', 'postgres', 'psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg']],
  ['mysql', ['mysql', 'mysql2', 'pymysql', 'aiomysql', 'mysqlclient']],
  ['sqlite', ['sqlite3', 'better-sqlite3', 'aiosqlite']],
  ['mongodb', ['mongoose', 'mongodb', 'pymongo', 'motor']],
  ['redis', ['redis', 'ioredis', 'aioredis']],
]

const DB_SCHEMES: [DatabaseKind, RegExp][] = [
  ['postgres', /\bpostgres(?:ql)?:\/\//g],
  ['mysql', /\bmysql(?:\+\w+)?:\/\//g],
  ['sqlite', /\bsqlite(?:\+\w+)?:\/{2,}/g],
  ['mongodb', /\bmongodb(?:\+srv)?:\/\//g],
  ['redis', /\brediss?:\/\//g],
]

/**
 * Whether the app needs a database, and which kind.
 *
 * Driver dependencies are the strongest signal; connection-string schemes catch
 * the case where an ORM hides the driver behind a URL. Getting this wrong in
 * either direction is expensive: a missed database means a crash loop on first
 * request, and a phantom one means provisioning a paid resource nobody asked
 * for — which is why `configure_database` sits behind the approval gate.
 */
export function detectDatabase(
  files: RepoFiles,
  node?: NodeManifest,
  python?: PythonManifest,
): DatabaseDetection {
  const kinds = new Set<DatabaseKind>()
  const evidence: Evidence[] = []

  const nodeDeps = new Set(Object.keys(node?.dependencies ?? {}).map(normalizeDistribution))
  const pythonDeps = new Set((python?.dependencies ?? []).map(normalizeDistribution))

  for (const [kind, packages] of DB_PACKAGES) {
    for (const name of packages) {
      const normalized = normalizeDistribution(name)
      const inNode = nodeDeps.has(normalized)
      const inPython = pythonDeps.has(normalized)
      if (!inNode && !inPython) continue

      kinds.add(kind)
      evidence.push({
        file: inNode ? 'package.json' : (python?.source ?? 'manifest'),
        excerpt: `${name} declared`,
      })
    }
  }

  for (const [path, content] of sourceFiles(files)) {
    for (const [kind, pattern] of DB_SCHEMES) {
      for (const { evidence: found } of findAll(path, content, pattern)) {
        kinds.add(kind)
        if (evidence.length < 8) evidence.push(found)
      }
    }
  }

  const connectionVar = findConnectionVar(files)

  return {
    // Redis and SQLite alone are not a managed database Harbor has to provision.
    required: [...kinds].some((kind) => kind !== 'sqlite' && kind !== 'redis'),
    kinds: [...kinds].sort(),
    ...(connectionVar === undefined ? {} : { connectionVar }),
    evidence,
  }
}

function findConnectionVar(files: RepoFiles): string | undefined {
  const names = new Set<string>()

  for (const [path, content] of sourceFiles(files)) {
    for (const pattern of ENV_REF_PATTERNS) {
      for (const { match } of findAll(path, content, pattern)) {
        if (match[1] !== undefined) names.add(match[1])
      }
    }
  }

  // DATABASE_URL is the convention every supported platform sets; prefer it.
  if (names.has('DATABASE_URL')) return 'DATABASE_URL'
  return [...names]
    .sort()
    .find((name) => /^(DB|DATABASE|POSTGRES|MONGO|MYSQL).*(URL|URI|DSN)$/.test(name))
}
