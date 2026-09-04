/**
 * The RepoProfile — the single structured object the agent reasons over.
 *
 * Harbor is given a URL and nothing else, so every deployment decision traces
 * back to something detected here. Two properties matter more than the rest:
 *
 *   - Every finding carries `evidence`: the file and line it came from. A
 *     diagnosis the operator cannot audit is not worth acting on, and when the
 *     agent later explains a fix, it cites these.
 *   - Detection is allowed to be uncertain. `confidence` and the `unknown`
 *     variants exist so the agent can say "I could not tell" rather than
 *     guessing, which is the difference between escalating and breaking things.
 */

/** Where a finding came from, so a human can check it. */
export interface Evidence {
  /** Repo-relative path, POSIX separators. */
  file: string
  /** 1-indexed, when the finding came from a specific line. */
  line?: number
  /** The matched text, trimmed and length-capped. */
  excerpt: string
}

export type Framework = 'nextjs' | 'express' | 'fastapi' | 'unknown'

export type Runtime = 'node' | 'python' | 'unknown'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'unknown'

export interface FrameworkDetection {
  framework: Framework
  runtime: Runtime
  /** 0–1. Below 0.5 the agent should treat the result as a guess. */
  confidence: number
  evidence: Evidence[]
}

/**
 * How the application decides which port to listen on.
 *
 * This is the highest-value field in the profile. Failure class A (port
 * mismatch) is exactly the case where `bindsEnvPort` is false: the app hardcodes
 * a port, the platform routes to $PORT, and the health check times out with a
 * green build. Distinguishing that from `process.env.PORT || 3000` — which is
 * correct and needs no fix — is the whole detection.
 */
export type PortSource =
  /** Reads the platform's PORT variable. Deployable as-is. */
  | 'env'
  /** Reads PORT with a local fallback. Also deployable as-is. */
  | 'env_with_fallback'
  /** Hardcoded. This is the class A defect. */
  | 'literal'
  /** Nothing found in code; inferred from framework convention. */
  | 'framework_default'
  | 'unknown'

export interface PortDetection {
  /** The literal or fallback port, when there is one. */
  port?: number
  source: PortSource
  /** True when the app will honour the platform's assigned port. */
  bindsEnvPort: boolean
  evidence: Evidence[]
}

export interface EnvVarRequirement {
  name: string
  /** Named in .env.example, so it is expected configuration rather than a guess. */
  declared: boolean
  /** Referenced from source code. */
  referenced: boolean
  /** A value the repo itself suggests. Never a real secret — those are not committed. */
  defaultValue?: string
  /** Name matches a secret-shaped pattern, so Harbor must escalate rather than invent one. */
  secret: boolean
  evidence: Evidence[]
}

export type DatabaseKind = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis'

export interface DatabaseDetection {
  required: boolean
  kinds: DatabaseKind[]
  /** The variable the app reads its connection string from, when identifiable. */
  connectionVar?: string
  evidence: Evidence[]
}

export interface DockerfileDetection {
  present: boolean
  path?: string
  baseImage?: string
  exposedPorts: number[]
  /** CMD or ENTRYPOINT, as written. */
  startCommand?: string
  evidence: Evidence[]
}

export interface NodeManifest {
  name?: string
  packageManager: PackageManager
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  /** engines.node, when pinned. */
  nodeVersion?: string
}

export interface PythonManifest {
  packageManager: PackageManager
  /** Distribution names as written in the manifest, lowercased. */
  dependencies: string[]
  pythonVersion?: string
  source: string
}

export interface RepoProfile {
  repoUrl: string
  branch: string
  /** Absolute path to the isolated clone. Never sent to the model. */
  workdir: string
  commit?: string

  detection: FrameworkDetection
  port: PortDetection
  database: DatabaseDetection
  dockerfile: DockerfileDetection
  environment: EnvVarRequirement[]

  node?: NodeManifest
  python?: PythonManifest

  /** Derived from framework + manifest; the agent may override with reason. */
  suggestedBuildCommand?: string
  suggestedStartCommand?: string

  /** Things Harbor could not determine. Surfaced rather than silently defaulted. */
  warnings: string[]
}
