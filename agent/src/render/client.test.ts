import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clearSecrets, redactSecrets } from '../redact.js'
import {
  RenderApiError,
  RenderAuthError,
  RenderClient,
  RenderNotFoundError,
  RenderRateLimitError,
  RenderTimeoutError,
  parseRetryAfter,
} from './client.js'
import { TERMINAL_DEPLOY_STATUSES, isTerminalDeploy } from './types.js'

interface Call {
  url: string
  method: string
  headers: Headers
  body: string | undefined
}

interface Scripted {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

/** A fetch stub that plays a fixed script and records what it was sent. */
function scriptedFetch(script: (Scripted | Error)[]): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  let index = 0

  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })

    const next = script[Math.min(index++, script.length - 1)]
    if (next instanceof Error) return Promise.reject(next)
    if (next === undefined) return Promise.reject(new Error('script exhausted'))

    return Promise.resolve(
      new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        ...(next.headers === undefined ? {} : { headers: next.headers }),
      }),
    )
  }

  return { fetchImpl, calls }
}

const noSleep = (): Promise<void> => Promise.resolve()

function makeClient(script: (Scripted | Error)[]): {
  client: RenderClient
  calls: Call[]
  sleeps: number[]
} {
  const { fetchImpl, calls } = scriptedFetch(script)
  const sleeps: number[] = []

  const client = new RenderClient({
    apiKey: 'rnd_testkey_abcdefghijklmnop',
    fetchImpl,
    sleepImpl: (ms) => {
      sleeps.push(ms)
      return noSleep()
    },
    randomImpl: () => 0,
    backoffBaseMs: 100,
  })

  return { client, calls, sleeps }
}

void describe('RenderClient transport', () => {
  void it('sends a bearer token and parses the response', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { id: 'srv-1', name: 'demo' } }])
    const service = await client.getService('srv-1')

    assert.equal(service.id, 'srv-1')
    assert.equal(calls[0]?.headers.get('authorization'), 'Bearer rnd_testkey_abcdefghijklmnop')
    assert.match(calls[0]?.url ?? '', /\/v1\/services\/srv-1$/)
  })

  void it('registers the API key for redaction before any request can fail', () => {
    clearSecrets()
    const key = 'rnd_supersecretvalue123'
    new RenderClient({ apiKey: key, fetchImpl: scriptedFetch([]).fetchImpl })

    assert.ok(!redactSecrets(`Authorization: Bearer ${key}`).includes(key))
  })

  void it('requires an API key rather than sending an empty bearer', () => {
    assert.throws(() => new RenderClient({ apiKey: '' }), /requires an API key/)
  })

  void it('url-encodes path segments', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }])
    await client.setEnvVar('srv-1', 'WEIRD/KEY', 'value')

    assert.match(calls[0]?.url ?? '', /env-vars\/WEIRD%2FKEY$/)
  })
})

void describe('RenderClient error typing', () => {
  void it('maps 401 to an auth error that names the offending variable', async () => {
    const { client } = makeClient([{ status: 401, body: { message: 'nope' } }])
    await assert.rejects(
      () => client.getService('srv-1'),
      (error: unknown) => {
        assert.ok(error instanceof RenderAuthError)
        assert.match(error.message, /RENDER_API_KEY/)
        return true
      },
    )
  })

  void it('maps 404 to a not-found error', async () => {
    const { client } = makeClient([{ status: 404, body: {} }])
    await assert.rejects(() => client.getService('missing'), RenderNotFoundError)
  })

  void it('keeps the status and body on a generic failure', async () => {
    const { client } = makeClient([{ status: 400, body: { message: 'bad plan' } }])
    await assert.rejects(
      () => client.getService('srv-1'),
      (error: unknown) => {
        assert.ok(error instanceof RenderApiError)
        assert.equal(error.status, 400)
        assert.match(error.body, /bad plan/)
        return true
      },
    )
  })

  void it('does not retry a 4xx', async () => {
    const { client, calls } = makeClient([{ status: 400, body: {} }])
    await assert.rejects(() => client.getService('srv-1'))
    assert.equal(calls.length, 1, 'a bad request will not become good on retry')
  })

  void it('times out rather than hanging forever', async () => {
    const hang = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })

    const client = new RenderClient({
      apiKey: 'rnd_key_aaaaaaaaaaaa',
      fetchImpl: hang,
      sleepImpl: noSleep,
      timeoutMs: 5,
      maxRetries: 0,
    })

    await assert.rejects(() => client.getService('srv-1'), RenderTimeoutError)
  })
})

