import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MAX_FILE_BYTES,
  RepoAccessError,
  loadRepoFiles,
  normalizeRepoUrl,
  readFiles,
  resolveInside,
} from './workspace.js'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

void describe('normalizeRepoUrl', () => {
  void it('accepts a plain GitHub URL, with or without .git', () => {
    for (const input of [
      'https://github.com/aarochu/Harbor',
      'https://github.com/aarochu/Harbor.git',
      'https://github.com/aarochu/Harbor/',
    ]) {
      const result = normalizeRepoUrl(input)
      assert.equal(result.url, 'https://github.com/aarochu/Harbor.git')
      assert.equal(result.owner, 'aarochu')
      assert.equal(result.repo, 'Harbor')
    }
  })

  // The repo URL is operator-pasted and not necessarily operator-authored, so
  // every one of these is a refusal rather than a best-effort attempt.
  void it('refuses non-https schemes', () => {
    for (const input of [
      'git@github.com:aarochu/Harbor.git',
      'file:///etc/passwd',
      'http://github.com/aarochu/Harbor',
      'ext::sh -c whoami',
    ]) {
      assert.throws(() => normalizeRepoUrl(input), RepoAccessError, input)
    }
  })

  void it('refuses hosts outside the allowlist', () => {
    assert.throws(
      () => normalizeRepoUrl('https://github.com.attacker.test/a/b'),
      RepoAccessError,
    )
  })

  void it('refuses credentials embedded in the URL', () => {
    assert.throws(
      () => normalizeRepoUrl('https://user:ghp_secretvalue@github.com/a/b'),
      RepoAccessError,
    )
  })

  void it('refuses anything that is not owner/repo', () => {
    assert.throws(() => normalizeRepoUrl('https://github.com/aarochu'), RepoAccessError)
    assert.throws(() => normalizeRepoUrl('https://github.com/a/b/tree/main/c'), RepoAccessError)
  })
})

void describe('resolveInside', () => {
  void it('resolves an ordinary repo-relative path', () => {
    const resolved = resolveInside(resolve('/repo'), 'src/app/main.py')
    assert.ok(resolved.endsWith(join('repo', 'src', 'app', 'main.py')))
  })

  void it('refuses traversal out of the clone', () => {
    for (const path of ['../secrets.txt', 'src/../../etc/passwd', 'a/b/../../../x']) {
      assert.throws(() => resolveInside(resolve('/repo'), path), RepoAccessError, path)
    }
  })

  void it('refuses absolute paths and NUL bytes', () => {
    assert.throws(() => resolveInside(resolve('/repo'), resolve('/etc/passwd')), RepoAccessError)
    assert.throws(() => resolveInside(resolve('/repo'), 'ok\0.txt'), RepoAccessError)
  })

  void it('allows a path that merely mentions .. inside a filename', () => {
    assert.doesNotThrow(() => resolveInside(resolve('/repo'), 'src/a..b.ts'))
  })
})

void describe('readFiles', () => {
  void it('reads requested files and omits the ones that are missing', async () => {
    const reads = await readFiles(join(FIXTURES, 'harbor-demo-clean'), [
      'requirements.txt',
      'does-not-exist.txt',
    ])

    assert.equal(reads.length, 1)
    assert.equal(reads[0]?.path, 'requirements.txt')
    assert.match(reads[0]?.content ?? '', /fastapi/)
    assert.equal(reads[0]?.truncated, false)
  })

  void it('truncates past the cap and says so', async () => {
    const reads = await readFiles(join(FIXTURES, 'harbor-demo-clean'), ['requirements.txt'], 10)

    assert.equal(reads[0]?.truncated, true)
    assert.equal(reads[0]?.content.length, 10)
    // The real size is still reported, so the agent knows what it did not see.
    assert.ok((reads[0]?.bytes ?? 0) > 10)
  })

  void it('refuses a traversal instead of reading through it', async () => {
    await assert.rejects(
      () => readFiles(join(FIXTURES, 'harbor-demo-clean'), ['../../package.json']),
      RepoAccessError,
    )
  })
})

void describe('loadRepoFiles', () => {
  void it('walks a repo into a POSIX-keyed map', async () => {
    const files = await loadRepoFiles(join(FIXTURES, 'harbor-demo-clean'))

    assert.ok(files.has('main.py'))
    assert.ok(files.has('requirements.txt'))
    assert.ok(files.has('.env.example'))
    for (const path of files.keys()) {
      assert.ok(!path.includes('\\'), `key should be POSIX: ${path}`)
    }
  })

  void it('honours the file-count cap', async () => {
    const files = await loadRepoFiles(join(FIXTURES, 'harbor-demo-clean'), { maxFiles: 1 })
    assert.equal(files.size, 1)
  })

  void it('skips files over the byte cap rather than truncating them silently', async () => {
    const files = await loadRepoFiles(join(FIXTURES, 'harbor-demo-clean'), { maxFileBytes: 5 })
    assert.equal(files.size, 0)
  })

  void it('has a per-file cap large enough for real source files', () => {
    assert.ok(MAX_FILE_BYTES >= 64 * 1024)
  })
})
