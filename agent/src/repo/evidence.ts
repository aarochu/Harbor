/**
 * Evidence helpers.
 *
 * Every detection Harbor makes has to be traceable to a file and a line. When
 * the agent later says "the app binds port 8000 instead of $PORT", the operator
 * needs to be able to check that claim in one click — and when a diagnosis is
 * wrong, the evidence is what makes it obvious that it is wrong.
 */
import type { Evidence } from './types.js'

/** Excerpts are for reading in a UI line, not for reconstructing the file. */
const MAX_EXCERPT = 160

/** 1-indexed line number containing byte offset `index`. */
export function lineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

export function makeEvidence(file: string, content: string, index: number): Evidence {
  const start = content.lastIndexOf('\n', index) + 1
  const end = content.indexOf('\n', index)
  const raw = content.slice(start, end === -1 ? content.length : end).trim()

  return {
    file,
    line: lineAt(content, index),
    excerpt: raw.length > MAX_EXCERPT ? `${raw.slice(0, MAX_EXCERPT)}…` : raw,
  }
}

/**
 * All matches of a global regex, as evidence.
 *
 * The regex is cloned so callers can pass a module-level constant without the
 * shared `lastIndex` of a /g regex leaking between calls — a bug that shows up
 * as detection working on the first repo and silently failing on the second.
 */
export function findAll(
  file: string,
  content: string,
  pattern: RegExp,
): { evidence: Evidence; match: RegExpExecArray }[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const regex = new RegExp(pattern.source, flags)
  const found: { evidence: Evidence; match: RegExpExecArray }[] = []

  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    found.push({ evidence: makeEvidence(file, content, match.index), match })
    // A zero-length match would spin here forever.
    if (match[0] === '') regex.lastIndex++
  }
  return found
}
