import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { setModelAliases, setPriceOverrides } from '../../src/models.js'
import { filterProjectsByDateRange } from '../../src/parser.js'
import { createOmpProvider } from '../../src/providers/pi.js'
import { aggregateSessions } from '../../src/sessions-report.js'
import type { ParsedApiCall, ProjectSummary } from '../../src/types.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'omp-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { id?: string; cwd?: string; timestamp?: string } = {}) {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: opts.id ?? 'sess-001',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:00.000Z',
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
  timestamp?: string | null
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
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
    ...(opts.timestamp === null ? {} : { timestamp: opts.timestamp ?? '2026-04-14T10:00:30.000Z' }),
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost ?? 0 },
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

function projectWithCalls(calls: ParsedProviderCall[]): ProjectSummary[] {
  return [{
    project: 'myproject',
    projectPath: '/Users/test/myproject',
    sessions: [{
      sessionId: calls[0]!.sessionId,
      project: 'myproject',
      turns: calls.map(call => {
        const assistantCall: ParsedApiCall = {
          provider: call.provider,
          model: call.model,
          usage: {
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
            cacheCreationInputTokens: call.cacheCreationInputTokens,
            cacheReadInputTokens: call.cacheReadInputTokens,
            cachedInputTokens: call.cachedInputTokens,
            reasoningTokens: call.reasoningTokens,
            webSearchRequests: call.webSearchRequests,
          },
          costUSD: call.costUSD,
          tools: call.tools,
          mcpTools: call.tools.filter(tool => tool.startsWith('mcp__')),
          skills: call.skills ?? [],
          subagentTypes: call.subagentTypes ?? [],
          hasAgentSpawn: call.tools.includes('Agent'),
          hasPlanMode: call.tools.includes('EnterPlanMode'),
          speed: call.speed,
          timestamp: call.timestamp,
          bashCommands: call.bashCommands,
          deduplicationKey: call.deduplicationKey,
        }
        return {
          userMessage: call.userMessage,
          assistantCalls: [assistantCall],
          timestamp: call.timestamp,
          sessionId: call.sessionId,
          category: 'general' as const,
          retries: 0,
          hasEdits: false,
        }
      }),
    }],
  }] as unknown as ProjectSummary[]
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

  it('discovers title-first sessions', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'title-first.jsonl', [
      JSON.stringify({ type: 'title', title: 'OMP title-first session' }),
      '',
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('omp')
    expect(sessions[0]!.project).toBe('myproject')
  })

  it('discovers nested per-agent sessions with their resolved model and start time', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const agentDir = join(projectDir, '2026-04-14T10-00-00-000Z_parent-001')
    const filePath = await writeSession(agentDir, 'KillSwitch.jsonl', [
      sessionMeta({ id: 'agent-001', timestamp: '2026-04-14T10:00:00.000Z' }),
      JSON.stringify({ type: 'model_change', model: 'openai-codex/gpt-5.6-terra' }),
      assistantMessage({ model: 'gpt-5.6-terra' }),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      path: filePath,
      agentName: 'KillSwitch',
      agentStartedAt: '2026-04-14T10:00:00.000Z',
    })

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls[0]!.model).toBe('openai-codex/gpt-5.6-terra')
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createOmpProvider('/nonexistent/omp/path')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips files without a session entry', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'bad.jsonl', [
      JSON.stringify({ type: 'message', id: 'x' }),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
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

  it('preserves a provider-reported nonzero cost', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.234 }),
    ])

    const provider = createOmpProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'omp' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls.map(call => call.costUSD)).toEqual([1.234])
  })

  it('prices a zero reported cost through its alias and price override', async () => {
    setModelAliases({ 'xai-oauth/grok-4.6': 'omp-grok-price-test' })
    setPriceOverrides({ 'omp-grok-price-test': { input: 2, output: 4 } })
    try {
      const projectDir = join(tmpDir, '--Users-test-myproject--')
      const filePath = await writeSession(projectDir, 'session.jsonl', [
        sessionMeta(),
        assistantMessage({
          model: 'xai-oauth/grok-4.6',
          input: 1_000_000,
          output: 1_000_000,
          cost: 0,
        }),
      ])

      const provider = createOmpProvider(tmpDir)
      const source = { path: filePath, project: 'myproject', provider: 'omp' }
      const calls: ParsedProviderCall[] = []
      for await (const call of provider.createSessionParser(source, new Set()).parse()) {
        calls.push(call)
      }

      expect(calls[0]!.costUSD).toBeCloseTo(6, 12)
    } finally {
      setModelAliases({})
      setPriceOverrides({})
    }
  })

  it('uses user attribution timestamps to date-slice records in one OMP session', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const firstTimestamp = '2026-04-15T10:00:00.000Z'
    const secondTimestamp = '2026-04-16T10:00:00.000Z'
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ id: 'assistant-header', responseId: 'response-header', timestamp: null }),
      JSON.stringify({
        type: 'message',
        id: 'user-first',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'first request' }],
          attribution: { timestamp: Date.parse(firstTimestamp) },
        },
      }),
      assistantMessage({ id: 'assistant-first', responseId: 'response-first', timestamp: null }),
      JSON.stringify({
        type: 'message',
        id: 'user-second',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'second request' }],
          attribution: { timestamp: Date.parse(secondTimestamp) },
        },
      }),
      assistantMessage({ id: 'assistant-second', responseId: 'response-second', timestamp: null }),
    ])

    const provider = createOmpProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'omp' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls.map(call => call.timestamp)).toEqual([
      '2026-04-14T10:00:00.000Z',
      firstTimestamp,
      secondTimestamp,
    ])

    const filtered = filterProjectsByDateRange(projectWithCalls(calls), {
      start: new Date('2026-04-16T00:00:00.000Z'),
      end: new Date('2026-04-16T23:59:59.999Z'),
    })
    const filteredCalls = filtered.flatMap(project =>
      project.sessions.flatMap(session => session.turns.flatMap(turn => turn.assistantCalls)),
    )

    expect(filteredCalls).toHaveLength(1)
    expect(filteredCalls[0]!.timestamp).toBe(secondTimestamp)
    expect(aggregateSessions(filtered)[0]!.startedAt).toBe(secondTimestamp)
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
