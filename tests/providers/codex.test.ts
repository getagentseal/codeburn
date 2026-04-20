import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider } from '../../src/providers/codex.js'
import * as fsUtils from '../../src/fs-utils.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codex-test-'))
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
})

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { cwd?: string; originator?: string; session_id?: string; model?: string } = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: {
      cwd: opts.cwd ?? '/Users/test/myproject',
      originator: opts.originator ?? 'codex-cli',
      session_id: opts.session_id ?? 'sess-001',
      model: opts.model ?? 'gpt-5.3-codex',
    },
  })
}

function tokenCount(opts: {
  timestamp?: string
  last?: { input?: number; cached?: number; output?: number; reasoning?: number }
  total?: { input?: number; cached?: number; output?: number; reasoning?: number; total?: number }
  model?: string
}) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: opts.timestamp ?? '2026-04-14T10:01:00Z',
    payload: {
      type: 'token_count',
      info: {
        model: opts.model,
        last_token_usage: opts.last ? {
          input_tokens: opts.last.input ?? 0,
          cached_input_tokens: opts.last.cached ?? 0,
          output_tokens: opts.last.output ?? 0,
          reasoning_output_tokens: opts.last.reasoning ?? 0,
          total_tokens: (opts.last.input ?? 0) + (opts.last.cached ?? 0) + (opts.last.output ?? 0) + (opts.last.reasoning ?? 0),
        } : undefined,
        total_token_usage: opts.total ? {
          input_tokens: opts.total.input ?? 0,
          cached_input_tokens: opts.total.cached ?? 0,
          output_tokens: opts.total.output ?? 0,
          reasoning_output_tokens: opts.total.reasoning ?? 0,
          total_tokens: opts.total.total ?? ((opts.total.input ?? 0) + (opts.total.cached ?? 0) + (opts.total.output ?? 0) + (opts.total.reasoning ?? 0)),
        } : undefined,
      },
    },
  })
}

function functionCall(name: string, timestamp?: string) {
  return JSON.stringify({
    type: 'response_item',
    timestamp: timestamp ?? '2026-04-14T10:00:30Z',
    payload: { type: 'function_call', name },
  })
}

function userMessage(text: string, timestamp?: string) {
  return JSON.stringify({
    type: 'response_item',
    timestamp: timestamp ?? '2026-04-14T10:00:00Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  })
}

async function writeSession(dir: string, date: string, filename: string, lines: string[]) {
  const [year, month, day] = date.split('-')
  const sessionDir = join(dir, 'sessions', year!, month!, day!)
  await mkdir(sessionDir, { recursive: true })
  const filePath = join(sessionDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('codex provider - session discovery', () => {
  it('discovers sessions in YYYY/MM/DD structure', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-abc123.jsonl', [
      sessionMeta({ cwd: '/Users/test/myproject' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('codex')
    expect(sessions[0]!.project).toBe('Users-test-myproject')
    expect(sessions[0]!.path).toContain('rollout-abc123.jsonl')
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createCodexProvider('/nonexistent/path/that/does/not/exist')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('accepts case-insensitive originator (Codex Desktop)', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-desktop.jsonl', [
      sessionMeta({ originator: 'Codex Desktop' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
  })

  it('skips files without codex session_meta', async () => {
    const [year, month, day] = '2026-04-14'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'rollout-bad.jsonl'),
      JSON.stringify({ type: 'other', payload: {} }) + '\n',
    )

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('reuses cached discovery results when the directory tree is unchanged', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-cached.jsonl', [
      sessionMeta({ cwd: '/Users/test/myproject' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const readSpy = vi.spyOn(fsUtils, 'readSessionFile')

    const first = await provider.discoverSessions()
    const firstReadCount = readSpy.mock.calls.length
    const second = await provider.discoverSessions()
    const secondReadCount = readSpy.mock.calls.length

    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
    expect(firstReadCount).toBeGreaterThan(0)
    expect(secondReadCount).toBe(firstReadCount)

    readSpy.mockRestore()
  })
})

describe('codex provider - JSONL parsing', () => {
  it('extracts token usage from last_token_usage', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-parse.jsonl', [
      sessionMeta({ session_id: 'sess-parse', model: 'gpt-5.3-codex' }),
      userMessage('fix the bug'),
      functionCall('exec_command'),
      functionCall('read_file'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, cached: 100, output: 200, reasoning: 50 },
        total: { total: 850 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('codex')
    expect(call.model).toBe('gpt-5.3-codex')
    expect(call.inputTokens).toBe(400)
    expect(call.cachedInputTokens).toBe(100)
    expect(call.cacheReadInputTokens).toBe(100)
    expect(call.outputTokens).toBe(200)
    expect(call.reasoningTokens).toBe(50)
    expect(call.tools).toEqual(['Bash', 'Read'])
    expect(call.userMessage).toBe('fix the bug')
    expect(call.sessionId).toBe('sess-parse')
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.deduplicationKey).toContain('codex:')
  })

  it('skips duplicate token_count events', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-dedup.jsonl', [
      sessionMeta(),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, output: 200 },
        total: { total: 700 },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:01:01Z',
        last: { input: 500, output: 200 },
        total: { total: 700 },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:02:00Z',
        last: { input: 300, output: 100 },
        total: { total: 1100 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[1]!.inputTokens).toBe(300)
  })
})
