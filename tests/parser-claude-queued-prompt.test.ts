import { describe, expect, it } from 'vitest'

import { compactEntry, groupIntoTurns } from '../src/parser.js'
import type { JournalEntry } from '../src/types.js'

function user(timestamp: string, content: string): JournalEntry {
  return {
    type: 'user',
    timestamp,
    sessionId: 'session-1',
    message: { role: 'user', content },
  }
}

function assistant(timestamp: string, id: string): JournalEntry {
  return {
    type: 'assistant',
    timestamp,
    sessionId: 'session-1',
    message: {
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      id,
      content: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }
}

function attachment(timestamp: string, type: string, commandMode: string, prompt: unknown): JournalEntry {
  return {
    type: 'attachment',
    timestamp,
    sessionId: 'session-1',
    attachment: { type, commandMode, prompt, discarded: 'large unused payload' },
  }
}

describe('Claude queued human prompts', () => {
  it('keeps a bounded queued prompt while dropping unrelated attachment data', () => {
    const raw = attachment('2026-07-01T10:00:03Z', 'queued_command', 'prompt', [
      { type: 'image', data: 'ignored' },
      { type: 'text', text: '  please continue the task  ' },
      { type: 'text', text: 'later text is not the first text' },
    ])

    const compacted = compactEntry(raw)
    const saved = compacted['attachment'] as Record<string, unknown>

    expect(saved).toEqual({
      type: 'queued_command',
      commandMode: 'prompt',
      prompt: '  please continue the task  ',
    })

    const longPrompt = attachment('2026-07-01T10:00:03Z', 'queued_command', 'prompt', 'p'.repeat(5000))
    const longSaved = compactEntry(longPrompt)['attachment'] as Record<string, unknown>
    expect(longSaved['prompt']).toBe('p'.repeat(2000))

    const unrelated = compactEntry(attachment('2026-07-01T10:00:03Z', 'queued_command', 'task-notification', 'finished'))
    expect(unrelated['attachment']).toBeUndefined()
  })

  it('starts a separate turn for a typed queued prompt and ignores other attachments', () => {
    const entries = [
      user('2026-07-01T10:00:00Z', 'implement the parser change'),
      assistant('2026-07-01T10:00:02Z', 'message-1'),
      // This can repeat the exact text of a user entry: queued events represent
      // a separate send and must not be deduplicated by prompt text.
      attachment('2026-07-01T10:00:03Z', 'queued_command', 'prompt', [
        { type: 'text', text: 'implement the parser change' },
      ]),
      assistant('2026-07-01T10:00:04Z', 'message-2'),
      attachment('2026-07-01T10:00:05Z', 'queued_command', 'task-notification', 'background task finished'),
      attachment('2026-07-01T10:00:06Z', 'queued_command', 'prompt', '<ide_opened_file>src/parser.ts</ide_opened_file>'),
      attachment('2026-07-01T10:00:07Z', 'queued_command', 'prompt', '<system-reminder>injected context</system-reminder>'),
      attachment('2026-07-01T10:00:08Z', 'queued_command', 'prompt', '/compact'),
      attachment('2026-07-01T10:00:09Z', 'other', 'prompt', 'not a queued command'),
      {
        type: 'attachment',
        timestamp: '2026-07-01T10:00:10Z',
        sessionId: 'session-1',
        attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__svc__tool'] },
      } as JournalEntry,
      assistant('2026-07-01T10:00:11Z', 'message-3'),
    ].map(compactEntry)

    const turns = groupIntoTurns(entries, new Set())

    expect(turns).toHaveLength(2)
    expect(turns.map(turn => turn.userMessage)).toEqual([
      'implement the parser change',
      'implement the parser change',
    ])
    expect(turns.map(turn => turn.assistantCalls.map(call => call.deduplicationKey))).toEqual([
      ['message-1'],
      ['message-2', 'message-3'],
    ])
    expect(turns.flatMap(turn => turn.assistantCalls)).toHaveLength(3)
  })
})
