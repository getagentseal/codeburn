import { describe, it, expect, afterAll } from 'vitest'
import { createOpenClawProvider } from '../../src/providers/openclaw.js'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const SESSION_LINES = [
  JSON.stringify({ type: 'session', version: 3, id: 'test-sess-1', timestamp: '2026-04-20T10:00:00.000Z', cwd: '/tmp' }),
  JSON.stringify({ type: 'model_change', id: 'mc1', timestamp: '2026-04-20T10:00:01.000Z', provider: 'anthropic', modelId: 'claude-sonnet-4-6' }),
  JSON.stringify({
    type: 'message', id: 'u1', timestamp: '2026-04-20T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
  }),
  JSON.stringify({
    type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:03.000Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hi!' }],
      usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50, totalTokens: 850 },
    },
  }),
  JSON.stringify({
    type: 'message', id: 'a2', timestamp: '2026-04-20T10:00:05.000Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Running command' },
        { type: 'toolCall', name: 'exec', arguments: { command: 'ls -la' } },
        { type: 'toolCall', name: 'read', arguments: { path: '/tmp/x' } },
        { type: 'tool_use', name: 'write', arguments: { path: '/tmp/y' } },
      ],
      usage: { input: 600, output: 200, cacheRead: 100, cacheWrite: 0, totalTokens: 900, cost: { total: 0.05 } },
    },
  }),
]

async function setupFixture(dir: string, agentName: string, sessionId: string, lines: string[]): Promise<string> {
  const sessionsDir = join(dir, agentName, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const filePath = join(sessionsDir, `${sessionId}.jsonl`)
  await writeFile(filePath, lines.join('\n'))
  return filePath
}

describe('openclaw provider', () => {
  const baseDir = join(tmpdir(), `codeburn-openclaw-test-${Date.now()}`)

  it('discovers sessions in agent directories', async () => {
    const dir = join(baseDir, 'discover')
    await setupFixture(dir, 'myproject', 'sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    expect(sources.length).toBe(1)
    expect(sources[0].provider).toBe('openclaw')
    expect(sources[0].project).toBe('myproject')
  })

  it('parses assistant messages with usage', async () => {
    const dir = join(baseDir, 'parse')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }
    expect(calls.length).toBe(2)
    expect(calls[0].provider).toBe('openclaw')
    expect(calls[0].model).toBe('claude-sonnet-4-6')
    expect(calls[0].inputTokens).toBe(500)
    expect(calls[0].outputTokens).toBe(100)
    expect(calls[0].cacheReadInputTokens).toBe(200)
    expect(calls[0].userMessage).toBe('hello world')
    expect(calls[0].sessionId).toBe('test-sess-1')
  })

  it('uses cost.total from provider when available', async () => {
    const dir = join(baseDir, 'cost')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls[1].costUSD).toBe(0.05)
  })

  it('extracts tools and bash commands', async () => {
    const dir = join(baseDir, 'tools')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls[1].tools).toContain('Bash')
    expect(calls[1].tools).toContain('Read')
    expect(calls[1].tools).toContain('Write')
    expect(calls[1].bashCommands).toContain('ls')
  })

  it('deduplicates on re-parse', async () => {
    const dir = join(baseDir, 'dedup')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const parser1 = provider.createSessionParser(sources[0], seen)
    const calls1: any[] = []
    for await (const c of parser1.parse()) calls1.push(c)
    expect(calls1.length).toBe(2)
    const parser2 = provider.createSessionParser(sources[0], seen)
    const calls2: any[] = []
    for await (const c of parser2.parse()) calls2.push(c)
    expect(calls2.length).toBe(0)
  })

  it('reads model from model_change event', async () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'mc-test', timestamp: '2026-04-20T10:00:00.000Z' }),
      JSON.stringify({ type: 'model_change', id: 'mc1', modelId: 'gpt-5.5', provider: 'openai' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:01.000Z',
        message: { role: 'assistant', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
      }),
    ]
    const dir = join(baseDir, 'model-change')
    await setupFixture(dir, 'proj', 'mc-test', lines)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const c of parser.parse()) calls.push(c)
    expect(calls[0].model).toBe('gpt-5.5')
  })

  it('reads model from custom model-snapshot event', async () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'snap-test', timestamp: '2026-04-20T10:00:00.000Z' }),
      JSON.stringify({ type: 'custom', customType: 'model-snapshot', data: { modelId: 'glm-5.1:cloud', provider: 'ollama' }, id: 's1' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:01.000Z',
        message: { role: 'assistant', usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0 } },
      }),
    ]
    const dir = join(baseDir, 'snapshot')
    await setupFixture(dir, 'proj', 'snap-test', lines)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const c of parser.parse()) calls.push(c)
    expect(calls[0].model).toBe('glm-5.1:cloud')
  })

  it('skips entries with invalid timestamps', async () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'bad-ts', timestamp: 'not-a-date' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: 'also-bad',
        message: { role: 'assistant', model: 'test', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
      }),
    ]
    const dir = join(baseDir, 'bad-ts')
    await setupFixture(dir, 'proj', 'bad-ts', lines)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const c of parser.parse()) calls.push(c)
    expect(calls.length).toBe(0)
  })

  it('tool and model display names work', () => {
    const provider = createOpenClawProvider()
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('dispatch_agent')).toBe('Agent')
    expect(provider.toolDisplayName('unknown')).toBe('unknown')
    expect(provider.modelDisplayName('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('returns empty for nonexistent directory', async () => {
    const provider = createOpenClawProvider('/tmp/nonexistent-openclaw-test')
    const sources = await provider.discoverSessions()
    expect(sources.length).toBe(0)
  })

  it('reports the agents root to doctor even when it holds no sessions', async () => {
    const dir = join(baseDir, 'empty-root')
    await mkdir(dir, { recursive: true })
    const provider = createOpenClawProvider(dir)
    expect(await provider.discoverSessions()).toEqual([])
    expect(await provider.probeRoots!()).toEqual([{ path: dir, label: 'agents' }])
  })

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })
})
