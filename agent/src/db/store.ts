/**
 * Persisting a run.
 *
 * Until now a restart lost every run, which is survivable for a CLI and not for
 * a console someone leaves open. The tables already existed; this is the layer
 * that writes to them.
 *
 * Two properties matter:
 *
 *   - **Writes never fail a run.** A deployment that succeeded but could not be
 *     recorded is still a deployment that succeeded. Persistence errors are
 *     reported and swallowed by the caller rather than thrown into the loop.
 *   - **Events are idempotent on (deployment_id, seq).** A replayed backlog
 *     re-inserts the same rows, and the unique constraint plus
 *     ON CONFLICT DO NOTHING makes that a no-op instead of a duplicate.
 */
import { Pool } from 'pg'
import type { HarborEvent } from '../events.js'
import { redactSecrets, registerSecret } from '../redact.js'
import type { RunRecord, RunStatus, RunSummary } from '../runs.js'

export interface RunStore {
  saveRun: (record: RunRecord) => Promise<void>
  updateRun: (record: RunRecord) => Promise<void>
  saveEvent: (deploymentId: string, event: HarborEvent) => Promise<void>
  listRuns: (limit?: number) => Promise<RunSummary[]>
  loadEvents: (deploymentId: string) => Promise<HarborEvent[]>
  close: () => Promise<void>
}

interface DeploymentRow {
  id: string
  repo_url: string
  branch: string
  status: string
  service_url: string | null
  issues_resolved: number
  started_at: Date
  ended_at: Date | null
  budget: { escalation?: string } | null
  last_seq: number | null
}

interface EventRow {
  seq: number
  event_type: string
  message: string
  detail: Record<string, unknown> | null
  duration_ms: number | null
  at: Date
}

export class PostgresRunStore implements RunStore {
  readonly #pool: Pool

  constructor(connectionString: string) {
    // Before a connection error can put the password into a stack trace.
    registerSecret(connectionString)
    this.#pool = new Pool({ connectionString, max: 4 })

    // An idle client dropped by the server must not take the process with it.
    this.#pool.on('error', (error: Error) => {
      console.error(`[harbor] database pool: ${redactSecrets(error.message)}`)
    })
  }

  async saveRun(record: RunRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO deployments (id, repo_url, branch, status, started_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [record.id, record.repoUrl, 'main', record.status, record.startedAt],
    )
  }

  async updateRun(record: RunRecord): Promise<void> {
    // The escalation reason has no column of its own; it rides in the budget
    // snapshot, which is already the jsonb bag for "how this run ended".
    const budget =
      record.result === undefined
        ? null
        : {
            ...record.result.budget,
            ...(record.result.escalation === undefined
              ? {}
              : { escalation: record.result.escalation.reason }),
          }

    await this.#pool.query(
      `UPDATE deployments
          SET status = $2,
              service_url = $3,
              issues_resolved = $4,
              budget = $5,
              ended_at = $6
        WHERE id = $1`,
      [
        record.id,
        record.status,
        record.result?.serviceUrl ?? null,
        record.result?.issuesResolved ?? 0,
        budget === null ? null : JSON.stringify(budget),
        record.endedAt ?? null,
      ],
    )
  }

  async saveEvent(deploymentId: string, event: HarborEvent): Promise<void> {
    await this.#pool.query(
      `INSERT INTO activity_events
         (deployment_id, seq, event_type, message, detail, duration_ms, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (deployment_id, seq) DO NOTHING`,
      [
        deploymentId,
        event.seq,
        event.type,
        event.message,
        event.detail === undefined ? null : JSON.stringify(event.detail),
        event.durationMs ?? null,
        event.at,
      ],
    )
  }

  async listRuns(limit = 50): Promise<RunSummary[]> {
    const { rows } = await this.#pool.query<DeploymentRow>(
      `SELECT d.*, (SELECT MAX(seq) FROM activity_events e WHERE e.deployment_id = d.id) AS last_seq
         FROM deployments d
        ORDER BY d.started_at DESC
        LIMIT $1`,
      [limit],
    )
    return rows.map(toSummary)
  }

  async loadEvents(deploymentId: string): Promise<HarborEvent[]> {
    const { rows } = await this.#pool.query<EventRow>(
      `SELECT seq, event_type, message, detail, duration_ms, at
         FROM activity_events
        WHERE deployment_id = $1
        ORDER BY seq ASC`,
      [deploymentId],
    )

    return rows.map((row) => ({
      seq: row.seq,
      at: row.at.toISOString(),
      runId: deploymentId,
      type: row.event_type as HarborEvent['type'],
      message: row.message,
      ...(row.detail === null ? {} : { detail: row.detail }),
      ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    }))
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}

function toSummary(row: DeploymentRow): RunSummary {
  const escalation = row.budget?.escalation

  return {
    id: row.id,
    repoUrl: row.repo_url,
    status: row.status as RunStatus,
    startedAt: row.started_at.toISOString(),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
    ...(row.service_url === null ? {} : { serviceUrl: row.service_url }),
    issuesResolved: row.issues_resolved,
    ...(escalation === undefined ? {} : { escalation }),
    lastSeq: row.last_seq ?? 0,
  }
}

/**
 * A store that drops everything.
 *
 * Lets the registry and server run without a database rather than branching on
 * `store === undefined` at every call site. Harbor is usable with no Postgres;
 * it just forgets.
 */
export const nullRunStore: RunStore = {
  saveRun: () => Promise.resolve(),
  updateRun: () => Promise.resolve(),
  saveEvent: () => Promise.resolve(),
  listRuns: () => Promise.resolve([]),
  loadEvents: () => Promise.resolve([]),
  close: () => Promise.resolve(),
}
