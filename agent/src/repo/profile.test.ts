import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildProfileFromFiles, findFastApiApp } from './profile.js'
import { RepoSession, createRepoTools, toModelProfile } from './tools.js'
import type { RepoProfile } from './types.js'
import { loadRepoFiles } from './workspace.js'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

/**
 * Profile a demo repo the way a run would: walk it off disk, then detect.
 *
 * These are the three repos the demo depends on, so this is the test that says
 * the pitch is true — Harbor is handed a URL and works the rest out itself.
 */
async function profileFixture(name: string): Promise<RepoProfile> {
  const workdir = join(FIXTURES, name)
  const files = await loadRepoFiles(workdir)
  return buildProfileFromFiles(files, {
    repoUrl: `https://github.com/aarochu/${name}`,
    branch: 'main',
    workdir,
  })
}

void describe('harbor-demo-clean', () => {
  void it('profiles as a deployable FastAPI + Postgres service with zero hints', async () => {
    const profile = await profileFixture('harbor-demo-clean')

    assert.equal(profile.detection.framework, 'fastapi')
    assert.equal(profile.detection.runtime, 'python')
    assert.equal(profile.python?.packageManager, 'pip')

    assert.equal(profile.port.bindsEnvPort, true)
    assert.equal(profile.port.source, 'env_with_fallback')

    assert.equal(profile.database.required, true)
    assert.deepEqual(profile.database.kinds, ['postgres'])
    assert.equal(profile.database.connectionVar, 'DATABASE_URL')

    assert.equal(profile.suggestedBuildCommand, 'pip install -r requirements.txt')
    assert.equal(profile.suggestedStartCommand, 'uvicorn main:app --host 0.0.0.0 --port $PORT')
  })

  // The clean repo is the control. If it warns, the warnings on the broken
  // repos mean nothing.
  void it('produces no warnings', async () => {
    const profile = await profileFixture('harbor-demo-clean')
    assert.deepEqual(profile.warnings, [])
  })

  void it('declares DATABASE_URL in .env.example and reads it in code', async () => {
    const profile = await profileFixture('harbor-demo-clean')
    const databaseUrl = profile.environment.find((entry) => entry.name === 'DATABASE_URL')

    assert.equal(databaseUrl?.declared, true)
    assert.equal(databaseUrl?.referenced, true)
    assert.equal(databaseUrl?.secret, false)
  })
})

void describe('harbor-demo-port-mismatch', () => {
  void it('detects the literal bind that passes the build and fails the health check', async () => {
    const profile = await profileFixture('harbor-demo-port-mismatch')

    assert.equal(profile.detection.framework, 'fastapi')
    assert.equal(profile.port.source, 'literal')
    assert.equal(profile.port.port, 8000)
    assert.equal(profile.port.bindsEnvPort, false)
  })

  void it('cites the exact line, so a fix can be applied and audited', async () => {
    const profile = await profileFixture('harbor-demo-port-mismatch')
    const cited = profile.port.evidence.find((entry) => entry.file === 'main.py')

    assert.ok(cited, 'the bind site must be cited')
    assert.match(cited.excerpt, /port=8000/)
    assert.ok((cited.line ?? 0) > 0)
  })

  void it('warns about $PORT before anything is deployed', async () => {
    const profile = await profileFixture('harbor-demo-port-mismatch')
    assert.ok(
      profile.warnings.some((warning) => warning.includes('$PORT')),
      `expected a $PORT warning, got: ${profile.warnings.join(' | ')}`,
    )
  })

  void it('reads its Dockerfile', async () => {
    const profile = await profileFixture('harbor-demo-port-mismatch')

    assert.equal(profile.dockerfile.present, true)
    assert.equal(profile.dockerfile.baseImage, 'python:3.13-slim')
    assert.deepEqual(profile.dockerfile.exposedPorts, [8000])
  })
})

void describe('harbor-demo-missing-dep', () => {
  void it('profiles clean, because a missing dependency is invisible until the build runs', async () => {
    const profile = await profileFixture('harbor-demo-missing-dep')

    assert.equal(profile.detection.framework, 'fastapi')
    assert.equal(profile.port.bindsEnvPort, true)
    assert.equal(profile.database.required, false)
    // Static profiling genuinely cannot see this defect: `httpx` is imported and
    // absent from requirements.txt, and nothing about the repo says so until pip
    // resolves the manifest. Asserting a clean profile here keeps M4 honest —
    // the fix has to come from reading a build failure, not from re-reading the
    // repository harder.
    assert.deepEqual(profile.warnings, [])
    assert.ok(!(profile.python?.dependencies ?? []).includes('httpx'))
  })
})

