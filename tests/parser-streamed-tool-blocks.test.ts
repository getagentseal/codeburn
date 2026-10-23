import { describe, expect, it } from 'vitest'

import { dedupeStreamingMessageIds, parseApiCall } from '../src/parser.js'
import type { ContentBlock, JournalEntry } from '../src/types.js'

// Claude Code writes one JSONL line per content block of an assistant message:
// every line repeats the message id and usage, and each carries only its own
// block. Parallel tool calls therefore arrive as several lines with the same id.
// Older streams (#110) instead restate the message and put every block in the
// final write. Both shapes must yield each tool_use exactly once.

const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 }

function line(id: string, content: ContentBlock[], timestamp: string): JournalEntry {
  return {
    type: 'assistant',
    sessionId: 's1',
    timestamp,
    message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content, usage },
  }
}

const read = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/work/${id}.ts` } })
const bash = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } })
const mcp = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'mcp__playwright__browser_navigate', input: { url: 'http://localhost' } })

function toolsOf(entries: JournalEntry[]): string[][] {
  return dedupeStreamingMessageIds(entries).map(e => parseApiCall(e)?.tools ?? [])
}

describe('streamed assistant messages with one content block per line', () => {
  it('keeps every parallel tool_use, not only the last line', () => {
    const entries = [
      line('msg-1', [{ type: 'thinking', thinking: 'plan' }], '2026-09-11T10:00:00.000Z'),
      line('msg-1', [read('t1')], '2026-09-11T10:00:01.000Z'),
      line('msg-1', [read('t2')], '2026-09-11T10:00:02.000Z'),
      line('msg-1', [bash('t3')], '2026-09-11T10:00:03.000Z'),
    ]
    const deduped = dedupeStreamingMessageIds(entries)
    expect(deduped).toHaveLength(1)
    expect(deduped[0]!.timestamp).toBe('2026-09-11T10:00:00.000Z')
    expect(toolsOf(entries)).toEqual([['Read', 'Read', 'Bash']])
  })

  it('keeps an MCP call made in parallel with a built-in tool', () => {
    const entries = [
      line('msg-1', [mcp('t1')], '2026-09-11T10:00:01.000Z'),
      line('msg-1', [read('t2')], '2026-09-11T10:00:02.000Z'),
    ]
    const call = parseApiCall(dedupeStreamingMessageIds(entries)[0]!)
    expect(call?.mcpTools).toEqual(['mcp__playwright__browser_navigate'])
    expect(call?.tools).toContain('Read')
  })

  it('still counts usage once per message', () => {
    const entries = [
      line('msg-1', [read('t1')], '2026-09-11T10:00:01.000Z'),
      line('msg-1', [bash('t2')], '2026-09-11T10:00:02.000Z'),
    ]
    const calls = dedupeStreamingMessageIds(entries).map(e => parseApiCall(e)!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.usage.outputTokens).toBe(200)
  })
})

describe('streamed assistant messages restated with every block in the final write (#110)', () => {
  it('does not double count a tool_use repeated in a later restatement', () => {
    const entries = [
      line('msg-1', [], '2026-09-11T10:00:00.000Z'),
      line('msg-1', [read('t1')], '2026-09-11T10:00:01.000Z'),
      line('msg-1', [read('t1'), bash('t2')], '2026-09-11T10:00:02.000Z'),
    ]
    expect(toolsOf(entries)).toEqual([['Read', 'Bash']])
  })

  it('leaves a message whose last line already holds every block unchanged', () => {
    const last = line('msg-1', [read('t1'), bash('t2')], '2026-09-11T10:00:02.000Z')
    const entries = [line('msg-1', [], '2026-09-11T10:00:00.000Z'), last]
    expect(dedupeStreamingMessageIds(entries)[0]!.message).toBe(last.message)
  })
})
