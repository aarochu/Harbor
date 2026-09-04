/**
 * RepoProfile assembly.
 *
 * The agent is handed one URL and must decide how to build, start, configure
 * and verify the application behind it. This module turns a clone into the
 * single structured object that decision is made from.
 *
 * Two halves on purpose:
 *   - `buildProfileFromFiles` is pure. It is what the tests exercise, and what
 *     M4 re-runs after applying a fix to confirm the defect is actually gone.
 *   - `profileRepo` adds the clone and the cleanup around it.
 *
 * Suggested commands are suggestions. They are derived from framework
 * convention and are the agent's starting point, not a contract — when a repo
 * declares its own scripts, those win.
 */
import { detectDatabase, detectEnvironment, detectFramework, detectPort } from './detect.js'
import { inspectDockerfile, inspectPackageJson, inspectPythonManifest } from './manifest.js'
import type { NodeManifest, PackageManager, PythonManifest, RepoProfile } from './types.js'
import type { RepoFiles } from './workspace.js'
import { cloneRepo, disposeWorkspace, loadRepoFiles } from './workspace.js'

export interface ProfileInput {
  repoUrl: string
  branch: string
  workdir: string
  commit?: string
}

/** Build a profile from an already-loaded file map. Pure and synchronous. */
export function buildProfileFromFiles(files: RepoFiles, input: ProfileInput): RepoProfile {
  const node = inspectPackageJson(files)
  const python = inspectPythonManifest(files)
  const detection = detectFramework(files, node, python)
  const port = detectPort(files, detection.framework)
  const database = detectDatabase(files, node, python)
  const dockerfile = inspectDockerfile(files)
  const environment = detectEnvironment(files)

  const warnings: string[] = []

  if (detection.framework === 'unknown') {
    warnings.push(
      'Framework could not be identified. Harbor supports Next.js, Express and FastAPI; ' +
        'deploying anything else needs a human decision.',
    )
  } else if (detection.confidence < 0.7) {
    warnings.push(
      `Framework identified as ${detection.framework} from source imports rather than a ` +
        'declared dependency; treat the build and start commands as unverified.',
    )
  }

  // The class A signature, caught before deploying rather than after the health
  // check times out.
  if (!port.bindsEnvPort && port.source === 'literal') {
    warnings.push(
      `Application binds port ${String(port.port)} directly instead of reading $PORT. ` +
        'The platform assigns a port, so this will build successfully and then fail its health check.',
    )
  }

  const undeclared = environment.filter((entry) => entry.referenced && !entry.declared)
  if (undeclared.length > 0) {
    warnings.push(
      `Referenced in code but absent from .env.example: ${undeclared
        .map((entry) => entry.name)
        .join(', ')}.`,
    )
  }

  const secrets = environment.filter((entry) => entry.secret && entry.defaultValue === undefined)
  if (secrets.length > 0) {
    warnings.push(
      `Requires secret values Harbor must not invent: ${secrets
        .map((entry) => entry.name)
        .join(', ')}. Escalate rather than guessing.`,
    )
  }

  if (database.required && database.connectionVar === undefined) {
    warnings.push(
      'A database is required but no connection-string variable was found. ' +
        'Harbor cannot tell the application where to connect.',
    )
  }

  if (
    dockerfile.present &&
    port.port !== undefined &&
    dockerfile.exposedPorts.length > 0 &&
    !dockerfile.exposedPorts.includes(port.port)
  ) {
    warnings.push(
      `Dockerfile EXPOSEs ${dockerfile.exposedPorts.join(', ')} but the application ` +
        `appears to listen on ${String(port.port)}.`,
    )
  }

  const suggestedBuildCommand = buildCommandFor(detection.framework, node, python)
  const suggestedStartCommand = startCommandFor(detection.framework, node, files)

  return {
    repoUrl: input.repoUrl,
    branch: input.branch,
    workdir: input.workdir,
    ...(input.commit === undefined ? {} : { commit: input.commit }),
    detection,
    port,
    database,
    dockerfile,
    environment,
    ...(node === undefined ? {} : { node }),
    ...(python === undefined ? {} : { python }),
    ...(suggestedBuildCommand === undefined ? {} : { suggestedBuildCommand }),
    ...(suggestedStartCommand === undefined ? {} : { suggestedStartCommand }),
    warnings,
  }
}

