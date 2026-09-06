import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nullRunStore } from './db/store.js'
import type { HarborEvent } from './events.js'
import type { RunResult } from './loop.js'
import { RunRegistry } from './runs.js'

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: 'succeeded',
    issuesResolved: 0,
    incidents: [],
    budget: {
      turns: 1,
      elapsedMs: 1000,
      fixAttempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
    ...overrides,
  }
}

void describe('RunRegistry', () => {
  void it('registers a run as running and hands back its bus', () => {
    const registry = new RunRegistry()
    const { record, bus } = registry.start('run-1', 'https://github.com/a/b')

    assert.equal(record.status, 'running')
    assert.equal(bus.runId, 'run-1')
    assert.equal(registry.summary('run-1')?.status, 'running')
  })

  void it('refuses to reuse a run id', () => {
    const registry = new RunRegistry()
    registry.start('run-1', 'https://github.com/a/b')
    assert.throws(() => registry.start('run-1', 'https://github.com/a/b'), /already exists/)
  })

  void it('carries the outcome onto the summary', () => {
    const registry = new RunRegistry()
    registry.start('run-1', 'https://github.com/a/b')
    registry.finish('run-1', result({ serviceUrl: 'https://demo.onrender.com', issuesResolved: 2 }))

    const summary = registry.summary('run-1')
    assert.equal(summary?.status, 'succeeded')
    assert.equal(summary?.serviceUrl, 'https://demo.onrender.com')
    assert.equal(summary?.issuesResolved, 2)
    assert.ok(summary?.endedAt)
  })

  void it('surfaces the escalation reason so the UI can show why it stopped', () => {
    const registry = new RunRegistry()
    registry.start('run-1', 'https://github.com/a/b')
    registry.finish('run-1', result({ status: 'escalated', escalation: { reason: 'Needs a secret' } }))

    assert.equal(registry.summary('run-1')?.escalation, 'Needs a secret')
  })

  void it('records a crash as a failure rather than losing it', () => {
    const registry = new RunRegistry()
    registry.start('run-1', 'https://github.com/a/b')
    registry.fail('run-1', 'Clone failed')

    const summary = registry.summary('run-1')
    assert.equal(summary?.status, 'failed')
    assert.equal(summary?.escalation, 'Clone failed')
  })

  // The reconnect path: a client that saw up to seq N asks for what came after.
  void it('replays only the events after a given seq', () => {
    const registry = new RunRegistry()
    const { bus } = registry.start('run-1', 'https://github.com/a/b')

    bus.emit('run_started', 'one')
    bus.emit('reasoning', 'two')
    bus.emit('reasoning', 'three')

    assert.deepEqual(
      registry.since('run-1', 1).map((event) => event.message),
      ['two', 'three'],
    )
    assert.deepEqual(registry.since('run-1', 3), [])
    assert.equal(registry.summary('run-1')?.lastSeq, 3)
  })

  void it('returns nothing for a run it does not know', () => {
    const registry = new RunRegistry()
    assert.equal(registry.summary('nope'), undefined)
    assert.deepEqual(registry.since('nope'), [])
  })

  void it('lists newest first', async () => {
    const registry = new RunRegistry()
    registry.start('old', 'https://github.com/a/old')
    await new Promise((done) => setTimeout(done, 5))
    registry.start('new', 'https://github.com/a/new')

    assert.deepEqual(
      registry.list().map((run) => run.id),
      ['new', 'old'],
    )
  })

  // Evicting a running deployment would orphan the only view of it.
  void it('never evicts a run that is still going', () => {
    const registry = new RunRegistry({ limit: 2 })
    registry.start('a', 'https://github.com/a/a')
    registry.start('b', 'https://github.com/a/b')
    registry.finish('b', result())
    registry.start('c', 'https://github.com/a/c')

    assert.ok(registry.get('a'), 'the running run must survive')
    assert.ok(registry.get('c'))
    assert.equal(registry.get('b'), undefined, 'the finished run is the one evicted')
  })

  // The bug this guards: activity_events has a foreign key to deployments, and
  // firing both writes without ordering meant the first events of every run
  // were rejected by the constraint, logged, and swallowed. The history looked
  // complete until someone counted it.
  void it('writes the run row before any event that references it', async () => {
    const order: string[] = []
    const slowStore = {
      ...nullRunStore,
      saveRun: async () => {
        // A real INSERT is not instantaneous; without ordering the events win.
        await new Promise((done) => setTimeout(done, 10))
        order.push('run')
      },
      saveEvent: (_id: string, event: HarborEvent) => {
        order.push(`event-${String(event.seq)}`)
        return Promise.resolve()
      },
    }

    const registry = new RunRegistry({ store: slowStore })
    const { bus } = registry.start('run-1', 'https://github.com/a/b')
    bus.emit('run_started', 'one')
    bus.emit('step_started', 'two')

    await registry.flush('run-1')
    assert.deepEqual(order, ['run', 'event-1', 'event-2'])
  })

  void it('reports a store failure without failing the run', async () => {
    const registry = new RunRegistry({
      store: { ...nullRunStore, saveRun: () => Promise.reject(new Error('database is down')) },
    })

    const { bus } = registry.start('run-1', 'https://github.com/a/b')
    bus.emit('run_started', 'still fine')

    // The write rejected; the run is unaffected and flush resolves.
    await registry.flush('run-1')
    assert.equal(registry.summary('run-1')?.status, 'running')
  })

  void it('keeps everything when nothing has finished', () => {
    const registry = new RunRegistry({ limit: 1 })
    registry.start('a', 'https://github.com/a/a')
    registry.start('b', 'https://github.com/a/b')

    assert.equal(registry.size, 2, 'a cap must not silently drop live runs')
  })
})
