import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RunBudget } from './budget.js'
import { EventBus } from './events.js'
import type { HealthResult } from './health.js'
import { deriveServiceName, runDeployment } from './loop.js'
import type { Advisor, DeployTarget, LoopDeps, RepoSource, RepoWriter } from './loop.js'
import type { RepoFiles } from './repo/workspace.js'
import { loadRepoFiles } from './repo/workspace.js'
import type { Deploy, DeployStatus, Service } from './render/types.js'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')

const SERVICE_URL = 'https://harbor-demo.onrender.com'

/**
 * A Render stand-in.
 *
 * `deployStatuses` is consumed one entry per deploy, so a test can script
 * "first deploy fails, second goes live" and watch the loop heal in between.
 */
function fakeTarget(options: { deployStatuses?: DeployStatus[] } = {}): DeployTarget & {
  deploys: number
  envVars: Map<string, string>
} {
  const statuses = options.deployStatuses ?? ['live']
  const service: Service = {
    id: 'srv-1',
    name: 'demo',
    type: 'web_service',
    serviceDetails: { url: SERVICE_URL },
  }

  const target = {
    deploys: 0,
    envVars: new Map<string, string>(),

    findOrCreateWebService: () => Promise.resolve({ service, created: true, deployId: 'dep-0' }),
    getService: () => Promise.resolve(service),
    setEnvVar: (_id: string, key: string, value: string) => {
      target.envVars.set(key, value)
      return Promise.resolve()
    },
    triggerDeploy: (): Promise<Deploy> => {
      target.deploys++
      return Promise.resolve({ id: `dep-${String(target.deploys)}`, status: 'created' })
    },
    getDeploy: (_serviceId: string, deployId: string): Promise<Deploy> => {
      const index = Math.min(target.deploys - 1, statuses.length - 1)
      return Promise.resolve({ id: deployId, status: statuses[index] ?? 'live' })
    },
    createPostgres: () => Promise.resolve({ id: 'dpg-1', name: 'demo-db' }),
    getPostgresConnectionInfo: () =>
      Promise.resolve({ internalConnectionString: 'postgres://u:pw@internal/db' }),
  }

  return target
}

async function fakeRepo(fixture: string): Promise<RepoSource> {
  const loaded = await loadRepoFiles(join(FIXTURES, fixture))
  let opened = false

  return {
    // Mirrors RepoSession, where `files` is a getter that throws before a
    // clone. A stub that just exposes a plain property is more permissive than
    // the real thing, and hid a bug where the loop read files on its first
    // line — which failed instantly against a live repository.
    get files(): RepoFiles {
      if (!opened) throw new Error('No repository has been cloned yet')
      return loaded
    },
    open: () => {
      opened = true
      return Promise.resolve({ branch: 'main', commit: 'abc1234' })
    },
  }
}

function fakeWriter(): RepoWriter & { commits: { branch: string; message: string }[] } {
  const commits: { branch: string; message: string }[] = []
  return {
    commits,
    commitFix: (input) => {
      commits.push({ branch: input.branch, message: input.message })
      return Promise.resolve({ commit: 'def5678' })
    },
  }
}

/** Health results scripted per call, holding on the last. */
function fakeHealth(sequence: HealthResult['status'][]): LoopDeps['checkHealthImpl'] {
  let calls = 0
  return () => {
    const status = sequence[Math.min(calls, sequence.length - 1)] ?? 'healthy'
    calls++
    return Promise.resolve({
      status,
      latencyMs: 120,
      attempts: 1,
      coldStart: false,
      detail: status === 'healthy' ? 'ok' : 'Connection failed: ECONNREFUSED',
    })
  }
}

const noSleep = (): Promise<void> => Promise.resolve()
const approveAll = (): Promise<boolean> => Promise.resolve(true)

async function baseDeps(fixture: string, overrides: Partial<LoopDeps> = {}): Promise<LoopDeps> {
  return {
    target: fakeTarget(),
    repo: await fakeRepo(fixture),
    writer: fakeWriter(),
    bus: new EventBus('run-test'),
    sleepImpl: noSleep,
    approve: approveAll,
    ...overrides,
  }
}

