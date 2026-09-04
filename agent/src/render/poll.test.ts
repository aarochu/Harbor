import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventBus } from '../events.js'
import { describeDeployResult, waitForDeploy } from './poll.js'
import type { DeployReader } from './poll.js'
import type { Deploy, DeployStatus } from './types.js'

/** Replays a fixed sequence of statuses, holding on the last one. */
function reader(statuses: DeployStatus[]): DeployReader & { calls: number } {
  let index = 0
  const impl = {
    calls: 0,
    getDeploy: (): Promise<Deploy> => {
      const status = statuses[Math.min(index++, statuses.length - 1)] ?? 'created'
      impl.calls++
      return Promise.resolve({ id: 'dep-1', status })
    },
  }
  return impl
}

/** A clock that advances only when the poller sleeps. */
function fakeClock(): { now: () => number; sleepImpl: (ms: number) => Promise<void> } {
  let current = 0
  return {
    now: () => current,
    sleepImpl: (ms: number) => {
      current += ms
      return Promise.resolve()
    },
  }
}

void describe('waitForDeploy', () => {
  void it('returns succeeded when the deploy goes live', async () => {
    const clock = fakeClock()
    const result = await waitForDeploy(
      reader(['created', 'build_in_progress', 'live']),
      'srv-1',
      'dep-1',
      { intervalMs: 1000, ...clock },
    )

    assert.equal(result.outcome, 'succeeded')
    assert.equal(result.status, 'live')
    assert.equal(result.polls, 3)
  })

  // The rule that keeps a broken deploy from being reported as a live URL.
  void it('reports every non-live terminal state as a failure', async () => {
    for (const status of [
      'build_failed',
      'update_failed',
      'pre_deploy_failed',
      'canceled',
      'deactivated',
    ] as const) {
      const clock = fakeClock()
      const result = await waitForDeploy(reader([status]), 'srv-1', 'dep-1', {
        intervalMs: 1000,
        ...clock,
      })

      assert.equal(result.outcome, 'failed', status)
      assert.equal(result.status, status)
    }
  })

  // A slow build and a broken build are different things, and the fix loop
  // must not be pointed at the first.
  void it('reports a still-building deploy as timed_out, not failed', async () => {
    const clock = fakeClock()
    const result = await waitForDeploy(reader(['build_in_progress']), 'srv-1', 'dep-1', {
      timeoutMs: 5000,
      intervalMs: 1000,
      ...clock,
    })

    assert.equal(result.outcome, 'timed_out')
    assert.equal(result.status, 'build_in_progress')
    assert.notEqual(result.outcome, 'failed')
  })

  void it('does not overshoot the timeout by a whole interval', async () => {
    const clock = fakeClock()
    const result = await waitForDeploy(reader(['queued']), 'srv-1', 'dep-1', {
      timeoutMs: 5000,
      intervalMs: 2000,
      ...clock,
    })

    assert.equal(result.outcome, 'timed_out')
    assert.ok(result.elapsedMs <= 5000, `elapsed ${String(result.elapsedMs)} exceeded the budget`)
  })

  void it('polls once and stops when the first read is already terminal', async () => {
    const clock = fakeClock()
    const source = reader(['live'])
    const result = await waitForDeploy(source, 'srv-1', 'dep-1', { intervalMs: 1000, ...clock })

    assert.equal(result.polls, 1)
    assert.equal(source.calls, 1)
  })

  void it('emits one event per status transition, not per poll', async () => {
    const bus = new EventBus('run-1')
    const clock = fakeClock()

    await waitForDeploy(
      reader(['queued', 'queued', 'queued', 'build_in_progress', 'build_in_progress', 'live']),
      'srv-1',
      'dep-1',
      { intervalMs: 1000, bus, ...clock },
    )

    const statuses = bus.history
      .filter((event) => event.type === 'reasoning')
      .map((event) => event.detail?.status)

    assert.deepEqual(statuses, ['queued', 'build_in_progress', 'live'])
  })
})

void describe('describeDeployResult', () => {
  void it('says a timeout is not a diagnosis', () => {
    const text = describeDeployResult({
      outcome: 'timed_out',
      status: 'build_in_progress',
      deploy: { id: 'dep-1', status: 'build_in_progress' },
      elapsedMs: 900_000,
      polls: 180,
    })

    assert.match(text, /not a diagnosis/)
    assert.match(text, /may still be running/)
  })

  void it('names the terminal status on a failure', () => {
    const text = describeDeployResult({
      outcome: 'failed',
      status: 'build_failed',
      deploy: { id: 'dep-1', status: 'build_failed' },
      elapsedMs: 42_000,
      polls: 9,
    })

    assert.match(text, /build_failed/)
    assert.match(text, /42s/)
  })

  void it('is unambiguous on success', () => {
    const text = describeDeployResult({
      outcome: 'succeeded',
      status: 'live',
      deploy: { id: 'dep-1', status: 'live' },
      elapsedMs: 61_000,
      polls: 13,
    })

    assert.match(text, /live/)
  })
})
