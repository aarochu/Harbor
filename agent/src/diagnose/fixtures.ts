/**
 * Recorded log fixtures.
 *
 * Real-shaped Render build and runtime output, including the noise: pip's
 * progress lines, the banner, the full traceback. Diagnosis has to find one
 * line in the middle of that, so testing against a single tidy error string
 * would prove much less than it appears to.
 */
import type { RepoProfile } from '../repo/types.js'

export const PYTHON_MISSING_DEPENDENCY_LOG = `==> Cloning from https://github.com/aarochu/harbor-demo-missing-dep
==> Checking out commit 4f2a9c1 in branch main
==> Running build command 'pip install -r requirements.txt'...
Collecting fastapi==0.121.0
  Downloading fastapi-0.121.0-py3-none-any.whl (95 kB)
Collecting uvicorn[standard]==0.42.0
  Downloading uvicorn-0.42.0-py3-none-any.whl (63 kB)
Installing collected packages: uvicorn, fastapi
Successfully installed fastapi-0.121.0 uvicorn-0.42.0
==> Build successful 🎉
==> Deploying...
==> Running 'uvicorn main:app --host 0.0.0.0 --port $PORT'
Traceback (most recent call last):
  File "/opt/render/project/src/main.py", line 3, in <module>
    import httpx
ModuleNotFoundError: No module named 'httpx'
==> Exited with status 1
`

export const NODE_MISSING_DEPENDENCY_LOG = `==> Running build command 'npm install'...
added 68 packages in 3s
==> Build successful 🎉
==> Deploying...
==> Running 'npm run start'
node:internal/modules/cjs/loader:1215
  throw err;
  ^

Error: Cannot find module 'express'
Require stack:
- /opt/render/project/src/server.js
    at Function._resolveFilename (node:internal/modules/cjs/loader:1212:15)
==> Exited with status 1
`

/** A subpath import: the package to add is `lodash`, not `lodash/get`. */
export const NODE_SUBPATH_IMPORT_LOG = `==> Running 'npm run start'
Error: Cannot find module 'lodash/get'
    at Function._resolveFilename (node:internal/modules/cjs/loader:1212:15)
==> Exited with status 1
`

/** A missing local file, which reads almost identically and is not a dependency. */
export const NODE_MISSING_LOCAL_FILE_LOG = `==> Running 'node dist/server.js'
Error: Cannot find module '/opt/render/project/src/dist/server.js'
    at Function._resolveFilename (node:internal/modules/cjs/loader:1212:15)
==> Exited with status 1
`

export const PYTHON_STDLIB_IMPORT_LOG = `==> Running 'python main.py'
Traceback (most recent call last):
  File "/opt/render/project/src/main.py", line 1, in <module>
    import dataclasses
ModuleNotFoundError: No module named 'dataclasses'
==> Exited with status 1
`

/** psycopg2 is imported; psycopg2-binary is the distribution that provides it. */
export const PYTHON_ALIASED_DISTRIBUTION_LOG = `==> Deploying...
Traceback (most recent call last):
  File "/opt/render/project/src/db.py", line 2, in <module>
    import psycopg2
ModuleNotFoundError: No module named 'psycopg2'
==> Exited with status 1
`

export const MISSING_ENV_VAR_LOG = `==> Build successful 🎉
==> Deploying...
==> Running 'uvicorn main:app --host 0.0.0.0 --port $PORT'
Traceback (most recent call last):
  File "/opt/render/project/src/main.py", line 8, in <module>
    engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
  File "/usr/local/lib/python3.13/os.py", line 679, in __getitem__
    raise KeyError(key) from None
KeyError: 'DATABASE_URL'
==> Exited with status 1
`

export const MISSING_SECRET_ENV_VAR_LOG = `==> Deploying...
==> Running 'npm run start'
Error: Missing required environment variable: STRIPE_API_KEY
    at loadConfig (/opt/render/project/src/config.js:12:11)
==> Exited with status 1
`

export const MISSING_NON_SECRET_ENV_VAR_LOG = `==> Deploying...
Error: Missing required environment variable: LOG_LEVEL
==> Exited with status 1
`

/**
 * The port-mismatch case, and the reason class A is hard.
 *
 * Nothing here is an error. The build succeeds, the app starts, the banner
 * looks healthy. The only symptom is that the platform's health check never
 * gets an answer, because it is knocking on a different port.
 */
export const PORT_MISMATCH_LOG = `==> Running build command 'pip install -r requirements.txt'...
Successfully installed fastapi-0.121.0 uvicorn-0.42.0
==> Build successful 🎉
==> Deploying...
==> Running 'python main.py'
INFO:     Started server process [42]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
==> No open ports detected on 0.0.0.0
==> Timed out waiting for the port to become available
`

export const BAD_START_COMMAND_LOG = `==> Build successful 🎉
==> Deploying...
==> Running 'uvicorn main:app --host 0.0.0.0 --port $PORT'
bash: line 1: uvicorn: command not found
==> Exited with status 127
`

export const UNRECOGNISED_LOG = `==> Build successful 🎉
==> Deploying...
==> Running 'npm run start'
Segmentation fault (core dumped)
==> Exited with status 139
`

/**
 * A repo profile shaped like the demo repos.
 *
 * `overrides` lets a test bend one field — the hardcoded port, the declared
 * dependencies — without restating the whole object.
 */
export function demoProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    repoUrl: 'https://github.com/aarochu/harbor-demo-clean',
    branch: 'main',
    workdir: '/tmp/harbor-demo',
    detection: {
      framework: 'fastapi',
      runtime: 'python',
      confidence: 0.95,
      evidence: [],
    },
    port: {
      port: 8000,
      source: 'env_with_fallback',
      bindsEnvPort: true,
      evidence: [],
    },
    database: {
      required: true,
      kinds: ['postgres'],
      connectionVar: 'DATABASE_URL',
      evidence: [],
    },
    dockerfile: { present: false, exposedPorts: [], evidence: [] },
    environment: [
      {
        name: 'DATABASE_URL',
        declared: true,
        referenced: true,
        secret: false,
        defaultValue: 'postgresql://localhost:5432/harbor_demo',
        evidence: [],
      },
    ],
    python: {
      packageManager: 'pip',
      dependencies: ['fastapi', 'uvicorn'],
      source: 'requirements.txt',
    },
    suggestedBuildCommand: 'pip install -r requirements.txt',
    suggestedStartCommand: 'uvicorn main:app --host 0.0.0.0 --port $PORT',
    warnings: [],
    ...overrides,
  }
}

/** The port-mismatch demo repo: a literal bind, with the line cited. */
export function portMismatchProfile(): RepoProfile {
  return demoProfile({
    port: {
      port: 8000,
      source: 'literal',
      bindsEnvPort: false,
      evidence: [
        {
          file: 'main.py',
          line: 12,
          excerpt: 'uvicorn.run(app, host="0.0.0.0", port=8000)',
        },
      ],
    },
    database: { required: false, kinds: [], evidence: [] },
    environment: [],
  })
}