void describe('runDeployment — happy path', () => {
  void it('deploys a clean repo to a healthy URL with no incidents', async () => {
    const deps = await baseDeps('harbor-demo-clean', { checkHealthImpl: fakeHealth(['healthy']) })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-clean', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'succeeded')
    assert.equal(result.serviceUrl, SERVICE_URL)
    assert.equal(result.issuesResolved, 0)
    assert.deepEqual(result.incidents, [])
  })

  void it('provisions the database and wires the connection string', async () => {
    const target = fakeTarget()
    const deps = await baseDeps('harbor-demo-clean', {
      target,
      checkHealthImpl: fakeHealth(['healthy']),
    })

    await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-clean', ownerId: 'own-1' },
      deps,
    )

    assert.equal(target.envVars.get('DATABASE_URL'), 'postgres://u:pw@internal/db')
  })

  // A run must never claim success on a build alone.
  void it('emits run_succeeded only after the health check passes', async () => {
    const bus = new EventBus('run-test')
    const deps = await baseDeps('harbor-demo-clean', {
      bus,
      checkHealthImpl: fakeHealth(['healthy']),
    })

    await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-clean', ownerId: 'own-1' },
      deps,
    )

    const types = bus.history.map((event) => event.type)
    const healthStep = bus.history.findIndex((event) => event.message === 'Health check')
    assert.ok(healthStep >= 0, 'a health check must have run')
    assert.ok(types.indexOf('run_succeeded') > healthStep)
  })
})

void describe('runDeployment — approval gate', () => {
  // Provisioning a database costs money, so silence is a refusal.
  void it('escalates rather than provisioning a database without approval', async () => {
    const deps = await baseDeps('harbor-demo-clean', {
      approve: () => Promise.resolve(false),
      checkHealthImpl: fakeHealth(['healthy']),
    })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-clean', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'escalated')
    assert.match(result.escalation?.reason ?? '', /paid action and needs approval/)
  })

  void it('treats a missing approver as a refusal', async () => {
    const deps = await baseDeps('harbor-demo-clean', {
      checkHealthImpl: fakeHealth(['healthy']),
    })
    delete deps.approve

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-clean', ownerId: 'own-1' },
      deps,
    )
    assert.equal(result.status, 'escalated')
  })
})

void describe('runDeployment — self-healing', () => {
  // The demo, end to end, with no network and no model: a green build whose
  // health check fails, diagnosed as a port mismatch, fixed, redeployed, live.
  void it('heals a port mismatch and reports the issue it resolved', async () => {
    const target = fakeTarget()
    const deps = await baseDeps('harbor-demo-port-mismatch', {
      target,
      // Unreachable first, then healthy once the fix has been applied.
      checkHealthImpl: fakeHealth(['unreachable', 'healthy']),
    })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-port-mismatch', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'succeeded')
    assert.equal(result.issuesResolved, 1)
    assert.equal(result.incidents.length, 1)
    assert.equal(result.incidents[0]?.failureClass, 'port_mismatch')
    assert.equal(result.incidents[0]?.outcome, 'resolved')
    assert.equal(target.deploys, 2, 'the fix must be followed by a redeploy')
  })

  void it('commits to a Harbor branch, never the default one', async () => {
    const writer = fakeWriter()
    const deps = await baseDeps('harbor-demo-port-mismatch', {
      writer,
      checkHealthImpl: fakeHealth(['unreachable', 'healthy']),
    })

    await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-port-mismatch', ownerId: 'own-1' },
      deps,
    )

    assert.equal(writer.commits.length, 1)
    assert.notEqual(writer.commits[0]?.branch, 'main')
    assert.match(writer.commits[0]?.message ?? '', /^harbor: /)
  })

  // The operator has to be able to check the change, not just be told about it.
  void it('publishes the diff on the fix_applied event', async () => {
    const bus = new EventBus('run-test')
    const deps = await baseDeps('harbor-demo-port-mismatch', {
      bus,
      checkHealthImpl: fakeHealth(['unreachable', 'healthy']),
    })

    await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-port-mismatch', ownerId: 'own-1' },
      deps,
    )

    const applied = bus.history.find((event) => event.type === 'fix_applied')
    assert.ok(applied)
    const diff = applied.detail?.diff
    assert.equal(typeof diff, 'string')
    assert.match(diff as string, /os\.environ\.get\("PORT"/)
  })
})

