import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { priceProviderCall } from '../../src/pricing-pass.js'
import { kiro, createKiroProvider } from '../../src/providers/kiro.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kiro-golden-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeChatFile(opts: {
  executionId?: string
  modelId?: string
  workflowId?: string
  startTime?: number
  endTime?: number
  userPrompt?: string
  botResponses?: string[]
}) {
  const chat = [
    { role: 'human', content: '<identity>\nYou are Kiro.\n</identity>' },
    { role: 'bot', content: '' },
    { role: 'tool', content: 'workspace tree...' },
    { role: 'bot', content: 'I will follow these instructions.' },
  ]
  if (opts.userPrompt) chat.push({ role: 'human', content: opts.userPrompt })
  for (const resp of opts.botResponses ?? ['Done.']) chat.push({ role: 'bot', content: resp })
  return JSON.stringify({
    executionId: opts.executionId ?? 'exec-001',
    actionId: 'act',
    context: [],
    validations: {},
    chat,
    metadata: {
      modelId: opts.modelId ?? 'claude-haiku-4-5',
      modelProvider: 'qdev',
      workflow: 'act',
      workflowId: opts.workflowId ?? 'wf-001',
      startTime: opts.startTime ?? 1777333000000,
      endTime: opts.endTime ?? 1777333010000,
    },
  })
}

function makeModernExecutionFile(opts: {
  executionId?: string
  sessionId?: string
  modelId?: string
  startTime?: number | string
  userPrompt?: string
  assistantResponse?: string
  usageSummary?: Array<{ usedTools?: string[]; usage?: number; unit?: string }>
}) {
  const startTime = opts.startTime ?? 1777333000000
  return JSON.stringify({
    executionId: opts.executionId ?? 'exec-modern-001',
    sessionId: opts.sessionId ?? 'session-modern-001',
    workflowType: 'chat-agent',
    status: 'succeed',
    startTime,
    endTime: typeof startTime === 'number' ? startTime + 10000 : 1777333010000,
    modelId: opts.modelId ?? 'claude-sonnet-4.5',
    messages: [
      { role: 'user', content: opts.userPrompt ?? 'explain the new kiro storage layout' },
      { role: 'assistant', content: opts.assistantResponse ?? 'Done. <tool_use><name>runCommand</name></tool_use>', toolCalls: [{ name: 'readFile' }] },
    ],
    usageSummary: opts.usageSummary,
  })
}

type V2Turn = {
  exec: string
  ts: string
  user: string
  say?: string
  reasoning?: string
  tools?: string[]
  toolResults?: string[]
  credits?: number
}

function makeV2Messages(turns: V2Turn[]): string {
  const lines: string[] = []
  lines.push(JSON.stringify({ id: 'sess-start', timestamp: turns[0]?.ts ?? '2026-07-14T13:39:00.000Z', payload: { type: 'session_start', agentType: 'vibe' } }))
  for (const t of turns) {
    lines.push(JSON.stringify({ id: `${t.exec}-u`, timestamp: t.ts, payload: { type: 'user', content: t.user, images: [], documents: [] } }))
    lines.push(JSON.stringify({ id: `${t.exec}-ts`, timestamp: t.ts, payload: { type: 'turn_start', executionId: t.exec } }))
    if (t.reasoning) {
      lines.push(JSON.stringify({ id: `${t.exec}-r`, timestamp: t.ts, payload: { type: 'assistant', operationType: 'Reasoning', content: t.reasoning, executionId: t.exec } }))
    }
    lines.push(JSON.stringify({ id: `${t.exec}-a`, timestamp: t.ts, payload: { type: 'assistant', operationType: 'Say', content: t.say ?? 'Done.', executionId: t.exec } }))
    for (const tool of t.tools ?? []) {
      lines.push(JSON.stringify({ id: `${t.exec}-tc`, timestamp: t.ts, payload: { type: 'tool_call', toolName: tool, toolCallId: `${t.exec}-${tool}`, executionId: t.exec } }))
    }
    for (const [i, result] of (t.toolResults ?? []).entries()) {
      lines.push(JSON.stringify({ id: `${t.exec}-tr${i}`, timestamp: t.ts, payload: { type: 'tool_result', toolCallId: `${t.exec}-tr${i}`, content: result, success: true, executionId: t.exec } }))
    }
    lines.push(JSON.stringify({ id: `${t.exec}-cm`, timestamp: t.ts, payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 12.5 }, executionId: t.exec } }))
    lines.push(JSON.stringify({ id: `${t.exec}-us`, timestamp: t.ts, payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: t.credits ?? 1, usedTools: t.tools ?? [] }], status: 'success', executionId: t.exec } }))
    lines.push(JSON.stringify({ id: `${t.exec}-te`, timestamp: t.ts, payload: { type: 'turn_end', stopReason: 'end_turn', executionId: t.exec } }))
  }
  return lines.join('\n')
}

