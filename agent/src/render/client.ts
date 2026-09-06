/**
 * Render API client.
 *
 * Three decisions here are load-bearing for the rest of Harbor:
 *
 *   1. **Retries are method-aware.** GETs retry on 5xx; creates do not. A 5xx
 *      on POST /v1/services can mean the service was created and the response
 *      was lost, so retrying it risks a duplicate paid resource. Only 429 is
 *      retried for writes, because a rate-limited request was rejected rather
 *      than processed.
 *   2. **Every call has a timeout.** An unattended agent that blocks forever on
 *      a hung socket is worse than one that fails: the run budget is measured
 *      in wall-clock time and a stuck request spends all of it.
 *   3. **The API key is registered for redaction on construction**, before any
 *      request can fail and put a header into an error message.
 */
import { registerSecret } from '../redact.js'
import type {
  CreatePostgresInput,
  CreateServiceResult,
  CreateWebServiceInput,
  Deploy,
  EnvVarInput,
  Paginated,
  PostgresConnectionInfo,
  PostgresInstance,
  Service,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.render.com/v1'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BACKOFF_MS = 500
/** Never wait longer than this between attempts, whatever Retry-After says. */
const MAX_BACKOFF_MS = 20_000

export class RenderApiError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  readonly body: string

  constructor(options: {
    status: number
    method: string
    path: string
    body: string
    message?: string
  }) {
    super(
      options.message ??
        `Render API ${options.method} ${options.path} failed with ${String(options.status)}: ${options.body}`,
    )
    this.name = 'RenderApiError'
    this.status = options.status
    this.method = options.method
    this.path = options.path
    this.body = options.body
  }
}

/** 401/403. Distinct because the fix is a human one, not a retry. */
export class RenderAuthError extends RenderApiError {
  constructor(options: { status: number; method: string; path: string; body: string }) {
    super({
      ...options,
      message:
        `Render rejected the API key on ${options.method} ${options.path} ` +
        `(${String(options.status)}). Check RENDER_API_KEY.`,
    })
    this.name = 'RenderAuthError'
  }
}

export class RenderNotFoundError extends RenderApiError {
  constructor(options: { method: string; path: string; body: string }) {
    super({ ...options, status: 404, message: `Render resource not found: ${options.path}` })
    this.name = 'RenderNotFoundError'
  }
}

export class RenderRateLimitError extends RenderApiError {
  readonly retryAfterMs: number | undefined

  constructor(options: { method: string; path: string; body: string; retryAfterMs?: number }) {
    super({ ...options, status: 429, message: `Render rate limit hit on ${options.path}` })
    this.name = 'RenderRateLimitError'
    this.retryAfterMs = options.retryAfterMs
  }
}

export class RenderTimeoutError extends Error {
  constructor(method: string, path: string, timeoutMs: number) {
    super(`Render API ${method} ${path} timed out after ${String(timeoutMs)}ms`)
    this.name = 'RenderTimeoutError'
  }
}

export interface RenderClientOptions {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  backoffBaseMs?: number
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  /** Injectable for deterministic backoff in tests. */
  randomImpl?: () => number
}

