import { describe, it, expect } from 'vitest'

import { dedupeStreamingMessageIds } from '../src/parser.js'
import type { JournalEntry } from '../src/types.js'

function userEntry(text: string, ts: string): JournalEntry {
  return {
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: text },
  }
}

function assistantEntry(opts: {
  id?: string
  ts: string
  content?: Array<{ type: string; [key: string]: unknown }>
  inputTokens?: number
  outputTokens?: number
}): JournalEntry {
  return {
    type: 'assistant',
    timestamp: opts.ts,
    message: {
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      id: opts.id,
      content: (opts.content ?? []) as never,
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: opts.outputTokens ?? 0,
      },
    },
  }
}

describe('dedupeStreamingMessageIds', () => {
  it('keeps the last occurrence of each message id within the file', () => {
    const partialStart = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:00Z', content: [] })
    const partialMid   = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:01Z', content: [] })
    const finalStop    = assistantEntry({
      id: 'msg_A',
      ts: '2026-04-25T10:00:02Z',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__playwright__browser_navigate', input: {} }],
      inputTokens: 1234,
      outputTokens: 89,
    })

    const result = dedupeStreamingMessageIds([partialStart, partialMid, finalStop])

    expect(result).toHaveLength(1)
    expect(result[0]).toBe(finalStop)
  })

  it('preserves entries without a message id (user messages, tool results, sidechains)', () => {
    const user1 = userEntry('hello', '2026-04-25T10:00:00Z')
    const stream1 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:01Z' })
    const stream2 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:02Z' })
    const user2 = userEntry('next', '2026-04-25T10:01:00Z')
    const stream3 = assistantEntry({ id: 'msg_B', ts: '2026-04-25T10:01:01Z' })

    const result = dedupeStreamingMessageIds([user1, stream1, stream2, user2, stream3])

    expect(result).toEqual([user1, stream2, user2, stream3])
  })

  it('returns the input untouched when no assistant message has an id', () => {
    const entries: JournalEntry[] = [
      userEntry('a', '2026-04-25T10:00:00Z'),
      assistantEntry({ ts: '2026-04-25T10:00:01Z' }),
      userEntry('b', '2026-04-25T10:00:02Z'),
    ]
    const result = dedupeStreamingMessageIds(entries)
    expect(result).toEqual(entries)
  })

  it('keeps relative ordering between distinct ids', () => {
    const a1 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:00Z' })
    const b1 = assistantEntry({ id: 'msg_B', ts: '2026-04-25T10:00:01Z' })
    const a2 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:02Z' })
    const b2 = assistantEntry({ id: 'msg_B', ts: '2026-04-25T10:00:03Z' })

    const result = dedupeStreamingMessageIds([a1, b1, a2, b2])

    expect(result).toEqual([a2, b2])
  })
})
