import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectDatabase, detectEnvironment, detectFramework, detectPort } from './detect.js'
import {
  detectPackageManager,
  inspectDockerfile,
  inspectPackageJson,
  inspectPythonManifest,
  parsePyprojectDependencies,
  parseRequirements,
} from './manifest.js'

/** Detectors are pure over a file map, so a fixture is just an object literal. */
function repo(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files))
}

const packageJson = (extra: Record<string, unknown>): string =>
  JSON.stringify({ name: 'demo', ...extra }, null, 2)

void describe('detectFramework', () => {
  void it('identifies Next.js from a declared dependency', () => {
    const files = repo({
      'package.json': packageJson({ dependencies: { next: '16.3.4', react: '19.2.8' } }),
    })
    const result = detectFramework(files, inspectPackageJson(files))

    assert.equal(result.framework, 'nextjs')
    assert.equal(result.runtime, 'node')
    assert.ok(result.confidence > 0.9)
    assert.ok(result.evidence.length > 0)
  })

  void it('identifies Next.js from a config file even without the dependency', () => {
    const files = repo({ 'next.config.ts': 'export default {}' })
    assert.equal(detectFramework(files).framework, 'nextjs')
  })

  void it('identifies Express from a declared dependency', () => {
    const files = repo({ 'package.json': packageJson({ dependencies: { express: '^5.1.0' } }) })
    assert.equal(detectFramework(files, inspectPackageJson(files)).framework, 'express')
  })

  void it('identifies FastAPI from requirements.txt', () => {
    const files = repo({ 'requirements.txt': 'fastapi==0.121.0\nuvicorn\n' })
    const result = detectFramework(files, undefined, inspectPythonManifest(files))

    assert.equal(result.framework, 'fastapi')
    assert.equal(result.runtime, 'python')
  })

  // A source import is weaker evidence than a manifest entry, and the profile
  // has to say so rather than presenting a guess as a fact.
  void it('falls back to source imports at reduced confidence', () => {
    const files = repo({ 'main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n' })
    const result = detectFramework(files)

    assert.equal(result.framework, 'fastapi')
    assert.ok(result.confidence < 0.7, 'an import is not a declaration')
  })

  void it('reports unknown rather than guessing', () => {
    const result = detectFramework(repo({ 'README.md': '# a repo' }))
    assert.equal(result.framework, 'unknown')
    assert.equal(result.confidence, 0)
  })
})

void describe('detectPort', () => {
  // This pair is the whole of failure class A: one deploys, one does not, and
  // they are a few characters apart.
  void it('treats process.env.PORT as binding the platform port', () => {
    const files = repo({ 'server.js': 'const port = process.env.PORT\napp.listen(port)\n' })
    const result = detectPort(files, 'express')

    assert.equal(result.bindsEnvPort, true)
    assert.equal(result.source, 'env')
  })

  void it('treats a hardcoded listen as a literal bind', () => {
    const files = repo({ 'server.js': 'app.listen(8000)\n' })
    const result = detectPort(files, 'express')

    assert.equal(result.bindsEnvPort, false)
    assert.equal(result.source, 'literal')
    assert.equal(result.port, 8000)
    assert.ok(result.evidence.length > 0, 'a fix has to cite the line it changes')
  })

  void it('records an env read with a fallback as still deployable', () => {
    const files = repo({ 'server.js': 'app.listen(process.env.PORT || 3000)\n' })
    const result = detectPort(files, 'express')

    assert.equal(result.bindsEnvPort, true)
    assert.equal(result.source, 'env_with_fallback')
    assert.equal(result.port, 3000)
  })

  void it('reads the Python forms of the same thing', () => {
    const withEnv = detectPort(
      repo({ 'main.py': 'uvicorn.run(app, port=int(os.environ.get("PORT", 8000)))\n' }),
      'fastapi',
    )
    assert.equal(withEnv.bindsEnvPort, true)
    assert.equal(withEnv.port, 8000)

    const withLiteral = detectPort(
      repo({ 'main.py': 'uvicorn.run(app, host="0.0.0.0", port=8000)\n' }),
      'fastapi',
    )
    assert.equal(withLiteral.bindsEnvPort, false)
    assert.equal(withLiteral.source, 'literal')
  })

  void it('sees $PORT in a Dockerfile CMD', () => {
    const files = repo({
      Dockerfile: 'FROM python:3.13-slim\nCMD ["sh", "-c", "uvicorn main:app --port $PORT"]\n',
    })
    assert.equal(detectPort(files, 'fastapi').bindsEnvPort, true)
  })

  void it('falls back to a framework default when nothing is found', () => {
    const result = detectPort(
      repo({ 'app/page.tsx': 'export default function Page() {}' }),
      'nextjs',
    )

    assert.equal(result.source, 'framework_default')
    assert.equal(result.port, 3000)
    // A convention is not a promise that the app honours $PORT.
    assert.equal(result.bindsEnvPort, false)
  })
})

