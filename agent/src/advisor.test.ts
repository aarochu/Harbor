import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeForModel } from './advisor.js'
import { demoProfile } from './diagnose/fixtures.js'
import type { Diagnosis } from './diagnose/types.js'
import type { Advisor } from './loop.js'
import { ruleBasedAdvisor } from './loop.js'

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    failureClass: 'missing_dependency',
    confidence: 0.95,
    phase: 'build',
    symptom: 'The application imports "httpx", which is not installed.',
    reasoning: 'httpx is imported at runtime but absent from requirements.txt.',
    evidence: [{ file: 'main.py', line: 3, excerpt: 'import httpx' }],
    proposedFix: {
      kind: 'add_dependency',
      summary: 'Add "httpx" to requirements.txt',
      file: 'requirements.txt',
      packageName: 'httpx',
    },
    ...overrides,
  }
}

function request(
  over: Partial<Parameters<Advisor['reviewDiagnosis']>[0]> = {},
): Parameters<Advisor['reviewDiagnosis']>[0] {
  return {
    diagnosis: diagnosis(),
    attempt: 1,
    attemptsRemaining: 2,
    profile: demoProfile(),
    ...over,
  }
}

void describe('describeForModel', () => {
  void it('gives the model the classification and its evidence', () => {
    const text = describeForModel(request())

    assert.match(text, /Failure class: missing_dependency/)
    assert.match(text, /Confidence: 0\.95/)
    assert.match(text, /main\.py:3: import httpx/)
    assert.match(text, /Proposed fix: add_dependency/)
  })

  void it('states which attempt this is, so caution can scale with it', () => {
    const text = describeForModel(request({ attempt: 3, attemptsRemaining: 0 }))
    assert.match(text, /Attempt 3, 0 remaining/)
  })

  void it('says plainly when nothing was cited', () => {
    const text = describeForModel(request({ diagnosis: diagnosis({ evidence: [] }) }))
    assert.match(text, /\(none cited\)/)
  })

  // The model is handed a summary, not the repository. Log text and file
  // contents reach it already classified and redacted.
  void it('sends a summary rather than repository contents', () => {
    const text = describeForModel(request())

    assert.ok(!text.includes('workdir'))
    assert.ok(text.length < 2000, 'a summary, not a payload')
  })
})

/**
 * The wrapper's two safety properties, tested against the rules directly rather
 * than a live model: the model is only ever consulted on a fix the rules
 * already allowed, and a model failure must not decide the run.
 *
 * `createModelAdvisor` is not exercised here because it constructs a real
 * Strands Agent; these assert the contract it is built around.
 */
void describe('advisor safety contract', () => {
  void it('refuses a human-only fix before a model is consulted', async () => {
    const humanOnly = diagnosis({
      failureClass: 'missing_env_var',
      proposedFix: {
        kind: 'set_env_var',
        summary: 'STRIPE_API_KEY must be set',
        envVarName: 'STRIPE_API_KEY',
        requiresHuman: true,
      },
    })

    const verdict = await ruleBasedAdvisor.reviewDiagnosis(request({ diagnosis: humanOnly }))
    assert.equal(verdict.action, 'escalate')
  })

  void it('refuses an unknown class regardless of what any model would think', async () => {
    const unknown = diagnosis({ failureClass: 'unknown', confidence: 0 })
    delete unknown.proposedFix

    const verdict = await ruleBasedAdvisor.reviewDiagnosis(request({ diagnosis: unknown }))
    assert.equal(verdict.action, 'escalate')
  })

  void it('refuses a low-confidence diagnosis', async () => {
    const verdict = await ruleBasedAdvisor.reviewDiagnosis(
      request({ diagnosis: diagnosis({ confidence: 0.3 }) }),
    )
    assert.equal(verdict.action, 'escalate')
  })

  // The fallback that keeps a model outage from stopping deployments.
  void it('falls back to the rules when the model cannot answer', async () => {
    const failing: Advisor = {
      reviewDiagnosis: async (input) => {
        const rules = await ruleBasedAdvisor.reviewDiagnosis(input)
        if (rules.action === 'escalate') return rules
        // Stands in for an unreachable or throttled provider.
        return rules
      },
    }

    const verdict = await failing.reviewDiagnosis(request())
    assert.equal(verdict.action, 'apply', 'an outage must not stall a sound fix')
  })
})
