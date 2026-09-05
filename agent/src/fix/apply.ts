/**
 * Turn a ProposedFix into concrete file edits.
 *
 * Planning is separate from committing. This module produces before/after
 * content and a diff; nothing here writes to disk, pushes a branch, or calls a
 * platform API. That split is what lets the diff be logged and reviewed before
 * anything is committed (SOW §4), and it makes every fix testable against an
 * in-memory repo rather than a live deployment.
 *
 * A fix marked `requiresHuman` is refused outright. The diagnoser sets that
 * flag for secrets and for cases where it has no real alternative to propose,
 * and quietly applying one anyway would defeat the escalation path.
 */
import type { ProposedFix } from '../diagnose/types.js'
import type { RepoFiles } from '../repo/workspace.js'
import { unifiedDiff } from './diff.js'

export class FixNotApplicableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FixNotApplicableError'
  }
}

export interface FileEdit {
  path: string
  before: string
  after: string
  diff: string
}

/**
 * A change that belongs to the platform rather than the repository.
 *
 * Setting an env var or changing a start command is Render configuration, not
 * a commit — so these are carried separately, and the caller must remember that
 * Render does not redeploy on an env var change by itself.
 */
export interface PlatformAction {
  kind: 'set_env_var' | 'change_start_command'
  envVarName?: string
  value?: string
  startCommand?: string
}

export interface FixPlan {
  fix: ProposedFix
  edits: FileEdit[]
  platformAction?: PlatformAction
  /** Every edit's diff, concatenated. Empty for a platform-only fix. */
  diff: string
  summary: string
  /** Caveats worth surfacing to a human, e.g. an unpinned version. */
  notes: string[]
}

export function planFix(fix: ProposedFix, files: RepoFiles): FixPlan {
  if (fix.requiresHuman === true) {
    throw new FixNotApplicableError(
      `Fix "${fix.summary}" is marked as requiring a human and must be escalated, not applied`,
    )
  }

  switch (fix.kind) {
    case 'add_dependency':
      return planAddDependency(fix, files)
    case 'bind_env_port':
      return planBindEnvPort(fix, files)
    case 'set_env_var':
      return planSetEnvVar(fix)
    case 'change_start_command':
      return planChangeStartCommand(fix)
  }
}

// ---------------------------------------------------------------------------
// B — add a dependency
// ---------------------------------------------------------------------------

function planAddDependency(fix: ProposedFix, files: RepoFiles): FixPlan {
  const packageName = fix.packageName
  if (packageName === undefined || packageName === '') {
    throw new FixNotApplicableError('add_dependency needs a packageName')
  }

  const path = fix.file ?? 'requirements.txt'
  const before = files.get(path)
  if (before === undefined) {
    throw new FixNotApplicableError(`Manifest not found in the repository: ${path}`)
  }

  const notes: string[] = []
  let after: string

  if (path.endsWith('package.json')) {
    after = addNodeDependency(before, packageName)
    notes.push(
      `"${packageName}" is added unpinned ("*"); the install step resolves it and the ` +
        'lockfile records the exact version.',
    )
  } else if (path.endsWith('pyproject.toml')) {
    after = addPyprojectDependency(before, packageName)
  } else {
    after = addRequirement(before, packageName)
    notes.push(
      `"${packageName}" is added unpinned, matching how a developer would add it before ` +
        'choosing a constraint.',
    )
  }

  if (after === before) {
    throw new FixNotApplicableError(`"${packageName}" already appears in ${path}`)
  }

  const edit = makeEdit(path, before, after)
  return {
    fix,
    edits: [edit],
    diff: edit.diff,
    summary: `Add "${packageName}" to ${path}`,
    notes,
  }
}

