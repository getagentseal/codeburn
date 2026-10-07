import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createKimiProvider } from '../../src/providers/kimi.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kimi-test-'))
})

afterEach(async () => {
  delete process.env.KIMI_MODEL_NAME
  await rm(tmpDir, { recursive: true, force: true })
})

function md5(value: string): string {
  return createHash('md5').update(value, 'utf-8').digest('hex')
}

function record(timestamp: number, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp,
    message: { type, payload },
  })
}

async function writeSession(workDir: string, sessionId: string, lines: string[]): Promise<string> {
  const hash = md5(workDir)
  const sessionDir = join(tmpDir, 'sessions', hash, sessionId)
  await mkdir(sessionDir, { recursive: true })
  const wirePath = join(sessionDir, 'wire.jsonl')
  await writeFile(wirePath, [
    JSON.stringify({ type: 'metadata', protocol_version: '2' }),
    ...lines,
  ].join('\n') + '\n')
  return wirePath
}

async function collect(provider: ReturnType<typeof createKimiProvider>, path: string, seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const parser = provider.createSessionParser({ path, project: 'app', provider: 'kimi' }, seen)
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('Kimi provider', () => {
  it('discovers session and subagent wire logs under KIMI_SHARE_DIR layout', async () => {
    const workDir = '/Users/test/work/app'
    const hash = md5(workDir)
    await writeFile(join(tmpDir, 'kimi.json'), JSON.stringify({
      work_dirs: [{ path: workDir, kaos: 'local', last_session_id: 'sess-1' }],
    }))

    const sessionDir = join(tmpDir, 'sessions', hash, 'sess-1')
    const subagentDir = join(sessionDir, 'subagents', 'agent-1')
    await mkdir(subagentDir, { recursive: true })
    await writeFile(join(sessionDir, 'wire.jsonl'), '\n')
    await writeFile(join(subagentDir, 'wire.jsonl'), '\n')

    const sources = await createKimiProvider(tmpDir).discoverSessions()

    expect(sources).toHaveLength(2)
    expect(sources.map(s => s.project)).toEqual(['app', 'app'])
    expect(sources.map(s => s.provider)).toEqual(['kimi', 'kimi'])
    expect(sources.map(s => s.path).sort()).toEqual([
      join(sessionDir, 'subagents', 'agent-1', 'wire.jsonl'),
      join(sessionDir, 'wire.jsonl'),
    ].sort())
  })

  it('parses Kimi wire StatusUpdate usage, tools, bash commands, and configured model', async () => {
    await writeFile(join(tmpDir, 'config.toml'), [
      'default_model = "kimi-code/k2"',
      '',
      '[models."kimi-code/k2"]',
      'model = "kimi-k2-thinking-turbo"',
    ].join('\n'))

    const wirePath = await writeSession('/Users/test/work/app', 'sess-1', [
      record(1776162400, 'TurnBegin', { user_input: 'add status endpoint' }),
      record(1776162401, 'ToolCall', {
        type: 'function',
        id: 'call-shell',
        function: { name: 'Shell', arguments: JSON.stringify({ command: 'git status && npm test' }) },
      }),
      record(1776162402, 'ToolCall', {
        type: 'function',
        id: 'call-read',
        function: { name: 'ReadFile', arguments: JSON.stringify({ path: 'src/index.ts' }) },
      }),
      record(1776162403, 'StatusUpdate', {
        message_id: 'msg-1',
        token_usage: {
          input_other: 100,
          input_cache_read: 25,
          input_cache_creation: 10,
          output: 40,
        },
      }),
    ])

    const calls = await collect(createKimiProvider(tmpDir), wirePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2-thinking-turbo',
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 25,
      cacheCreationInputTokens: 10,
      cachedInputTokens: 25,
      tools: ['Bash', 'Read'],
      bashCommands: ['git', 'npm'],
      timestamp: '2026-04-14T10:26:43.000Z',
      deduplicationKey: 'kimi:sess-1:msg-1',
      userMessage: 'add status endpoint',
      sessionId: 'sess-1',
    })
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('prices kimi-for-coding by call date', async () => {
    const wirePath = await writeSession('/Users/test/work/app', 'sess-k28', [
      record(1789084799, 'StatusUpdate', {
        message_id: 'before',
        model_name: 'kimi-for-coding',
        token_usage: { input_other: 1_000_000, output: 1_000_000 },
      }),
      record(1789084800, 'StatusUpdate', {
        message_id: 'from',
        model_name: 'kimi-for-coding',
        token_usage: { input_other: 1_000_000, output: 1_000_000 },
      }),
      record(1777593600, 'StatusUpdate', {
        message_id: 'k26',
        model_name: 'kimi-for-coding',
        token_usage: { input_other: 1_000_000, output: 0 },
      }),
    ])

    const calls = await collect(createKimiProvider(tmpDir), wirePath)

    expect(calls[0]!.costUSD).toBeCloseTo(4.95)
    expect(calls[1]!.costUSD).toBeCloseTo(4.95)
    expect(calls[2]!.costUSD).toBeCloseTo(0.95)
  })

  it('uses content parts, model payload overrides, and message-id deduplication', async () => {
    process.env.KIMI_MODEL_NAME = 'kimi-k2-thinking'
    const wirePath = await writeSession('/Users/test/work/app', 'sess-2', [
      record(1776023300, 'TurnBegin', {
        user_input: [
          { type: 'text', text: 'refactor parser' },
          { type: 'image_url', image_url: { url: 'file://diagram.png' } },
          { type: 'text', text: 'carefully' },
        ],
      }),
      record(1776023301, 'ToolCallRequest', {
        id: 'call-write',
        name: 'WriteFile',
        arguments: JSON.stringify({ path: 'src/parser.ts', content: 'x' }),
      }),
      record(1776023302, 'StatusUpdate', {
        message_id: 'msg-2',
        model_name: 'kimi-k2.6',
        token_usage: { input_other: 5, output: 7 },
      }),
      record(1776023303, 'StatusUpdate', {
        message_id: 'msg-2',
        model_name: 'kimi-k2.6',
        token_usage: { input_other: 5, output: 7 },
      }),
    ])

    const calls = await collect(createKimiProvider(tmpDir), wirePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'kimi-k2.6',
      userMessage: 'refactor parser carefully',
      tools: ['Write'],
      deduplicationKey: 'kimi:sess-2:msg-2',
    })
  })

  it('skips non-usage updates and supports legacy input total fields defensively', async () => {
    const wirePath = await writeSession('/Users/test/work/app', 'sess-3', [
      record(1776023400, 'TurnBegin', { user_input: 'summarize' }),
      record(1776023401, 'StatusUpdate', { context_usage: 0.5 }),
      record(1776023402, 'StatusUpdate', {
        message_id: 'msg-3',
        token_usage: {
          input: 120,
          input_cache_read: 30,
          input_cache_creation: 10,
          output_tokens: 20,
        },
      }),
    ])

    const calls = await collect(createKimiProvider(tmpDir), wirePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 80,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 10,
      outputTokens: 20,
      model: 'kimi-auto',
    })
  })
})