void describe('RenderClient retry policy', () => {
  void it('retries a GET through a 500 and returns the eventual success', async () => {
    const { client, calls } = makeClient([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { id: 'srv-1', name: 'demo' } },
    ])

    const service = await client.getService('srv-1')
    assert.equal(service.id, 'srv-1')
    assert.equal(calls.length, 3)
  })

  // The expensive mistake: a 500 on create may mean the service exists and the
  // response was lost. Retrying bills a second one.
  void it('never retries a create on a server error', async () => {
    const { client, calls } = makeClient([{ status: 500, body: {} }])

    await assert.rejects(() =>
      client.createWebService({
        name: 'demo',
        ownerId: 'own-1',
        repo: 'https://github.com/owner/repo',
        runtime: 'python',
        buildCommand: 'pip install -r requirements.txt',
        startCommand: 'uvicorn main:app --host 0.0.0.0 --port $PORT',
      }),
    )

    assert.equal(calls.length, 1, 'a duplicate paid service is worse than a failed run')
  })

  void it('does retry a create on 429, which was rejected rather than processed', async () => {
    const { client, calls } = makeClient([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 201, body: { service: { id: 'srv-1', name: 'demo' }, deployId: 'dep-1' } },
    ])

    const result = await client.createWebService({
      name: 'demo',
      ownerId: 'own-1',
      repo: 'https://github.com/owner/repo',
      runtime: 'python',
      buildCommand: 'pip install -r requirements.txt',
      startCommand: 'uvicorn main:app --host 0.0.0.0 --port $PORT',
    })

    assert.equal(result.deployId, 'dep-1')
    assert.equal(calls.length, 2)
  })

  void it('honours Retry-After instead of its own backoff', async () => {
    const { client, sleeps } = makeClient([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: { id: 'srv-1' } },
    ])

    await client.getService('srv-1')
    assert.deepEqual(sleeps, [2000])
  })

  void it('backs off exponentially when the server gives no hint', async () => {
    const { client, sleeps } = makeClient([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 200, body: { id: 'srv-1' } },
    ])

    await client.getService('srv-1')
    // randomImpl returns 0, so jitter contributes nothing and the shape is exact.
    assert.deepEqual(sleeps, [100, 200, 400])
  })

  void it('retries a request that never got a response, whatever the method', async () => {
    const { client, calls } = makeClient([
      new TypeError('fetch failed'),
      { status: 201, body: { service: { id: 'srv-1', name: 'demo' } } },
    ])

    const result = await client.createWebService({
      name: 'demo',
      ownerId: 'own-1',
      repo: 'https://github.com/owner/repo',
      runtime: 'node',
      buildCommand: 'npm install',
      startCommand: 'npm run start',
    })

    assert.equal(result.service.id, 'srv-1')
    assert.equal(calls.length, 2)
  })

  void it('gives up after maxRetries and surfaces the last error', async () => {
    const { client, calls } = makeClient([{ status: 503 }])
    await assert.rejects(() => client.getService('srv-1'), RenderApiError)
    assert.equal(calls.length, 4, '1 attempt + 3 retries')
  })
})

void describe('RenderClient service creation', () => {
  void it('disables autoDeploy so Harbor owns when a build happens', async () => {
    const { client, calls } = makeClient([
      { status: 201, body: { service: { id: 'srv-1', name: 'demo' } } },
    ])

    await client.createWebService({
      name: 'demo',
      ownerId: 'own-1',
      repo: 'https://github.com/owner/repo',
      runtime: 'python',
      buildCommand: 'pip install -r requirements.txt',
      startCommand: 'uvicorn main:app --host 0.0.0.0 --port $PORT',
    })

    const parsed = JSON.parse(calls[0]?.body ?? '{}') as {
      autoDeploy: string
      serviceDetails: { plan: string; envSpecificDetails: { startCommand: string } }
    }

    assert.equal(parsed.autoDeploy, 'no')
    assert.equal(parsed.serviceDetails.plan, 'free')
    assert.match(parsed.serviceDetails.envSpecificDetails.startCommand, /\$PORT/)
  })

  void it('reuses an existing service rather than creating a duplicate', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: [{ service: { id: 'srv-existing', name: 'demo' } }] },
    ])

    const result = await client.findOrCreateWebService({
      name: 'demo',
      ownerId: 'own-1',
      repo: 'https://github.com/owner/repo',
      runtime: 'node',
      buildCommand: 'npm install',
      startCommand: 'npm run start',
    })

    assert.equal(result.created, false)
    assert.equal(result.service.id, 'srv-existing')
    assert.equal(calls.length, 1, 'no POST should follow a match')
  })

  void it('creates when no service by that name exists', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: [] },
      { status: 201, body: { service: { id: 'srv-new', name: 'demo' }, deployId: 'dep-1' } },
    ])

    const result = await client.findOrCreateWebService({
      name: 'demo',
      ownerId: 'own-1',
      repo: 'https://github.com/owner/repo',
      runtime: 'node',
      buildCommand: 'npm install',
      startCommand: 'npm run start',
    })

    assert.equal(result.created, true)
    assert.equal(result.deployId, 'dep-1')
    assert.equal(calls[1]?.method, 'POST')
  })

  void it('unwraps both the wrapped and bare list shapes', async () => {
    const wrapped = makeClient([{ status: 200, body: [{ service: { id: 'a', name: 'a' } }] }])
    assert.equal((await wrapped.client.listServices())[0]?.id, 'a')

    const bare = makeClient([{ status: 200, body: [{ id: 'b', name: 'b' }] }])
    assert.equal((await bare.client.listServices())[0]?.id, 'b')
  })
})

