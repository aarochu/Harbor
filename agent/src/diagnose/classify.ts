/**
 * Failure classification.
 *
 * Turns "the deployment failed" into "this is why, here is the line, here is
 * the change". Everything is a pure function over log text plus the repo
 * profile, which is what makes the demo's central claim testable without
 * deploying anything.
 *
 * Order matters, and the order is by specificity. An explicit error message
 * beats an inference: `ModuleNotFoundError: No module named 'httpx'` says
 * exactly what is wrong, whereas "health check failed and the app hardcodes a
 * port" is a conclusion drawn from two separate facts. Checking the inferences
 * first would let a weak signal shadow a strong one.
 *
 * Log text is DATA. It comes from a build running someone else's repository,
 * so nothing here interprets it as an instruction — it is only ever matched
 * against patterns.
 */
import { makeEvidence } from '../repo/evidence.js'
import type { Evidence, RepoProfile } from '../repo/types.js'
import type { Diagnosis, FailurePhase, ProposedFix } from './types.js'

/** The profile as the diagnoser sees it — no host paths. */
export type DiagnosisProfile = Omit<RepoProfile, 'workdir'>

export interface FailureSignal {
  phase: FailurePhase
  buildLogs?: string
  runtimeLogs?: string
  health?: {
    status: 'healthy' | 'unhealthy' | 'unreachable'
    httpStatus?: number
  }
  /** Whether the platform reported the build itself as successful. */
  buildSucceeded?: boolean
  profile?: DiagnosisProfile
}

// ---------------------------------------------------------------------------
// Import -> distribution
// ---------------------------------------------------------------------------

/**
 * Python imports whose distribution name differs from the module name.
 *
 * Getting this wrong produces a fix that looks right and fails identically:
 * `pip install psycopg2` compiles from source and breaks on a slim image,
 * where `psycopg2-binary` is what the repo actually wanted.
 */
const PYTHON_DISTRIBUTION: Record<string, string> = {
  psycopg2: 'psycopg2-binary',
  PIL: 'Pillow',
  cv2: 'opencv-python',
  yaml: 'PyYAML',
  sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  jwt: 'PyJWT',
  dateutil: 'python-dateutil',
  attr: 'attrs',
  OpenSSL: 'pyOpenSSL',
  serial: 'pyserial',
  Crypto: 'pycryptodome',
  magic: 'python-magic',
  jose: 'python-jose',
  multipart: 'python-multipart',
}

/**
 * Standard library modules.
 *
 * A missing stdlib module is not a missing dependency — it means the runtime
 * is broken or the Python version is wrong. Adding it to requirements.txt
 * would install some unrelated package off PyPI, which is worse than failing.
 */
const PYTHON_STDLIB = new Set([
  'abc',
  'argparse',
  'array',
  'asyncio',
  'base64',
  'binascii',
  'bisect',
  'calendar',
  'codecs',
  'collections',
  'configparser',
  'contextlib',
  'copy',
  'csv',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'email',
  'enum',
  'errno',
  'functools',
  'gc',
  'getpass',
  'gettext',
  'glob',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'locale',
  'logging',
  'math',
  'mimetypes',
  'multiprocessing',
  'operator',
  'os',
  'pathlib',
  'pickle',
  'platform',
  'pprint',
  'queue',
  'random',
  're',
  'secrets',
  'shutil',
  'signal',
  'socket',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'struct',
  'subprocess',
  'sys',
  'tempfile',
  'textwrap',
  'threading',
  'time',
  'traceback',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'warnings',
  'weakref',
  'xml',
  'zipfile',
  'zlib',
  'zoneinfo',
])

/** `lodash/get` -> `lodash`, `@scope/pkg/sub` -> `@scope/pkg`. */
export function nodePackageRoot(specifier: string): string {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0] ?? specifier
}

/** `google.protobuf` -> `google`, then mapped to its distribution. */
export function pythonDistributionFor(moduleName: string): string {
  const root = moduleName.split('.')[0] ?? moduleName
  return PYTHON_DISTRIBUTION[root] ?? root
}

function isRelativeOrAbsolute(specifier: string): boolean {
  return (
    specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier)
  )
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const PYTHON_MISSING_MODULE = [
  /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/,
  /ImportError:\s*No module named ['"]?([\w.]+)['"]?/,
]

const NODE_MISSING_MODULE = [
  /Cannot find module ['"]([^'"]+)['"]/,
  /Cannot find package ['"]([^'"]+)['"]/,
  /Module not found:.*?Can't resolve ['"]([^'"]+)['"]/,
]