void describe('suggested commands', () => {
  const profileOf = (files: Record<string, string>): RepoProfile =>
    buildProfileFromFiles(new Map(Object.entries(files)), {
      repoUrl: 'https://github.com/owner/repo',
      branch: 'main',
      workdir: '/tmp/repo',
    })

  // Caught by running the CLI against a real pyproject-based FastAPI repo: it
  // suggested installing a requirements.txt that did not exist, which would
  // have failed on the build's first line.
  void it('installs from the manifest the repo actually ships', () => {
    assert.equal(
      profileOf({ 'requirements.txt': 'fastapi\n' }).suggestedBuildCommand,
      'pip install -r requirements.txt',
    )
    assert.equal(
      profileOf({ 'pyproject.toml': '[project]\ndependencies = ["fastapi"]\n' })
        .suggestedBuildCommand,
      'pip install .',
    )
    assert.equal(
      profileOf({
        'pyproject.toml': '[tool.poetry]\nname = "x"\n\n[tool.poetry.dependencies]\nfastapi = "*"\n',
      }).suggestedBuildCommand,
      'poetry install --no-root',
    )
  })

  void it('chains install and build for a Node app, using the lockfile manager', () => {
    const profile = profileOf({
      'package.json': JSON.stringify({
        dependencies: { next: '16.3.4' },
        scripts: { build: 'next build', start: 'next start' },
      }),
      'pnpm-lock.yaml': '',
    })

    assert.equal(profile.suggestedBuildCommand, 'pnpm install --frozen-lockfile && pnpm run build')
    assert.equal(profile.suggestedStartCommand, 'pnpm run start')
  })

  void it('suggests nothing rather than a command that cannot work', () => {
    const profile = profileOf({ 'README.md': '# nothing here' })
    assert.equal(profile.suggestedBuildCommand, undefined)
    assert.equal(profile.suggestedStartCommand, undefined)
  })
})

void describe('findFastApiApp', () => {
  void it('prefers the shallowest module', () => {
    const files = new Map([
      ['app/routers/items.py', 'router = FastAPI()\n'],
      ['main.py', 'app = FastAPI()\n'],
    ])
    assert.equal(findFastApiApp(files), 'main:app')
  })

  void it('reports the real variable name, not an assumed one', () => {
    const files = new Map([['src/server.py', 'application = FastAPI()\n']])
    assert.equal(findFastApiApp(files), 'src.server:application')
  })

  void it('returns undefined rather than a made-up module', () => {
    assert.equal(findFastApiApp(new Map([['main.py', 'x = 1\n']])), undefined)
  })
})

void describe('repo tools', () => {
  void it('never hands the model an absolute host path', async () => {
    const profile = await profileFixture('harbor-demo-clean')
    const forModel: Record<string, unknown> = toModelProfile(profile)

    assert.ok(!('workdir' in forModel))
    assert.ok(!JSON.stringify(forModel).includes(profile.workdir))
  })

  void it('refuses to read before a repository has been cloned', async () => {
    const tools = createRepoTools(new RepoSession())
    const read = tools.find((tool) => tool.name === 'github_read_files')

    assert.ok(read)
    await assert.rejects(
      () => Promise.resolve(read.run({ paths: ['package.json'] })),
      /Clone a repository before reading/,
    )
  })

  void it('rejects malformed arguments instead of coercing them', async () => {
    const tools = createRepoTools(new RepoSession())
    const clone = tools.find((tool) => tool.name === 'github_clone_repo')

    assert.ok(clone)
    // Whatever a hostile README talked the model into, it still has to produce
    // arguments that parse.
    await assert.rejects(() => Promise.resolve(clone.run({ repo_url: 42 })))
    await assert.rejects(() => Promise.resolve(clone.run({})))
  })

  void it('exposes only read-only tools in this milestone', () => {
    const tools = createRepoTools(new RepoSession())
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['detect_framework', 'github_clone_repo', 'github_read_files', 'inspect_environment'],
    )
    assert.ok(tools.every((tool) => tool.mutating !== true))
  })
})
