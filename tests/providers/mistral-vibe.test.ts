import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createMistralVibeProvider } from '../../src/providers/mistral-vibe.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mistral-vibe-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function metadata(opts: {
  sessionId?: string
  cwd?: string
  input?: number
  output?: number
  sessionCost?: number
  inputPrice?: number
  outputPrice?: number
  activeModel?: string
  modelName?: string
  configInputPrice?: number
  configOutputPrice?: number
  endTime?: string | null
  title?: string
} = {}) {
  const activeModel = opts.activeModel ?? 'mistral-medium-3.5'
  return {
    session_id: opts.sessionId ?? 'session-abc123',
    start_time: '2026-05-11T10:00:00+00:00',
    end_time: Object.hasOwn(opts, 'endTime') ? opts.endTime : '2026-05-11T10:05:00+00:00',
    environment: {
      working_directory: opts.cwd ?? '/Users/test/mistral-project',
    },
    stats: {
      session_prompt_tokens: opts.input ?? 2000,
      session_completion_tokens: opts.output ?? 3000,
      session_cost: opts.sessionCost,
      input_price_per_million: opts.inputPrice ?? 1.5,
      output_price_per_million: opts.outputPrice ?? 7.5,
      tokens_per_second: 42,
    },
    config: {
      active_model: activeModel,
      models: [
        {
          alias: activeModel,
          name: opts.modelName ?? 'mistral-vibe-cli-latest',
          provider: 'mistral',
          input_price: opts.configInputPrice ?? 1.5,
          output_price: opts.configOutputPrice ?? 7.5,
        },
      ],
    },
    title: opts.title ?? 'implement mistral support',
    total_messages: 2,
  }
}

function userMessage(content: unknown = 'implement mistral support') {
  return {
    role: 'user',
    content,
    message_id: 'msg-user-1',
  }
}

function assistantMessage(toolCalls: Array<{ name: string; args?: Record<string, unknown> | string }> = []) {
  return {
    role: 'assistant',
    content: 'Done',
    message_id: 'msg-assistant-1',
    tool_calls: toolCalls.map((call, idx) => ({
      id: `tool-${idx}`,
      type: 'function',
      function: {
        name: call.name,
        arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
      },
    })),
  }
}

async function writeSession(
  name: string,
  meta: Record<string, unknown>,
  messages = [userMessage(), assistantMessage()],
  root = tmpDir,
) {
  const sessionDir = join(root, name)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2))
  await writeFile(join(sessionDir, 'messages.jsonl'), messages.map(m => JSON.stringify(m)).join('\n') + '\n')
  return sessionDir
}

async function collect(sourcePath: string, provider = createMistralVibeProvider(tmpDir)): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser({
    path: sourcePath,
    project: 'mistral-project',
    provider: 'mistral-vibe',
  }, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

describe('mistral-vibe provider - session discovery', () => {
  it('discovers Vibe session folders and derives project from metadata cwd', async () => {
    const sessionDir = await writeSession('session_20260511_100000_sessiona', metadata({
      sessionId: 'session-a',
      cwd: '/Users/test/project-a',
    }))
    await mkdir(join(tmpDir, 'not-a-session'), { recursive: true })

    const provider = createMistralVibeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual({
      path: sessionDir,
      project: 'project-a',
      provider: 'mistral-vibe',
    })
  })

  it('discovers subagent session folders nested under agents', async () => {
    const parentDir = await writeSession('session_20260511_100000_parent', metadata({
      sessionId: 'parent-session',
      cwd: '/Users/test/parent-project',
    }))
    const childDir = await writeSession('session_20260511_100001_child', metadata({
      sessionId: 'child-session',
      cwd: '/Users/test/child-project',
    }), [userMessage('child task'), assistantMessage()], join(parentDir, 'agents'))

    const provider = createMistralVibeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions.map(s => s.path).sort()).toEqual([childDir, parentDir].sort())
    expect(sessions.map(s => s.project).sort()).toEqual(['child-project', 'parent-project'])
  })

  it('returns empty for a missing Vibe sessions directory', async () => {
    const provider = createMistralVibeProvider('/missing/vibe/logs/session')
    await expect(provider.discoverSessions()).resolves.toEqual([])
  })

  it('uses VIBE_HOME when no override directory is provided', async () => {
    const vibeHome = join(tmpDir, 'vibe-home')
    process.env['VIBE_HOME'] = vibeHome
    const sessionsDir = join(vibeHome, 'logs', 'session')
    await writeSession('session_20260511_100000_sessiona', metadata({
      sessionId: 'env-session',
      cwd: '/Users/test/env-project',
    }), [userMessage(), assistantMessage()], sessionsDir)

    const provider = createMistralVibeProvider()
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('env-project')
  })
})

