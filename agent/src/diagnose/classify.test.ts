import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diagnose, nodePackageRoot, pythonDistributionFor } from './classify.js'
import {
  BAD_START_COMMAND_LOG,
  MISSING_ENV_VAR_LOG,
  MISSING_NON_SECRET_ENV_VAR_LOG,
  MISSING_SECRET_ENV_VAR_LOG,
  NODE_MISSING_DEPENDENCY_LOG,
  NODE_MISSING_LOCAL_FILE_LOG,
  NODE_SUBPATH_IMPORT_LOG,
  PORT_MISMATCH_LOG,
  PYTHON_ALIASED_DISTRIBUTION_LOG,
  PYTHON_MISSING_DEPENDENCY_LOG,
  PYTHON_STDLIB_IMPORT_LOG,
  UNRECOGNISED_LOG,
  demoProfile,
  portMismatchProfile,
} from './fixtures.js'
import { isActionable } from './types.js'

void describe('failure class B — missing dependency', () => {
  void it('finds the missing package in a full build log', () => {
    const result = diagnose({
      phase: 'runtime',
      buildLogs: PYTHON_MISSING_DEPENDENCY_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'missing_dependency')
    assert.equal(result.proposedFix?.kind, 'add_dependency')
    assert.equal(result.proposedFix?.packageName, 'httpx')
    assert.equal(result.proposedFix?.file, 'requirements.txt')
    assert.ok(isActionable(result))
  })

  void it('cites the traceback line, not just the package name', () => {
    const result = diagnose({
      phase: 'runtime',
      buildLogs: PYTHON_MISSING_DEPENDENCY_LOG,
      profile: demoProfile(),
    })

    const cited = result.evidence[0]
    assert.ok(cited)
    assert.match(cited.excerpt, /ModuleNotFoundError: No module named 'httpx'/)
    assert.ok((cited.line ?? 0) > 1, 'the error is buried in the middle of the log')
  })

  // pip install psycopg2 compiles from source and fails on a slim image.
  void it('maps an import to its real distribution name', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: PYTHON_ALIASED_DISTRIBUTION_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.proposedFix?.packageName, 'psycopg2-binary')
    assert.equal(result.proposedFix?.importName, 'psycopg2')
    assert.match(result.reasoning, /psycopg2-binary/)
  })

  void it('handles the Node form', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: NODE_MISSING_DEPENDENCY_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'missing_dependency')
    assert.equal(result.proposedFix?.packageName, 'express')
    assert.equal(result.proposedFix?.file, 'package.json')
  })

  void it('strips a subpath to the installable package', () => {
    const result = diagnose({ phase: 'runtime', runtimeLogs: NODE_SUBPATH_IMPORT_LOG })

    assert.equal(result.proposedFix?.packageName, 'lodash')
    assert.equal(result.proposedFix?.importName, 'lodash/get')
  })

  // Installing a PyPI package named `dataclasses` would be actively harmful.
  void it('refuses to treat a stdlib module as a dependency', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: PYTHON_STDLIB_IMPORT_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'unknown')
    assert.equal(result.proposedFix, undefined)
    assert.ok(!isActionable(result))
    assert.match(result.reasoning, /ships with Python/)
  })

  void it('does not re-add a package that is already declared', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: "ModuleNotFoundError: No module named 'fastapi'",
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'unknown')
    assert.match(result.reasoning, /already in the manifest/)
  })
})

void describe('failure class A — port mismatch', () => {
  void it('diagnoses a green build with a dead health check', () => {
    const result = diagnose({
      phase: 'health',
      runtimeLogs: PORT_MISMATCH_LOG,
      health: { status: 'unreachable' },
      buildSucceeded: true,
      profile: portMismatchProfile(),
    })

    assert.equal(result.failureClass, 'port_mismatch')
    assert.equal(result.proposedFix?.kind, 'bind_env_port')
    assert.equal(result.proposedFix?.from, '8000')
    assert.equal(result.proposedFix?.to, '$PORT')
    assert.ok(isActionable(result))
  })

  void it('carries the bind site through from the repo profile', () => {
    const result = diagnose({
      phase: 'health',
      runtimeLogs: PORT_MISMATCH_LOG,
      health: { status: 'unreachable' },
      profile: portMismatchProfile(),
    })

    const bindSite = result.evidence.find((entry) => entry.file === 'main.py')
    assert.ok(bindSite, 'the fix has to name the line it edits')
    assert.match(bindSite.excerpt, /port=8000/)
    assert.equal(result.proposedFix?.file, 'main.py')
  })

  void it('also cites the listening banner, which names the wrong port', () => {
    const result = diagnose({
      phase: 'health',
      runtimeLogs: PORT_MISMATCH_LOG,
      health: { status: 'unreachable' },
      profile: portMismatchProfile(),
    })

    assert.ok(
      result.evidence.some((entry) => /Uvicorn running on/.test(entry.excerpt)),
      'the banner is what makes this near-certain',
    )
  })

  // The demo-critical guard: a healthy service is not a port mismatch, however
  // hardcoded its port looks.
  void it('does not fire when the health check passed', () => {
    const result = diagnose({
      phase: 'health',
      runtimeLogs: PORT_MISMATCH_LOG,
      health: { status: 'healthy', httpStatus: 200 },
      profile: portMismatchProfile(),
    })

    assert.notEqual(result.failureClass, 'port_mismatch')
  })

  void it('does not fire when the app already reads $PORT', () => {
    const result = diagnose({
      phase: 'health',
      health: { status: 'unreachable' },
      profile: demoProfile(),
    })

    assert.notEqual(result.failureClass, 'port_mismatch')
    assert.equal(result.failureClass, 'unknown')
  })

  void it('defers to the build when the build never succeeded', () => {
    const result = diagnose({
      phase: 'build',
      health: { status: 'unreachable' },
      buildSucceeded: false,
      profile: portMismatchProfile(),
    })

    assert.notEqual(result.failureClass, 'port_mismatch')
  })
})