const MISSING_ENV_VAR = [
  /KeyError:\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/,
  /[Mm]issing required environment variable:?\s*['"]?([A-Z][A-Z0-9_]{1,63})['"]?/,
  /[Ee]nvironment variable ['"]?([A-Z][A-Z0-9_]{1,63})['"]? (?:is )?(?:not set|required|missing)/,
  /([A-Z][A-Z0-9_]{1,63}) is not set/,
]

const BAD_START_COMMAND = [
  /(?:bash|sh):.*?:?\s*([\w.-]+): (?:command )?not found/,
  /(?:python|python3): can't open file ['"]([^'"]+)['"]/,
  /Error: Cannot find module ['"]((?:\/|[A-Za-z]:)[^'"]+)['"]/,
  /npm ERR! Missing script: ['"]([^'"]+)['"]/,
]

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

/**
 * Classify a failure.
 *
 * Always returns a diagnosis. `unknown` with zero confidence is a real answer —
 * it routes to escalation, which is the correct outcome for a failure Harbor
 * does not recognise.
 */
export function diagnose(signal: FailureSignal): Diagnosis {
  return (
    diagnoseBadStartCommand(signal) ??
    diagnoseMissingDependency(signal) ??
    diagnoseMissingEnvVar(signal) ??
    diagnosePortMismatch(signal) ??
    unknownDiagnosis(signal)
  )
}

/**
 * D — the start command does not point at anything runnable.
 *
 * Checked before the dependency class because Node reports a missing entry
 * file with the same "Cannot find module" wording it uses for a missing
 * package. The difference is that the specifier is a path, and adding a path
 * to package.json is meaningless.
 */
function diagnoseBadStartCommand(signal: FailureSignal): Diagnosis | undefined {
  const logs = joinLogs(signal)
  if (logs.text === '') return undefined

  for (const pattern of BAD_START_COMMAND) {
    const match = pattern.exec(logs.text)
    if (!match) continue

    const target = match[1] ?? 'the start command'
    const suggested = signal.profile?.suggestedStartCommand

    // If the convention is already what just failed, proposing it again would
    // spend a fix attempt re-running the identical command. That is not really a
    // start command problem — the executable is missing from the image — and it
    // needs a human rather than another lap of the loop.
    const alreadyRunning = suggested !== undefined && logs.text.includes(suggested)
    const usable = suggested !== undefined && !alreadyRunning

    const fix: ProposedFix = usable
      ? {
          kind: 'change_start_command',
          summary: `Change the start command to the framework convention: ${suggested}`,
          to: suggested,
        }
      : {
          kind: 'change_start_command',
          summary: alreadyRunning
            ? `The start command is already "${suggested}" and "${target}" is still missing — ` +
              'the build did not install it'
            : `Start command references "${target}", which does not exist on the service`,
          // Without an alternative there is nothing to change it to, and guessing
          // a start command is how an app gets launched wrongly three times.
          requiresHuman: true,
        }

    return {
      failureClass: 'bad_start_command',
      confidence: usable ? 0.85 : 0.55,
      phase: signal.phase,
      symptom: `The service exited immediately: "${target}" could not be run.`,
      reasoning:
        'The runtime reported a missing executable or entry file rather than an ' +
        'application error, so the process never started. That is a start command ' +
        'problem, not a code problem.',
      evidence: [logs.evidenceAt(match.index)],
      proposedFix: fix,
    }
  }

  return undefined
}

/** B — a package is imported but not declared. */
function diagnoseMissingDependency(signal: FailureSignal): Diagnosis | undefined {
  const logs = joinLogs(signal)
  if (logs.text === '') return undefined

  const python = firstMatch(logs.text, PYTHON_MISSING_MODULE)
  if (python) {
    const moduleName = python.value
    const root = moduleName.split('.')[0] ?? moduleName

    if (PYTHON_STDLIB.has(root)) {
      // Real, but not fixable by adding a dependency.
      return {
        failureClass: 'unknown',
        confidence: 0,
        phase: signal.phase,
        symptom: `The standard library module "${root}" could not be imported.`,
        reasoning:
          `"${root}" ships with Python, so its absence points at a broken or ` +
          'mismatched runtime rather than a missing package. Installing a ' +
          'same-named package from PyPI would be wrong.',
        evidence: [logs.evidenceAt(python.index)],
      }
    }

    const packageName = pythonDistributionFor(moduleName)
    const manifest = signal.profile?.python?.source ?? 'requirements.txt'
    const alreadyDeclared = (signal.profile?.python?.dependencies ?? []).includes(
      packageName.toLowerCase().replace(/[-_.]+/g, '-'),
    )

    if (alreadyDeclared) {
      return {
        failureClass: 'unknown',
        confidence: 0,
        phase: signal.phase,
        symptom: `"${moduleName}" is declared in ${manifest} but could not be imported.`,
        reasoning:
          'The package is already in the manifest, so adding it again would change ' +
          'nothing. The install step likely failed or the build used a different manifest.',
        evidence: [logs.evidenceAt(python.index)],
      }
    }

    return {
      failureClass: 'missing_dependency',
      confidence: 0.95,
      phase: signal.phase,
      symptom: `The application imports "${moduleName}", which is not installed.`,
      reasoning:
        `"${moduleName}" is imported at runtime but absent from ${manifest}, so the ` +
        'build never installed it.' +
        (packageName === moduleName
          ? ''
          : ` The distribution that provides it is "${packageName}", not "${moduleName}".`),
      evidence: [logs.evidenceAt(python.index)],
      proposedFix: {
        kind: 'add_dependency',
        summary: `Add "${packageName}" to ${manifest}`,
        file: manifest,
        packageName,
        importName: moduleName,
      },
    }
  }

  const node = firstMatch(logs.text, NODE_MISSING_MODULE)
  if (node) {
    // A path is a missing file in the repo, not a missing package.
    if (isRelativeOrAbsolute(node.value)) return undefined

    const packageName = nodePackageRoot(node.value)
    const declared = {
      ...signal.profile?.node?.dependencies,
      ...signal.profile?.node?.devDependencies,
    }

    if (packageName in declared) {
      return {
        failureClass: 'unknown',
        confidence: 0,
        phase: signal.phase,
        symptom: `"${packageName}" is declared in package.json but could not be resolved.`,
        reasoning:
          'The package is already a declared dependency, so the install step or the ' +
          'lockfile is the problem, not the manifest.',
        evidence: [logs.evidenceAt(node.index)],
      }
    }

    return {
      failureClass: 'missing_dependency',
      confidence: 0.95,
      phase: signal.phase,
      symptom: `The application imports "${node.value}", which is not installed.`,
      reasoning:
        `"${node.value}" is imported but absent from package.json, so it was never ` +
        'installed.' +
        (packageName === node.value
          ? ''
          : ` The package to add is "${packageName}"; the rest of the specifier is a subpath.`),
      evidence: [logs.evidenceAt(node.index)],
      proposedFix: {
        kind: 'add_dependency',
        summary: `Add "${packageName}" to package.json dependencies`,
        file: 'package.json',
        packageName,
        importName: node.value,
      },
    }
  }

  return undefined
}

/**
 * C — a required environment variable is unset.
 *
 * The fix splits on whether the value is a secret. Harbor can set LOG_LEVEL. It
 * must never invent a STRIPE_API_KEY, because a plausible-looking wrong value
 * turns a clear failure into a silent one.
 */
function diagnoseMissingEnvVar(signal: FailureSignal): Diagnosis | undefined {
  const logs = joinLogs(signal)
  if (logs.text === '') return undefined

  const match = firstMatch(logs.text, MISSING_ENV_VAR)
  if (!match) return undefined

  const name = match.value
  const known = signal.profile?.environment.find((entry) => entry.name === name)
  const isSecret = known?.secret ?? /SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL/.test(name)
  const suggested = known?.defaultValue

  const fix: ProposedFix =
    isSecret || suggested === undefined
      ? {
          kind: 'set_env_var',
          summary: `${name} must be set before the service can start`,
          envVarName: name,
          requiresHuman: true,
        }
      : {
          kind: 'set_env_var',
          summary: `Set ${name} to the value declared in .env.example`,
          envVarName: name,
          to: suggested,
        }

  return {
    failureClass: 'missing_env_var',
    confidence: 0.9,
    phase: signal.phase,
    symptom: `The application requires the environment variable ${name}, which is not set.`,
    reasoning: isSecret
      ? `${name} looks like a credential. Harbor will not invent a value for it — a ` +
        'wrong secret fails in ways that are harder to diagnose than a missing one.'
      : `${name} is referenced at startup and has a non-secret default in the repository, ` +
        'so it can be set directly.',
    evidence: [logs.evidenceAt(match.index)],
    proposedFix: fix,
  }
}

/**
 * A — the app binds a literal port while the platform routes to $PORT.
 *
 * This one is an inference rather than an error message, and that is the whole
 * difficulty of the class: the build is green and the logs look healthy. The
 * evidence is the bind site the repo profile already found, which is why this
 * needs no log parsing at all.
 */
function diagnosePortMismatch(signal: FailureSignal): Diagnosis | undefined {
  const port = signal.profile?.port
  if (!port || port.bindsEnvPort) return undefined

  const healthFailed = signal.health !== undefined && signal.health.status !== 'healthy'
  if (!healthFailed) return undefined

  // A build that never succeeded has a different, earlier explanation.
  if (signal.buildSucceeded === false) return undefined

  const evidence: Evidence[] = [...port.evidence]
  const logs = joinLogs(signal)

  // A listening banner naming the hardcoded port makes this near-certain.
  if (port.port !== undefined && logs.text !== '') {
    const banner = new RegExp(
      `(?:Running on|Uvicorn running on|listening on|Listening on)[^\\n]*?:${String(port.port)}\\b`,
    ).exec(logs.text)
    if (banner) evidence.push(logs.evidenceAt(banner.index))
  }

  const literal = port.source === 'literal'

  return {
    failureClass: 'port_mismatch',
    confidence: literal ? 0.9 : 0.65,
    phase: signal.phase,
    symptom:
      'The service built successfully but did not answer on its public URL ' +
      `(health check: ${signal.health?.status ?? 'failed'}).`,
    reasoning:
      `The application listens on ${port.port === undefined ? 'a fixed port' : String(port.port)} ` +
      'instead of reading the platform-assigned $PORT, so the platform routes traffic to a ' +
      'port nothing is bound to. That produces a green build and a failing health check, ' +
      'which is exactly what was observed.',
    evidence,
    proposedFix: {
      kind: 'bind_env_port',
      summary: `Bind to $PORT instead of ${String(port.port ?? 'a literal port')}`,
      ...(evidence[0]?.file === undefined ? {} : { file: evidence[0].file }),
      ...(port.port === undefined ? {} : { from: String(port.port) }),
      to: '$PORT',
    },
  }
}

function unknownDiagnosis(signal: FailureSignal): Diagnosis {
  const logs = joinLogs(signal)

  return {
    failureClass: 'unknown',
    confidence: 0,
    phase: signal.phase,
    symptom:
      signal.health !== undefined && signal.health.status !== 'healthy'
        ? `The service is ${signal.health.status} and no known failure pattern matched.`
        : 'The deployment failed and no known failure pattern matched.',
    reasoning:
      'None of the recognised failure classes fit the available signals. Escalating ' +
      'rather than applying a speculative fix.',
    evidence: logs.text === '' ? [] : [logs.evidenceAt(Math.max(0, logs.text.length - 1))],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JoinedLogs {
  text: string
  evidenceAt: (index: number) => Evidence
}

/**
 * Runtime logs first.
 *
 * When both exist the runtime failure is the more recent event, and a build log
 * from an earlier successful stage should not outrank it.
 */
function joinLogs(signal: FailureSignal): JoinedLogs {
  const runtime = signal.runtimeLogs ?? ''
  const build = signal.buildLogs ?? ''

  if (runtime !== '' && build !== '') {
    const text = `${runtime}\n${build}`
    const boundary = runtime.length + 1
    return {
      text,
      evidenceAt: (index) =>
        index < boundary
          ? makeEvidence('runtime.log', runtime, index)
          : makeEvidence('build.log', build, index - boundary),
    }
  }

  if (runtime !== '') {
    return { text: runtime, evidenceAt: (index) => makeEvidence('runtime.log', runtime, index) }
  }
  return { text: build, evidenceAt: (index) => makeEvidence('build.log', build, index) }
}

function firstMatch(
  text: string,
  patterns: readonly RegExp[],
): { value: string; index: number } | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1] !== undefined) return { value: match[1], index: match.index }
  }
  return undefined
}