async function makeV2Session(sessionsRoot: string, opts: {
  wsHash?: string
  sessionId?: string
  modelId?: string
  workspacePaths?: string[]
  turns: V2Turn[]
}): Promise<string> {
  const wsHash = opts.wsHash ?? '4748323122002acb'
  const sessionId = opts.sessionId ?? 'sess_test-001'
  const sessDir = join(sessionsRoot, wsHash, sessionId)
  await mkdir(sessDir, { recursive: true })
  await writeFile(join(sessDir, 'session.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    dataModelVersion: 1,
    id: sessionId,
    title: 'Test v2 session',
    agentMode: 'vibe',
    workspacePaths: opts.workspacePaths ?? ['/tmp/test-proj'],
    modelId: opts.modelId ?? 'claude-opus-4.8',
    status: 'in_progress',
  }))
  await writeFile(join(sessDir, 'messages.jsonl'), makeV2Messages(opts.turns))
  return join(sessDir, 'messages.jsonl')
}

async function parseSource(source: { path: string; project: string; provider: 'kiro' }, seenKeys?: Set<string>): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of kiro.createSessionParser(source, seenKeys ?? new Set()).parse()) calls.push(call)
  return calls
}

const BASE18_KEYS = [
  'bashCommands',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'cachedInputTokens',
  'costBasis',
  'costIsEstimated',
  'deduplicationKey',
  'inputTokens',
  'model',
  'outputTokens',
  'provider',
  'reasoningTokens',
  'sessionId',
  'speed',
  'timestamp',
  'tools',
  'userMessage',
  'webSearchRequests',
]

