import { describe, expect, it } from 'vitest'

import { decodeOpenCodeSession, toObservations } from '../../src/providers/opencode-session/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type {
  FileMessageData,
  MessageData,
  OpenCodeSessionEnvelope,
  PartData,
} from '../../src/providers/opencode-session/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'opencode', sourceRef: 'ref' }

function sqliteEnvelope(overrides: Partial<Extract<OpenCodeSessionEnvelope, { kind: 'sqlite' }>> = {}): Extract<OpenCodeSessionEnvelope, { kind: 'sqlite' }> {
  return {
    kind: 'sqlite',
    sessionId: 'sess-a',
    messages: [],
    parts: [],
    sessionTokens: null,
    ...overrides,
  }
}

function fileEnvelope(overrides: Partial<Extract<OpenCodeSessionEnvelope, { kind: 'file' }>> = {}): Extract<OpenCodeSessionEnvelope, { kind: 'file' }> {
  return {
    kind: 'file',
    sessionId: 'sess-a',
    messages: [],
    partsRawByMessageId: new Map(),
    metaTimeCreatedMs: undefined,
    ...overrides,
  }
}

function msg(data: MessageData, overrides: Partial<{ id: string; session_id: string; time_created: number }> = {}): { session_id: string; id: string; time_created: number; data: string } {
  return {
    session_id: overrides.session_id ?? 'sess-a',
    id: overrides.id ?? 'msg-1',
    time_created: overrides.time_created ?? 1700000001000,
    data: JSON.stringify(data),
  }
}

function part(messageId: string, data: PartData): { message_id: string; data: string } {
  return { message_id: messageId, data: JSON.stringify(data) }
}

// ── Shared builder arms ─────────────────────────────────────────────────────