void describe('detectEnvironment', () => {
  void it('merges .env.example declarations with code references', () => {
    const files = repo({
      '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\nLOG_LEVEL=info\n',
      'main.py': 'os.environ["DATABASE_URL"]\nos.getenv("STRIPE_API_KEY")\n',
    })
    const byName = new Map(detectEnvironment(files).map((entry) => [entry.name, entry]))

    assert.equal(byName.get('DATABASE_URL')?.declared, true)
    assert.equal(byName.get('DATABASE_URL')?.referenced, true)
    assert.equal(byName.get('LOG_LEVEL')?.referenced, false)
    // Referenced but undeclared: the usual cause of a crash loop on first boot.
    assert.equal(byName.get('STRIPE_API_KEY')?.declared, false)
    assert.equal(byName.get('STRIPE_API_KEY')?.referenced, true)
  })

  void it('flags secret-shaped names so Harbor escalates instead of inventing a value', () => {
    const files = repo({
      'server.js': 'process.env.STRIPE_API_KEY\nprocess.env.SESSION_SECRET\nprocess.env.LOG_LEVEL\n',
    })
    const byName = new Map(detectEnvironment(files).map((entry) => [entry.name, entry]))

    assert.equal(byName.get('STRIPE_API_KEY')?.secret, true)
    assert.equal(byName.get('SESSION_SECRET')?.secret, true)
    assert.equal(byName.get('LOG_LEVEL')?.secret, false)
  })

  void it('takes a non-secret default from the example file but never a secret one', () => {
    const files = repo({ '.env.example': 'LOG_LEVEL=debug\nAPI_KEY=replace-me\n' })
    const byName = new Map(detectEnvironment(files).map((entry) => [entry.name, entry]))

    assert.equal(byName.get('LOG_LEVEL')?.defaultValue, 'debug')
    assert.equal(byName.get('API_KEY')?.defaultValue, undefined)
  })

  void it('ignores variables the platform provides', () => {
    const files = repo({ 'server.js': 'process.env.PORT\nprocess.env.NODE_ENV\n' })
    assert.deepEqual(detectEnvironment(files), [])
  })
})

void describe('detectDatabase', () => {
  void it('detects Postgres from a Node driver', () => {
    const files = repo({ 'package.json': packageJson({ dependencies: { pg: '^8.23.0' } }) })
    const result = detectDatabase(files, inspectPackageJson(files))

    assert.equal(result.required, true)
    assert.deepEqual(result.kinds, ['postgres'])
  })

  void it('detects Postgres from a Python driver and finds the connection variable', () => {
    const files = repo({
      'requirements.txt': 'fastapi\npsycopg2-binary\n',
      'main.py': 'engine = create_engine(os.environ["DATABASE_URL"])\n',
    })
    const result = detectDatabase(files, undefined, inspectPythonManifest(files))

    assert.equal(result.required, true)
    assert.deepEqual(result.kinds, ['postgres'])
    assert.equal(result.connectionVar, 'DATABASE_URL')
  })

  void it('detects a database behind an ORM from the connection scheme alone', () => {
    const files = repo({ 'config.py': 'DB = "postgresql://user@localhost/app"\n' })
    assert.equal(detectDatabase(files).required, true)
  })

  // Provisioning a managed database is a paid, approval-gated action, so a
  // false positive here costs real money.
  void it('does not require a managed database for sqlite or redis alone', () => {
    const files = repo({
      'package.json': packageJson({
        dependencies: { 'better-sqlite3': '^11.0.0', ioredis: '^5' },
      }),
    })
    const result = detectDatabase(files, inspectPackageJson(files))

    assert.equal(result.required, false)
    assert.deepEqual(result.kinds, ['redis', 'sqlite'])
  })

  void it('reports no database when there is none', () => {
    const files = repo({ 'package.json': packageJson({ dependencies: { express: '^5' } }) })
    const result = detectDatabase(files, inspectPackageJson(files))

    assert.equal(result.required, false)
    assert.deepEqual(result.kinds, [])
  })
})

