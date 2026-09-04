import { BedrockModel, type Model } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'

/**
 * Harbor talks to Claude through whichever provider is configured.
 *
 * Preference order:
 *   1. ANTHROPIC_API_KEY -> Anthropic direct
 *   2. otherwise         -> Amazon Bedrock, the Strands default (runs on AWS credits)
 *
 * Credential values are read from the environment and never logged.
 *
 * Cost control: this project runs on a fixed $100 AWS credit balance, so both
 * paths cap output tokens and enable prompt caching. A deploy loop re-sends a
 * growing transcript on every turn; without caching, the same repo profile and
 * log excerpts get re-billed at full input price on every turn.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.HARBOR_MAX_TOKENS ?? 4096)

export function createModel(): Model {
  const modelId = process.env.HARBOR_MODEL_ID

  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicModel({
      modelId: modelId ?? 'claude-sonnet-4-6',
      maxTokens: MAX_OUTPUT_TOKENS,
      cacheConfig: {},
    })
  }

  return new BedrockModel({
    modelId: modelId ?? 'global.anthropic.claude-sonnet-4-6',
    region: process.env.AWS_REGION ?? 'us-east-1',
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheConfig: {},
  })
}

/** Which provider createModel() will pick, for startup logging. Never includes a secret. */
export function describeProvider(): string {
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'bedrock'
}
