import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, beforeEach, afterEach } from 'vitest'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import type { DateRange } from '../src/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-large-'))
  process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
})

afterEach(async () => {
  clearSessionCache()
  await rm(home, { recursive: true, force: true })
})

function userLine(sessionId: string, timestamp: string, textSize = 100): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    cwd: '/projects/app',
    message: { role: 'user', content: 'x'.repeat(textSize) },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string, opts?: {
  contentSize?: number
  toolCount?: number
}): string {
  const contentSize = opts?.contentSize ?? 0
  const toolCount = opts?.toolCount ?? 1
  const content: unknown[] = []
  if (contentSize > 0) {
    content.push({ type: 'text', text: 'y'.repeat(contentSize) })
    content.push({ type: 'thinking', thinking: 'z'.repeat(contentSize) })
  }
  for (let i = 0; i < toolCount; i++) {
    content.push({
      type: 'tool_use',
      id: `tu-${i}`,
      name: i === 0 ? 'Edit' : 'Read',
      input: { file_path: '/tmp/x', big: 'w'.repeat(contentSize) },
    })
  }
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })
}

function messageFirstLargeAssistantLine(sessionId: string, timestamp: string, messageId: string): string {
  const hugeText = 'y'.repeat(3_000_000)
  return `{"parentUuid":"u1","isSidechain":false,"message":{"model":"claude-sonnet-4-5","id":"${messageId}","type":"message","role":"assistant","content":[{"type":"text","text":"${hugeText}"},{"type":"tool_use","id":"tu-large","name":"Edit","input":{"file_path":"/tmp/x","old_string":"a","new_string":"b"}}],"usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":5000}},"uuid":"a1","timestamp":"${timestamp}","type":"assistant","sessionId":"${sessionId}","cwd":"/projects/app"}`
}

function attachmentLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'attachment',
    sessionId,
    timestamp,
    attachment: {
      type: 'deferred_tools_delta',
      addedNames: ['Bash', 'Edit', 'Read', 'mcp__hf__hub_search'],
    },
  })
}