describe('mistral-vibe provider - parsing', () => {
  it('parses cumulative session usage, tools, bash commands, and first user message', async () => {
    const sessionDir = await writeSession('session_20260511_100000_sessiona', metadata(), [
      userMessage([{ type: 'text', text: 'track Mistral Vibe usage' }]),
      assistantMessage([
        { name: 'read_file', args: { path: 'src/index.ts' } },
        { name: 'search_replace', args: { file_path: 'src/index.ts', content: 'patch' } },
        { name: 'bash', args: { command: 'npm test && git status' } },
      ]),
    ])

    const calls = await collect(sessionDir, createMistralVibeProvider(tmpDir))

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('mistral-vibe')
    expect(call.model).toBe('mistral-medium-3.5')
    expect(call.inputTokens).toBe(2000)
    expect(call.outputTokens).toBe(3000)
    expect(call.costUSD).toBeCloseTo(0.0255, 8)
    expect(call.tools).toEqual(['Read', 'Edit', 'Bash'])
    expect(call.bashCommands).toEqual(['npm', 'git'])
    expect(call.timestamp).toBe('2026-05-11T10:05:00+00:00')
    expect(call.userMessage).toBe('track Mistral Vibe usage')
    expect(call.sessionId).toBe('session-abc123')
    expect(call.deduplicationKey).toBe('mistral-vibe:session-abc123:msg-assistant-1')
  })

  it('prefers Vibe session_cost over price-derived estimates when present', async () => {
    const sessionDir = await writeSession('session_20260511_100000_sessiona', metadata({
      input: 364147,
      output: 1731,
      sessionCost: 0.381681,
      inputPrice: 100,
      outputPrice: 100,
    }))

    const calls = await collect(sessionDir, createMistralVibeProvider(tmpDir))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(0.381681)
  })

  it('uses configured model prices when stats omit prices', async () => {
    const sessionDir = await writeSession('session_20260511_100000_sessiona', metadata({
      inputPrice: 0,
      outputPrice: 0,
      input: 1000,
      output: 1000,
    }))

    const calls = await collect(sessionDir, createMistralVibeProvider(tmpDir))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeCloseTo(0.009, 8)
  })

  it('falls back to LiteLLM pricing when Vibe does not provide prices', async () => {
    const sessionDir = await writeSession('session_20260511_100000_sessiona', metadata({
      activeModel: 'claude-sonnet-4-6',
      modelName: 'claude-sonnet-4-6',
      input: 1000,
      output: 1000,
      inputPrice: 0,
      outputPrice: 0,
      configInputPrice: 0,
      configOutputPrice: 0,
    }))

    const calls = await collect(sessionDir, createMistralVibeProvider(tmpDir))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeCloseTo(0.018, 8)
  })

  it('falls back to start_time when end_time is missing', async () => {
    const sessionDir = await writeSession('session_20260511_100000_sessiona', metadata({
      endTime: null,
    }))

    const calls = await collect(sessionDir, createMistralVibeProvider(tmpDir))

    expect(calls[0]!.timestamp).toBe('2026-05-11T10:00:00+00:00')
  })

  it('deduplicates by session id', async () => {
    const sessionDir = await writeSession('session_20260511_100000_sessiona', metadata())
    const provider = createMistralVibeProvider(tmpDir)
    const source = { path: sessionDir, project: 'mistral-project', provider: 'mistral-vibe' }
    const seen = new Set<string>()

    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('skips sessions without cumulative token usage', async () => {
    const sessionDir = await writeSession('session_20260511_100000_empty', metadata({
      input: 0,
      output: 0,
    }))

    const calls = await collect(sessionDir, createMistralVibeProvider(tmpDir))

    expect(calls).toEqual([])
  })

  it('skips sessions with malformed meta.json', async () => {
    const sessionDir = join(tmpDir, 'session_20260511_100000_bad')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'meta.json'), '{{not json')
    await writeFile(join(sessionDir, 'messages.jsonl'), JSON.stringify(userMessage()) + '\n')

    const provider = createMistralVibeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('returns empty calls when messages.jsonl is malformed', async () => {
    const sessionDir = await writeSession('session_20260511_100000_badjsonl', metadata())
    await writeFile(join(sessionDir, 'messages.jsonl'), '{{not json\n{{also bad\n')

    const calls = await collect(sessionDir, createMistralVibeProvider(tmpDir))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual([])
    expect(calls[0]!.bashCommands).toEqual([])
  })

  it('formats model and tool display names', () => {
    const provider = createMistralVibeProvider(tmpDir)

    expect(provider.modelDisplayName('mistral-medium-3.5')).toBe('Mistral Medium 3.5')
    expect(provider.modelDisplayName('devstral-small-latest')).toBe('Devstral Small')
    expect(provider.toolDisplayName('search_replace')).toBe('Edit')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})