function addRequirement(content: string, packageName: string): string {
  const declared = new RegExp(`^\\s*${escapeRegex(packageName)}\\s*(?:[=<>!~\\[;].*)?$`, 'im')
  if (declared.test(content)) return content

  // Keep the file's existing newline convention rather than imposing one.
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const trimmed = content.replace(/\s*$/, '')
  return trimmed === '' ? `${packageName}${eol}` : `${trimmed}${eol}${packageName}${eol}`
}

/**
 * Insert into package.json without reformatting the file.
 *
 * Reserializing through JSON.parse would rewrite every line and bury a
 * one-package change in a whole-file diff, which defeats the point of logging
 * the diff for review.
 */
function addNodeDependency(content: string, packageName: string): string {
  const block = /"dependencies"\s*:\s*\{([\s\S]*?)\}/.exec(content)
  const entry = `"${packageName}": "*"`

  if (!block) {
    // No dependencies block at all: create one directly after the opening brace.
    const open = content.indexOf('{')
    if (open === -1) throw new FixNotApplicableError('package.json is not a JSON object')
    const indent = detectIndent(content)
    return (
      `${content.slice(0, open + 1)}\n${indent}"dependencies": { ${entry} },` +
      `${content.slice(open + 1)}`
    )
  }

  const body = block[1] ?? ''
  if (new RegExp(`"${escapeRegex(packageName)}"\\s*:`).test(body)) return content

  const existing = [...body.matchAll(/^([ \t]*)"([^"]+)"\s*:\s*("[^"]*"|[^,\n]+)/gm)]
  if (existing.length === 0) {
    const indent = detectIndent(content)
    return content.replace(block[0], `"dependencies": {\n${indent.repeat(2)}${entry}\n${indent}}`)
  }

  // npm keeps dependencies sorted; insert in place to keep the diff one line.
  const indent = existing[0]?.[1] ?? '    '
  const insertBefore = existing.find((match) => (match[2] ?? '') > packageName)

  if (insertBefore) {
    const anchor = insertBefore[0]
    return content.replace(anchor, `${indent}${entry},\n${anchor}`)
  }

  const last = existing.at(-1)
  if (!last) return content
  return content.replace(last[0], `${last[0]},\n${indent}${entry}`)
}

