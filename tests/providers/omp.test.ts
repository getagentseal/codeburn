import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createOmpProvider } from '../../src/providers/pi.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'omp-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { id?: string; cwd?: string } = {}) {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: opts.id ?? 'sess-001',
    timestamp: '2026-04-14T10:00:00.000Z',
    cwd: opts.cwd ?? '/Users/test/myproject',
  })
}

function userMessage(text: string) {
  return JSON.stringify({
    type: 'message',
    id: 'msg-user-1',
    timestamp: '2026-04-14T10:00:10.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1776023210000,
    },
  })
}

function assistantMessage(opts: {
  id?: string
  responseId?: string
  timestamp?: string
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  tools?: Array<{ name: string; command?: string }>
}) {
  const content = (opts.tools ?? []).map(t => ({
    type: 'toolCall',
    id: `call-${t.name}`,
    name: t.name,
    arguments: t.command !== undefined ? { command: t.command } : {},
  }))

  return JSON.stringify({
    type: 'message',
    id: opts.id ?? 'msg-asst-1',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:30.000Z',
    message: {
      role: 'assistant',
      content,
      provider: 'anthropic',
      model: opts.model ?? 'claude-sonnet-4-5',
      responseId: opts.responseId ?? 'resp-001',
      usage: {
        input: opts.input ?? 1000,
        output: opts.output ?? 200,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1776023230000,
    },
  })
}

async function writeSession(projectDir: string, filename: string, lines: string[]) {
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('omp provider - identity', () => {
  it('has correct name and displayName', () => {
    const provider = createOmpProvider(tmpDir)
    expect(provider.name).toBe('omp')
    expect(provider.displayName).toBe('OMP')
  })
})

describe('omp provider - session discovery', () => {
  it('discovers sessions from the omp sessions directory', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, '2026-04-14T10-00-00-000Z_sess-001.jsonl', [
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('omp')
    expect(sessions[0]!.project).toBe('myproject')
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createOmpProvider('/nonexistent/omp/path')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips files whose first line is not a session entry', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'bad.jsonl', [
      JSON.stringify({ type: 'message', id: 'x' }),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })
  it('discovers sub-agent sessions nested inside session subdirectory', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const parentFile = '2026-04-21T10-00-00-000Z_abc123'

    // Main session at project-dir level
    await writeSession(projectDir, `${parentFile}.jsonl`, [
      sessionMeta({ id: 'main-session', cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    // Sub-agent sessions inside <session-id>/ subdirectory
    const subDir = join(projectDir, parentFile)
    await writeSession(subDir, '0-SubAgent.jsonl', [
      sessionMeta({ id: 'sub-agent-0', cwd: '/Users/test/myproject' }),
      assistantMessage({ input: 500, output: 100 }),
    ])
    await writeSession(subDir, '1-SubAgent.jsonl', [
      sessionMeta({ id: 'sub-agent-1', cwd: '/Users/test/myproject' }),
      assistantMessage({ input: 600, output: 120 }),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(3)
    expect(sessions.every(s => s.provider === 'omp')).toBe(true)
    expect(sessions.every(s => s.project === 'myproject')).toBe(true)
  })

})

describe('omp provider - JSONL parsing', () => {
  it('extracts token usage from an omp-format assistant message', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta({ id: 'sess-omp-1', cwd: '/Users/test/myproject' }),
      userMessage('write a test'),
      assistantMessage({
        responseId: 'resp-omp-1',
        timestamp: '2026-04-14T10:00:30.000Z',
        model: 'claude-sonnet-4-5',
        input: 1500,
        output: 300,
        cacheRead: 2000,
        cacheWrite: 50,
      }),
    ])

    const provider = createOmpProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'omp' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('omp')
    expect(call.model).toBe('claude-sonnet-4-5')
    expect(call.inputTokens).toBe(1500)
    expect(call.outputTokens).toBe(300)
    expect(call.cacheReadInputTokens).toBe(2000)
    expect(call.cachedInputTokens).toBe(2000)
    expect(call.cacheCreationInputTokens).toBe(50)
    expect(call.sessionId).toBe('sess-omp-1')
    expect(call.userMessage).toBe('write a test')
    expect(call.timestamp).toBe('2026-04-14T10:00:30.000Z')
    expect(call.deduplicationKey).toContain('omp:')
    expect(call.deduplicationKey).toContain('resp-omp-1')
  })

  it('ignores the embedded usage.cost and recalculates cost', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }),
    ])

    const provider = createOmpProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'omp' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    // cost must be calculated by codeburn, not taken from usage.cost (which is zeroed in fixture)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('collects tool names from toolCall content items', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [{ name: 'read' }, { name: 'edit' }, { name: 'bash', command: 'bun test' }],
      }),
    ])

    const provider = createOmpProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'omp' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.tools).toEqual(['Read', 'Edit', 'Bash'])
    expect(calls[0]!.bashCommands).toEqual(['bun'])
  })

  it('skips assistant messages with zero tokens', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ input: 0, output: 0 }),
    ])

    const provider = createOmpProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'omp' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(0)
  })
})
