import { describe, it, expect } from 'vitest'

import { compactEntry } from '../src/parser.js'
import type { JournalEntry } from '../src/types.js'

function entry(overrides: Partial<JournalEntry> & Record<string, unknown>): JournalEntry {
  return { type: 'user', ...overrides } as JournalEntry
}

describe('compactEntry', () => {
  it('preserves type, timestamp, sessionId, cwd', () => {
    const raw = entry({ type: 'user', timestamp: 't1', sessionId: 's1', cwd: '/foo' })
    const c = compactEntry(raw)
    expect(c.type).toBe('user')
    expect(c.timestamp).toBe('t1')
    expect(c.sessionId).toBe('s1')
    expect(c.cwd).toBe('/foo')
  })

  it('strips unknown catch-all fields', () => {
    const raw = entry({
      type: 'assistant',
      toolResult: { type: 'tool_result', content: 'x'.repeat(10_000) },
      someHugeField: 'y'.repeat(10_000),
    })
    const c = compactEntry(raw)
    expect((c as Record<string, unknown>)['toolResult']).toBeUndefined()
    expect((c as Record<string, unknown>)['someHugeField']).toBeUndefined()
  })

  it('preserves prUrl on a pr-link entry for per-turn PR attribution', () => {
    const raw = entry({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/1', extra: 'x'.repeat(10_000) })
    const c = compactEntry(raw)
    expect((c as Record<string, unknown>)['prUrl']).toBe('https://github.com/o/r/pull/1')
    expect((c as Record<string, unknown>)['extra']).toBeUndefined()
  })

  it('does not copy prUrl onto non-pr-link entries', () => {
    const raw = entry({ type: 'user', prUrl: 'https://github.com/o/r/pull/1' })
    const c = compactEntry(raw)
    expect((c as Record<string, unknown>)['prUrl']).toBeUndefined()
  })

  it('preserves deferred_tools_delta attachment with copied names', () => {
    const raw = entry({
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['mcp__svc__t1', 'Bash'],
        extraData: 'should be dropped',
      },
    })
    const c = compactEntry(raw)
    const att = (c as Record<string, unknown>)['attachment'] as Record<string, unknown>
    expect(att['type']).toBe('deferred_tools_delta')
    expect(att['addedNames']).toEqual(['mcp__svc__t1', 'Bash'])
    expect(att['extraData']).toBeUndefined()
  })

  it('copies addedNames into a new array (not by reference)', () => {
    const originalNames = ['mcp__a__b', 'Bash']
    const raw = entry({
      type: 'attachment',
      attachment: { type: 'deferred_tools_delta', addedNames: originalNames },
    })
    const c = compactEntry(raw)
    const att = (c as Record<string, unknown>)['attachment'] as { addedNames: string[] }
    expect(att.addedNames).not.toBe(originalNames)
    expect(att.addedNames).toEqual(originalNames)
  })

  it('caps addedNames at 1000 entries', () => {
    const names = Array.from({ length: 2000 }, (_, i) => `mcp__svc__t${i}`)
    const raw = entry({
      type: 'attachment',
      attachment: { type: 'deferred_tools_delta', addedNames: names },
    })
    const c = compactEntry(raw)
    const att = (c as Record<string, unknown>)['attachment'] as { addedNames: string[] }
    expect(att.addedNames).toHaveLength(1000)
  })

  it('filters non-string entries from addedNames', () => {
    const raw = entry({
      type: 'attachment',
      attachment: { type: 'deferred_tools_delta', addedNames: [42, null, 'mcp__a__b', undefined] },
    })
    const c = compactEntry(raw)
    const att = (c as Record<string, unknown>)['attachment'] as { addedNames: string[] }
    expect(att.addedNames).toEqual(['mcp__a__b'])
  })

  it('drops non-deferred_tools_delta attachments', () => {
    const raw = entry({
      type: 'attachment',
      attachment: { type: 'other', data: 'x'.repeat(10_000) },
    })
    const c = compactEntry(raw)
    expect((c as Record<string, unknown>)['attachment']).toBeUndefined()
  })

  it('caps user message string content at 2000', () => {
    const longText = 'a'.repeat(5000)
    const raw = entry({
      type: 'user',
      message: { role: 'user' as const, content: longText },
    })
    const c = compactEntry(raw)
    expect(c.message!.role).toBe('user')
    const content = (c.message as { content: string }).content
    expect(content.length).toBe(2000)
  })

  it('caps total user text across all blocks at 2000', () => {
    const raw = entry({
      type: 'user',
      message: {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'a'.repeat(1500) },
          { type: 'text' as const, text: 'b'.repeat(1500) },
          { type: 'text' as const, text: 'c'.repeat(1500) },
          { type: 'image' as const, source: 'big data' },
        ],
      },
    })
    const c = compactEntry(raw)
    const content = (c.message as { content: Array<{ type: string; text: string }> }).content
    expect(content).toHaveLength(2)
    expect(content[0]!.text.length).toBe(1500)
    expect(content[1]!.text.length).toBe(500)
  })

  it('compacts assistant tool_use blocks, dropping text and thinking, preserving id', () => {
    const raw = entry({
      type: 'assistant',
      timestamp: 't1',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        id: 'msg_123',
        usage: { input_tokens: 100, output_tokens: 200 },
        content: [
          { type: 'text', text: 'x'.repeat(50_000) },
          { type: 'thinking', thinking: 'y'.repeat(50_000) },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/foo', huge: 'z'.repeat(10_000) } },
          { type: 'tool_use', id: 'tu2', name: 'Edit', input: { old_string: 'a'.repeat(5000), new_string: 'b'.repeat(5000) } },
        ],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> }
    expect(msg.content).toHaveLength(2)
    expect(msg.content[0]!.name).toBe('Read')
    expect(msg.content[0]!.id).toBe('tu1')
    expect(msg.content[0]!.input).toEqual({ file_path: '/foo' })
    expect(msg.content[1]!.name).toBe('Edit')
    expect(msg.content[1]!.id).toBe('tu2')
    expect(msg.content[1]!.input).toEqual({})
  })

  it('caps tool_use blocks at 500 per message', () => {
    const blocks = Array.from({ length: 600 }, (_, i) => ({
      type: 'tool_use' as const,
      id: `tu${i}`,
      name: `Tool${i}`,
      input: {},
    }))
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: blocks,
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: unknown[] }
    expect(msg.content).toHaveLength(500)
  })

  it('preserves model, usage (destructured), and id on assistant messages', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        id: 'msg_abc',
        usage: {
          input_tokens: 50,
          output_tokens: 100,
          cache_read_input_tokens: 25,
          extraGarbage: 'should not survive',
        },
        content: [],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { model: string; id: string; usage: Record<string, unknown> }
    expect(msg.model).toBe('claude-opus-4-6')
    expect(msg.id).toBe('msg_abc')
    expect(msg.usage['input_tokens']).toBe(50)
    expect(msg.usage['output_tokens']).toBe(100)
    expect(msg.usage['cache_read_input_tokens']).toBe(25)
    expect(msg.usage['extraGarbage']).toBeUndefined()
  })

  it('deep-copies usage nested objects, stripping extra keys', () => {
    const cacheCreation = { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200, extraJunk: 'big' }
    const serverToolUse = { web_search_requests: 3, web_fetch_requests: 1, extraJunk: 'big' }
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          speed: 'fast',
          cache_creation: cacheCreation,
          server_tool_use: serverToolUse,
        },
        content: [],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { usage: Record<string, unknown> }
    expect(msg.usage['speed']).toBe('fast')
    const cc = msg.usage['cache_creation'] as Record<string, unknown>
    expect(cc['ephemeral_5m_input_tokens']).toBe(100)
    expect(cc['ephemeral_1h_input_tokens']).toBe(200)
    expect(cc['extraJunk']).toBeUndefined()
    expect(cc).not.toBe(cacheCreation)
    const stu = msg.usage['server_tool_use'] as Record<string, unknown>
    expect(stu['web_search_requests']).toBe(3)
    expect(stu['web_fetch_requests']).toBe(1)
    expect(stu['extraJunk']).toBeUndefined()
    expect(stu).not.toBe(serverToolUse)
  })

  it('keeps Skill input.skill and input.name, type-checked and capped', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [
          { type: 'tool_use', id: 'tu', name: 'Skill', input: { skill: 'graphify', args: 'huge arg data' } },
        ],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: Array<{ input: Record<string, unknown> }> }
    expect(msg.content[0]!.input['skill']).toBe('graphify')
    expect(msg.content[0]!.input['args']).toBeUndefined()
  })

  it('rejects non-string Skill input.skill and caps long names', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: { malicious: 'x'.repeat(10_000) } } },
          { type: 'tool_use', id: 'tu2', name: 'Skill', input: { skill: 'a'.repeat(500) } },
        ],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: Array<{ input: Record<string, unknown> }> }
    expect(msg.content[0]!.input['skill']).toBeUndefined()
    expect((msg.content[1]!.input['skill'] as string).length).toBe(200)
  })

  it('keeps Bash input.command capped at 2000 for bash command extraction', () => {
    const longCmd = 'npm run build && '.repeat(200)
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [
          { type: 'tool_use', id: 'tu', name: 'Bash', input: { command: longCmd, description: 'big desc' } },
        ],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: Array<{ input: Record<string, unknown> }> }
    const cmd = msg.content[0]!.input['command'] as string
    expect(cmd.length).toBe(2000)
    expect(msg.content[0]!.input['description']).toBeUndefined()
  })

  it('keeps Read file_path capped and drops unrelated input fields', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [
          { type: 'tool_use', id: 'tu', name: 'Read', input: { file_path: '/tmp/' + 'x'.repeat(3000), content: 'big' } },
        ],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: Array<{ input: Record<string, unknown> }> }
    expect((msg.content[0]!.input['file_path'] as string).length).toBe(2000)
    expect(msg.content[0]!.input['content']).toBeUndefined()
  })

  it('keeps Agent subagent_type capped and drops prompt text', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [
          { type: 'tool_use', id: 'tu', name: 'Agent', input: { subagent_type: 'reviewer'.repeat(50), prompt: 'big' } },
        ],
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: Array<{ input: Record<string, unknown> }> }
    expect((msg.content[0]!.input['subagent_type'] as string).length).toBe(200)
    expect(msg.content[0]!.input['prompt']).toBeUndefined()
  })

  it('handles entry with no message field', () => {
    const raw = entry({ type: 'system', timestamp: 't1', cwd: '/x' })
    const c = compactEntry(raw)
    expect(c.type).toBe('system')
    expect(c.timestamp).toBe('t1')
    expect(c.message).toBeUndefined()
  })

  it('handles assistant message with no usage (non-standard)', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'response' }],
      },
    })
    const c = compactEntry(raw)
    expect(c.message).toBeUndefined()
  })

  it('handles unexpected message role (neither user nor assistant)', () => {
    const raw = entry({
      type: 'system',
      message: { role: 'system' as never, content: 'sys prompt' },
    })
    const c = compactEntry(raw)
    expect(c.message).toBeUndefined()
  })

  it('tolerates null elements in user content array', () => {
    const raw = entry({
      type: 'user',
      message: {
        role: 'user' as const,
        content: [null, undefined, { type: 'text', text: 'ok' }, 42, { type: 'text' }] as never,
      },
    })
    const c = compactEntry(raw)
    const content = (c.message as { content: Array<{ text: string }> }).content
    expect(content).toHaveLength(1)
    expect(content[0]!.text).toBe('ok')
  })

  it('tolerates assistant content that is not an array', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: 'not an array' as never,
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: unknown[] }
    expect(msg.content).toEqual([])
  })

  it('tolerates null elements in assistant content array', () => {
    const raw = entry({
      type: 'assistant',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [null, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }, undefined] as never,
      },
    })
    const c = compactEntry(raw)
    const msg = c.message as { content: Array<{ name: string }> }
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]!.name).toBe('Read')
  })

  it('memory reduction: compacted entry is much smaller than raw', () => {
    const hugeContent = Array.from({ length: 20 }, (_, i) => ({
      type: i % 2 === 0 ? 'text' : 'tool_result',
      text: 'x'.repeat(100_000),
      content: 'y'.repeat(100_000),
    }))
    const raw = entry({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00',
      message: {
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-opus-4-6',
        id: 'msg_1',
        usage: { input_tokens: 1000, output_tokens: 500 },
        content: hugeContent as never,
      },
      toolResult: { content: 'z'.repeat(500_000) },
    })
    const rawSize = JSON.stringify(raw).length
    const compacted = compactEntry(raw)
    const compactedSize = JSON.stringify(compacted).length
    expect(rawSize).toBeGreaterThan(2_000_000)
    expect(compactedSize).toBeLessThan(500)
  })
})