function addPyprojectDependency(content: string, packageName: string): string {
  const pep621 = /(^\s*dependencies\s*=\s*\[)([\s\S]*?)(\])/m.exec(content)
  if (pep621) {
    const body = pep621[2] ?? ''
    if (new RegExp(`["']${escapeRegex(packageName)}\\b`).test(body)) return content

    const indent = /\n(\s+)["']/.exec(body)?.[1] ?? '    '
    const trimmed = body.replace(/\s*$/, '')
    // A trailing comma is legal TOML and common in a multi-line array, so only
    // add one when the last entry does not already have it.
    const separator = trimmed === '' || trimmed.endsWith(',') ? '' : ','
    return content.replace(
      pep621[0],
      `${pep621[1] ?? ''}${trimmed}${separator}\n${indent}"${packageName}",\n${pep621[3] ?? ']'}`,
    )
  }

  const poetry = /^[ \t]*\[tool\.poetry\.dependencies\][ \t]*\r?\n/m.exec(content)
  if (poetry) {
    if (new RegExp(`^\\s*${escapeRegex(packageName)}\\s*=`, 'm').test(content)) return content
    const insertAt = poetry.index + poetry[0].length
    return `${content.slice(0, insertAt)}${packageName} = "*"\n${content.slice(insertAt)}`
  }

  throw new FixNotApplicableError('pyproject.toml has no recognised dependencies table')
}

// ---------------------------------------------------------------------------
// A — bind the platform's port
// ---------------------------------------------------------------------------

/**
 * Rewrite a hardcoded port into a read of $PORT.
 *
 * The literal is kept as the fallback rather than deleted: the app still runs
 * locally afterwards, which means the fix does not trade a broken deployment
 * for a broken development setup.
 */
function planBindEnvPort(fix: ProposedFix, files: RepoFiles): FixPlan {
  const path = fix.file
  if (path === undefined) {
    throw new FixNotApplicableError('bind_env_port needs the file containing the bind')
  }

  const before = files.get(path)
  if (before === undefined) {
    throw new FixNotApplicableError(`File not found in the repository: ${path}`)
  }

  const port = fix.from
  if (port === undefined || !/^\d+$/.test(port)) {
    throw new FixNotApplicableError('bind_env_port needs the literal port it is replacing')
  }

  const notes: string[] = []
  let after: string

  if (path.endsWith('.py')) {
    after = before.replace(
      new RegExp(`(\\bport\\s*=\\s*)${port}\\b`),
      `$1int(os.environ.get("PORT", ${port}))`,
    )
    if (after !== before && !hasPythonOsImport(before)) {
      after = addPythonImport(after, 'import os')
      notes.push('Added "import os", which the new port lookup needs.')
    }
  } else if (/\.(m?[jt]sx?|cjs)$/.test(path)) {
    after = before.replace(
      new RegExp(`(\\.listen\\(\\s*)${port}\\b`),
      `$1process.env.PORT || ${port}`,
    )
  } else {
    // Dockerfile, Procfile, compose: the port is a command-line argument.
    after = before.replace(new RegExp(`(--port[\\s=]+)${port}\\b`), '$1$$PORT')
  }

  if (after === before) {
    throw new FixNotApplicableError(
      `Could not find a bind to port ${port} in ${path} that this fix knows how to rewrite`,
    )
  }

  const edit = makeEdit(path, before, after)
  return {
    fix,
    edits: [edit],
    diff: edit.diff,
    summary: `Bind to $PORT in ${path}, keeping ${port} as the local fallback`,
    notes,
  }
}

function hasPythonOsImport(content: string): boolean {
  return /^\s*import\s+os\s*$/m.test(content) || /^\s*import\s+os\s*,/m.test(content)
}

/** Put the import with the others, or at the top when there are none. */
function addPythonImport(content: string, statement: string): string {
  const firstImport = /^(?:import|from)\s+\S/m.exec(content)
  if (firstImport) {
    return `${content.slice(0, firstImport.index)}${statement}\n${content.slice(firstImport.index)}`
  }
  return `${statement}\n\n${content}`
}

// ---------------------------------------------------------------------------
// Platform-side fixes
// ---------------------------------------------------------------------------

function planSetEnvVar(fix: ProposedFix): FixPlan {
  const envVarName = fix.envVarName
  if (envVarName === undefined) {
    throw new FixNotApplicableError('set_env_var needs envVarName')
  }
  if (fix.to === undefined) {
    throw new FixNotApplicableError(
      `No value is available for ${envVarName}; this fix should have been escalated`,
    )
  }

  return {
    fix,
    edits: [],
    platformAction: { kind: 'set_env_var', envVarName, value: fix.to },
    diff: '',
    summary: `Set ${envVarName} on the service`,
    // The trap in Render's API: an env var change alone does not redeploy.
    notes: [
      'Setting an environment variable does not trigger a deploy on its own — a deploy ' +
        'must follow, or the service keeps running with the old configuration.',
    ],
  }
}

function planChangeStartCommand(fix: ProposedFix): FixPlan {
  const startCommand = fix.to
  if (startCommand === undefined) {
    throw new FixNotApplicableError(
      'change_start_command has no replacement command; this fix should have been escalated',
    )
  }

  return {
    fix,
    edits: [],
    platformAction: { kind: 'change_start_command', startCommand },
    diff: '',
    summary: `Change the service start command to: ${startCommand}`,
    notes: [],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdit(path: string, before: string, after: string): FileEdit {
  return { path, before, after, diff: unifiedDiff(before, after, { path }) }
}

function detectIndent(content: string): string {
  return /\n([ \t]+)"/.exec(content)?.[1] ?? '  '
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