void describe('runDeployment — stopping conditions', () => {
  // Without this the loop would fix, fail, fix, fail, until the credits are gone.
  void it('stops when the fix budget is exhausted', async () => {
    const deps = await baseDeps('harbor-demo-port-mismatch', {
      // Never becomes healthy, so every attempt fails.
      checkHealthImpl: fakeHealth(['unreachable']),
      budget: new RunBudget({ limits: { maxFixAttempts: 0 } }),
    })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-port-mismatch', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'escalated')
    assert.match(result.escalation?.reason ?? '', /budget exhausted \(fix_budget\)/)
    assert.equal(result.budget.fixAttempts, 0)
  })

  // A slow build and a broken build are different things.
  void it('escalates on an indeterminate deploy instead of diagnosing it', async () => {
    const target = fakeTarget({ deployStatuses: ['build_in_progress'] })
    const deps = await baseDeps('harbor-demo-clean', {
      target,
      checkHealthImpl: fakeHealth(['healthy']),
      // A real (tiny) sleep, so wall-clock time actually advances and the wait
      // can expire rather than spinning forever on a never-terminal status.
      sleepImpl: (ms: number) => new Promise((done) => setTimeout(done, Math.min(ms, 2))),
      deployWaitMs: 40,
      deployPollMs: 10,
    })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-clean', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'escalated')
    assert.deepEqual(result.incidents, [], 'no incident should be opened for an unknown state')
  })

  void it('refuses a repository whose framework it cannot identify', async () => {
    const repo: RepoSource = {
      files: new Map([['README.md', '# just a readme']]),
      open: () => Promise.resolve({ branch: 'main', commit: 'abc1234' }),
    }
    const deps = await baseDeps('harbor-demo-clean', { repo })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/mystery', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'escalated')
    assert.match(result.escalation?.reason ?? '', /could not identify the framework/)
  })
})

void describe('runDeployment — the advisor seam', () => {
  // Where the model plugs in. It can veto a fix the rules would have applied.
  void it('lets the advisor escalate a fix the rules would have accepted', async () => {
    const advisor: Advisor = {
      reviewDiagnosis: () =>
        Promise.resolve({ action: 'escalate', rationale: 'Not confident enough to touch this.' }),
    }
    const writer = fakeWriter()

    const deps = await baseDeps('harbor-demo-port-mismatch', {
      advisor,
      writer,
      checkHealthImpl: fakeHealth(['unreachable', 'healthy']),
    })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-port-mismatch', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'escalated')
    assert.equal(result.escalation?.reason, 'Not confident enough to touch this.')
    assert.deepEqual(writer.commits, [], 'a vetoed fix must not be committed')
    assert.equal(result.incidents[0]?.outcome, 'escalated')
  })

  // An advisor may be cautious, but it cannot widen what Harbor is willing to
  // do: planFix independently refuses anything flagged requiresHuman.
  void it('cannot talk Harbor into applying a human-only fix', async () => {
    const advisor: Advisor = {
      reviewDiagnosis: () => Promise.resolve({ action: 'apply', rationale: 'Do it anyway.' }),
    }
    const repo: RepoSource = {
      files: new Map([
        ['requirements.txt', 'fastapi\nuvicorn\n'],
        ['main.py', 'import os\nfrom fastapi import FastAPI\n\napp = FastAPI()\n'],
      ]),
      open: () => Promise.resolve({ branch: 'main', commit: 'abc1234' }),
    }
    const writer = fakeWriter()

    const deps = await baseDeps('harbor-demo-clean', {
      advisor,
      repo,
      writer,
      // A crash naming a secret: the fix is flagged requiresHuman.
      checkHealthImpl: () =>
        Promise.resolve({
          status: 'unhealthy',
          httpStatus: 500,
          latencyMs: 40,
          attempts: 1,
          coldStart: false,
          detail: 'Error: Missing required environment variable: STRIPE_API_KEY',
        }),
    })

    const result = await runDeployment(
      { repoUrl: 'https://github.com/aarochu/harbor-demo-clean', ownerId: 'own-1' },
      deps,
    )

    assert.equal(result.status, 'escalated')
    assert.deepEqual(writer.commits, [], 'no secret may be invented and committed')
  })
})

void describe('deriveServiceName', () => {
  void it('turns a repo URL into a Render-safe name', () => {
    assert.equal(deriveServiceName('https://github.com/aarochu/Harbor.git'), 'harbor')
    assert.equal(deriveServiceName('https://github.com/a/My_App'), 'my-app')
  })

  void it('never returns an empty name', () => {
    assert.equal(deriveServiceName('https://github.com/a/___'), 'harbor-app')
  })
})
