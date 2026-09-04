import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  REDACTED,
  clearSecrets,
  redactDeep,
  redactSecrets,
  registerSecret,
} from './redact.js'

afterEach(() => {
  clearSecrets()
})

// Every credential below is synthetic filler, not a real key.
const FAKE = {
  github: 'ghp_' + 'a'.repeat(36),
  render: 'rnd_' + 'b'.repeat(30),
  openai: 'sk-' + 'c'.repeat(40),
  aws: 'AKIAIOSFODNN7EXAMPLE',
}

void describe('registered secrets', () => {
  void it('masks a registered value anywhere it appears', () => {
    registerSecret('super-secret-value')
    const out = redactSecrets('connecting with super-secret-value now')
    assert.ok(!out.includes('super-secret-value'))
    assert.ok(out.includes(REDACTED))
  })

  void it('ignores short values that would shred ordinary logs', () => {
    registerSecret('8080')
    assert.equal(redactSecrets('listening on 8080'), 'listening on 8080')
  })

  void it('masks every occurrence, not just the first', () => {
    registerSecret('repeated-secret-1')
    const out = redactSecrets('repeated-secret-1 then repeated-secret-1')
    assert.ok(!out.includes('repeated-secret-1'))
  })
})

void describe('credential shapes', () => {
  for (const [name, value] of Object.entries(FAKE)) {
    void it(`masks a ${name} token by shape alone`, () => {
      const out = redactSecrets(`log line with ${value} embedded`)
      assert.ok(!out.includes(value), `${name} token survived redaction`)
    })
  }

  void it('masks named assignments like DATABASE_PASSWORD=...', () => {
    const out = redactSecrets('DATABASE_PASSWORD=hunter2applesauce')
    assert.ok(!out.includes('hunter2applesauce'))
  })

  void it('masks bearer tokens', () => {
    const out = redactSecrets('Authorization: Bearer ' + 'z'.repeat(32))
    assert.ok(!out.includes('z'.repeat(32)))
  })

  void it('strips connection-string credentials but keeps the host', () => {
    const out = redactSecrets('postgres://user:p4ssw0rd@db.internal:5432/harbor')
    assert.ok(!out.includes('p4ssw0rd'))
    assert.ok(out.includes('db.internal:5432/harbor'), 'host should survive')
    assert.ok(out.startsWith('postgres://'), 'scheme should survive')
  })
})

void describe('ordinary log content', () => {
  void it('leaves a normal build log untouched', () => {
    const log = 'npm ERR! Cannot find module date-fns\nBuild failed in 24s'
    assert.equal(redactSecrets(log), log)
  })

  void it('keeps port numbers readable — diagnosis depends on them', () => {
    const log = 'Uvicorn running on http://0.0.0.0:8000'
    assert.equal(redactSecrets(log), log)
  })
})

void describe('redactDeep', () => {
  void it('redacts nested strings while preserving shape', () => {
    registerSecret('nested-secret-value')
    const out = redactDeep({
      step: 'deploy',
      attempts: 2,
      env: { DATABASE_URL: 'nested-secret-value' },
      logs: ['ok', 'nested-secret-value'],
    })

    assert.equal(out.step, 'deploy')
    assert.equal(out.attempts, 2)
    assert.equal(out.env.DATABASE_URL, REDACTED)
    assert.deepEqual(out.logs, ['ok', REDACTED])
  })

  void it('passes through non-string primitives unchanged', () => {
    assert.deepEqual(redactDeep({ a: 1, b: true, c: null }), {
      a: 1,
      b: true,
      c: null,
    })
  })
})
