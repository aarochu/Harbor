import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diagnose } from '../diagnose/classify.js'
import { PYTHON_MISSING_DEPENDENCY_LOG } from '../diagnose/fixtures.js'
import type { ProposedFix } from '../diagnose/types.js'
import { inspectPythonManifest } from '../repo/manifest.js'
import { buildProfileFromFiles } from '../repo/profile.js'
import type { RepoProfile } from '../repo/types.js'
import { loadRepoFiles } from '../repo/workspace.js'
import { FixNotApplicableError, planFix } from './apply.js'
import { unifiedDiff } from './diff.js'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

function repo(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files))
}

async function loadFixture(name: string): Promise<Map<string, string>> {
  return loadRepoFiles(join(FIXTURES, name))
}

function profileOf(files: ReadonlyMap<string, string>, name: string): RepoProfile {
  return buildProfileFromFiles(files, {
    repoUrl: `https://github.com/aarochu/${name}`,
    branch: 'main',
    workdir: join(FIXTURES, name),
  })
}

/** Apply a plan's edits to a copy of the repo. */
function patched(
  files: ReadonlyMap<string, string>,
  edits: { path: string; after: string }[],
): Map<string, string> {
  const next = new Map(files)
  for (const edit of edits) next.set(edit.path, edit.after)
  return next
}

function addedLines(diff: string): string[] {
  return diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
}

