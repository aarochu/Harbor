import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixBranchFor, isRetryablePush } from './writer.js'

void describe('isRetryablePush', () => {
  // A conflict is not transient. Repeating it neither resolves the divergence
  // nor surfaces it any sooner, and it delays the escalation a human needs.
  void it('refuses to retry a real conflict', () => {
    for (const message of [
      'Updates were rejected because the tip of your current branch is behind',
      '! [rejected]        main -> main (non-fast-forward)',
      'error: failed to push some refs; fetch first',
      'remote: Permission to owner/repo.git denied to someone',
      'remote: Write access to repository not granted (403 Forbidden)',
    ]) {
      assert.equal(isRetryablePush(message), false, message)
    }
  })

  void it('retries what another attempt could actually fix', () => {
    for (const message of [
      'fatal: unable to access: Failed to connect to github.com port 443: Connection timed out',
      'error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly',
      'fatal: The remote end hung up unexpectedly: early EOF',
      'You have exceeded a secondary rate limit',
      'fatal: unable to access: The requested URL returned error: 503',
      'ssh: Could not resolve hostname github.com',
    ]) {
      assert.equal(isRetryablePush(message), true, message)
    }
  })

  // "Rejected" appearing anywhere wins: a rate-limited rejection is still a
  // rejection, and guessing wrong in this direction pushes over someone.
  void it('treats a rejection as fatal even when it mentions a rate limit', () => {
    assert.equal(isRetryablePush('rejected: rate limit exceeded, non-fast-forward'), false)
  })

  void it('does not retry something it simply does not recognise', () => {
    assert.equal(isRetryablePush('something nobody has seen before'), false)
  })
})

void describe('fixBranchFor', () => {
  void it('namespaces the branch to the run, so a retry never collides', () => {
    assert.equal(fixBranchFor('mtq0kgwt'), 'harbor/fix-mtq0kgwt')
    assert.notEqual(fixBranchFor('a'), fixBranchFor('b'))
  })

  void it('strips anything that would make an invalid ref', () => {
    assert.match(fixBranchFor('a b/c~d^e'), /^harbor\/fix-[A-Za-z0-9._-]+$/)
  })

  void it('never produces a bare prefix', () => {
    assert.equal(fixBranchFor(''), 'harbor/fix-run')
    assert.equal(fixBranchFor('!!!'), 'harbor/fix-run')
  })
})
