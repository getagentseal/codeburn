import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLingTaiTuiProvider } from '../../src/providers/lingtai-tui.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'lingtai-tui-provider-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeAgent(name: string, opts: {
  home?: string
  manifest?: Record<string, unknown>
  ledgerLines?: Array<Record<string, unknown> | string>
} = {}): Promise<string> {
  const home = opts.home ?? tmpDir
  const agentDir = join(home, name)
  await mkdir(join(agentDir, 'logs'), { recursive: true })
  if (opts.manifest) {
    await writeFile(join(agentDir, '.agent.json'), JSON.stringify(opts.manifest, null, 2))
  }
  const ledgerPath = join(agentDir, 'logs', 'token_ledger.jsonl')
  const lines = opts.ledgerLines ?? []
  await writeFile(
    ledgerPath,
    lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + (lines.length ? '\n' : ''),
  )
  return ledgerPath
}

async function collectCalls(provider: ReturnType<typeof createLingTaiTuiProvider>, sourcePath: string, project = 'agent'): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  const parser = provider.createSessionParser({ path: sourcePath, project, provider: 'lingtai-tui' }, new Set())
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('lingtai-tui provider', () => {
  it('discovers top-level LingTai token ledgers', async () => {
    const ledgerPath = await writeAgent('agent-a', {
      manifest: {
        agent_id: 'agent-001',
        agent_name: 'Operator Agent',
        llm: { model: 'gpt-5.5', base_url: 'example-endpoint' },
      },
      ledgerLines: [
        { source: 'main', ts: '2026-06-04T01:25:09Z', input: 100, output: 20, thinking: 5, cached: 10, model: 'gpt-5.5' },
      ],
    })
    await mkdir(join(tmpDir, 'agent-a', 'daemons', 'em-1', 'logs'), { recursive: true })
    await writeFile(join(tmpDir, 'agent-a', 'daemons', 'em-1', 'logs', 'token_ledger.jsonl'), '{}\n')

    const provider = createLingTaiTuiProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toEqual([{ path: ledgerPath, project: 'Operator Agent', provider: 'lingtai-tui' }])
  })

  it('discovers project-local LingTai homes from the TUI registry', async () => {
    const defaultHome = join(tmpDir, 'home', '.lingtai')
    const globalDir = join(tmpDir, 'home', '.lingtai-tui')
    const projectRoot = join(tmpDir, 'projects', 'sample-project')
    const projectHome = join(projectRoot, '.lingtai')

    const defaultLedger = await writeAgent('personal', {
      home: defaultHome,
      manifest: { agent_name: 'Personal Agent' },
      ledgerLines: [{ ts: '2026-07-06T01:00:00Z', input: 1, output: 1, model: 'gpt-5.5' }],
    })
    const projectLedger = await writeAgent('lingtai', {
      home: projectHome,
      manifest: { agent_name: 'Project Agent' },
      ledgerLines: [{ ts: '2026-07-06T02:00:00Z', input: 2, output: 2, model: 'gpt-5.5' }],
    })
    await mkdir(globalDir, { recursive: true })
    await writeFile(join(globalDir, 'registry.jsonl'), JSON.stringify({ path: projectRoot }) + '\n')

    const provider = createLingTaiTuiProvider({
      defaultHomeOverride: defaultHome,
      globalDirOverride: globalDir,
      cwdOverride: join(tmpDir, 'elsewhere'),
    })
    const sessions = await provider.discoverSessions()

    expect(sessions).toEqual([
      { path: defaultLedger, project: 'Personal Agent', provider: 'lingtai-tui' },
      { path: projectLedger, project: 'sample-project-Project Agent', provider: 'lingtai-tui' },
    ])
  })

  it('parses ledger entries and separates cached input from fresh input', async () => {
    const ledgerPath = await writeAgent('agent-b', {
      manifest: {
        agent_id: 'agent-002',
        address: 'agent-b',
        llm: { model: 'fallback-model', base_url: 'fallback-endpoint' },
      },
      ledgerLines: [
        { source: 'main', ts: '2026-06-04T01:25:09Z', input: 100, output: 20, thinking: 5, cached: 10, model: 'gpt-5.5', endpoint: 'example-endpoint' },
        { source: 'tc_wake', ts: '2026-06-04T01:28:24Z', input: 25, output: 5, thinking: 0, cached: 10 },
        { source: 'summarize_apriori', ts: '2026-06-04T01:29:24Z', input: 40, output: 10, thinking: 0, cached: 20 },
        { source: 'daemon', em_id: 'em-1', run_id: 'run-1', ts: '2026-06-04T01:30:24Z', input: 50, output: 10, thinking: 0, cached: 50 },
      ],
    })

    const calls = await collectCalls(createLingTaiTuiProvider(tmpDir), ledgerPath, 'agent-b')

    expect(calls).toHaveLength(4)
    expect(calls[0]).toMatchObject({
      provider: 'lingtai-tui',
      model: 'gpt-5.5',
      inputTokens: 90,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadInputTokens: 10,
      cachedInputTokens: 10,
      timestamp: '2026-06-04T01:25:09.000Z',
      userMessage: 'LingTai main conversation',
      sessionId: 'agent-002:main',
      project: 'agent-b',
    })
    expect(calls[1]).toMatchObject({
      tools: ['Agent'],
      subagentTypes: ['lingtai-task-coordinator'],
      userMessage: 'LingTai task coordinator wake',
      sessionId: 'agent-002:tc_wake',
    })
    expect(calls[2]).toMatchObject({
      tools: ['EnterPlanMode'],
      subagentTypes: [],
      userMessage: 'LingTai planning summary',
      sessionId: 'agent-002:summarize_apriori',
    })
    expect(calls[1]).toMatchObject({
      model: 'fallback-model',
    })
    expect(calls[3]).toMatchObject({
      model: 'fallback-model',
      inputTokens: 0,
      cacheReadInputTokens: 50,
      tools: ['Agent'],
      subagentTypes: ['lingtai-daemon'],
      sessionId: 'run-1',
      userMessage: 'LingTai daemon task',
    })
    expect(calls[0]!.deduplicationKey).not.toBe(calls[3]!.deduplicationKey)
  })

  it('skips corrupt and zero-token lines', async () => {
    const ledgerPath = await writeAgent('agent-c', {
      ledgerLines: [
        'not json',
        { source: 'main', ts: '2026-06-04T01:25:09Z', input: 0, output: 0, thinking: 0, cached: 0, model: 'gpt-5.5' },
        { source: 'main', ts: '2026-06-04T01:26:09Z', input: 1, output: 2, thinking: 3, cached: 0, model: 'gpt-5.5' },
      ],
    })

    const calls = await collectCalls(createLingTaiTuiProvider(tmpDir), ledgerPath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(1)
    expect(calls[0]!.outputTokens).toBe(2)
    expect(calls[0]!.reasoningTokens).toBe(3)
  })

  it('uses shared model display names', () => {
    const provider = createLingTaiTuiProvider(tmpDir)
    expect(provider.modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(provider.modelDisplayName('some-future-model')).toBe('some-future-model')
  })

  // A planted .agent.json can be valid JSON with wrong-typed fields. Before the
  // manifest was normalized, an object-valued agent_name reached
  // sanitizeProject().trim() and threw — and discoverAllSessions loops providers
  // with no try/catch, so that one file broke usage discovery for EVERY
  // provider. Discovery and parsing must both survive it.
  it('does not crash on a valid-JSON manifest with wrong-typed fields', async () => {
    const ledgerPath = await writeAgent('agent-hostile', {
      manifest: {
        agent_name: {},
        agent_id: [1, 2],
        address: 42,
        nickname: { x: 1 },
        llm: { model: {}, base_url: [] },
      },
      ledgerLines: [
        { source: 'main', ts: '2026-06-04T01:26:09Z', input: 10, output: 5, model: 'gpt-5.5' },
      ],
    })

    const provider = createLingTaiTuiProvider(tmpDir)
    await expect(provider.discoverSessions()).resolves.toBeInstanceOf(Array)
    const calls = await collectCalls(provider, ledgerPath)
    expect(calls).toHaveLength(1)
    // Wrong-typed manifest name falls back to the sanitized agent directory.
    expect(typeof calls[0]!.model).toBe('string')
  })
})
