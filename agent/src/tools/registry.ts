/**
 * Tool registry and allowlist.
 *
 * The system prompt tells the model which tools exist. That is guidance, not a
 * control — a prompt-injected instruction inside a repository README could ask
 * for something the prompt never offered. So the allowlist is enforced here, at
 * the call boundary: an unregistered name cannot execute, whatever the model
 * was persuaded to ask for.
 *
 * The registry also wraps every call so that timing, input, and outcome land in
 * the event log without each tool re-implementing that.
 */
import type { EventBus } from '../events.js'

export class ToolDeniedError extends Error {
  readonly toolName: string

  constructor(toolName: string, reason: string) {
    super(`Tool "${toolName}" denied: ${reason}`)
    this.name = 'ToolDeniedError'
    this.toolName = toolName
  }
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  /** Tools that change infrastructure or repositories, for audit and gating. */
  mutating?: boolean
  /** Requires explicit human approval before it may run. */
  requiresApproval?: boolean
  run: (input: I) => Promise<O> | O
}

export interface RegistryOptions {
  bus?: EventBus
  /**
   * Names permitted to execute. A tool must be both registered AND allowed,
   * so a mistaken registration is not automatically a capability.
   */
  allow: readonly string[]
  /** Called before a tool marked requiresApproval runs. */
  approve?: (tool: ToolDefinition, input: unknown) => Promise<boolean> | boolean
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>()
  readonly #allow: ReadonlySet<string>
  readonly #bus: EventBus | undefined
  readonly #approve: RegistryOptions['approve']

  constructor(options: RegistryOptions) {
    this.#allow = new Set(options.allow)
    this.#bus = options.bus
    this.#approve = options.approve
  }

  register<I, O>(tool: ToolDefinition<I, O>): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    this.#tools.set(tool.name, tool as ToolDefinition)
    return this
  }

  /** Names that are both registered and allowed. */
  names(): string[] {
    return [...this.#tools.keys()].filter((name) => this.#allow.has(name)).sort()
  }

  has(name: string): boolean {
    return this.#tools.has(name) && this.#allow.has(name)
  }

  /**
   * Execute a tool by name. Every rejection path throws ToolDeniedError so the
   * agent loop can surface a refusal distinctly from a tool that ran and failed.
   */
  async call(name: string, input: unknown): Promise<unknown> {
    const tool = this.#tools.get(name)

    if (!tool) {
      this.#bus?.emit('tool_result', `Denied unknown tool: ${name}`, {
        tool: name,
        denied: 'unregistered',
      })
      throw new ToolDeniedError(name, 'not registered')
    }

    if (!this.#allow.has(name)) {
      this.#bus?.emit('tool_result', `Denied tool outside allowlist: ${name}`, {
        tool: name,
        denied: 'not_allowlisted',
      })
      throw new ToolDeniedError(name, 'not in the allowlist')
    }

    if (tool.requiresApproval) {
      const approved = (await this.#approve?.(tool, input)) ?? false
      if (!approved) {
        this.#bus?.emit('escalated', `Approval required for ${name}`, {
          tool: name,
        })
        throw new ToolDeniedError(name, 'human approval required')
      }
    }

    const startedAt = Date.now()
    this.#bus?.emit('tool_call', name, {
      tool: name,
      input,
      ...(tool.mutating ? { mutating: true } : {}),
    })

    try {
      const output = await tool.run(input)
      this.#bus?.emit(
        'tool_result',
        `${name} ok`,
        { tool: name, output },
        Date.now() - startedAt,
      )
      return output
    } catch (error) {
      this.#bus?.emit(
        'tool_result',
        `${name} failed`,
        {
          tool: name,
          error: error instanceof Error ? error.message : String(error),
        },
        Date.now() - startedAt,
      )
      throw error
    }
  }
}
