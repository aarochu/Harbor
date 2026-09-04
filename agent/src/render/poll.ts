/**
 * Wait for a deploy to reach a terminal state.
 *
 * The rule this enforces is SOW §8: a failed deployment is surfaced as a
 * failure, never silently passed. So the result distinguishes three outcomes
 * that are easy to collapse into one and must not be:
 *
 *   - `succeeded` — reached `live`.
 *   - `failed`    — reached a terminal state that is not `live`. There is a
 *                   diagnosis to make and logs to read.
 *   - `timed_out` — still building when the clock ran out. Harbor does NOT
 *                   know whether this deploy is broken, and saying otherwise
 *                   would send the fix loop after a build that was merely slow.
 *
 * Only the first is success. Treating a timeout as a failure would burn fix
 * budget on a healthy deploy; treating it as success would report a live URL
 * that does not exist yet.
 */
import type { EventBus } from '../events.js'
import type { Deploy, DeployStatus } from './types.js'
import { isTerminalDeploy } from './types.js'

export type DeployOutcome = 'succeeded' | 'failed' | 'timed_out'

export interface DeployWaitResult {
  outcome: DeployOutcome
  status: DeployStatus
  deploy: Deploy
  /** How long the wait took, not how long Render says the build took. */
  elapsedMs: number
  polls: number
}

export interface WaitForDeployOptions {
  /** Give up after this long. Render free-tier builds are slow; be generous. */
  timeoutMs?: number
  intervalMs?: number
  bus?: EventBus
  sleepImpl?: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_INTERVAL_MS = 5_000

/** Just enough of the client to poll, so tests need no HTTP stub. */
export interface DeployReader {
  getDeploy: (serviceId: string, deployId: string) => Promise<Deploy>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForDeploy(
  client: DeployReader,
  serviceId: string,
  deployId: string,
  options: WaitForDeployOptions = {},
): Promise<DeployWaitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const sleep = options.sleepImpl ?? defaultSleep
  const now = options.now ?? Date.now

  const startedAt = now()
  let polls = 0
  let lastStatus: DeployStatus | undefined

  for (;;) {
    const deploy = await client.getDeploy(serviceId, deployId)
    polls++

    // Only announce transitions. A 15-minute build polled every 5s would
    // otherwise push ~180 identical lines into the activity stream.
    if (deploy.status !== lastStatus) {
      options.bus?.emit('reasoning', `Deploy ${deployId} is ${deploy.status}`, {
        serviceId,
        deployId,
        status: deploy.status,
      })
      lastStatus = deploy.status
    }

    if (isTerminalDeploy(deploy.status)) {
      return {
        outcome: deploy.status === 'live' ? 'succeeded' : 'failed',
        status: deploy.status,
        deploy,
        elapsedMs: now() - startedAt,
        polls,
      }
    }

    // Check before sleeping, so a timeout is not overshot by a whole interval.
    if (now() - startedAt + intervalMs > timeoutMs) {
      return {
        outcome: 'timed_out',
        status: deploy.status,
        deploy,
        elapsedMs: now() - startedAt,
        polls,
      }
    }

    await sleep(intervalMs)
  }
}

/**
 * A one-line summary for the activity stream.
 *
 * Deliberately explicit that a timeout is an unknown rather than a failure —
 * the phrasing is what an operator reads before deciding whether to intervene.
 */
export function describeDeployResult(result: DeployWaitResult): string {
  const seconds = Math.round(result.elapsedMs / 1000)

  switch (result.outcome) {
    case 'succeeded':
      return `Deploy live after ${String(seconds)}s`
    case 'failed':
      return `Deploy failed (${result.status}) after ${String(seconds)}s`
    default:
      return (
        `Deploy still ${result.status} after ${String(seconds)}s — timed out waiting. ` +
        'This is not a diagnosis: the build may still be running.'
      )
  }
}