describe('kiro golden pins (raw calls, unmodified provider)', () => {
  it('G0 — key-set gates for all five arms', async () => {
    // A1 chat
    {
      const wsHash = 'a'.repeat(32)
      const wsDir = join(tmpDir, 'g0a1', wsHash)
      await mkdir(wsDir, { recursive: true })
      const chatPath = join(wsDir, 'g0.chat')
      await writeFile(chatPath, makeChatFile({ botResponses: ['hi'] }))
      const calls = await parseSource({ path: chatPath, project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 15), 'toolSequence', ...BASE18_KEYS.slice(15)])
    }

    // A2 modern without credits (18 keys)
    {
      const wsHash = 'a'.repeat(32)
      const wsDir = join(tmpDir, 'g0a2none', wsHash, 'sess')
      await mkdir(wsDir, { recursive: true })
      const path = join(wsDir, 'exec')
      await writeFile(path, makeModernExecutionFile({ userPrompt: 'hi', assistantResponse: 'hello' }))
      const calls = await parseSource({ path, project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual(BASE18_KEYS)
    }

    // A2 modern with credits (19 keys)
    {
      const wsHash = 'b'.repeat(32)
      const wsDir = join(tmpDir, 'g0a2some', wsHash, 'sess')
      await mkdir(wsDir, { recursive: true })
      const path = join(wsDir, 'exec')
      await writeFile(path, makeModernExecutionFile({ userPrompt: 'hi', assistantResponse: 'hello', usageSummary: [{ usage: 1, unit: 'credit' }] }))
      const calls = await parseSource({ path, project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 6), 'costUSD', ...BASE18_KEYS.slice(6)])
    }

    // A3 ws-session
    {
      const wsSessionsDir = join(tmpDir, 'g0a3', 'workspace-sessions', 'L3RtcC90ZXN0')
      await mkdir(wsSessionsDir, { recursive: true })
      const path = join(wsSessionsDir, 'ws.json')
      await writeFile(path, JSON.stringify({
        sessionId: 'ws-g0',
        selectedModel: 'claude-opus-4.8',
        history: [{ message: { role: 'user', content: 'hi' } }, { message: { role: 'assistant', content: 'hello' } }],
      }))
      const calls = await parseSource({ path, project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual(BASE18_KEYS)
    }

    // A4 cli without credits (19 keys)
    {
      const cliDir = join(tmpDir, 'g0a4none', 'cli')
      await mkdir(cliDir, { recursive: true })
      const sessionId = '00000000-0000-0000-0000-000000000000'
      await writeFile(join(cliDir, `${sessionId}.jsonl`), [
        JSON.stringify({ version: '1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'hi' }] } }),
        JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'hello' }] } }),
      ].join('\n'))
      await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({ session_id: sessionId, cwd: '/tmp/p', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z' }))
      const calls = await parseSource({ path: join(cliDir, `${sessionId}.jsonl`), project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 10), 'project', ...BASE18_KEYS.slice(10)])
    }

    // A4 cli with credits (20 keys)
    {
      const cliDir = join(tmpDir, 'g0a4some', 'cli')
      await mkdir(cliDir, { recursive: true })
      const sessionId = '00000000-0000-0000-0000-000000000001'
      await writeFile(join(cliDir, `${sessionId}.jsonl`), [
        JSON.stringify({ version: '1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'hi' }] } }),
        JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'hello' }] } }),
      ].join('\n'))
      await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
        session_id: sessionId, cwd: '/tmp/p', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z',
        session_state: { conversation_metadata: { user_turn_metadatas: [{ end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 1, unit: 'credit' }] }] } },
      }))
      const calls = await parseSource({ path: join(cliDir, `${sessionId}.jsonl`), project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 6), 'costUSD', ...BASE18_KEYS.slice(6, 10), 'project', ...BASE18_KEYS.slice(10)])
    }

    // A5 v2 without credits (19 keys)
    {
      const sessionsRoot = join(tmpDir, 'g0a5none')
      const msgs = await makeV2Session(sessionsRoot, { sessionId: 'sess_g0a5none', turns: [{ exec: 'exec-1', ts: '2026-07-14T13:39:40.000Z', user: 'hi', say: 'hello', credits: 0 }] })
      const calls = await parseSource({ path: msgs, project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 10), 'project', ...BASE18_KEYS.slice(10)])
    }

    // A5 v2 with credits (20 keys)
    {
      const sessionsRoot = join(tmpDir, 'g0a5some')
      const msgs = await makeV2Session(sessionsRoot, { sessionId: 'sess_g0a5some', turns: [{ exec: 'exec-1', ts: '2026-07-14T13:39:40.000Z', user: 'hi', say: 'hello', credits: 1 }] })
      const calls = await parseSource({ path: msgs, project: 'p', provider: 'kiro' })
      expect(calls).toHaveLength(1)
      expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 6), 'costUSD', ...BASE18_KEYS.slice(6, 10), 'project', ...BASE18_KEYS.slice(10)])
    }
  })

  it('G1 — A1 chat whole object (multi-tool, priced)', async () => {
    const wsHash = 'a'.repeat(32)
    const wsDir = join(tmpDir, 'g1', wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'abc123.chat')
    await writeFile(chatPath, makeChatFile({
      executionId: 'exec-g1',
      workflowId: 'wf-g1',
      userPrompt: 'explain the code',
      botResponses: [
        'First answer with <tool_use><name>runCommand</name></tool_use>',
        'Second answer with <tool_use><name>readFile</name></tool_use>',
      ],
    }))
    const calls = await parseSource({ path: chatPath, project: 'myproject', provider: 'kiro' })
    expect(calls).toStrictEqual([{
      provider: 'kiro',
      model: 'claude-haiku-4-5',
      inputTokens: 4,
      outputTokens: 39,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      tools: ['Bash', 'Read'],
      bashCommands: [],
      toolSequence: [[{ tool: 'Bash' }], [{ tool: 'Read' }]],
      timestamp: '2026-04-27T23:36:40.000Z',
      speed: 'standard',
      deduplicationKey: 'kiro:wf-g1:exec-g1',
      userMessage: 'explain the code',
      sessionId: 'wf-g1',
    }])
    expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 15), 'toolSequence', ...BASE18_KEYS.slice(15)])
    // A1 never carries credits, so the raw call has no costUSD and pricing must
    // fall back to token estimation (exact value tracks the litellm snapshot).
    expect('costUSD' in calls[0]!).toBe(false)
    const priced = priceProviderCall(calls[0]!)
    expect(priced.costUSD).toBeGreaterThan(0)
    expect(priced.costIsEstimated).toBe(true)
  })

  it('G1b — A1 chat dedup key uses the raw executionId field (no path fallback)', async () => {
    const wsHash = 'e'.repeat(32)
    const wsDir = join(tmpDir, 'g1b', wsHash)
    await mkdir(wsDir, { recursive: true })

    const missing = join(wsDir, 'no-execid.chat')
    await writeFile(missing, JSON.stringify({
      actionId: 'act',
      chat: [{ role: 'human', content: 'q' }, { role: 'bot', content: 'answer' }],
      metadata: { modelId: 'claude-haiku-4-5', workflowId: 'wf-g1b', startTime: 1777333000000 },
    }))
    const missingCalls = await parseSource({ path: missing, project: 'p', provider: 'kiro' })
    expect(missingCalls).toHaveLength(1)
    expect(missingCalls[0]!.deduplicationKey).toBe('kiro:wf-g1b:undefined')

    const blank = join(wsDir, 'blank-execid.chat')
    await writeFile(blank, JSON.stringify({
      executionId: '',
      actionId: 'act',
      chat: [{ role: 'human', content: 'q' }, { role: 'bot', content: 'answer' }],
      metadata: { modelId: 'claude-haiku-4-5', workflowId: 'wf-g1b2', startTime: 1777333000000 },
    }))
    const blankCalls = await parseSource({ path: blank, project: 'p', provider: 'kiro' })
    expect(blankCalls).toHaveLength(1)
    expect(blankCalls[0]!.deduplicationKey).toBe('kiro:wf-g1b2:')
  })

  it('G2 — A1 input tokens from the full prompt (500 cap is display-only); A2 modern arm from full prompt', async () => {
    const wsHashA1 = 'a'.repeat(32)
    const wsDirA1 = join(tmpDir, 'g2a1', wsHashA1)
    await mkdir(wsDirA1, { recursive: true })
    const chatPath = join(wsDirA1, 'long.chat')
    await writeFile(chatPath, makeChatFile({
      executionId: 'exec-g2a1',
      workflowId: 'wf-g2a1',
      userPrompt: 'x'.repeat(3000),
      botResponses: ['short'],
    }))
    const a1 = await parseSource({ path: chatPath, project: 'p', provider: 'kiro' })
    expect(a1).toHaveLength(1)
    // 3000 fixture chars / 4 per token = 750. The prior pin (125) encoded the
    // pre-fix behaviour: input tokens were estimated from the last human turn
    // sliced to 500 chars (500 / 4 = 125), under-reporting cost for any longer
    // prompt. That bug was fixed by porting upstream 6c4645a ('fix(kiro):
    // estimate input tokens from the full prompt, not a 500-char slice');
    // do not restore 125.
    expect(a1[0]!.inputTokens).toBe(750)
    expect(a1[0]!.userMessage.length).toBe(500)

    const wsHashA2 = 'b'.repeat(32)
    const wsDirA2 = join(tmpDir, 'g2a2', wsHashA2, 'session-modern')
    await mkdir(wsDirA2, { recursive: true })
    const execPath = join(wsDirA2, 'execution-modern')
    await writeFile(execPath, makeModernExecutionFile({
      executionId: 'exec-g2a2',
      sessionId: 'session-g2a2',
      userPrompt: 'x'.repeat(2000),
      assistantResponse: 'short',
    }))
    const a2 = await parseSource({ path: execPath, project: 'p', provider: 'kiro' })
    expect(a2).toHaveLength(1)
    expect(a2[0]!.inputTokens).toBe(500)
  })

  it('G2b — A1 rounding is pinned: an odd length forces ceil, not round/floor', async () => {
    // 3000 (G2), 2400 (money-path regression) and 1000+1000 (multi-turn
    // accumulation) are all exact multiples of four, so they cannot
    // distinguish ceil from round or floor in estimateTokensFromChars.
    // 3001 chars / 4 = 750.25: ceil gives 751, round and floor both give
    // 750 — only the ceil pin passes here.
    const wsHash = 'd'.repeat(32)
    const wsDir = join(tmpDir, 'g2b', wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'odd.chat')
    await writeFile(chatPath, makeChatFile({
      executionId: 'exec-g2b',
      workflowId: 'wf-g2b',
      userPrompt: 'x'.repeat(3001),
      botResponses: ['short'],
    }))
    const calls = await parseSource({ path: chatPath, project: 'p', provider: 'kiro' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(751)
    expect(calls[0]!.userMessage.length).toBe(500)
  })

  it('G3 — A1 single-tool toolSequence is present but undefined', async () => {
    const wsHash = 'c'.repeat(32)
    const wsDir = join(tmpDir, 'g3', wsHash)
    await mkdir(wsDir, { recursive: true })
    const chatPath = join(wsDir, 'single.chat')
    await writeFile(chatPath, makeChatFile({
      executionId: 'exec-g3',
      workflowId: 'wf-g3',
      userPrompt: 'do one thing',
      botResponses: ['One tool: <tool_use><name>writeFile</name></tool_use>'],
    }))
    const calls = await parseSource({ path: chatPath, project: 'p', provider: 'kiro' })
    expect(calls).toHaveLength(1)
    expect('toolSequence' in calls[0]!).toBe(true)
    expect(calls[0]!.toolSequence).toBeUndefined()
    expect(Object.keys(calls[0]!).sort()).toEqual([...BASE18_KEYS.slice(0, 15), 'toolSequence', ...BASE18_KEYS.slice(15)])
  })

  it('G4 — A2 modern both cost paths (whole object)', async () => {
    const wsHash = 'd'.repeat(32)
    const sessDir = join(tmpDir, 'g4', wsHash, 'session-cost')
    await mkdir(sessDir, { recursive: true })

    const withCredits = join(sessDir, 'with-credits')
    await writeFile(withCredits, makeModernExecutionFile({
      executionId: 'exec-g4-with',
      sessionId: 'session-g4',
      userPrompt: 'priced',
      assistantResponse: 'answer',
      usageSummary: [{ usedTools: ['readFile'], usage: 2, unit: 'credit' }],
    }))
    const withCalls = await parseSource({ path: withCredits, project: 'p', provider: 'kiro' })
    expect(withCalls).toStrictEqual([{
      provider: 'kiro',
      model: 'claude-sonnet-4-5',
      inputTokens: 2,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.08,
      costBasis: 'measured',
      costIsEstimated: false,
      tools: ['Read'],
      bashCommands: [],
      timestamp: '2026-04-27T23:36:40.000Z',
      speed: 'standard',
      deduplicationKey: 'kiro:session-g4:exec-g4-with',
      userMessage: 'priced',
      sessionId: 'session-g4',
    }])

    const withoutCredits = join(sessDir, 'without-credits')
    await writeFile(withoutCredits, makeModernExecutionFile({
      executionId: 'exec-g4-without',
      sessionId: 'session-g4',
      userPrompt: 'unpriced',
      assistantResponse: 'answer',
    }))
    const withoutCalls = await parseSource({ path: withoutCredits, project: 'p', provider: 'kiro' })
    expect(withoutCalls).toStrictEqual([{
      provider: 'kiro',
      model: 'claude-sonnet-4-5',
      inputTokens: 2,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      tools: ['Read'],
      bashCommands: [],
      timestamp: '2026-04-27T23:36:40.000Z',
      speed: 'standard',
      deduplicationKey: 'kiro:session-g4:exec-g4-without',
      userMessage: 'unpriced',
      sessionId: 'session-g4',
    }])
  })

  it('G4b — credits seam: host multiplication is exact and survives pricing', async () => {
    // credits x USD_PER_KIRO_CREDIT (0.04) is plain float arithmetic; pin the
    // exact products so a changed rate or a moved multiply is caught.
    const wsHash = 'f'.repeat(32)
    const sessDir = join(tmpDir, 'g4b', wsHash, 'session-frac')
    await mkdir(sessDir, { recursive: true })
    const path = join(sessDir, 'frac')
    await writeFile(path, makeModernExecutionFile({
      executionId: 'exec-g4b',
      sessionId: 'session-g4b',
      userPrompt: 'frac',
      assistantResponse: 'answer',
      usageSummary: [{ usage: 0.05, unit: 'credit' }, { usage: 0.2, unit: 'credit' }],
    }))
    const calls = await parseSource({ path, project: 'p', provider: 'kiro' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(0.25 * 0.04)
    expect(calls[0]!.costBasis).toBe('measured')
    expect(calls[0]!.costIsEstimated).toBe(false)
    expect(priceProviderCall(calls[0]!).costUSD).toBe(0.25 * 0.04)

    const sessionsRoot = join(tmpDir, 'g4bv2')
    const msgs = await makeV2Session(sessionsRoot, {
      sessionId: 'sess_g4b',
      turns: [{ exec: 'exec-g4b-v2', ts: '2026-07-14T13:39:40.000Z', user: 'frac', say: 'answer', credits: 0.05 }],
    })
    const v2calls = await parseSource({ path: msgs, project: 'p', provider: 'kiro' })
    expect(v2calls).toHaveLength(1)
    expect(v2calls[0]!.costUSD).toBe(0.05 * 0.04)
    expect(priceProviderCall(v2calls[0]!).costUSD).toBe(0.05 * 0.04)
  })

  it('G5 — A3 ws-session timestamp from mtime, no project key, stub-only yields zero', async () => {
    const wsSessionsDir = join(tmpDir, 'g5', 'workspace-sessions', 'L3RtcC90ZXN0')
    await mkdir(wsSessionsDir, { recursive: true })
    const path = join(wsSessionsDir, 'ws-session-g5.json')
    await writeFile(path, JSON.stringify({
      sessionId: 'ws-session-g5',
      title: 'Test',
      selectedModel: 'claude-opus-4.8',
      workspaceDirectory: '/tmp/test',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'What is TypeScript?' }] } },
        { message: { role: 'assistant', content: 'TypeScript is a typed superset.' } },
        { message: { role: 'assistant', content: 'On it.' }, executionId: 'exec-ref-g5' },
      ],
    }))
    const calls = await parseSource({ path, project: 'test', provider: 'kiro' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('ws-session-g5')
    expect(calls[0]!.deduplicationKey).toBe('kiro:ws-session:ws-session-g5')
    expect(calls[0]!.timestamp).toBe(new Date((await stat(path)).mtimeMs).toISOString())
    expect(Object.keys(calls[0]!).sort()).toEqual(BASE18_KEYS)
    // A3 never carries credits either: raw call has no costUSD, pricing estimates.
    expect('costUSD' in calls[0]!).toBe(false)
    const g5priced = priceProviderCall(calls[0]!)
    expect(g5priced.costUSD).toBeGreaterThan(0)
    expect(g5priced.costIsEstimated).toBe(true)

    const stubPath = join(wsSessionsDir, 'ws-stub.json')
    await writeFile(stubPath, JSON.stringify({
      sessionId: 'ws-stub',
      selectedModel: 'auto',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'Deploy the stack' }] } },
        { message: { role: 'assistant', content: 'On it.' }, executionId: 'exec-ref' },
      ],
    }))
    const stubCalls = await parseSource({ path: stubPath, project: 'test', provider: 'kiro' })
    expect(stubCalls).toHaveLength(0)
  })

  it('G6 — A4 CLI turnIndex advances asymmetrically across zero-output turn', async () => {
    const cliDir = join(tmpDir, 'g6', 'cli')
    await mkdir(cliDir, { recursive: true })
    const sessionId = '66666666-6666-6666-6666-666666666666'
    const jsonl = [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'first' }], meta: { timestamp: 1700000000 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'first answer' }] } }),
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm3', content: [{ kind: 'text', data: 'second no output' }], meta: { timestamp: 1700000060 } } }),
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm5', content: [{ kind: 'text', data: 'third' }], meta: { timestamp: 1700000120 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm6', content: [{ kind: 'text', data: 'third answer' }] } }),
    ].join('\n')
    await writeFile(join(cliDir, `${sessionId}.jsonl`), jsonl)
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/tmp/g6-proj',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      session_state: {
        rts_model_state: { model_info: { model_id: 'claude-sonnet-4' } },
        conversation_metadata: {
          user_turn_metadatas: [
            { end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 1, unit: 'credit' }] },
            { end_timestamp: '2026-01-01T00:01:30Z', metering_usage: [{ value: 2, unit: 'credit' }] },
          ],
        },
      },
    }))
    const calls = await parseSource({ path: join(cliDir, `${sessionId}.jsonl`), project: 'g6', provider: 'kiro' })
    expect(calls).toStrictEqual([{
      provider: 'kiro',
      model: 'claude-sonnet-4',
      inputTokens: 2,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.04,
      costBasis: 'measured',
      costIsEstimated: false,
      tools: [],
      bashCommands: [],
      timestamp: '2026-01-01T00:00:30.000Z',
      speed: 'standard',
      deduplicationKey: `kiro-cli:${sessionId}:0`,
      userMessage: 'first',
      sessionId,
      project: 'g6-proj',
    }, {
      provider: 'kiro',
      model: 'claude-sonnet-4',
      inputTokens: 2,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.08,
      costBasis: 'measured',
      costIsEstimated: false,
      tools: [],
      bashCommands: [],
      timestamp: '2026-01-01T00:01:30.000Z',
      speed: 'standard',
      deduplicationKey: `kiro-cli:${sessionId}:1`,
      userMessage: 'third',
      sessionId,
      project: 'g6-proj',
    }])
  })

  it('G6b — A4 CLI turnIndex advances across a bad-timestamp turn too', async () => {
    const cliDir = join(tmpDir, 'g6b', 'cli')
    await mkdir(cliDir, { recursive: true })
    const sessionId = '66666666-6666-6666-6666-66666666666b'
    const jsonl = [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'first' }] } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'first answer' }] } }),
      JSON.stringify({ version: '1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'second' }] } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'second answer' }] } }),
      JSON.stringify({ version: '1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'third' }] } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'third answer' }] } }),
    ].join('\n')
    await writeFile(join(cliDir, `${sessionId}.jsonl`), jsonl)
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/tmp/g6b-proj',
      created_at: 'also-not-a-date',
      updated_at: '2026-01-01T00:01:00Z',
      session_state: {
        conversation_metadata: {
          user_turn_metadatas: [
            { end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 1, unit: 'credit' }] },
            { end_timestamp: 'not-a-date', metering_usage: [{ value: 9, unit: 'credit' }] },
            { end_timestamp: '2026-01-01T00:02:30Z', metering_usage: [{ value: 3, unit: 'credit' }] },
          ],
        },
      },
    }))
    const calls = await parseSource({ path: join(cliDir, `${sessionId}.jsonl`), project: 'g6b', provider: 'kiro' })
    expect(calls.map(c => [c.deduplicationKey, c.timestamp, c.costUSD])).toStrictEqual([
      [`kiro-cli:${sessionId}:0`, '2026-01-01T00:00:30.000Z', 0.04],
      [`kiro-cli:${sessionId}:2`, '2026-01-01T00:02:30.000Z', 0.12],
    ])
  })

  it('G7 — A5 v2 dedup-key fallback uses local results.length', async () => {
    const sessionsRoot = join(tmpDir, 'g7')
    const msgs = await makeV2Session(sessionsRoot, {
      sessionId: 'sess_g7',
      turns: [
        { exec: 'exec-g7-1', ts: '2026-07-14T13:39:40.000Z', user: 'first' },
        { exec: '', ts: '2026-07-14T13:40:00.000Z', user: 'second no execId' },
        { exec: 'exec-g7-3', ts: '2026-07-14T13:41:00.000Z', user: 'third' },
      ],
    })
    const calls = await parseSource({ path: msgs, project: 'g7', provider: 'kiro' })
    expect(calls.map(c => c.deduplicationKey)).toStrictEqual([
      'kiro-v2:sess_g7:exec-g7-1',
      'kiro-v2:sess_g7:1',
      'kiro-v2:sess_g7:exec-g7-3',
    ])
  })

  it('G8 — A5 v2 whole object (reasoning, tool_result, mcp strip, project, credits)', async () => {
    const sessionsRoot = join(tmpDir, 'g8')
    const msgs = await makeV2Session(sessionsRoot, {
      sessionId: 'sess_g8',
      turns: [
        { exec: 'exec-g8', ts: '2026-07-14T13:39:40.000Z', user: 'x'.repeat(8), say: 'done', reasoning: 'x'.repeat(400), tools: ['mcp_someTool'], toolResults: ['r'.repeat(150)], credits: 3 },
      ],
    })
    const calls = await parseSource({ path: msgs, project: 'g8-proj', provider: 'kiro' })
    expect(calls).toStrictEqual([{
      provider: 'kiro',
      model: 'claude-opus-4-8',
      inputTokens: 40,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 100,
      webSearchRequests: 0,
      costUSD: 0.12,
      costBasis: 'measured',
      costIsEstimated: false,
      tools: ['someTool'],
      bashCommands: [],
      timestamp: '2026-07-14T13:39:40.000Z',
      speed: 'standard',
      deduplicationKey: 'kiro-v2:sess_g8:exec-g8',
      userMessage: 'xxxxxxxx',
      sessionId: 'sess_g8',
      project: 'g8-proj',
    }])
    const priced = priceProviderCall(calls[0]!)
    expect(priced.costUSD).toBeCloseTo(0.12, 8)
  })

  it('G9 — A5 v2 implicit turn carries empty userMessage and zero inputTokens', async () => {
    const sessionsRoot = join(tmpDir, 'g9')
    const sessDir = join(sessionsRoot, 'hash', 'sess_g9')
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, 'session.json'), JSON.stringify({ id: 'sess_g9', modelId: 'claude-opus-4.8' }))
    const lines = [
      JSON.stringify({ id: 'u', timestamp: '2026-07-14T13:39:00.000Z', payload: { type: 'user', content: 'user prompt', images: [], documents: [] } }),
      JSON.stringify({ id: 'a', timestamp: '2026-07-14T13:39:40.000Z', payload: { type: 'assistant', operationType: 'Say', content: 'implicit answer' } }),
    ].join('\n')
    await writeFile(join(sessDir, 'messages.jsonl'), lines)
    const calls = await parseSource({ path: join(sessDir, 'messages.jsonl'), project: 'g9', provider: 'kiro' })
    expect(calls).toStrictEqual([{
      provider: 'kiro',
      model: 'claude-opus-4-8',
      inputTokens: 0,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      costIsEstimated: true,
      tools: [],
      bashCommands: [],
      timestamp: '2026-07-14T13:39:40.000Z',
      speed: 'standard',
      deduplicationKey: 'kiro-v2:sess_g9:0',
      userMessage: '',
      sessionId: 'sess_g9',
      project: 'g9',
    }])
  })

  it('G10 — cross-format dedup with shared seenKeys', async () => {
    const root = join(tmpDir, 'g10')
    const agentDir = join(root, 'agent')
    const sessionsRoot = join(root, 'sessions')
    await mkdir(agentDir, { recursive: true })
    await mkdir(join(sessionsRoot, 'cli'), { recursive: true })
    const wsHash = 'a1b2c3d4'.repeat(4)
    const wsDir = join(agentDir, wsHash)
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, 'legacy.chat'), makeChatFile({ executionId: 'exec-legacy', workflowId: 'wf-legacy', userPrompt: 'legacy question', botResponses: ['legacy answer'] }))
    const v1Dir = join(wsDir, 'session-v1')
    await mkdir(v1Dir, { recursive: true })
    await writeFile(join(v1Dir, 'execution-v1'), makeModernExecutionFile({ executionId: 'exec-v1', sessionId: 'session-v1', userPrompt: 'v1 question', assistantResponse: 'v1 answer' }))
    const wssDir = join(agentDir, 'workspace-sessions', 'L3RtcC9taXhlZA__')
    await mkdir(wssDir, { recursive: true })
    await writeFile(join(wssDir, 'ws-real.json'), JSON.stringify({ sessionId: 'ws-real', selectedModel: 'claude-sonnet-4.5', history: [{ message: { role: 'user', content: [{ type: 'text', text: 'ws question' }] } }, { message: { role: 'assistant', content: 'a real standalone workspace-session answer' } }] }))
    const cliSessionId = '44444444-4444-4444-4444-444444444444'
    await writeFile(join(sessionsRoot, 'cli', `${cliSessionId}.jsonl`), [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'cli question' }], meta: { timestamp: 1700000000 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'cli answer' }] } }),
    ].join('\n'))
    await writeFile(join(sessionsRoot, 'cli', `${cliSessionId}.json`), JSON.stringify({
      session_id: cliSessionId, cwd: '/tmp/mixed-proj',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z',
      session_state: { rts_model_state: { model_info: { model_id: 'claude-sonnet-4' } }, conversation_metadata: { user_turn_metadatas: [{ end_timestamp: '2026-01-01T00:00:30Z', metering_usage: [{ value: 0.05, unit: 'credit' }] }] } },
    }))
    await makeV2Session(sessionsRoot, { wsHash: 'a1b2c3d4e5f60718', sessionId: 'sess_mixed-001', turns: [{ exec: 'exec-v2-1', ts: '2026-07-14T13:39:40.000Z', user: 'v2 first', say: 'v2 first answer', tools: ['readFile'] }] })

    const provider = createKiroProvider(agentDir, join(root, 'ws-storage'), join(sessionsRoot, 'cli'))
    const sources = await provider.discoverSessions()
    const seenKeys = new Set<string>()
    const run1: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) run1.push(call)
    }
    const run2: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) run2.push(call)
    }
    expect(run1).toHaveLength(5)
    expect(run2).toStrictEqual([])
  })

  it('G11 — routing precedence (v2 beats CLI; ws-session beats chat)', async () => {
    const sessionsRoot = join(tmpDir, 'g11v2')
    const msgs = await makeV2Session(sessionsRoot, { sessionId: 'sess_g11', turns: [{ exec: 'exec-g11', ts: '2026-07-14T13:39:40.000Z', user: 'v2 routing', say: 'hi' }] })
    const v2calls = await parseSource({ path: msgs, project: 'g11', provider: 'kiro' })
    expect(v2calls).toHaveLength(1)
    expect(v2calls[0]!.model).toBe('claude-opus-4-8')
    expect(v2calls[0]!.deduplicationKey).toBe('kiro-v2:sess_g11:exec-g11')

    const wsSessionsDir = join(tmpDir, 'g11ws', 'workspace-sessions', 'L3RtcC90ZXN0')
    await mkdir(wsSessionsDir, { recursive: true })
    const wsPath = join(wsSessionsDir, 'ws-routing.json')
    await writeFile(wsPath, JSON.stringify({
      sessionId: 'ws-routing',
      selectedModel: 'claude-opus-4.8',
      history: [{ message: { role: 'user', content: [{ type: 'text', text: 'ws question' }] } }, { message: { role: 'assistant', content: 'ws answer' } }],
      chat: [{ role: 'human', content: 'chat ignored' }],
    }))
    const wsCalls = await parseSource({ path: wsPath, project: 'g11ws', provider: 'kiro' })
    expect(wsCalls).toHaveLength(1)
    expect(wsCalls[0]!.deduplicationKey).toBe('kiro:ws-session:ws-routing')
  })

  it('G12 — degenerate reads yield zero calls and throw nothing', async () => {
    const wsHash = 'z'.repeat(32)
    const wsDir = join(tmpDir, 'g12', wsHash)
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, 'empty.chat'), '')
    await writeFile(join(wsDir, 'bad.chat'), 'not json')
    await writeFile(join(wsDir, 'array.chat'), '[]')
    const cliDir = join(tmpDir, 'g12cli')
    await mkdir(cliDir, { recursive: true })
    await writeFile(join(cliDir, 'blank.jsonl'), '   \n\n  ')

    const scenarios = [
      { path: '/nonexistent/test.chat', label: 'missing file' },
      { path: join(wsDir, 'empty.chat'), label: 'empty file' },
      { path: join(wsDir, 'bad.chat'), label: 'invalid JSON' },
      { path: join(wsDir, 'array.chat'), label: 'JSON array' },
      { path: join(cliDir, 'blank.jsonl'), label: 'blank jsonl' },
    ]
    for (const { path } of scenarios) {
      const calls = await parseSource({ path, project: 'p', provider: 'kiro' })
      expect(calls).toStrictEqual([])
    }
  })
})
