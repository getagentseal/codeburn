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
  it('keeps the last occurrence content of each message id but preserves first timestamp', () => {
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
    // Content (tool_use blocks, usage) comes from the last occurrence
    expect((result[0] as typeof finalStop).message).toEqual(finalStop.message)
    // Timestamp comes from the first occurrence so date bucketing reflects when the call started
    expect(result[0]!.timestamp).toBe('2026-04-25T10:00:00Z')
  })

  it('preserves entries without a message id (user messages, tool results, sidechains)', () => {
    const user1 = userEntry('hello', '2026-04-25T10:00:00Z')
    const stream1 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:01Z' })
    const stream2 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:02Z' })
    const user2 = userEntry('next', '2026-04-25T10:01:00Z')
    const stream3 = assistantEntry({ id: 'msg_B', ts: '2026-04-25T10:01:01Z' })

    const result = dedupeStreamingMessageIds([user1, stream1, stream2, user2, stream3])

    expect(result).toHaveLength(4)
    expect(result[0]).toBe(user1)
    expect(result[2]).toBe(user2)
    expect(result[3]).toBe(stream3)
    // The kept stream entry carries stream2's body but stream1's timestamp
    expect((result[1] as typeof stream2).message).toEqual(stream2.message)
    expect(result[1]!.timestamp).toBe('2026-04-25T10:00:01Z')
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

  it('keeps relative ordering between distinct ids and preserves each first timestamp', () => {
    const a1 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:00Z' })
    const b1 = assistantEntry({ id: 'msg_B', ts: '2026-04-25T10:00:01Z' })
    const a2 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:02Z' })
    const b2 = assistantEntry({ id: 'msg_B', ts: '2026-04-25T10:00:03Z' })

    const result = dedupeStreamingMessageIds([a1, b1, a2, b2])

    expect(result).toHaveLength(2)
    expect((result[0] as typeof a2).message).toEqual(a2.message)
    expect(result[0]!.timestamp).toBe('2026-04-25T10:00:00Z')
    expect((result[1] as typeof b2).message).toEqual(b2.message)
    expect(result[1]!.timestamp).toBe('2026-04-25T10:00:01Z')
  })

  it('does not mutate the original entries (returns a new wrapper for the kept entry)', () => {
    const a1 = assistantEntry({ id: 'msg_A', ts: '2026-04-25T10:00:00Z', content: [] })
    const a2 = assistantEntry({
      id: 'msg_A',
      ts: '2026-04-25T10:00:02Z',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
    })

    dedupeStreamingMessageIds([a1, a2])

    expect(a1.timestamp).toBe('2026-04-25T10:00:00Z')
    expect(a2.timestamp).toBe('2026-04-25T10:00:02Z')
  })
})