describe('parseAllSessions with large Claude fixture', () => {
  it('correctly parses sessions with bulky text/thinking/tool_result blocks', async () => {
    const projectDir = join(home, '.claude', 'projects', 'bigapp')
    await mkdir(projectDir, { recursive: true })

    const lines: string[] = []
    lines.push(attachmentLine('s1', '2026-04-10T09:00:00Z'))
    for (let i = 0; i < 50; i++) {
      const ts = `2026-04-10T${String(9 + Math.floor(i / 10)).padStart(2, '0')}:${String((i % 10) * 5).padStart(2, '0')}:00Z`
      lines.push(userLine('s1', ts, 5000))
      lines.push(assistantLine('s1', ts.replace(':00Z', ':30Z'), `msg-${i}`, {
        contentSize: 50_000,
        toolCount: 3,
      }))
    }

    await writeFile(join(projectDir, 'session.jsonl'), lines.join('\n'))

    const range: DateRange = {
      start: new Date('2026-04-10T00:00:00Z'),
      end: new Date('2026-04-10T23:59:59Z'),
    }

    const projects = await parseAllSessions(range, 'claude')

    expect(projects.length).toBeGreaterThan(0)
    const proj = projects[0]!
    expect(proj.totalApiCalls).toBe(50)
    expect(proj.totalCostUSD).toBeGreaterThan(0)

    const sess = proj.sessions[0]!
    expect(sess.turns.length).toBe(50)

    for (const turn of sess.turns) {
      expect(turn.userMessage.length).toBeLessThanOrEqual(2000)
      expect(turn.assistantCalls.length).toBe(1)
      const call = turn.assistantCalls[0]!
      expect(call.tools).toContain('Edit')
      expect(call.tools).toContain('Read')
      expect(call.model).toBe('claude-sonnet-4-5')
    }

    expect(sess.mcpInventory).toContain('mcp__hf__hub_search')
  })

  it('handles malformed JSONL lines without crashing', async () => {
    const projectDir = join(home, '.claude', 'projects', 'baddata')
    await mkdir(projectDir, { recursive: true })

    const lines = [
      'not json at all',
      '{"type": "user", "sessionId": "s1", "timestamp": "2026-04-10T10:00:00Z", "message": {"role": "user", "content": [null, {"type": "text", "text": "hello"}, 42]}}',
      '{"type": "assistant", "sessionId": "s1", "timestamp": "2026-04-10T10:01:00Z", "message": {"id": "m1", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5", "content": "not-an-array", "usage": {"input_tokens": 100, "output_tokens": 50}}}',
      '{"type": "assistant", "sessionId": "s1", "timestamp": "2026-04-10T10:02:00Z", "message": {"id": "m2", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5", "content": [null, {"type": "tool_use", "id": "t1", "name": "Read", "input": {}}], "usage": {"input_tokens": 100, "output_tokens": 50}}}',
    ]

    await writeFile(join(projectDir, 'session.jsonl'), lines.join('\n'))

    const range: DateRange = {
      start: new Date('2026-04-10T00:00:00Z'),
      end: new Date('2026-04-10T23:59:59Z'),
    }

    const projects = await parseAllSessions(range, 'claude')
    expect(projects.length).toBeGreaterThan(0)

    const sess = projects[0]!.sessions[0]!
    expect(sess.apiCalls).toBeGreaterThanOrEqual(1)
  })

  it('discovers direct Claude subagent JSONL files under a project directory', async () => {
    const projectDir = join(home, '.claude', 'projects', 'direct-subagents')
    const subagentsDir = join(projectDir, 'subagents')
    await mkdir(subagentsDir, { recursive: true })

    const lines = [
      userLine('subagent-session', '2026-04-10T10:00:00Z', 100),
      assistantLine('subagent-session', '2026-04-10T10:01:00Z', 'subagent-msg', {
        contentSize: 0,
        toolCount: 2,
      }),
    ]
    await writeFile(join(subagentsDir, 'worker.jsonl'), lines.join('\n'))

    const range: DateRange = {
      start: new Date('2026-04-10T00:00:00Z'),
      end: new Date('2026-04-10T23:59:59Z'),
    }

    const projects = await parseAllSessions(range, 'claude')

    expect(projects).toHaveLength(1)
    const session = projects[0]!.sessions[0]!
    expect(session.sessionId).toBe('worker')
    expect(session.apiCalls).toBe(1)
    expect(session.toolBreakdown['Edit']?.calls).toBe(1)
    expect(session.toolBreakdown['Read']?.calls).toBe(1)
  })

  it('discovers nested Claude subagent JSONL files under a direct subagents directory', async () => {
    const projectDir = join(home, '.claude', 'projects', 'nested-subagents')
    const nestedSubagentsDir = join(projectDir, 'subagents', 'subagents')
    await mkdir(nestedSubagentsDir, { recursive: true })

    const lines = [
      userLine('nested-subagent-session', '2026-04-10T11:00:00Z', 100),
      assistantLine('nested-subagent-session', '2026-04-10T11:01:00Z', 'nested-subagent-msg', {
        contentSize: 0,
        toolCount: 1,
      }),
    ]
    await writeFile(join(nestedSubagentsDir, 'worker.jsonl'), lines.join('\n'))

    const range: DateRange = {
      start: new Date('2026-04-10T00:00:00Z'),
      end: new Date('2026-04-10T23:59:59Z'),
    }

    const projects = await parseAllSessions(range, 'claude')

    expect(projects).toHaveLength(1)
    const session = projects[0]!.sessions[0]!
    expect(session.sessionId).toBe('worker')
    expect(session.apiCalls).toBe(1)
    expect(session.toolBreakdown['Edit']?.calls).toBe(1)
  })

  it('parses huge message-first assistant lines without full JSON.parse expansion', async () => {
    const projectDir = join(home, '.claude', 'projects', 'messagefirst')
    await mkdir(projectDir, { recursive: true })

    const lines = [
      userLine('s1', '2026-04-10T10:00:00Z', 100),
      messageFirstLargeAssistantLine('s1', '2026-04-10T10:00:01Z', 'msg-large'),
    ]

    await writeFile(join(projectDir, 'session.jsonl'), lines.join('\n'))

    const range: DateRange = {
      start: new Date('2026-04-10T00:00:00Z'),
      end: new Date('2026-04-10T23:59:59Z'),
    }

    const projects = await parseAllSessions(range, 'claude')
    expect(projects.length).toBeGreaterThan(0)

    const sess = projects[0]!.sessions[0]!
    expect(sess.apiCalls).toBe(1)
    expect(sess.totalInputTokens).toBe(1000)
    expect(sess.totalOutputTokens).toBe(100)
    expect(sess.totalCacheReadTokens).toBe(5000)
    expect(sess.toolBreakdown['Edit']?.calls).toBe(1)
  })
})
