/**
 * Find and remove resources a Harbor run left behind.
 *
 *   npm run cleanup                 # list what would go
 *   npm run cleanup -- --delete     # actually remove it
 *
 * Dry run by default, on purpose. A cleanup tool that deletes the moment it is
 * invoked is its own hazard, and the first thing anyone does with an unfamiliar
 * script is run it to see what it does.
 *
 * Two further limits: only names matching Harbor's own prefix are ever
 * considered, and everything else in the workspace is listed as untouched
 * rather than silently skipped — so an operator can see the tool looked at it
 * and chose not to act.
 */
import { RenderClient } from './render/client.js'
import type { PostgresInstance, Service } from './render/types.js'

/** Only resources named like this are eligible. Everything else is someone's. */
const HARBOR_PREFIX = /^harbor-demo-/

const apiKey = process.env.RENDER_API_KEY
const ownerId = process.env.RENDER_OWNER_ID
if (!apiKey || !ownerId) {
  console.error('RENDER_API_KEY and RENDER_OWNER_ID must be set. See agent/.env.example.')
  process.exit(1)
}

const shouldDelete = process.argv.includes('--delete')
const client = new RenderClient({ apiKey })

interface Removable {
  kind: 'service' | 'postgres'
  id: string
  name: string
}

const authHeaders = { authorization: `Bearer ${apiKey}`, accept: 'application/json' }

/**
 * Render exposes deletion, but the typed client deliberately does not: nothing
 * in the deploy loop should be able to destroy infrastructure. This script asks
 * for it directly, which keeps the capability out of the agent's reach.
 */
async function remove(entry: Removable): Promise<void> {
  const path = entry.kind === 'service' ? 'services' : 'postgres'
  const response = await fetch(`https://api.render.com/v1/${path}/${entry.id}`, {
    method: 'DELETE',
    headers: authHeaders,
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${path}/${entry.id} returned ${String(response.status)}`)
  }
}

async function listPostgres(): Promise<PostgresInstance[]> {
  const response = await fetch(
    `https://api.render.com/v1/postgres?limit=100&ownerId=${ownerId ?? ''}`,
    { headers: authHeaders },
  )
  if (!response.ok) return []

  const body: unknown = await response.json()
  if (!Array.isArray(body)) return []
  return body.map((row) => {
    const record = row as { postgres?: PostgresInstance }
    return record.postgres ?? (row as PostgresInstance)
  })
}

/**
 * Fix branches Harbor pushed.
 *
 * Run-scoped names are what let the writer refuse to force-push, and the cost
 * is that every run leaves a branch behind. Three verification runs produced
 * three; a demo week would produce dozens.
 *
 * Uses the GitHub API rather than the git CLI on purpose — the source-level
 * guardrail restricts process spawning to workspace.ts and writer.ts, and this
 * script has no business acquiring that.
 */
async function listFixBranches(repo: string): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN
  if (token === undefined) return []

  const response = await fetch(
    `https://api.github.com/repos/${repo}/git/matching-refs/heads/harbor/fix-`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'harbor-cleanup',
      },
    },
  )
  if (!response.ok) return []

  const body: unknown = await response.json()
  if (!Array.isArray(body)) return []
  return body
    .map((row) => (row as { ref?: string }).ref ?? '')
    .filter((ref) => ref.startsWith('refs/heads/harbor/fix-'))
    .map((ref) => ref.replace('refs/heads/', ''))
}

async function deleteBranch(repo: string, branch: string): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'harbor-cleanup',
    },
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${repo}#${branch} returned ${String(response.status)}`)
  }
}

/** Demo repositories Harbor commits to. Nothing else is ever considered. */
const DEMO_REPOS = (process.env.HARBOR_DEMO_REPOS ?? 'aarochu/harbor-demo-missing-dep')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '')

const services: Service[] = await client.listServices({ limit: 100 })
const databases = await listPostgres()

const branches: { repo: string; branch: string }[] = []
for (const repo of DEMO_REPOS) {
  for (const branch of await listFixBranches(repo)) branches.push({ repo, branch })
}

const eligible: Removable[] = [
  ...services
    .filter((service) => HARBOR_PREFIX.test(service.name))
    .map((service): Removable => ({ kind: 'service', id: service.id, name: service.name })),
  ...databases
    .filter((database) => HARBOR_PREFIX.test(database.name))
    .map((database): Removable => ({ kind: 'postgres', id: database.id, name: database.name })),
]

const untouched = [
  ...services.filter((service) => !HARBOR_PREFIX.test(service.name)).map((one) => one.name),
  ...databases.filter((database) => !HARBOR_PREFIX.test(database.name)).map((one) => one.name),
]

console.log(`[harbor] workspace ${ownerId}`)
console.log(
  `[harbor] ${String(services.length)} service(s), ${String(databases.length)} database(s)\n`,
)

if (untouched.length > 0) {
  console.log('Not Harbor-created, leaving alone:')
  for (const name of untouched) console.log(`  - ${name}`)
  console.log()
}

if (eligible.length === 0 && branches.length === 0) {
  console.log('Nothing to clean up.')
  process.exit(0)
}

console.log(shouldDelete ? 'Deleting:' : 'Would delete (pass --delete to do it):')
for (const entry of eligible) console.log(`  - ${entry.kind}  ${entry.name}  (${entry.id})`)
for (const entry of branches) console.log(`  - branch    ${entry.repo}  ${entry.branch}`)

if (!shouldDelete) {
  console.log('\nDry run. Nothing was changed.')
  process.exit(0)
}

const total = eligible.length + branches.length
let failures = 0

for (const entry of eligible) {
  try {
    await remove(entry)
    console.log(`  removed ${entry.name}`)
  } catch (error) {
    failures++
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  FAILED ${entry.name}: ${message}`)
  }
}

for (const entry of branches) {
  try {
    await deleteBranch(entry.repo, entry.branch)
    console.log(`  removed ${entry.repo}#${entry.branch}`)
  } catch (error) {
    failures++
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  FAILED ${entry.repo}#${entry.branch}: ${message}`)
  }
}

console.log(`\n[harbor] removed ${String(total - failures)} of ${String(total)}`)
process.exitCode = failures === 0 ? 0 : 1