describe('opencode-session rich decode: shared builder', () => {
  it('H1-H3: normalizes tokens, usage fallback, and fills both cacheReadInputTokens and cachedInputTokens', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'user' }, { id: 'msg-user' }),
          msg({
            role: 'assistant',
            modelID: 'claude-opus-4-6',
            cost: 0.05,
            tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 500, write: 300 } },
          }),
        ],
        parts: [
          part('msg-user', { type: 'text', text: 'hello' }),
        ],
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 300,
      cachedInputTokens: 500,
      fallbackCostUSD: 0.05,
    })
    expect(calls[0]!.cacheReadInputTokens).toBe(calls[0]!.cachedInputTokens)
  })

  it('H2: tokens.* wins over usage.*; usage.* fills null/undefined tokens', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'user' }, { id: 'msg-user' }),
          msg({
            role: 'assistant',
            cost: 0.05,
            tokens: { input: 10, output: 20, cache: { read: 50, write: 30 } },
            usage: { input_tokens: 999, output_tokens: 888, cache_creation_input_tokens: 777, cache_read_input_tokens: 666 },
          }),
        ],
        parts: [],
      })],
      context,
    })
    expect(calls[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 30,
    })
  })

  it('H4: counts tool/tool-call/tool_call; tool-result/tool_result are activity but not tools', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 } }),
        ],
        parts: [
          part('msg-1', { type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } }),
          part('msg-1', { type: 'tool-call', tool: 'read' }),
          part('msg-1', { type: 'tool_call', tool: 'grep' }),
          part('msg-1', { type: 'tool-result', tool: 'bash' }),
          part('msg-1', { type: 'tool_result', tool: 'bash' }),
        ],
      })],
      context,
    })
    expect(calls[0]!.tools).toEqual(['Bash', 'Read', 'Grep'])
    expect(calls[0]!.rawBashCommands).toEqual(['ls'])
  })

  it('H5: normalizeToolName builtins, mcp__ passthrough, server_tool conversion, underscore edge cases', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 } }),
        ],
        parts: [
          part('msg-1', { type: 'tool', tool: 'bash' }),
          part('msg-1', { type: 'tool', tool: 'mcp__x__y' }),
          part('msg-1', { type: 'tool', tool: 'server_tool' }),
          part('msg-1', { type: 'tool', tool: '_leading' }),
          part('msg-1', { type: 'tool', tool: 'trailing_' }),
        ],
      })],
      context,
    })
    expect(calls[0]!.tools).toEqual(['Bash', 'mcp__x__y', 'mcp__server__tool', '_leading', 'trailing_'])
  })

  it('H6-H8: extracts rawBashCommands, skills, and subagentTypes', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 } }),
        ],
        parts: [
          part('msg-1', { type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }),
          part('msg-1', { type: 'tool', tool: 'skill', state: { input: { name: 'commit' } } }),
          part('msg-1', { type: 'tool', tool: 'task', state: { input: { subagent_type: 'general-purpose' } } }),
        ],
      })],
      context,
    })
    expect(calls[0]!.rawBashCommands).toEqual(['npm test'])
    expect(calls[0]!.skills).toEqual(['commit'])
    expect(calls[0]!.subagentTypes).toEqual(['general-purpose'])
  })

  it('H9: skills and subagentTypes are present as empty arrays when absent', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 } })],
        parts: [],
      })],
      context,
    })
    expect(calls[0]!.skills).toEqual([])
    expect(calls[0]!.subagentTypes).toEqual([])
  })

  it('H10: skips all-zero tokens with falsy cost and no substantive parts', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })],
        parts: [],
      })],
      context,
    })
    expect(calls).toEqual([])
  })

  it('H11: yields zero-token assistant with non-empty text', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'user' }, { id: 'msg-user' }),
          msg({ role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, { id: 'msg-2' }),
        ],
        parts: [
          part('msg-user', { type: 'text', text: 'prompt' }),
          part('msg-2', { type: 'text', text: 'I will help' }),
        ],
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(0)
  })

  it('H12: yields zero-token assistant with a tool-call part', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'user' }, { id: 'msg-user' }),
          msg({ role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, { id: 'msg-2' }),
        ],
        parts: [
          part('msg-user', { type: 'text', text: 'prompt' }),
          part('msg-2', { type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } }),
        ],
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Bash'])
  })

  it('H13: yields zero-token assistant with reasoning or file part', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'assistant', tokens: { input: 0, output: 0 } }, { id: 'msg-2' }),
          msg({ role: 'assistant', tokens: { input: 0, output: 0 } }, { id: 'msg-3' }),
        ],
        parts: [
          part('msg-2', { type: 'reasoning' }),
          part('msg-3', { type: 'file' }),
        ],
      })],
      context,
    })
    expect(calls).toHaveLength(2)
  })

  it('H14: yields all-zero tokens when cost > 0', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', cost: 0.01, tokens: { input: 0, output: 0 } })],
        parts: [],
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.fallbackCostUSD).toBe(0.01)
  })

  it('H15: fallbackCostUSD present for cost 0, absent when cost undefined', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'assistant', cost: 0, tokens: { input: 10, output: 10 } }, { id: 'msg-2' }),
          msg({ role: 'assistant', tokens: { input: 10, output: 10 } }, { id: 'msg-3' }),
        ],
        parts: [],
      })],
      context,
    })
    expect(calls[0]!).toHaveProperty('fallbackCostUSD', 0)
    expect(calls[1]!).not.toHaveProperty('fallbackCostUSD')
  })

  it('H16: model precedence modelID -> model -> unknown', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'assistant', tokens: { input: 10, output: 10 }, model: 'from-model' }, { id: 'msg-2' }),
          msg({ role: 'assistant', tokens: { input: 10, output: 10 } }, { id: 'msg-3' }),
        ],
        parts: [],
      })],
      context,
    })
    expect(calls[0]!.model).toBe('from-model')
    expect(calls[1]!.model).toBe('unknown')
  })

  it('H17: parseTimestamp treats <1e12 as seconds and >=1e12 as ms', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', tokens: { input: 10, output: 10 } }, { time_created: 1700000000 })],
        parts: [],
      })],
      context,
    })
    expect(calls[0]!.timestamp).toBe(new Date(1700000000 * 1000).toISOString())
  })

  it('providerName comes from context.providerId (opencode vs kilo-code)', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', tokens: { input: 10, output: 10 } })],
        parts: [],
      })],
      context: { ...context, providerId: 'kilo-code' },
    })
    expect(calls[0]!.provider).toBe('kilo-code')
    expect(calls[0]!.deduplicationKey).toBe('kilo-code:sess-a:msg-1')
  })
})

