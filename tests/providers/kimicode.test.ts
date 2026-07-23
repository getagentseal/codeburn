import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { calculateCost } from '../../src/models.js'
import { createKimicodeProvider, kimicode } from '../../src/providers/kimicode.js'
import type { ParsedProviderCall, Provider, SessionSource } from '../../src/providers/types.js'

type FixtureAgent = {
  id: string
  type?: string
  lines: Array<string | Record<string, unknown>>
}

let fixtureHome: string

beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'kimicode-test-'))
})

afterEach(async () => {
  delete process.env.KIMI_CODE_HOME
  await rm(fixtureHome, { recursive: true, force: true })
})

function prompt(text: string, time: number): Record<string, unknown> {
  return {
    type: 'turn.prompt',
    input: [{ type: 'text', text }],
    origin: { kind: 'user' },
    time,
  }
}

function request(
  turnStep: string,
  modelAlias: string,
  model: string,
  time: number,
  attempt?: string,
): Record<string, unknown> {
  return {
    type: 'llm.request',
    kind: 'loop',
    provider: 'fixture-provider',
    model,
    modelAlias,
    maxTokens: 4096,
    messageCount: 2,
    turnStep,
    ...(attempt ? { attempt } : {}),
    time,
  }
}

function usage(
  modelAlias: string,
  time: number,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): Record<string, unknown> {
  return {
    type: 'usage.record',
    model: modelAlias,
    usage: {
      inputOther: tokens.input,
      output: tokens.output,
      inputCacheRead: tokens.cacheRead ?? 0,
      inputCacheCreation: tokens.cacheWrite ?? 0,
    },
    usageScope: 'turn',
    time,
  }
}

function tool(
  name: string,
  turnId: number,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      name,
      args,
      turnId,
      step: 1,
      toolCallId: `tool-${turnId}-${name}`,
    },
  }
}

async function writeSession(
  sessionId: string,
  agents: FixtureAgent[],
  workDir = '/workspace/neutral-project',
): Promise<string[]> {
  const sessionDir = join(
    fixtureHome,
    'sessions',
    'wd_neutral-project_0123456789ab',
    `session_${sessionId}`,
  )
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:05:00.000Z',
    title: 'Sanitized fixture',
    isCustomTitle: false,
    workDir,
    lastPrompt: 'sanitized fixture prompt',
    agents: Object.fromEntries(agents.map(agent => [agent.id, {
      homedir: '/workspace',
      type: agent.type ?? (agent.id === 'main' ? 'main' : 'worker'),
      parentAgentId: agent.id === 'main' ? null : 'main',
    }])),
  }))

  const paths: string[] = []
  for (const agent of agents) {
    const agentDir = join(sessionDir, 'agents', agent.id)
    await mkdir(agentDir, { recursive: true })
    const wirePath = join(agentDir, 'wire.jsonl')
    await writeFile(wirePath, [
      JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900000000 }),
      ...agent.lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)),
      '',
    ].join('\n'))
    paths.push(wirePath)
  }
  return paths
}

async function collect(
  provider: Provider,
  source: SessionSource,
  seenKeys = new Set<string>(),
): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
  return calls
}