void describe('planFix — add_dependency', () => {
  void it('appends to requirements.txt without disturbing the existing pins', () => {
    const files = repo({ 'requirements.txt': 'fastapi==0.121.0\nuvicorn[standard]==0.42.0\n' })
    const plan = planFix(
      { kind: 'add_dependency', summary: '', file: 'requirements.txt', packageName: 'httpx' },
      files,
    )

    assert.equal(plan.edits[0]?.after, 'fastapi==0.121.0\nuvicorn[standard]==0.42.0\nhttpx\n')
    assert.match(plan.diff, /^\+httpx$/m)
    assert.ok(plan.notes.some((note) => note.includes('unpinned')))
  })

  void it('refuses when the package is already declared, in any pinned form', () => {
    const files = repo({ 'requirements.txt': 'fastapi==0.121.0\nhttpx>=0.28\n' })
    assert.throws(
      () =>
        planFix(
          { kind: 'add_dependency', summary: '', file: 'requirements.txt', packageName: 'httpx' },
          files,
        ),
      FixNotApplicableError,
    )
  })

  // Reserialising the JSON would rewrite every line and bury the change.
  void it('inserts into package.json alphabetically, as a one-line diff', () => {
    const files = repo({
      'package.json': [
        '{',
        '  "name": "demo",',
        '  "dependencies": {',
        '    "cors": "^2.8.5",',
        '    "zod": "^4.5.4"',
        '  }',
        '}',
        '',
      ].join('\n'),
    })

    const plan = planFix(
      { kind: 'add_dependency', summary: '', file: 'package.json', packageName: 'express' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /"cors": "\^2\.8\.5",\n {4}"express": "\*",\n {4}"zod"/)
    assert.equal(addedLines(plan.diff).length, 1, 'exactly one line should be added')
  })

  void it('appends after the last dependency when the name sorts last', () => {
    const files = repo({
      'package.json': '{\n  "dependencies": {\n    "cors": "^2.8.5"\n  }\n}\n',
    })
    const plan = planFix(
      { kind: 'add_dependency', summary: '', file: 'package.json', packageName: 'zod' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /"cors": "\^2\.8\.5",\n {4}"zod": "\*"/)
  })

  void it('adds to a PEP 621 dependencies array', () => {
    const files = repo({
      'pyproject.toml': '[project]\nname = "demo"\ndependencies = [\n    "fastapi",\n]\n',
    })
    const plan = planFix(
      { kind: 'add_dependency', summary: '', file: 'pyproject.toml', packageName: 'httpx' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /"fastapi",\n {4}"httpx",/)
  })

  void it('adds to a Poetry dependency table', () => {
    const files = repo({
      'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.13"\nfastapi = "^0.121"\n',
    })
    const plan = planFix(
      { kind: 'add_dependency', summary: '', file: 'pyproject.toml', packageName: 'httpx' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /\[tool\.poetry\.dependencies\]\nhttpx = "\*"/)
  })

  void it('reports a missing manifest instead of creating one', () => {
    assert.throws(
      () =>
        planFix(
          { kind: 'add_dependency', summary: '', file: 'requirements.txt', packageName: 'httpx' },
          repo({}),
        ),
      /Manifest not found/,
    )
  })
})

void describe('planFix — bind_env_port', () => {
  // The literal is kept as the fallback, so the app still runs locally.
  void it('rewrites a Python bind to read $PORT with the old port as fallback', () => {
    const files = repo({
      'main.py': 'import os\n\nuvicorn.run(app, host="0.0.0.0", port=8000)\n',
    })
    const plan = planFix(
      { kind: 'bind_env_port', summary: '', file: 'main.py', from: '8000', to: '$PORT' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /port=int\(os\.environ\.get\("PORT", 8000\)\)/)
    assert.match(plan.summary, /local fallback/)
  })

  void it('adds "import os" when the file does not already have it', () => {
    const files = repo({
      'main.py': 'from fastapi import FastAPI\n\nuvicorn.run(app, port=8000)\n',
    })
    const plan = planFix(
      { kind: 'bind_env_port', summary: '', file: 'main.py', from: '8000', to: '$PORT' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /^import os\nfrom fastapi import FastAPI/)
    assert.ok(plan.notes.some((note) => note.includes('import os')))
  })

  void it('does not duplicate an existing "import os"', () => {
    const files = repo({ 'main.py': 'import os\nimport sys\n\nuvicorn.run(app, port=8000)\n' })
    const plan = planFix(
      { kind: 'bind_env_port', summary: '', file: 'main.py', from: '8000', to: '$PORT' },
      files,
    )

    const occurrences = (plan.edits[0]?.after.match(/^import os$/gm) ?? []).length
    assert.equal(occurrences, 1)
  })

  void it('rewrites a Node listen call', () => {
    const files = repo({ 'server.js': 'app.listen(3000, () => console.log("up"))\n' })
    const plan = planFix(
      { kind: 'bind_env_port', summary: '', file: 'server.js', from: '3000', to: '$PORT' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /app\.listen\(process\.env\.PORT \|\| 3000,/)
  })

  void it('rewrites a --port argument in a Dockerfile', () => {
    const files = repo({
      Dockerfile: 'FROM python:3.13-slim\nCMD uvicorn main:app --port 8000\n',
    })
    const plan = planFix(
      { kind: 'bind_env_port', summary: '', file: 'Dockerfile', from: '8000', to: '$PORT' },
      files,
    )

    assert.match(plan.edits[0]?.after ?? '', /--port \$PORT/)
  })

  void it('refuses rather than guessing when the bind cannot be found', () => {
    const files = repo({ 'main.py': 'print("no bind here")\n' })
    assert.throws(
      () =>
        planFix(
          { kind: 'bind_env_port', summary: '', file: 'main.py', from: '8000', to: '$PORT' },
          files,
        ),
      FixNotApplicableError,
    )
  })
})

void describe('planFix — platform-side fixes', () => {
  void it('carries a set_env_var as a platform action, not a repo edit', () => {
    const plan = planFix(
      { kind: 'set_env_var', summary: '', envVarName: 'LOG_LEVEL', to: 'info' },
      repo({}),
    )

    assert.deepEqual(plan.edits, [])
    assert.equal(plan.platformAction?.kind, 'set_env_var')
    assert.equal(plan.platformAction?.value, 'info')
  })

  // Render does not redeploy on an env var change; forgetting that makes every
  // later diagnosis wrong.
  void it('warns that an env var change needs a deploy to take effect', () => {
    const plan = planFix(
      { kind: 'set_env_var', summary: '', envVarName: 'LOG_LEVEL', to: 'info' },
      repo({}),
    )
    assert.ok(plan.notes.some((note) => /does not trigger a deploy/.test(note)))
  })

  void it('refuses a set_env_var with no value rather than writing an empty one', () => {
    assert.throws(
      () => planFix({ kind: 'set_env_var', summary: '', envVarName: 'API_KEY' }, repo({})),
      /should have been escalated/,
    )
  })
})

void describe('planFix — escalation boundary', () => {
  // The guardrail: the diagnoser flags secrets, and the applier must honour it.
  void it('refuses any fix marked as requiring a human', () => {
    const fix: ProposedFix = {
      kind: 'set_env_var',
      summary: 'STRIPE_API_KEY must be set',
      envVarName: 'STRIPE_API_KEY',
      requiresHuman: true,
    }

    assert.throws(() => planFix(fix, repo({})), FixNotApplicableError)
    assert.throws(() => planFix(fix, repo({})), /must be escalated, not applied/)
  })
})

void describe('diagnose -> plan round trip on the demo repos', () => {
  // The claim the demo makes, proven without deploying: the fix Harbor derives
  // actually removes the defect it diagnosed.
  void it('turns the port-mismatch repo into one that profiles clean', async () => {
    const files = await loadFixture('harbor-demo-port-mismatch')
    const before = profileOf(files, 'harbor-demo-port-mismatch')

    assert.equal(before.port.bindsEnvPort, false)
    assert.ok(before.warnings.some((warning) => warning.includes('$PORT')))

    const diagnosis = diagnose({
      phase: 'health',
      health: { status: 'unreachable' },
      buildSucceeded: true,
      profile: before,
    })
    assert.equal(diagnosis.failureClass, 'port_mismatch')

    const fix = diagnosis.proposedFix
    assert.ok(fix)
    const plan = planFix(fix, files)

    const after = profileOf(patched(files, plan.edits), 'harbor-demo-port-mismatch')
    assert.equal(after.port.bindsEnvPort, true, 'the defect must actually be gone')
    assert.ok(
      !after.warnings.some((warning) => warning.includes('$PORT')),
      `warnings remained: ${after.warnings.join(' | ')}`,
    )
  })

  void it('adds the dependency the missing-dep repo was importing', async () => {
    const files = await loadFixture('harbor-demo-missing-dep')
    const profile = profileOf(files, 'harbor-demo-missing-dep')

    assert.ok(!(profile.python?.dependencies ?? []).includes('httpx'))

    const diagnosis = diagnose({
      phase: 'runtime',
      buildLogs: PYTHON_MISSING_DEPENDENCY_LOG,
      profile,
    })
    const fix = diagnosis.proposedFix
    assert.ok(fix)

    const plan = planFix(fix, files)
    const manifest = inspectPythonManifest(patched(files, plan.edits))

    assert.ok(manifest)
    assert.ok(manifest.dependencies.includes('httpx'), 'httpx must now be declared')
    // The existing pins must survive the edit.
    assert.ok(manifest.dependencies.includes('fastapi'))
    assert.ok(manifest.dependencies.includes('uvicorn'))
  })
})

void describe('unifiedDiff', () => {
  void it('returns nothing when the sides are identical', () => {
    assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', { path: 'f.txt' }), '')
  })

  void it('does not report a phantom change from a trailing newline', () => {
    const diff = unifiedDiff('a\nb\n', 'a\nb\nc\n', { path: 'f.txt' })
    const removed = diff
      .split('\n')
      .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    assert.deepEqual(removed, [], 'appending a line must not show a deletion')
  })

  void it('produces headers and a hunk with surrounding context', () => {
    const before = ['one', 'two', 'three', 'four', 'five'].join('\n')
    const after = ['one', 'two', 'CHANGED', 'four', 'five'].join('\n')
    const diff = unifiedDiff(before, after, { path: 'f.txt' })

    assert.match(diff, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ /)
    assert.match(diff, /^-three$/m)
    assert.match(diff, /^\+CHANGED$/m)
    assert.match(diff, /^ two$/m)
    assert.match(diff, /^ four$/m)
  })

  void it('handles a file that was empty', () => {
    const diff = unifiedDiff('', 'first\n', { path: 'new.txt' })
    assert.match(diff, /^\+first$/m)
  })
})