void describe('failure class C — missing env var', () => {
  void it('reads the variable name out of a KeyError traceback', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: MISSING_ENV_VAR_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'missing_env_var')
    assert.equal(result.proposedFix?.envVarName, 'DATABASE_URL')
  })

  // The line Harbor must not cross: inventing a credential.
  void it('escalates rather than inventing a secret', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: MISSING_SECRET_ENV_VAR_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'missing_env_var')
    assert.equal(result.proposedFix?.envVarName, 'STRIPE_API_KEY')
    assert.equal(result.proposedFix?.requiresHuman, true)
    assert.equal(result.proposedFix?.to, undefined, 'no value may be guessed')
    assert.ok(!isActionable(result), 'a secret must route to a human')
  })

  void it('sets a non-secret variable itself when the repo declares a default', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: MISSING_NON_SECRET_ENV_VAR_LOG,
      profile: demoProfile({
        environment: [
          {
            name: 'LOG_LEVEL',
            declared: true,
            referenced: true,
            secret: false,
            defaultValue: 'info',
            evidence: [],
          },
        ],
      }),
    })

    assert.equal(result.proposedFix?.to, 'info')
    assert.notEqual(result.proposedFix?.requiresHuman, true)
    assert.ok(isActionable(result))
  })

  void it('escalates a non-secret variable with no known default', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: MISSING_NON_SECRET_ENV_VAR_LOG,
      profile: demoProfile({ environment: [] }),
    })

    assert.equal(result.proposedFix?.requiresHuman, true)
  })
})

void describe('failure class D — bad start command', () => {
  void it('recognises a missing executable', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: BAD_START_COMMAND_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'bad_start_command')
    assert.match(result.symptom, /uvicorn/)
  })

  // Re-running the identical command would spend a fix attempt to learn nothing.
  void it('will not propose the command that just failed', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: BAD_START_COMMAND_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.proposedFix?.to, undefined)
    assert.equal(result.proposedFix?.requiresHuman, true)
    assert.ok(!isActionable(result))
    assert.match(result.proposedFix?.summary ?? '', /did not install it/)
  })

  void it('proposes the convention when it differs from what ran', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: 'bash: line 1: gunicorn: command not found\n',
      profile: demoProfile(),
    })

    assert.equal(result.proposedFix?.to, 'uvicorn main:app --host 0.0.0.0 --port $PORT')
    assert.ok(isActionable(result))
  })

  // Node reports a missing entry file with the same wording it uses for a
  // missing package; adding a filesystem path to package.json is nonsense.
  void it('outranks the dependency class on a missing entry file', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: NODE_MISSING_LOCAL_FILE_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'bad_start_command')
    assert.notEqual(result.proposedFix?.kind, 'add_dependency')
  })
})

void describe('unknown failures', () => {
  void it('escalates rather than guessing', () => {
    const result = diagnose({
      phase: 'runtime',
      runtimeLogs: UNRECOGNISED_LOG,
      profile: demoProfile(),
    })

    assert.equal(result.failureClass, 'unknown')
    assert.equal(result.confidence, 0)
    assert.equal(result.proposedFix, undefined)
    assert.ok(!isActionable(result))
  })

  void it('still returns a diagnosis when there is nothing to go on', () => {
    const result = diagnose({ phase: 'build' })

    assert.equal(result.failureClass, 'unknown')
    assert.deepEqual(result.evidence, [])
    assert.ok(result.symptom.length > 0)
  })
})

void describe('signal precedence', () => {
  // Both logs present: the runtime crash is the more recent event and the one
  // that actually stopped the service.
  void it('prefers the runtime failure over an earlier build log', () => {
    const result = diagnose({
      phase: 'runtime',
      buildLogs: '==> Running build command...\nSuccessfully installed fastapi-0.121.0\n',
      runtimeLogs: "ModuleNotFoundError: No module named 'httpx'\n",
      profile: demoProfile(),
    })

    assert.equal(result.proposedFix?.packageName, 'httpx')
    assert.equal(result.evidence[0]?.file, 'runtime.log')
  })

  // An explicit error message beats an inference drawn from two separate facts.
  void it('lets a stated error outrank the port-mismatch inference', () => {
    const result = diagnose({
      phase: 'health',
      runtimeLogs: "ModuleNotFoundError: No module named 'httpx'\n",
      health: { status: 'unreachable' },
      profile: portMismatchProfile(),
    })

    assert.equal(result.failureClass, 'missing_dependency')
  })
})

void describe('name resolution helpers', () => {
  void it('reduces a Node specifier to its installable root', () => {
    assert.equal(nodePackageRoot('express'), 'express')
    assert.equal(nodePackageRoot('lodash/get'), 'lodash')
    assert.equal(nodePackageRoot('@scope/pkg'), '@scope/pkg')
    assert.equal(nodePackageRoot('@scope/pkg/sub'), '@scope/pkg')
  })

  void it('maps Python imports to distributions', () => {
    assert.equal(pythonDistributionFor('httpx'), 'httpx')
    assert.equal(pythonDistributionFor('PIL'), 'Pillow')
    assert.equal(pythonDistributionFor('yaml'), 'PyYAML')
    assert.equal(pythonDistributionFor('dotenv'), 'python-dotenv')
    assert.equal(pythonDistributionFor('google.protobuf'), 'google')
  })
})
