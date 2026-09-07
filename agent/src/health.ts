/**
 * Cold-start-tolerant health probe.
 *
 * Free-tier hosts sleep a service after ~15 minutes idle, so the first request
 * after a deploy can take tens of seconds. A naive probe reads that as a
 * failure, and Harbor then "diagnoses" a bug that does not exist — spending fix
 * budget and credits on a phantom, in front of an audience.
 *
 * So the probe separates three outcomes rather than two:
 *   healthy      responded acceptably (possibly slowly)
 *   unhealthy    responded, but with a failing status — a real defect
 *   unreachable  never responded within the total budget
 *
 * A slow-but-eventually-2xx service is HEALTHY, flagged coldStart, not failed.
 */

export type HealthStatus = 'healthy' | 'unhealthy' | 'unreachable'

export interface HealthResult {
  status: HealthStatus
  /** HTTP status of the final attempt, when one was received. */
  httpStatus?: number
  /** Time to the successful response, or total time spent failing. */
  latencyMs: number
  attempts: number
  /** True when the service took long enough that it was likely asleep. */
  coldStart: boolean
  detail: string
}

export interface HealthOptions {
  /** Per-attempt timeout. Generous: a waking container is not a broken one. */
  attemptTimeoutMs?: number
  /** Total budget across all attempts. */
  totalTimeoutMs?: number
  /** Delay between attempts. */
  retryDelayMs?: number
  /** Above this, the response is treated as a cold start. */
  coldStartThresholdMs?: number
  /** Predicate for an acceptable response. Default: any non-5xx, non-404. */
  accept?: (status: number) => boolean
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

const DEFAULTS = {
  attemptTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  retryDelayMs: 3_000,
  coldStartThresholdMs: 5_000,
} as const

const defaultAccept = (status: number): boolean => status < 500 && status !== 404

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function checkHealth(
  url: string,
  options: HealthOptions = {},
): Promise<HealthResult> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULTS.attemptTimeoutMs
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs
  const retryDelayMs = options.retryDelayMs ?? DEFAULTS.retryDelayMs
  const coldStartThresholdMs =
    options.coldStartThresholdMs ?? DEFAULTS.coldStartThresholdMs
  const accept = options.accept ?? defaultAccept
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleepImpl ?? defaultSleep

  const startedAt = Date.now()
  let attempts = 0
  let lastDetail = 'no attempt completed'
  let lastStatus: number | undefined

  while (Date.now() - startedAt < totalTimeoutMs) {
    attempts++
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, attemptTimeoutMs)

    try {
      const response = await doFetch(url, {
        signal: controller.signal,
        redirect: 'follow',
      })
      const elapsed = Date.now() - startedAt
      lastStatus = response.status

      if (accept(response.status)) {
        const cold = elapsed > coldStartThresholdMs
        return {
          status: 'healthy',
          httpStatus: response.status,
          latencyMs: elapsed,
          attempts,
          coldStart: cold,
          detail: cold
            ? `Responded ${String(response.status)} after ${String(elapsed)}ms — slow first response, consistent with a cold start`
            : `Responded ${String(response.status)} in ${String(elapsed)}ms`,
        }
      }

      // A 5xx is the service answering that it is broken. That is a real
      // defect, not a cold start, and retrying will not change it.
      if (response.status >= 500) {
        return {
          status: 'unhealthy',
          httpStatus: response.status,
          latencyMs: elapsed,
          attempts,
          coldStart: false,
          detail: `Service responded ${String(response.status)} — application error, not a cold start`,
        }
      }

      lastDetail = `Responded ${String(response.status)}, not acceptable`
    } catch (error) {
      // Connection refused / aborted: the container may still be waking.
      lastDetail =
        error instanceof Error && error.name === 'AbortError'
          ? `Attempt timed out after ${String(attemptTimeoutMs)}ms`
          : `Connection failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      clearTimeout(timer)
    }

    if (Date.now() - startedAt + retryDelayMs >= totalTimeoutMs) break
    await sleep(retryDelayMs)
  }

  const elapsed = Date.now() - startedAt

  // A server that answered is reachable, whatever it answered with. Reporting
  // a 404 as `unreachable` claims nothing is listening, which is false, and it
  // sent the fix loop after a service answering perfectly well on a different
  // path — on that reading Harbor "repaired" a healthy deployment. The
  // distinction the caller needs is "nothing is there" versus "something is
  // there and it is not what we asked for".
  return {
    status: lastStatus === undefined ? 'unreachable' : 'unhealthy',
    ...(lastStatus === undefined ? {} : { httpStatus: lastStatus }),
    latencyMs: elapsed,
    attempts,
    coldStart: false,
    detail:
      lastStatus === undefined
        ? `Nothing answered within ${String(totalTimeoutMs)}ms across ${String(attempts)} attempt(s). Last: ${lastDetail}`
        : `Service answered ${String(lastStatus)} but never acceptably, across ${String(attempts)} attempt(s) in ${String(totalTimeoutMs)}ms. Last: ${lastDetail}`,
  }
}
