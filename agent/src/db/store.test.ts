import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventBus } from '../events.js'
import type { RunRecord } from '../runs.js'
import { PostgresRunStore, nullRunStore } from './store.js'

const DATABASE_URL = process.env.DATABASE_URL

/**
 * These run against the real database, because the whole value of this layer is
 * whether the SQL matches the schema — and a mocked pg client would assert only
 * that the strings I wrote are the strings I wrote.
 *
 * Skipped rather than failed when no DATABASE_URL is set, so the suite still
 * passes on a machine with no Postgres.
 */
void describe('PostgresRunStore', { skip: DATABASE_URL === undefined }, () => {
  const store = new PostgresRunStore(DATABASE_URL ?? '')

  const record = (id: string): RunRecord => ({
    id,
    repoUrl: 'https://github.com/aarochu/harbor-demo-missing-dep',
    status: 'running',
    startedAt: new Date().toISOString(),
  })

  const uniqueId = (): string =>
    `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  void it('round-trips a run and its outcome', async () => {
    const id = uniqueId()
    const run = record(id)
    await store.saveRun(run)

    run.status = 'succeeded'
    run.endedAt = new Date().toISOString()
    run.result = {
      status: 'succeeded',
      issuesResolved: 1,
      incidents: [],
      serviceUrl: 'https://demo.onrender.com',
      budget: {
        turns: 2,
        elapsedMs: 94000,
        fixAttempts: 1,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
    }
    await store.updateRun(run)

    const found = (await store.listRuns(200)).find((entry) => entry.id === id)
    assert.ok(found, 'the run should come back from the database')
    assert.equal(found.status, 'succeeded')
    assert.equal(found.issuesResolved, 1)
    assert.equal(found.serviceUrl, 'https://demo.onrender.com')
  })

  void it('keeps the escalation reason, which has no column of its own', async () => {
    const id = uniqueId()
    const run = record(id)
    await store.saveRun(run)

    run.status = 'escalated'
    run.endedAt = new Date().toISOString()
    run.result = {
      status: 'escalated',
      issuesResolved: 0,
      incidents: [],
      escalation: { reason: 'Needs a secret Harbor will not invent' },
      budget: {
        turns: 1,
        elapsedMs: 1000,
        fixAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
    }
    await store.updateRun(run)

    const found = (await store.listRuns(200)).find((entry) => entry.id === id)
    assert.equal(found?.escalation, 'Needs a secret Harbor will not invent')
  })

  void it('stores events in order with their detail intact', async () => {
    const id = uniqueId()
    await store.saveRun(record(id))

    const bus = new EventBus(id)
    const first = bus.emit('run_started', 'Deploying')
    const second = bus.emit('fix_applied', 'Add "httpx"', { diff: '+httpx\n' }, 42)

    await store.saveEvent(id, first)
    await store.saveEvent(id, second)

    const events = await store.loadEvents(id)
    assert.equal(events.length, 2)
    assert.equal(events[0]?.type, 'run_started')
    assert.equal(events[1]?.durationMs, 42)
    assert.equal(events[1]?.detail?.diff, '+httpx\n')
  })

  // The reconnect path re-sends the backlog, so the same rows arrive twice.
  void it('ignores a repeated event rather than duplicating it', async () => {
    const id = uniqueId()
    await store.saveRun(record(id))

    const bus = new EventBus(id)
    const event = bus.emit('run_started', 'Deploying')

    await store.saveEvent(id, event)
    await store.saveEvent(id, event)

    assert.equal((await store.loadEvents(id)).length, 1)
  })

  void it('reports lastSeq so a client knows where the history ends', async () => {
    const id = uniqueId()
    await store.saveRun(record(id))

    const bus = new EventBus(id)
    for (const message of ['one', 'two', 'three']) {
      await store.saveEvent(id, bus.emit('reasoning', message))
    }

    const found = (await store.listRuns(200)).find((entry) => entry.id === id)
    assert.equal(found?.lastSeq, 3)
  })

  void it('returns nothing for a run it never saw', async () => {
    assert.deepEqual(await store.loadEvents('no-such-run'), [])
  })

  // Otherwise every run of the suite leaves rows behind, and they show up in
  // the operator's history list looking like real deployments. Only the
  // "test-" prefix this suite generates is removed; real run ids have none.
  void it('cleans up after itself', async () => {
    const { Client } = await import('pg')
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    try {
      await client.query("DELETE FROM deployments WHERE id LIKE 'test-%'")
      const { rows } = await client.query<{ remaining: number }>(
        "SELECT count(*)::int AS remaining FROM deployments WHERE id LIKE 'test-%'",
      )
      assert.equal(rows[0]?.remaining, 0)
    } finally {
      await client.end()
    }
  })

  void it('closes its pool', async () => {
    await store.close()
  })
})

void describe('nullRunStore', () => {
  // Harbor has to work with no database at all; it simply forgets.
  void it('accepts every write and returns nothing', async () => {
    await nullRunStore.saveRun({
      id: 'x',
      repoUrl: 'https://github.com/a/b',
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    assert.deepEqual(await nullRunStore.listRuns(), [])
    assert.deepEqual(await nullRunStore.loadEvents('x'), [])
  })
})