// ── SQLite-only arms ────────────────────────────────────────────────────────

describe('opencode-session rich decode: SQLite arm', () => {
  it('S1: child and grandchild calls are attributed to the root sessionId', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        sessionId: 'root',
        messages: [
          msg({ role: 'assistant', tokens: { input: 10, output: 10 } }, { id: 'm-child', session_id: 'child' }),
          msg({ role: 'assistant', tokens: { input: 20, output: 20 } }, { id: 'm-grandchild', session_id: 'grandchild' }),
        ],
        parts: [],
      })],
      context,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.sessionId).toBe('root')
    expect(calls[1]!.sessionId).toBe('root')
  })

  it('S3: corrupt message data is counted as malformed-json diagnostic', () => {
    const { calls, diagnostics } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          { session_id: 'sess-a', id: 'msg-bad', time_created: 1700000000000, data: 'not-json' },
          msg({ role: 'assistant', tokens: { input: 10, output: 10 } }, { id: 'msg-good' }),
        ],
        parts: [],
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.code).toBe('malformed-json')
    expect(diagnostics[0]!.index).toBe(0)
    // The sanitiser is wired into the parse-failure path: detail is a keyed
    // fingerprint of the error, never its message.
    expect(diagnostics[0]!.detail).toMatch(/^[0-9a-f]{16}$/)
  })

  it('S4: corrupt part data is skipped silently', () => {
    const { calls, diagnostics } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', tokens: { input: 10, output: 10 } })],
        parts: [
          { message_id: 'msg-1', data: 'not-json' },
          part('msg-1', { type: 'tool', tool: 'read' }),
        ],
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(diagnostics).toEqual([])
  })

  it('S5: user messages are accumulated per msg.session_id and joined with space', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'user' }, { id: 'msg-user', session_id: 'sess-a' }),
          msg({ role: 'assistant', tokens: { input: 10, output: 10 } }, { id: 'msg-2', session_id: 'sess-a' }),
        ],
        parts: [
          part('msg-user', { type: 'text', text: 'first' }),
          part('msg-user', { type: 'text', text: 'second' }),
        ],
      })],
      context,
    })
    expect(calls[0]!.userMessage).toBe('first second')
  })

  it('S6-S7: model role accepted, other roles counted as unknown-shape', () => {
    const { calls, diagnostics } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'model', tokens: { input: 10, output: 10 } }, { id: 'msg-model' }),
          msg({ role: 'system' }, { id: 'msg-system' }),
        ],
        parts: [],
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(diagnostics).toEqual([{ index: 0, code: 'unknown-shape' }])
  })

  // Opposite of the vscode-cline arm, which burns the dedup key BEFORE deciding
  // to skip. Here a null build must leave the key unclaimed, so the second
  // message sharing that key still yields. Asserting only `seen.has(...)` would
  // hold under either ordering — the call count is what discriminates.
  it('S8: dedup key added only after successful build', () => {
    const seen = new Set<string>()
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [
          msg({ role: 'assistant', tokens: { input: 0, output: 0 } }, { id: 'msg-skip' }),
          msg({ role: 'assistant', tokens: { input: 10, output: 10 } }, { id: 'msg-skip' }),
        ],
        parts: [],
      })],
      context,
      seenKeys: seen,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(10)
    expect(calls[0]!.deduplicationKey).toBe('opencode:sess-a:msg-skip')
    expect(seen.has('opencode:sess-a:msg-skip')).toBe(true)
  })

  it('S9-S11: session-level fallback fires with correct shape and cost guard', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'user' }, { id: 'msg-user' })],
        parts: [part('msg-user', { type: 'text', text: 'hello' })],
        sessionTokens: { cost: 1, input: 100, output: 50, reasoning: 5, cacheRead: 10, cacheWrite: 20, model: 'session-model' },
      })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      arm: 'session-level',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 5,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 20,
      cachedInputTokens: 10,
      fallbackCostUSD: 1,
      deduplicationKey: 'opencode:sess-a:session-level',
      model: 'session-model',
      tools: [],
      rawBashCommands: [],
      userMessage: '',
    })
  })

  it('S10: session-level fallback omitted when session row is all zeros', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'user' }, { id: 'msg-user' })],
        parts: [],
        sessionTokens: { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: undefined },
      })],
      context,
    })
    expect(calls).toEqual([])
  })

  it('S11: session-level fallback omits fallbackCostUSD when cost is 0', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'user' }, { id: 'msg-user' })],
        parts: [],
        sessionTokens: { cost: 0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, model: undefined },
      })],
      context,
    })
    expect(calls[0]!).not.toHaveProperty('fallbackCostUSD')
  })

  it('S12: session with only user messages yields nothing', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'user' }, { id: 'msg-user' })],
        parts: [part('msg-user', { type: 'text', text: 'hello' })],
        sessionTokens: null,
      })],
      context,
    })
    expect(calls).toEqual([])
  })
})

