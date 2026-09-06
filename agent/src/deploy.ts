/**
 * Harbor, wired to the real world.
 *
 *   npm run deploy -- https://github.com/owner/repo
 *   npm run deploy -- https://github.com/owner/repo --approve-database
 *
 * This is the same `runDeployment` the tests drive; only the dependencies
 * differ. That is the point of the injection seams — if this run behaves
 * differently from the stubbed one, the difference is in Render or GitHub, not
 * in Harbor's reasoning.
 *
 * The activity stream is printed as it happens, because until the mission
 * control UI exists the terminal is the operator's only view of the run.
 */
import { RunBudget } from './budget.js'
import { EventBus } from './events.js'
import { runDeployment } from './loop.js'
import type { LoopDeps } from './loop.js'
import { RepoSession } from './repo/tools.js'
import { GitWriter, fixBranchFor } from './repo/writer.js'
import { RenderClient } from './render/client.js'

const args = process.argv.slice(2)
const repoUrl = args.find((arg) => !arg.startsWith('--'))
const approveDatabase = args.includes('--approve-database')

if (repoUrl === undefined) {
  console.error('usage: npm run deploy -- <github-url> [--approve-database]')
  process.exit(1)
}

const renderApiKey = process.env.RENDER_API_KEY
const ownerId = process.env.RENDER_OWNER_ID
if (!renderApiKey || !ownerId) {
  console.error('RENDER_API_KEY and RENDER_OWNER_ID must be set. See agent/.env.example.')
  process.exit(1)
}

const runId = Date.now().toString(36)
const bus = new EventBus(runId)

const ICON: Record<string, string> = {
  run_started: '>',
  plan_created: '=',
  step_started: '.',
  step_succeeded: 'ok',
  step_failed: 'XX',
  reasoning: '..',
  incident_opened: '!!',
  fix_applied: '~~',
  escalated: '^^',
  run_succeeded: 'ok',
  run_failed: 'XX',
  budget_warning: '$$',
}

bus.subscribe((event) => {
  const icon = (ICON[event.type] ?? '  ').padStart(2)
  const took =
    event.durationMs === undefined
      ? ''
      : ` (${String(Math.round(event.durationMs / 100) / 10)}s)`
  console.log(`  ${icon} ${event.message}${took}`)

  // The diff is the whole point of a fix event: it is what makes the change
  // auditable rather than merely announced.
  const diff = event.detail?.diff
  if (event.type === 'fix_applied' && typeof diff === 'string') {
    for (const line of diff.split('\n')) {
      if (line !== '') console.log(`       ${line}`)
    }
  }
})

const githubToken = process.env.GITHUB_TOKEN
const session = new RepoSession(githubToken === undefined ? {} : { token: githubToken })

const deps: LoopDeps = {
  target: new RenderClient({ apiKey: renderApiKey }),
  repo: session,
  writer: new GitWriter({
    workdir: () => session.workdir,
    ...(githubToken === undefined ? {} : { token: githubToken }),
  }),
  bus,
  budget: new RunBudget({ bus }),
  fixBranch: fixBranchFor(runId),
  // Provisioning a database costs money, so it takes an explicit flag rather
  // than a default. Silence is a refusal.
  approve: (request) => {
    if (request.action === 'configure_database' && approveDatabase) {
      console.log(`  ok approved: ${request.detail}`)
      return Promise.resolve(true)
    }
    console.log(`  ^^ refused (pass --approve-database to allow): ${request.detail}`)
    return Promise.resolve(false)
  },
}

console.log(`[harbor] run ${runId} - ${repoUrl}`)
console.log(`[harbor] fixes commit to ${fixBranchFor(runId)}\n`)

try {
  const result = await runDeployment({ repoUrl, ownerId }, deps)

  console.log(`\n[harbor] ${result.status.toUpperCase()}`)
  if (result.serviceUrl !== undefined) console.log(`[harbor] url: ${result.serviceUrl}`)

  if (result.issuesResolved > 0) {
    console.log(`[harbor] automatically resolved ${String(result.issuesResolved)} issue(s):`)
    for (const incident of result.incidents) {
      console.log(`  ${String(incident.attempt)}. ${incident.failureClass} - ${incident.outcome}`)
      if (incident.fixApplied !== undefined) console.log(`     ${incident.fixApplied}`)
    }
  }
  if (result.escalation !== undefined) {
    console.log(`[harbor] escalated: ${result.escalation.reason}`)
  }

  const spend = result.budget
  console.log(
    `[harbor] budget: ${String(spend.turns)} turns, ` +
      `${String(Math.round(spend.elapsedMs / 1000))}s, ` +
      `${String(spend.fixAttempts)} fix attempts, ` +
      `$${spend.estimatedCostUsd.toFixed(4)}`,
  )

  process.exitCode = result.status === 'succeeded' ? 0 : 1
} catch (error) {
  console.error(`[harbor] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await session.dispose()
}
