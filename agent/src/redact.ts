/**
 * Secret redaction.
 *
 * Harbor reads build logs, runtime logs, and provider responses, then feeds
 * them to a model and persists them for the UI. Any of those paths can leak a
 * credential, so redaction runs at the boundary: before persistence, before
 * model context, and before the activity stream.
 *
 * Two layers, because each catches what the other misses:
 *   1. Registered values — secrets Harbor itself set (env vars it wrote).
 *      Exact, no false negatives, but only covers what we know about.
 *   2. Shape patterns — credentials that appear in logs from elsewhere.
 *      Catches the unknown, at the cost of occasional over-redaction.
 *
 * Over-redaction is the correct failure mode here.
 */

export const REDACTED = '[REDACTED]'

/** Values Harbor knows are secret. Never serialized, never logged. */
const known = new Set<string>()

/**
 * Register a value as secret so it is masked wherever it later appears.
 * Short values are ignored — masking every occurrence of "8080" would
 * shred the logs Harbor needs to read.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) known.add(value)
}

/** Drop all registered secrets. Used between runs and in tests. */
export function clearSecrets(): void {
  known.clear()
}

/**
 * Mask every secret found in `text`.
 *
 * Safe on any input: non-strings are coerced, so a caller cannot accidentally
 * bypass redaction by passing an object.
 */
export function redactSecrets(text: unknown): string {
  let out =
    typeof text === 'string' ? text : (JSON.stringify(text) ?? String(text))

  // Longest first, so a secret containing another secret masks completely.
  for (const secret of [...known].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED)
  }

  // Named sensitive assignments: KEY=value, "token": "value".
  out = out.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[:=]\s*"?)([^\s"',}]+)/gi,
    `$1$2${REDACTED}`,
  )

  // Authorization headers.
  out = out.replace(
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
    `Bearer ${REDACTED}`,
  )

  // Provider keys with recognizable prefixes.
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
  out = out.replace(/\brnd_[A-Za-z0-9]{16,}/g, REDACTED)
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED)
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED)

  // Connection strings: keep scheme and host, drop the credentials.
  out = out.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@]+@/gi,
    `$1${REDACTED}@`,
  )

  return out
}

/** Redact every string in a structure, preserving its shape for the UI. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) out[key] = redactDeep(inner)
    return out as T
  }
  return value
}
