/**
 * Harbor — Strands SDK smoke test.
 *
 * Proves the toolchain end to end: the SDK loads, a custom tool is registered,
 * the model provider is reachable, and the agent chooses the tool on its own.
 *
 * Run: npm run dev
 *
 * This file is scaffolding. The real Harbor agent (deploy loop, GitHub tools,
 * Render tools, observation tools) replaces it in M0 — see docs/TODO.md.
 */
import { Agent, tool } from '@strands-agents/sdk'
import z from 'zod'
import { createModel, describeProvider } from './model.js'

const letterCounter = tool({
  name: 'letter_counter',
  description:
    'Count occurrences of a specific letter in a word. Performs case-insensitive matching.',
  inputSchema: z
    .object({
      word: z.string().describe('The input word to search in'),
      letter: z.string().describe('The specific letter to count'),
    })
    .refine((data) => data.letter.length === 1, {
      message: "The 'letter' parameter must be a single character",
    }),
  callback: ({ word, letter }) => {
    const target = letter.toLowerCase()
    let count = 0
    for (const char of word.toLowerCase()) {
      if (char === target) count++
    }
    return `The letter '${letter}' appears ${count} time(s) in '${word}'`
  },
})

const agent = new Agent({
  model: createModel(),
  tools: [letterCounter],
})

console.log(`[harbor] model provider: ${describeProvider()}`)

const result = await agent.invoke(
  'Tell me how many letter R\'s are in the word "strawberry"',
)

console.log(result.lastMessage)