void describe('RenderClient secret handling', () => {
  void it('writes an env var without returning its value', async () => {
    clearSecrets()
    const { client, calls } = makeClient([{ status: 200, body: {} }])

    const result = await client.setEnvVar('srv-1', 'DATABASE_URL', 'postgres://u:pw@host/db')

    assert.equal(result, undefined, 'a write-only method cannot leak what it wrote')
    assert.equal(calls[0]?.method, 'PUT')
    // Registered on the way out, so any later log line is already masked.
    assert.ok(!redactSecrets('using postgres://u:pw@host/db').includes('pw@host'))
  })

  void it('uses the single-key endpoint, which cannot delete other variables', async () => {
    const { client, calls } = makeClient([{ status: 200, body: {} }])
    await client.setEnvVar('srv-1', 'LOG_LEVEL', 'debug')

    assert.match(calls[0]?.url ?? '', /\/env-vars\/LOG_LEVEL$/)
  })

  void it('returns env var keys only, never values', async () => {
    const { client } = makeClient([
      { status: 200, body: [{ envVar: { key: 'DATABASE_URL', value: 'postgres://secret' } }] },
    ])

    const keys = await client.listEnvVarKeys('srv-1')
    assert.deepEqual(keys, ['DATABASE_URL'])
  })

  void it('registers every field of a database connection info response', async () => {
    clearSecrets()
    const { client } = makeClient([
      {
        status: 200,
        body: {
          internalConnectionString: 'postgres://user:internalpw@internal/db',
          externalConnectionString: 'postgres://user:externalpw@external/db',
        },
      },
    ])

    await client.getPostgresConnectionInfo('dpg-1')

    assert.ok(!redactSecrets('postgres://user:internalpw@internal/db').includes('internalpw'))
    assert.ok(!redactSecrets('postgres://user:externalpw@external/db').includes('externalpw'))
  })
})

void describe('deploy status', () => {
  void it('treats only live as success', () => {
    assert.ok(isTerminalDeploy('live'))
    assert.ok(TERMINAL_DEPLOY_STATUSES.includes('build_failed'))
  })

  void it('keeps every in-progress state non-terminal so polling continues', () => {
    for (const status of [
      'created',
      'queued',
      'build_in_progress',
      'update_in_progress',
      'pre_deploy_in_progress',
    ] as const) {
      assert.equal(isTerminalDeploy(status), false, status)
    }
  })
})

void describe('parseRetryAfter', () => {
  void it('reads a seconds value', () => {
    assert.equal(parseRetryAfter('5'), 5000)
  })

  void it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const parsed = parseRetryAfter(future) ?? 0
    assert.ok(parsed > 8000 && parsed <= 10_000, `got ${String(parsed)}`)
  })

  void it('returns undefined for junk rather than a NaN delay', () => {
    assert.equal(parseRetryAfter(null), undefined)
    assert.equal(parseRetryAfter(''), undefined)
    assert.equal(parseRetryAfter('soon'), undefined)
  })

  void it('never returns a negative delay for a past date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    assert.equal(parseRetryAfter(past), 0)
  })
})

void describe('RenderRateLimitError', () => {
  void it('carries the parsed retry delay for the backoff to use', async () => {
    const { client } = makeClient([{ status: 429, headers: { 'retry-after': '3' } }])

    await assert.rejects(
      () => client.getService('srv-1'),
      (error: unknown) => {
        assert.ok(error instanceof RenderRateLimitError)
        assert.equal(error.retryAfterMs, 3000)
        return true
      },
    )
  })
})
