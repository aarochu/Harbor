import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createModel, describeProvider } from './model.js'

const TOUCHED = ['ANTHROPIC_API_KEY', 'HARBOR_MODEL_ID', 'AWS_REGION'] as const
const original = new Map(TOUCHED.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Read a model's config without caring which provider produced it. */
function configOf(model: ReturnType<typeof createModel>): Record<string, unknown> {
  return model.getConfig() as unknown as Record<string, unknown>
}

void describe('describeProvider', () => {
  void it('reports anthropic when an Anthropic key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
    assert.equal(describeProvider(), 'anthropic')
  })

  void it('falls back to bedrock when no Anthropic key is set', () => {
    delete process.env.ANTHROPIC_API_KEY
    assert.equal(describeProvider(), 'bedrock')
  })

  void it('never leaks the key value', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
    assert.doesNotMatch(describeProvider(), /test-key-not-real/)
  })
})

void describe('createModel', () => {
  void it('selects a Claude model on Bedrock by default', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.HARBOR_MODEL_ID
    const config = configOf(createModel())
    assert.match(String(config.modelId), /anthropic/)
  })

  void it('selects Anthropic when a key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
    delete process.env.HARBOR_MODEL_ID
    const config = configOf(createModel())
    assert.equal(config.modelId, 'claude-sonnet-4-6')
  })

  void it('honours a HARBOR_MODEL_ID override on both providers', () => {
    process.env.HARBOR_MODEL_ID = 'custom-model-id'

    delete process.env.ANTHROPIC_API_KEY
    assert.equal(configOf(createModel()).modelId, 'custom-model-id')

    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
    assert.equal(configOf(createModel()).modelId, 'custom-model-id')
  })

  // Cost guards: this project runs on a fixed credit balance, so an uncapped
  // response or an uncached transcript is a budget bug, not a style nit.
  void it('caps output tokens on every provider', () => {
    delete process.env.ANTHROPIC_API_KEY
    assert.equal(typeof configOf(createModel()).maxTokens, 'number')

    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
    assert.equal(typeof configOf(createModel()).maxTokens, 'number')
  })

  void it('enables prompt caching on every provider', () => {
    delete process.env.ANTHROPIC_API_KEY
    assert.ok(configOf(createModel()).cacheConfig, 'bedrock cacheConfig missing')

    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
    assert.ok(configOf(createModel()).cacheConfig, 'anthropic cacheConfig missing')
  })
})
