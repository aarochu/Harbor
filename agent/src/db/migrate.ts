/**
 * Schema migration runner.
 *
 * schema.sql is written to be idempotent, so migrating is "apply it again".
 * That keeps the path from an empty database to a working one a single command,
 * which is what a hackathon build needs — and it is repeatable from scratch
 * (docs/TODO.md M0).
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { redactSecrets, registerSecret } from '../redact.js'

const here = dirname(fileURLToPath(import.meta.url))

export interface MigrateResult {
  tables: string[]
}

export async function migrate(connectionString: string): Promise<MigrateResult> {
  // The connection string carries a password; make sure it can never surface
  // in an error message or log line from here on.
  registerSecret(connectionString)

  const sql = await readFile(join(here, 'schema.sql'), 'utf8')
  const client = new Client({ connectionString })

  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')

    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`,
    )
    return { tables: rows.map((row) => row.table_name) }
  } catch (error) {
    await client.query('ROLLBACK')
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Migration failed: ${redactSecrets(message)}`, {
      cause: error,
    })
  } finally {
    await client.end()
  }
}

/** True when this module was run directly, rather than imported. */
function isCliEntry(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return import.meta.url.endsWith(argv1.replace(/\\/g, '/').split('/').pop() ?? '')
}

if (isCliEntry()) {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set. See agent/.env.example.')
    process.exit(1)
  }

  try {
    const result = await migrate(connectionString)
    console.log(`[harbor] migrated. tables: ${result.tables.join(', ')}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[harbor] ${message}`)
    process.exit(1)
  }
}