void describe('manifest inspection', () => {
  void it('follows the committed lockfile rather than the declared packageManager', () => {
    const files = repo({
      'package.json': packageJson({ packageManager: 'pnpm@10.0.0' }),
      'package-lock.json': '{}',
    })
    assert.equal(detectPackageManager(files), 'npm')
  })

  void it('reads scripts, deps and the pinned Node version', () => {
    const files = repo({
      'package.json': packageJson({
        scripts: { build: 'next build', start: 'next start' },
        dependencies: { next: '16.3.4' },
        devDependencies: { typescript: '^5.9.3' },
        engines: { node: '>=24' },
      }),
      'pnpm-lock.yaml': '',
    })
    const manifest = inspectPackageJson(files)

    assert.equal(manifest?.packageManager, 'pnpm')
    assert.equal(manifest?.scripts.build, 'next build')
    assert.equal(manifest?.nodeVersion, '>=24')
  })

  void it('survives a package.json that will not parse', () => {
    const manifest = inspectPackageJson(repo({ 'package.json': '{ not json' }))
    assert.deepEqual(manifest?.scripts, {})
  })

  void it('strips pins, extras, markers and comments from requirements.txt', () => {
    const parsed = parseRequirements(
      [
        '# comment',
        'fastapi==0.121.0',
        'uvicorn[standard]>=0.42',
        'psycopg2-binary ; sys_platform != "win32"',
        '-r other.txt',
        '',
      ].join('\n'),
    )
    assert.deepEqual(parsed, ['fastapi', 'psycopg2-binary', 'uvicorn'])
  })

  void it('reads both PEP 621 and Poetry dependency tables', () => {
    assert.deepEqual(
      parsePyprojectDependencies('[project]\ndependencies = ["fastapi>=0.121", "httpx"]\n'),
      ['fastapi', 'httpx'],
    )
    assert.deepEqual(
      parsePyprojectDependencies(
        [
          '[tool.poetry.dependencies]',
          'python = "^3.13"',
          'fastapi = "^0.121"',
          '',
          '[tool.poetry.group.dev.dependencies]',
          'pytest = "*"',
        ].join('\n'),
      ),
      ['fastapi'],
    )
  })

  void it('reads the final FROM, every EXPOSE, and the CMD from a Dockerfile', () => {
    const files = repo({
      Dockerfile: [
        'FROM node:24-alpine AS build',
        'RUN npm ci',
        'FROM node:24-slim',
        'EXPOSE 8080 9090',
        'CMD ["node", "dist/server.js"]',
      ].join('\n'),
    })
    const result = inspectDockerfile(files)

    assert.equal(result.present, true)
    assert.equal(result.baseImage, 'node:24-slim', 'the last stage is the one that runs')
    assert.deepEqual(result.exposedPorts, [8080, 9090])
    assert.equal(result.startCommand, '["node", "dist/server.js"]')
  })

  void it('reports absence without inventing a Dockerfile', () => {
    assert.deepEqual(inspectDockerfile(repo({})), {
      present: false,
      exposedPorts: [],
      evidence: [],
    })
  })
})
