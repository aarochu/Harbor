import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkHealth } from './health.js'

/** A fetch stub that plays a fixed script of responses or errors. */
function scriptedFetch(script: (number | Error)[]): typeof fetch {
  let call = 0
  const impl = (): Promise<Response> => {
    const next = script[Math.min(call++, script.length - 1)]
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(new Response(null, { status: next }))
  }
  return impl
}

const noSleep = async (): Promise<void> => {}

void describe('checkHealth', () => {
  void it('reports healthy on a fast 200', async () => {
    const result = await checkHealth('https://example.test', {
      fetchImpl: scriptedFetch([200]),
      sleepImpl: noSleep,
    })

    assert.equal(result.status, 'healthy')
    assert.equal(result.httpStatus, 200)
    assert.equal(result.attempts, 1)
    assert.equal(result.coldStart, false)
  })

  // The demo-critical case: a sleeping free-tier service is not a broken one.
  void it('treats a slow eventual success as healthy, flagged as a cold start', async () => {
    const refused = new Error('ECONNREFUSED')
    const result = await checkHealth('https://example.test', {
      fetchImpl: scriptedFetch([refused, refused, 200]),
      sleepImpl: noSleep,
      coldStartThresholdMs: -1, // force the cold-start branch deterministically
    })

    assert.equal(result.status, 'healthy')
    assert.equal(result.attempts, 3)
    assert.equal(result.coldStart, true)
    assert.match(result.detail, /cold start/i)
  })

  void it('does not misreport a waking service as unreachable', async () => {
    const result = await checkHealth('https://example.test', {
      fetchImpl: scriptedFetch([new Error('ECONNREFUSED'), 200]),
      sleepImpl: noSleep,
    })
    assert.notEqual(result.status, 'unreachable')
  })

  void it('reports a 5xx as unhealthy immediately, without retrying', async () => {
    let calls = 0
    const impl = (): Promise<Response> => {
      calls++
      return Promise.resolve(new Response(null, { status: 500 }))
    }
    const fetchImpl = impl

    const result = await checkHealth('https://example.test', {
      fetchImpl,
      sleepImpl: noSleep,
    })

    assert.equal(result.status, 'unhealthy')
    assert.equal(result.httpStatus, 500)
    assert.equal(calls, 1, 'a 5xx is a real defect; retrying wastes budget')
    assert.equal(result.coldStart, false)
  })

  void it('reports unreachable when nothing ever answers', async () => {
    const result = await checkHealth('https://example.test', {
      fetchImpl: scriptedFetch([new Error('ECONNREFUSED')]),
      sleepImpl: noSleep,
      totalTimeoutMs: 50,
      retryDelayMs: 10,
    })

    assert.equal(result.status, 'unreachable')
    assert.ok(result.attempts >= 1)
    assert.match(result.detail, /Connection failed/)
  })

  void it('treats a 404 as not acceptable by default', async () => {
    const result = await checkHealth('https://example.test', {
      fetchImpl: scriptedFetch([404]),
      sleepImpl: noSleep,
      totalTimeoutMs: 50,
      retryDelayMs: 10,
    })
    assert.equal(result.status, 'unreachable')
  })

  void it('honours a custom accept predicate', async () => {
    const result = await checkHealth('https://example.test', {
      fetchImpl: scriptedFetch([404]),
      sleepImpl: noSleep,
      accept: (status) => status === 404,
    })
    assert.equal(result.status, 'healthy')
  })
})
