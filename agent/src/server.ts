/**
 * The observation server.
 *
 *   npm run serve
 *
 * The UI reads from here and cannot do anything else. There is one write
 * endpoint — start a run — and everything else is a read. No route pauses,
 * steers, approves, or cancels an agent, because SOW §4 puts that boundary in
 * the architecture rather than in a convention someone can forget.
 *
 * Events are served over SSE with their `seq` as the SSE id, so a dropped
 * connection resumes from exactly where it stopped instead of replaying a run
 * from the beginning or silently losing the middle of it.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HarborEvent } from './events.js'
import { MissingCredentialsError, createLiveRun } from './live.js'
import { runDeployment } from './loop.js'
import { RunRegistry } from './runs.js'

const PORT = Number(process.env.HARBOR_PORT ?? 4000)
const registry = new RunRegistry()

/** Dev-only. The server binds loopback and holds no cookies or sessions. */
const CORS = {
  'access-control-allow-origin': process.env.HARBOR_CORS_ORIGIN ?? 'http://localhost:3000',
  'access-control-allow-headers': 'content-type,last-event-id',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    bytes += buffer.length
    // A start request is a URL. Anything larger is not one.
    if (bytes > 8 * 1024) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Start a run in the background and record how it ends.
 *
 * The HTTP response returns as soon as the run is registered; a deployment
 * takes minutes, and holding the request open would make the UI's first
 * interaction look like a hang.
 */
function startRun(repoUrl: string, allowDatabase: boolean): string {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const { bus } = registry.start(runId, repoUrl)

  const live = createLiveRun({
    bus,
    runId,
    allowDatabase,
    onApproval: (request, approved) => {
      if (!approved) {
        bus.emit('escalated', `Approval required: ${request.detail}`, { action: request.action })
      }
    },
  })

  void (async () => {
    try {
      const result = await runDeployment({ repoUrl, ownerId: live.ownerId }, live.deps)
      registry.finish(runId, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bus.emit('run_failed', message)
      registry.fail(runId, message)
    } finally {
      await live.session.dispose()
    }
  })()

  return runId
}

/**
 * Stream a run's events.
 *
 * Backlog first, then live. Subscribing before the replay would interleave new
 * events into the middle of the history; replaying without subscribing first
 * would drop anything emitted during the replay. Subscribe, buffer, flush.
 */
function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  after: number,
): void {
  const bus = registry.bus(runId)
  if (bus === undefined) {
    json(res, 404, { error: `No run ${runId}` })
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...CORS,
  })

  const send = (event: HarborEvent): void => {
    res.write(`id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  let live = false
  const pending: HarborEvent[] = []

  const unsubscribe = bus.subscribe((event) => {
    if (live) send(event)
    else pending.push(event)
  })

  for (const event of bus.since(after)) send(event)
  for (const event of pending) if (event.seq > after) send(event)
  live = true

  // Comment frames keep intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)

  const close = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  req.on('close', close)
  res.on('close', close)
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }

    try {
      if (req.method === 'POST' && path === '/api/runs') {
        const body = await readBody(req)
        const repoUrl = (body as { repoUrl?: unknown }).repoUrl
        if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
          json(res, 400, { error: 'repoUrl is required' })
          return
        }
        const allowDatabase = (body as { allowDatabase?: unknown }).allowDatabase === true
        json(res, 202, { id: startRun(repoUrl.trim(), allowDatabase) })
        return
      }

      if (req.method === 'GET' && path === '/api/runs') {
        json(res, 200, { runs: registry.list() })
        return
      }

      const events = /^\/api\/runs\/([\w-]+)\/events$/.exec(path)
      if (req.method === 'GET' && events?.[1] !== undefined) {
        const header = req.headers['last-event-id']
        const after = Number(url.searchParams.get('after') ?? header ?? 0)
        streamEvents(req, res, events[1], Number.isFinite(after) ? after : 0)
        return
      }

      const one = /^\/api\/runs\/([\w-]+)$/.exec(path)
      if (req.method === 'GET' && one?.[1] !== undefined) {
        const summary = registry.summary(one[1])
        if (summary === undefined) {
          json(res, 404, { error: `No run ${one[1]}` })
          return
        }
        json(res, 200, summary)
        return
      }

      json(res, 404, { error: 'Not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      json(res, error instanceof MissingCredentialsError ? 503 : 500, { error: message })
    }
  })()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[harbor] observing on http://127.0.0.1:${String(PORT)}`)
})