/** Clone, profile, and dispose of the clone unless the caller wants to keep it. */
export async function profileRepo(
  repoUrl: string,
  options: { branch?: string; token?: string; keepWorkdir?: boolean } = {},
): Promise<RepoProfile> {
  const clone = await cloneRepo(repoUrl, {
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.token === undefined ? {} : { token: options.token }),
  })

  try {
    const files = await loadRepoFiles(clone.workdir)
    return buildProfileFromFiles(files, {
      repoUrl,
      branch: clone.branch,
      workdir: clone.workdir,
      commit: clone.commit,
    })
  } finally {
    // M2 needs the clone to commit fixes into; a read-only profile does not.
    if (!options.keepWorkdir) await disposeWorkspace(clone.workdir)
  }
}

function installCommand(manager: PackageManager): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile'
    case 'yarn':
      return 'yarn install --frozen-lockfile'
    case 'bun':
      return 'bun install'
    default:
      // `npm ci` requires a lockfile that matches package.json exactly; on a
      // repo Harbor did not write, `npm install` is the form that survives.
      return 'npm install'
  }
}

function runScript(manager: PackageManager, script: string): string {
  return manager === 'yarn' ? `yarn ${script}` : `${manager} run ${script}`
}

function buildCommandFor(
  framework: string,
  node?: NodeManifest,
  python?: PythonManifest,
): string | undefined {
  if (framework === 'fastapi') {
    // Follow the manifest the repo actually ships. Assuming requirements.txt
    // for every Python project produces a build command that fails on the first
    // line for a repo that uses pyproject.toml.
    if (python === undefined) return undefined
    if (python.source === 'requirements.txt') return 'pip install -r requirements.txt'
    return python.packageManager === 'poetry' ? 'poetry install --no-root' : 'pip install .'
  }

  if (!node) return undefined

  const install = installCommand(node.packageManager)
  return node.scripts.build === undefined
    ? install
    : `${install} && ${runScript(node.packageManager, 'build')}`
}

function startCommandFor(
  framework: string,
  node: NodeManifest | undefined,
  files: RepoFiles,
): string | undefined {
  if (framework === 'fastapi') {
    const target = findFastApiApp(files)
    return target === undefined ? undefined : `uvicorn ${target} --host 0.0.0.0 --port $PORT`
  }

  if (!node) return undefined
  // A declared start script is the author's own answer; prefer it to convention.
  if (node.scripts.start !== undefined) return runScript(node.packageManager, 'start')
  if (framework === 'nextjs') return runScript(node.packageManager, 'start')
  return undefined
}

/**
 * Locate the ASGI application for uvicorn, as `module.path:variable`.
 *
 * Shallower paths win so `main.py` beats `app/routers/thing.py` — the top-level
 * module is where an entrypoint conventionally lives.
 */
export function findFastApiApp(files: RepoFiles): string | undefined {
  const candidates: { module: string; variable: string; depth: number }[] = []

  for (const [path, content] of files) {
    if (!path.endsWith('.py')) continue

    const match = /^\s*(\w+)\s*=\s*FastAPI\s*\(/m.exec(content)
    if (!match?.[1]) continue

    candidates.push({
      module: path.replace(/\.py$/, '').split('/').join('.'),
      variable: match[1],
      depth: path.split('/').length,
    })
  }

  candidates.sort((a, b) => a.depth - b.depth || a.module.localeCompare(b.module))
  const best = candidates[0]
  return best === undefined ? undefined : `${best.module}:${best.variable}`
}