interface RequestOptions {
  method: string
  path: string
  body?: unknown
  query?: Record<string, string | number | undefined>
  /**
   * Override the default retry policy. Set for writes that are safe to repeat
   * — updating an env var to a fixed value is idempotent; creating a service
   * is not.
   */
  retryOnServerError?: boolean
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export class RenderClient {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #maxRetries: number
  readonly #backoffBaseMs: number
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #random: () => number

  constructor(options: RenderClientOptions) {
    if (!options.apiKey) throw new Error('RenderClient requires an API key')

    // Before anything can throw with a header in it.
    registerSecret(options.apiKey)

    this.#apiKey = options.apiKey
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.#backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_MS
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#sleep = options.sleepImpl ?? defaultSleep
    this.#random = options.randomImpl ?? Math.random
  }

  // -------------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------------

  async listServices(options: { name?: string; limit?: number } = {}): Promise<Service[]> {
    const raw = await this.#request<unknown>({
      method: 'GET',
      path: '/services',
      query: { name: options.name, limit: options.limit ?? 100 },
    })
    return unwrapList<Service>(raw, 'service')
  }

  async getService(serviceId: string): Promise<Service> {
    return this.#request<Service>({ method: 'GET', path: `/services/${encode(serviceId)}` })
  }

  /**
   * Create a web service.
   *
   * Never retried on a server error — see the note at the top of the file.
   * `findOrCreateWebService` is the safe entry point for an agent that may run
   * the same step twice.
   */
  async createWebService(input: CreateWebServiceInput): Promise<CreateServiceResult> {
    return this.#request<CreateServiceResult>({
      method: 'POST',
      path: '/services',
      retryOnServerError: false,
      body: {
        type: 'web_service',
        name: input.name,
        ownerId: input.ownerId,
        repo: input.repo,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        autoDeploy: input.autoDeploy ?? 'no',
        ...(input.envVars === undefined ? {} : { envVars: input.envVars }),
        serviceDetails: {
          env: input.runtime,
          runtime: input.runtime,
          plan: input.plan ?? 'free',
          region: input.region ?? 'oregon',
          ...(input.healthCheckPath === undefined
            ? {}
            : { healthCheckPath: input.healthCheckPath }),
          envSpecificDetails: {
            buildCommand: input.buildCommand,
            startCommand: input.startCommand,
          },
        },
      },
    })
  }

  /**
   * Create a service, or return the existing one with that name.
   *
   * Render service names are unique per workspace, which makes the name a
   * natural idempotency key. Without this, a retried run leaves a second paid
   * service behind and the operator finds it on a bill rather than in the UI.
   */
  async findOrCreateWebService(
    input: CreateWebServiceInput,
  ): Promise<{ service: Service; created: boolean; deployId?: string }> {
    const existing = await this.listServices({ name: input.name })
    const match = existing.find((service) => service.name === input.name)
    if (match) return { service: match, created: false }

    const result = await this.createWebService(input)
    return {
      service: result.service,
      created: true,
      ...(result.deployId === undefined ? {} : { deployId: result.deployId }),
    }
  }

  /**
   * Point an existing service at a different branch.
   *
   * Needed for self-healing: Harbor commits its fix to its own branch and must
   * never write to the default one, so after a fix the service has to be told
   * to build the branch the fix is actually on. Without this the redeploy
   * rebuilds the unfixed default branch, and the loop concludes its own repair
   * did not work.
   */
  async updateServiceBranch(serviceId: string, branch: string): Promise<Service> {
    return this.#request<Service>({
      method: 'PATCH',
      path: `/services/${encode(serviceId)}`,
      body: { branch },
      // Setting a field to a fixed value is idempotent.
      retryOnServerError: true,
    })
  }

  // -------------------------------------------------------------------------
  // Environment variables
  // -------------------------------------------------------------------------

  /**
   * Set one environment variable.
   *
   * Returns nothing on purpose. The value may be a database password, and a
   * method that echoes it back invites it into a log line or an event payload;
   * the write-only shape makes that impossible rather than discouraged.
   *
   * Two Render behaviours the caller has to know about:
   *   - the bulk `PUT /env-vars` endpoint REPLACES the entire list, deleting
   *     anything omitted, so this deliberately uses the single-key endpoint;
   *   - env var changes are NOT deployed automatically, regardless of
   *     autoDeploy. A deploy has to follow, or the service keeps running with
   *     the old configuration and every diagnosis of it is wrong.
   */
  async setEnvVar(serviceId: string, key: string, value: string): Promise<void> {
    registerSecret(value)
    await this.#request<unknown>({
      method: 'PUT',
      path: `/services/${encode(serviceId)}/env-vars/${encode(key)}`,
      body: { value },
      // Setting a key to a fixed value is idempotent, so a repeat is harmless.
      retryOnServerError: true,
    })
  }

  /** Keys only. Values are never read back into Harbor. */
  async listEnvVarKeys(serviceId: string): Promise<string[]> {
    const raw = await this.#request<unknown>({
      method: 'GET',
      path: `/services/${encode(serviceId)}/env-vars`,
    })
    return unwrapList<EnvVarInput>(raw, 'envVar')
      .map((entry) => entry.key)
      .filter((key) => typeof key === 'string')
  }

  // -------------------------------------------------------------------------
  // Deploys
  // -------------------------------------------------------------------------

  /**
   * Start a deploy, or adopt the one already running.
   *
   * Render answers `201` with the new deploy normally, but `202` with an empty
   * body when a deploy is already in flight: the request is accepted and no new
   * deploy is created. That is undocumented, and returning the empty response
   * would hand the caller `undefined` to poll — which is exactly how the first
   * live run failed. The in-flight deploy is what the caller actually needs, so
   * it is fetched and returned.
   */
  async triggerDeploy(serviceId: string, options: { clearCache?: boolean } = {}): Promise<Deploy> {
    const created = await this.#request<Deploy | undefined>({
      method: 'POST',
      path: `/services/${encode(serviceId)}/deploys`,
      retryOnServerError: false,
      body: options.clearCache === true ? { clearCache: 'clear' } : {},
    })

    if (created?.id !== undefined) return created

    const [latest] = await this.listDeploys(serviceId, { limit: 1 })
    if (latest?.id === undefined) {
      throw new RenderApiError({
        status: 202,
        method: 'POST',
        path: `/services/${serviceId}/deploys`,
        body: '',
        message:
          `Render accepted the deploy request for ${serviceId} without returning a deploy, ` +
          'and no existing deploy could be found to watch.',
      })
    }
    return latest
  }

  async getDeploy(serviceId: string, deployId: string): Promise<Deploy> {
    return this.#request<Deploy>({
      method: 'GET',
      path: `/services/${encode(serviceId)}/deploys/${encode(deployId)}`,
    })
  }

  async listDeploys(serviceId: string, options: { limit?: number } = {}): Promise<Deploy[]> {
    const raw = await this.#request<unknown>({
      method: 'GET',
      path: `/services/${encode(serviceId)}/deploys`,
      query: { limit: options.limit ?? 20 },
    })
    return unwrapList<Deploy>(raw, 'deploy')
  }

  // -------------------------------------------------------------------------
  // Postgres
  // -------------------------------------------------------------------------

  async createPostgres(input: CreatePostgresInput): Promise<PostgresInstance> {
    return this.#request<PostgresInstance>({
      method: 'POST',
      path: '/postgres',
      retryOnServerError: false,
      body: {
        name: input.name,
        ownerId: input.ownerId,
        plan: input.plan,
        version: input.version ?? '17',
        region: input.region ?? 'oregon',
        ...(input.databaseName === undefined ? {} : { databaseName: input.databaseName }),
        ...(input.databaseUser === undefined ? {} : { databaseUser: input.databaseUser }),
      },
    })
  }

  async getPostgres(postgresId: string): Promise<PostgresInstance> {
    return this.#request<PostgresInstance>({
      method: 'GET',
      path: `/postgres/${encode(postgresId)}`,
    })
  }

  /** Every field returned here is a credential; all of them are registered. */
  async getPostgresConnectionInfo(postgresId: string): Promise<PostgresConnectionInfo> {
    const info = await this.#request<PostgresConnectionInfo>({
      method: 'GET',
      path: `/postgres/${encode(postgresId)}/connection-info`,
    })

    for (const value of Object.values(info)) {
      if (typeof value === 'string') registerSecret(value)
    }
    return info
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async #request<T>(options: RequestOptions): Promise<T> {
    const url = this.#buildUrl(options.path, options.query)
    const isRead = options.method === 'GET' || options.method === 'HEAD'
    const retryOnServerError = options.retryOnServerError ?? isRead

    let lastError: unknown

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await this.#sleep(this.#backoffFor(attempt, lastError))

      let response: Response
      try {
        response = await this.#send(options, url)
      } catch (error) {
        lastError = error
        // A request that never got a response is safe to repeat regardless of
        // method: nothing was acknowledged.
        if (error instanceof RenderTimeoutError || isNetworkError(error)) continue
        throw error
      }

      if (response.ok) return (await parseJson<T>(response)) as T

      const body = await safeText(response)
      const error = toTypedError(options, response, body)

      // 429 means rejected, not processed — always safe to repeat.
      if (error instanceof RenderRateLimitError) {
        lastError = error
        continue
      }
      if (response.status >= 500 && retryOnServerError) {
        lastError = error
        continue
      }
      throw error
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Render API ${options.method} ${options.path} failed after retries`)
  }

  async #send(options: RequestOptions, url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.#timeoutMs)

    try {
      return await this.#fetch(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RenderTimeoutError(options.method, options.path, this.#timeoutMs)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Exponential backoff with jitter, and Retry-After when the server sent one.
   *
   * The jitter matters more than it looks: without it, several polls that hit
   * the same rate limit all wake at the same instant and hit it again together.
   */
  #backoffFor(attempt: number, lastError: unknown): number {
    if (lastError instanceof RenderRateLimitError && lastError.retryAfterMs !== undefined) {
      return Math.min(lastError.retryAfterMs, MAX_BACKOFF_MS)
    }

    const exponential = this.#backoffBaseMs * 2 ** (attempt - 1)
    const jitter = 1 + this.#random() * 0.25
    return Math.min(Math.round(exponential * jitter), MAX_BACKOFF_MS)
  }

  #buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.#baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    return url.toString()
  }
}

function toTypedError(options: RequestOptions, response: Response, body: string): RenderApiError {
  const shared = { method: options.method, path: options.path, body }

  if (response.status === 401 || response.status === 403) {
    return new RenderAuthError({ ...shared, status: response.status })
  }
  if (response.status === 404) return new RenderNotFoundError(shared)
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    return new RenderRateLimitError({
      ...shared,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
  }
  return new RenderApiError({ ...shared, status: response.status })
}

/** Retry-After is seconds or an HTTP date; both appear in the wild. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || header.trim() === '') return undefined

  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000

  const date = Date.parse(header)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

/**
 * Render returns collections as `[{ service: {...}, cursor }]` on some routes
 * and a bare array on others. Both shapes are unwrapped to a plain list so
 * callers never branch on it.
 */
function unwrapList<T>(raw: unknown, key: string): T[] {
  if (!Array.isArray(raw)) {
    if (raw !== null && typeof raw === 'object') {
      const items = (raw as Paginated<T>).items
      if (Array.isArray(items)) return items
    }
    return []
  }

  return raw.map((entry) => {
    if (entry !== null && typeof entry === 'object' && key in entry) {
      return (entry as Record<string, T>)[key] as T
    }
    return entry as T
  })
}

async function parseJson<T>(response: Response): Promise<T | undefined> {
  const text = await safeText(response)
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function isNetworkError(error: unknown): boolean {
  // fetch surfaces connection failures as TypeError.
  return error instanceof TypeError
}

function encode(segment: string): string {
  return encodeURIComponent(segment)
}
