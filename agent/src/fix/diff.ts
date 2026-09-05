/**
 * Unified diff generation.
 *
 * SOW §4 requires the diff to be logged before a commit is made, so an operator
 * can see what Harbor changed rather than being told. That makes this a
 * reviewability feature, not a formatting nicety.
 *
 * The algorithm is deliberately simple: find the first and last differing
 * lines and emit one hunk spanning them with context either side. Harbor's
 * fixes are single-region edits — append a dependency, rewrite one bind line —
 * so a full LCS diff would buy nothing. A scattered edit still produces a
 * correct diff, just a wider hunk than a minimal one.
 */

const CONTEXT_LINES = 3

export interface DiffOptions {
  /** Path shown in the ---/+++ headers. */
  path: string
  contextLines?: number
}

/** A unified diff, or an empty string when the two sides are identical. */
export function unifiedDiff(before: string, after: string, options: DiffOptions): string {
  if (before === after) return ''

  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)

  const context = options.contextLines ?? CONTEXT_LINES
  const prefix = commonPrefix(beforeLines, afterLines)
  const suffix = commonSuffix(beforeLines, afterLines, prefix)

  const beforeEnd = beforeLines.length - suffix
  const afterEnd = afterLines.length - suffix

  const start = Math.max(0, prefix - context)
  const beforeStop = Math.min(beforeLines.length, beforeEnd + context)
  const afterStop = Math.min(afterLines.length, afterEnd + context)

  const lines: string[] = [`--- a/${options.path}`, `+++ b/${options.path}`]

  const beforeCount = beforeStop - start
  const afterCount = afterStop - start
  lines.push(
    `@@ -${String(start + 1)},${String(beforeCount)} ` +
      `+${String(start + 1)},${String(afterCount)} @@`,
  )

  for (let i = start; i < prefix; i++) lines.push(` ${beforeLines[i] ?? ''}`)
  for (let i = prefix; i < beforeEnd; i++) lines.push(`-${beforeLines[i] ?? ''}`)
  for (let i = prefix; i < afterEnd; i++) lines.push(`+${afterLines[i] ?? ''}`)
  for (let i = beforeEnd; i < beforeStop; i++) lines.push(` ${beforeLines[i] ?? ''}`)

  return `${lines.join('\n')}\n`
}

/**
 * Split without inventing a trailing empty line.
 *
 * "a\nb\n" is two lines, not three. Getting this wrong makes every diff on a
 * newline-terminated file report a spurious change at the end.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function commonPrefix(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length)
  let index = 0
  while (index < limit && before[index] === after[index]) index++
  return index
}

function commonSuffix(before: readonly string[], after: readonly string[], prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix
  let count = 0
  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count]) {
    count++
  }
  return count
}