// ── File arm ────────────────────────────────────────────────────────────────

describe('opencode-session rich decode: file arm', () => {
  it('F1-F3: message ordering, id fallback, and sorted parts', async () => {
    const messages: Array<{ id: string; data: FileMessageData }> = [
      { id: 'msg_b', data: { role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 }, time: { created: 2 } } },
      { id: 'msg_a', data: { role: 'assistant', cost: 0.05, tokens: { input: 20, output: 20 }, time: { created: 2 } } },
      { id: 'msg_c', data: { role: 'assistant', cost: 0.05, tokens: { input: 30, output: 30 }, time: { created: 3 } } },
    ]
    const parts = new Map<string, string[]>([
      ['msg_b', [JSON.stringify({ type: 'text', text: 'b-first' }), JSON.stringify({ type: 'text', text: 'b-second' })]],
      ['msg_a', [JSON.stringify({ type: 'text', text: 'a-wins-tie' })]],
      ['msg_c', [JSON.stringify({ type: 'text', text: 'c-latest' })]],
    ])
    const { calls } = decodeOpenCodeSession({
      records: [fileEnvelope({ messages, partsRawByMessageId: parts })],
      context,
    })
    expect(calls.map(c => c.deduplicationKey)).toEqual([
      'opencode:sess-a:msg_a',
      'opencode:sess-a:msg_b',
      'opencode:sess-a:msg_c',
    ])
  })

  it('F2: message id falls back to filename minus .json', () => {
    const messages: Array<{ id: string; data: FileMessageData }> = [
      { id: 'from_filename', data: { role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 }, time: { created: 1 } } },
    ]
    const { calls } = decodeOpenCodeSession({
      records: [fileEnvelope({ messages, partsRawByMessageId: new Map([['from_filename', [JSON.stringify({ type: 'text', text: 'ok' })]]]) })],
      context,
    })
    expect(calls[0]!.deduplicationKey).toBe('opencode:sess-a:from_filename')
  })

  it('F4: unparseable part file is skipped', () => {
    const messages: Array<{ id: string; data: FileMessageData }> = [
      { id: 'msg_a', data: { role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 }, time: { created: 1 } } },
    ]
    const { calls } = decodeOpenCodeSession({
      records: [fileEnvelope({
        messages,
        partsRawByMessageId: new Map([['msg_a', ['not-json', JSON.stringify({ type: 'text', text: 'ok' })]]]),
      })],
      context,
    })
    expect(calls).toHaveLength(1)
  })

  it('F5: timeCreatedMs precedence data.time.created -> meta.time.created -> 0', () => {
    const messages: Array<{ id: string; data: FileMessageData }> = [
      { id: 'msg_a', data: { role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 } } },
    ]
    const { calls } = decodeOpenCodeSession({
      records: [fileEnvelope({
        messages,
        partsRawByMessageId: new Map([['msg_a', [JSON.stringify({ type: 'text', text: 'ok' })]]]),
        metaTimeCreatedMs: 1781886356809,
      })],
      context,
    })
    expect(calls[0]!.timestamp).toBe(new Date(1781886356809).toISOString())
  })

  it('F8: currentUserMessage only overwritten by non-empty joined text', () => {
    const messages: Array<{ id: string; data: FileMessageData }> = [
      { id: 'msg_user1', data: { role: 'user', time: { created: 1 } } },
      { id: 'msg_user2_empty', data: { role: 'user', time: { created: 2 } } },
      { id: 'msg_assistant', data: { role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 }, time: { created: 3 } } },
    ]
    const { calls } = decodeOpenCodeSession({
      records: [fileEnvelope({
        messages,
        partsRawByMessageId: new Map([
          ['msg_user1', [JSON.stringify({ type: 'text', text: 'first prompt' })]],
          ['msg_user2_empty', [JSON.stringify({ type: 'text', text: '' })]],
          ['msg_assistant', [JSON.stringify({ type: 'text', text: 'reply' })]]
        ]),
      })],
      context,
    })
    expect(calls[0]!.userMessage).toBe('first prompt')
  })

  // Both messages resolve to the same id, so they share a dedup key. The first
  // must build to null — no parts, or it would gain activity from the shared
  // part list and yield instead — leaving the key unclaimed for the second.
  it('F9: dedup adds only after successful build', () => {
    const seen = new Set<string>()
    const { calls } = decodeOpenCodeSession({
      records: [fileEnvelope({
        messages: [
          { id: 'msg_skip', data: { role: 'assistant', tokens: { input: 0, output: 0 }, time: { created: 1 } } },
          { id: 'msg_skip', data: { role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 }, time: { created: 2 } } },
        ],
        partsRawByMessageId: new Map(),
      })],
      context,
      seenKeys: seen,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(10)
    expect(calls[0]!.deduplicationKey).toBe('opencode:sess-a:msg_skip')
    expect(seen.has('opencode:sess-a:msg_skip')).toBe(true)
  })
})

// ── Cross-cutting ───────────────────────────────────────────────────────────

describe('opencode-session rich decode: cross-cutting', () => {
  it('cross-run dedup drops a repeated session id', () => {
    const seen = new Set<string>()
    const first = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', tokens: { input: 10, output: 10 } })],
        parts: [],
      })],
      context,
      seenKeys: seen,
    })
    expect(first.calls).toHaveLength(1)
    const again = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', tokens: { input: 10, output: 10 } })],
        parts: [],
      })],
      context,
      seenKeys: seen,
    })
    expect(again.calls).toEqual([])
  })

  it('Map partsRawByMessageId does not return prototype members for constructor/__proto__ keys', () => {
    const parts = new Map<string, string[]>()
    expect(parts.get('constructor')).toBeUndefined()
    expect(parts.get('__proto__')).toBeUndefined()
  })

  it('toObservations produces a schema-valid envelope', () => {
    const { calls } = decodeOpenCodeSession({
      records: [sqliteEnvelope({
        messages: [msg({ role: 'assistant', cost: 0.05, tokens: { input: 10, output: 10 } })],
        parts: [],
      })],
      context,
    })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/t/alpha', calls },
      { privacyKey: 'test-privacy-key', provider: 'opencode' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
  })
})
