import { describe, expect, it } from 'vitest'

import { decodeCodebuff, toObservations, type CodebuffChatMessage } from '../../src/providers/codebuff/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import { sourceRefFingerprint } from '../../src/fingerprint.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'codebuff', sourceRef: '/data/manicode/projects/alpha/chats/2026-04-14T10-00-00.000Z' }

const MESSAGES: CodebuffChatMessage[] = [
  { id: 'u1', variant: 'user', content: 'implement the feature', timestamp: '2026-04-14T10:00:10.000Z' },
  {
    id: 'a1',
    variant: 'ai',
    timestamp: '2026-04-14T10:00:30.000Z',
    credits: 42,
    metadata: {
      runState: { sessionState: { mainAgentState: { agentType: 'base2' } } },
    },
    blocks: [
      { type: 'tool', toolName: 'read_files', input: {} },
      { type: 'tool', toolName: 'str_replace', input: {} },
      { type: 'tool', toolName: 'run_terminal_command', input: { command: 'npm test' } },
      { type: 'tool', toolName: 'suggest_followups', input: {} },
    ],
  },
  { id: 'u2', variant: 'user', content: 'fix the bug', timestamp: '2026-04-14T10:01:00.000Z' },
  {
    id: 'a2',
    variant: 'ai',
    timestamp: '2026-04-14T10:01:30.000Z',
    credits: 10,
    metadata: {
      model: 'claude-haiku-4-5-20251001',
      usage: {
        inputTokens: 5000,
        outputTokens: 2000,
        cacheCreationInputTokens: 1000,
        cacheReadInputTokens: 500,
      },
    },
  },
  {
    id: 'a3',
    variant: 'ai',
    timestamp: '2026-04-14T10:02:00.000Z',
    credits: 7,
    metadata: {
      runState: {
        sessionState: {
          mainAgentState: {
            messageHistory: [
              { role: 'user' },
              {
                role: 'assistant',
                providerOptions: {
                  codebuff: {
                    model: 'openai/gpt-4o',
                    usage: {
                      prompt_tokens: 2000,
                      completion_tokens: 800,
                      prompt_tokens_details: { cached_tokens: 400 },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
  // Duplicate id -> must drop.
  { id: 'a1', variant: 'ai', timestamp: '2026-04-14T10:02:30.000Z', credits: 5 },
  // No credits, no tokens -> must skip.
  { id: 'a4', variant: 'ai', content: 'mode-divider', timestamp: '2026-04-14T10:03:00.000Z' },
]

describe('codebuff rich decode (moved to @codeburn/core)', () => {
  it('decodes assistant calls into cost-free rich calls, preserving credits for host-side fallback', () => {
    const { calls } = decodeCodebuff({ records: MESSAGES, context })
    expect(calls).toHaveLength(3)

    const [first, second, third] = calls
    // No host-computed pricing crosses into the decode layer.
    expect(first).not.toHaveProperty('costUSD')
    expect(first).not.toHaveProperty('costBasis')

    expect(first!.model).toBe('codebuff-base2')
    expect(first!.inputTokens).toBe(0)
    expect(first!.outputTokens).toBe(0)
    expect(first!.tools).toEqual(['Read', 'Edit', 'Bash'])
    expect(first!.rawBashCommands).toEqual(['npm test'])
    expect(first!.credits).toBe(42)
    expect(first!.userMessage).toBe('implement the feature')
    // The dedup key threads a FINGERPRINT of the chat directory (the source
    // ref), never the raw absolute path: dedupKey ships on the envelope, so
    // the raw-path form (`codebuff:${context.sourceRef}:a1`) was the defect —
    // do not restore it. The expectation is DERIVED from the same fingerprint
    // function the decoder uses, so the golden pins the contract, not a
    // literal.
    expect(first!.deduplicationKey).toBe(`codebuff:${sourceRefFingerprint(context.privacyKey, context.sourceRef)}:a1`)

    expect(second!.model).toBe('claude-haiku-4-5-20251001')
    expect(second!.inputTokens).toBe(5000)
    expect(second!.outputTokens).toBe(2000)
    expect(second!.cacheCreationInputTokens).toBe(1000)
    expect(second!.cacheReadInputTokens).toBe(500)
    expect(second!.cachedInputTokens).toBe(500)
    expect(second!.credits).toBe(10)

    // History fallback usage.
    expect(third!.model).toBe('openai/gpt-4o')
    expect(third!.inputTokens).toBe(2000)
    expect(third!.outputTokens).toBe(800)
    expect(third!.cacheReadInputTokens).toBe(400)
    expect(third!.credits).toBe(7)
    // The previous message was assistant, so no pending user message.
    expect(third!.userMessage).toBe('')
  })

  it('threads a live seenKeys set so a repeated id across passes drops', () => {
    const seen = new Set<string>()
    const first = decodeCodebuff({ records: MESSAGES.slice(0, 2), context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    const again = decodeCodebuff({ records: MESSAGES.slice(0, 2), context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const { calls } = decodeCodebuff({ records: MESSAGES, context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/t/alpha', calls },
      { privacyKey: 'test-privacy-key', provider: 'codebuff' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    const toolNames = sessions.flatMap(s => s.calls.flatMap(c => c.toolNames))
    expect(toolNames).toContain('Read')
    expect(toolNames).toContain('Edit')
    expect(toolNames).toContain('Bash')
  })
})