describe('Kimi Code provider', () => {
  it('honors KIMI_CODE_HOME and reports the resolved doctor probe root', async () => {
    process.env.KIMI_CODE_HOME = fixtureHome

    await expect(kimicode.probeRoots!()).resolves.toEqual([
      { path: fixtureHome, label: 'Kimi Code home' },
    ])
  })

  it('discovers agent wires and uses state.json workDir metadata', async () => {
    const paths = await writeSession('discovery', [
      { id: 'main', lines: [] },
      { id: 'agent-neutral', lines: [] },
    ])

    const provider = createKimicodeProvider(fixtureHome)
    const sources = await provider.discoverSessions()

    expect(sources).toHaveLength(2)
    expect(sources.map(source => source.path)).toEqual([...paths].sort())
    expect(sources.map(source => source.sourceId)).toEqual(['agent-neutral', 'main'])
    expect(sources.every(source => source.project === 'neutral-project')).toBe(true)
    expect(sources.every(source => source.sourcePath === '/workspace/neutral-project')).toBe(true)
  })

  it('discovers embedded-runtime conv-* and ctitle-* session directories', async () => {
    // Embedded runtimes (Kimi desktop app, Kimi Code IDE) name session dirs
    // conv-*/ctitle-* instead of session_*; their wires carry the same event
    // format and must be discovered and priced the same way.
    for (const dirName of ['conv-abc123def456', 'ctitle-019f8f78-db81']) {
      const agentDir = join(fixtureHome, 'sessions', 'wd_neutral-project_0123456789ab', dirName, 'agents', 'main')
      await mkdir(agentDir, { recursive: true })
      await writeFile(join(agentDir, '..', 'state.json'), JSON.stringify({
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:05:00.000Z',
        workDir: '/workspace/neutral-project',
      }))
      await writeFile(join(agentDir, 'wire.jsonl'), [
        JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900000000 }),
        JSON.stringify(prompt('hello from an embedded runtime', 1782900000000)),
        JSON.stringify(request('0.1', 'k3-agent', 'k3-agent', 1782900001000)),
        JSON.stringify(usage('k3-agent', 1782900002000, { input: 100, output: 50 })),
        '',
      ].join('\n'))
    }

    const provider = createKimicodeProvider(fixtureHome)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(2)
    expect(sources.every(source => source.project === 'neutral-project')).toBe(true)

    const seen = new Set<string>()
    const calls = (await Promise.all(sources.map(source => collect(provider, source, seen)))).flat()
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.model === 'k3-agent')).toBe(true)
    // k3-agent prices through the kimi-k3 alias, never $0.
    expect(calls.every(call => call.costUSD > 0)).toBe(true)
  })

  it('parses single-turn usage with the real model id and estimated token pricing', async () => {
    const [wirePath] = await writeSession('single-turn', [{ id: 'main', lines: [
      prompt('Summarize the neutral module.', 1782900000000),
      request('0.1', 'friendly-alias', 'kimi-k3', 1782900001000),
      usage('friendly-alias', 1782900002000, {
        input: 100,
        output: 40,
        cacheRead: 25,
        cacheWrite: 10,
      }),
    ] }])
    const provider = createKimicodeProvider(fixtureHome)
    const source = { path: wirePath!, project: 'neutral-project', provider: 'kimicode', sourceId: 'main' }
    const seen = new Set<string>()

    const calls = await collect(provider, source, seen)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'kimicode',
      model: 'kimi-k3',
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 25,
      cacheCreationInputTokens: 10,
      cachedInputTokens: 25,
      costIsEstimated: true,
      timestamp: '2026-07-01T10:00:02.000Z',
      turnId: '0',
      userMessage: 'Summarize the neutral module.',
      sessionId: 'single-turn',
      projectPath: '/workspace/neutral-project',
    })
    expect(calls[0]!.model).not.toBe('friendly-alias')
    expect(calls[0]!.costUSD).toBe(calculateCost('kimi-k3', 100, 40, 10, 25, 0))
    await expect(collect(provider, source, seen)).resolves.toHaveLength(0)
  })

  it('uses the usage alias to resolve the exact request model', async () => {
    const [wirePath] = await writeSession('alias-model-resolution', [{ id: 'main', lines: [
      prompt('Compare two neutral model requests.', 1782900050000),
      request('0.1', 'first-alias', 'kimi-k3', 1782900051000),
      request('0.2', 'second-alias', 'glm-5.2', 1782900052000),
      usage('first-alias', 1782900053000, { input: 24, output: 6 }),
    ] }])
    const provider = createKimicodeProvider(fixtureHome)

    const calls = await collect(provider, {
      path: wirePath!, project: 'neutral-project', provider: 'kimicode', sourceId: 'main',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('kimi-k3')
  })

  it('attaches multiple tool calls and bash command names to the billed step', async () => {
    const [wirePath] = await writeSession('multi-tool', [{ id: 'main', lines: [
      prompt('Inspect and verify the neutral fixture.', 1782900100000),
      request('0.1', 'glm-alias', 'glm-5.2', 1782900101000),
      tool('Write', 0, { path: 'notes.txt', content: 'neutral' }),
      tool('Read', 0, { path: 'notes.txt' }),
      tool('Bash', 0, { command: 'npm test && git status' }),
      tool('Grep', 0, { pattern: 'neutral' }),
      usage('glm-alias', 1782900102000, { input: 80, output: 20 }),
    ] }])
    const provider = createKimicodeProvider(fixtureHome)

    const calls = await collect(provider, {
      path: wirePath!, project: 'neutral-project', provider: 'kimicode', sourceId: 'main',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Write', 'Read', 'Bash', 'Grep'])
    expect(calls[0]!.bashCommands).toEqual(['npm', 'git'])
    expect(calls[0]!.model).toBe('glm-5.2')
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('does not carry failed-turn tools into the next turn usage', async () => {
    const [wirePath] = await writeSession('failed-turn-tools', [{ id: 'main', lines: [
      prompt('Run a neutral command in the first turn.', 1782900150000),
      request('0.1', 'first-alias', 'kimi-k3', 1782900151000),
      tool('Bash', 0, { command: 'npm test' }),
      prompt('Continue with a clean second turn.', 1782900160000),
      usage('first-alias', 1782900161000, { input: 18, output: 4 }),
    ] }])
    const provider = createKimicodeProvider(fixtureHome)

    const calls = await collect(provider, {
      path: wirePath!, project: 'neutral-project', provider: 'kimicode', sourceId: 'main',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual([])
    expect(calls[0]!.bashCommands).toEqual([])
  })

  it('keeps multiple turns in one session and attributes each prompt and model', async () => {
    const [wirePath] = await writeSession('multi-turn', [{ id: 'main', lines: [
      prompt('Review the first neutral file.', 1782900200000),
      request('0.1', 'first-alias', 'kimi-k3', 1782900201000),
      usage('first-alias', 1782900202000, { input: 20, output: 5 }),
      prompt('Now review the second neutral file.', 1782900210000),
      request('1.1', 'second-alias', 'glm-5.2', 1782900211000),
      usage('second-alias', 1782900212000, { input: 30, output: 7 }),
    ] }])
    const provider = createKimicodeProvider(fixtureHome)

    const calls = await collect(provider, {
      path: wirePath!, project: 'neutral-project', provider: 'kimicode', sourceId: 'main',
    })

    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.sessionId)).toEqual(['multi-turn', 'multi-turn'])
    expect(calls.map(call => call.turnId)).toEqual(['0', '1'])
    expect(calls.map(call => call.model)).toEqual(['kimi-k3', 'glm-5.2'])
    expect(calls.map(call => call.userMessage)).toEqual([
      'Review the first neutral file.',
      'Now review the second neutral file.',
    ])
  })

  it('returns zero usage without throwing for a failed retry-only session', async () => {
    const [wirePath] = await writeSession('failed-retry', [{ id: 'main', lines: [
      prompt('Perform a neutral operation.', 1782900300000),
      request('0.1', 'retry-alias', 'kimi-k3', 1782900301000),
      request('0.1', 'retry-alias', 'kimi-k3', 1782900302000, '2/10'),
      request('0.1', 'retry-alias', 'kimi-k3', 1782900303000, '3/10'),
    ] }])
    const provider = createKimicodeProvider(fixtureHome)

    await expect(collect(provider, {
      path: wirePath!, project: 'neutral-project', provider: 'kimicode', sourceId: 'main',
    })).resolves.toEqual([])
  })

  it('counts main and subagent usage once each under the same session', async () => {
    await writeSession('subagent', [
      { id: 'main', lines: [
        prompt('Coordinate a neutral task.', 1782900400000),
        request('0.1', 'main-alias', 'kimi-k3', 1782900401000),
        usage('main-alias', 1782900402000, { input: 50, output: 10 }),
      ] },
      { id: 'agent-helper', lines: [
        request('0.1', 'helper-alias', 'glm-5.2', 1782900403000),
        usage('helper-alias', 1782900404000, { input: 15, output: 4 }),
      ] },
    ])
    const provider = createKimicodeProvider(fixtureHome)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const calls = (await Promise.all(sources.map(source => collect(provider, source, seen)))).flat()

    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.sessionId === 'subagent')).toBe(true)
    expect(calls.reduce((sum, call) => sum + call.inputTokens, 0)).toBe(65)
    expect(new Set(calls.map(call => call.deduplicationKey)).size).toBe(2)
  })

  it('skips malformed JSONL lines and continues with later valid events', async () => {
    const [wirePath] = await writeSession('malformed-lines', [{ id: 'main', lines: [
      prompt('Continue after malformed fixture data.', 1782900500000),
      '{not valid json',
      request('0.1', 'safe-alias', 'kimi-k3', 1782900501000),
      'null',
      usage('safe-alias', 1782900502000, { input: 12, output: 3 }),
      '{"type":"context.append_loop_event","event":',
    ] }])
    const provider = createKimicodeProvider(fixtureHome)

    const calls = await collect(provider, {
      path: wirePath!, project: 'neutral-project', provider: 'kimicode', sourceId: 'main',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'kimi-k3', inputTokens: 12, outputTokens: 3 })
  })
})
