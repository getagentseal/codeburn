import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createGrokProvider } from '../../src/providers/grok.js'
import { calculateCost } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// `chooseAuthoritativeModel` branches on whether a modelUsage id resolves to a
// price, so pin the reporter's real id from #998 as unpriced here rather than
// letting the bundled LiteLLM snapshot decide it: xAI pricing landing upstream
// would otherwise silently flip these assertions. Only this lookup is stubbed,
// so `calculateCost` still prices off the real tables.
vi.mock('../../src/models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/models.js')>()
  return {
    ...actual,
    getModelCosts: (model: string) => (model === 'grok-4.6-build' ? null : actual.getModelCosts(model)),
  }
})

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'grok-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// Mirrors the real on-disk layout:
// <sessionsDir>/<url-encoded-cwd>/<uuid>/{summary.json, signals.json, updates.jsonl}
async function writeSession(opts: {
  cwdEncoded?: string
  uuid?: string
  cwd?: string
  model?: string
  turns?: Array<{ promptId: string; totals: number[] }>
  completedTurns?: Array<{ promptId?: string; usage: unknown }>
  toolCalls?: Array<{ title: string; rawInput: Record<string, unknown> }>
  toolsUsed?: string[]
} = {}) {
  const cwdEncoded = opts.cwdEncoded ?? '%2FUsers%2Ftest'
  const uuid = opts.uuid ?? '019edf9c-0000-7000-8000-000000000001'
  const cwd = opts.cwd ?? '/Users/test/myproject'
  const model = opts.model ?? 'grok-build'
  const dir = join(tmpDir, cwdEncoded, uuid)
  await mkdir(dir, { recursive: true })

  await writeFile(join(dir, 'summary.json'), JSON.stringify({
    info: { id: uuid, cwd },
    created_at: '2026-06-19T11:20:40.686261Z',
    updated_at: '2026-06-19T11:31:12.282793Z',
    last_active_at: '2026-06-19T11:31:12.222328Z',
    num_messages: 42,
    current_model_id: model,
    session_summary: 'User asks about the repo',
    generated_title: 'User asks about the repo',
  }))

  await writeFile(join(dir, 'signals.json'), JSON.stringify({
    primaryModelId: model,
    modelsUsed: [model],
    toolsUsed: opts.toolsUsed ?? ['read_file', 'run_terminal_command', 'grep'],
    contextTokensUsed: 40000,
    contextWindowTokens: 512000,
  }))

  const turns = opts.turns ?? [
    { promptId: 'p1', totals: [20000, 25000] },
    { promptId: 'p2', totals: [30000, 35000] },
    { promptId: 'p3', totals: [40000, 45000] },
  ]
  const lines: string[] = []
  for (const turn of turns) {
    for (const total of turn.totals) {
      lines.push(JSON.stringify({
        timestamp: '2026-06-19T11:30:00.000Z',
        method: 'session/update',
        params: {
          sessionId: uuid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
          _meta: { totalTokens: total, promptId: turn.promptId, updateType: 'AgentMessageChunk', modelId: model },
        },
      }))
    }
  }
  for (const completed of opts.completedTurns ?? []) {
    lines.push(JSON.stringify({
      timestamp: 1786724773,
      method: '_x.ai/session/update',
      params: {
        sessionId: uuid,
        update: {
          sessionUpdate: 'turn_completed',
          ...(completed.promptId === undefined ? {} : { prompt_id: completed.promptId }),
          usage: completed.usage,
        },
        _meta: { eventId: 'event-1', agentTimestampMs: 1786724773589 },
      },
    }))
  }
  for (const tc of opts.toolCalls ?? [
    { title: 'read_file', rawInput: { target_directory: '.' } },
    { title: 'grep', rawInput: { pattern: 'x' } },
    { title: 'run_terminal_command', rawInput: { command: 'git status' } },
    { title: 'spawn_subagent', rawInput: { subagent_type: 'general-purpose', prompt: 'x' } },
  ]) {
    lines.push(JSON.stringify({
      timestamp: '2026-06-19T11:30:05.000Z',
      method: 'session/update',
      params: { sessionId: uuid, update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: tc.title, rawInput: tc.rawInput } },
    }))
  }
  await writeFile(join(dir, 'updates.jsonl'), lines.join('\n') + '\n')

  return { dir, uuid }
}

function authoritativeUsage(opts: {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  reasoning?: number
  model?: string
  modelUsage?: Record<string, Record<string, unknown>>
} = {}): Record<string, unknown> {
  const input = opts.input ?? 1000
  const output = opts.output ?? 100
  const cacheRead = opts.cacheRead ?? 0
  const cacheCreation = opts.cacheCreation ?? 0
  const reasoning = opts.reasoning ?? 0
  const model = opts.model ?? 'grok-4.6-build'
  const singleModelUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: reasoning,
    modelCalls: 1,
    apiDurationMs: 1000,
    costUsdTicks: 125117780000,
  }
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: reasoning,
    modelCalls: 1,
    apiDurationMs: 1000,
    costUsdTicks: 125117780000,
    modelUsage: opts.modelUsage ?? { [model]: singleModelUsage },
    numTurns: 1,
  }
}

describe('grok provider - discovery', () => {
  it('discovers each session dir and derives project from cwd', async () => {
    await writeSession({ cwd: '/Users/test/myproject' })
    const sessions = await createGrokProvider(tmpDir).discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('grok')
    expect(sessions[0]!.project).toBe('myproject')
    expect(sessions[0]!.path).toMatch(/updates\.jsonl$/)
  })

  it('returns empty for a non-existent sessions dir', async () => {
    const sessions = await createGrokProvider('/nope/does/not/exist').discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips directories without a summary.json', async () => {
    await mkdir(join(tmpDir, '%2Ftmp', 'not-a-session'), { recursive: true })
    const sessions = await createGrokProvider(tmpDir).discoverSessions()
    expect(sessions).toEqual([])
  })
})

describe('grok provider - parsing', () => {
  async function parse(seen = new Set<string>()) {
    const provider = createGrokProvider(tmpDir)
    const [source] = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    if (!source) return calls
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
    return calls
  }

  it('emits one estimated call per session from the totalTokens fallback curve', async () => {
    await writeSession()
    const calls = await parse()
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('grok-build')
    // input = peak context (max totalTokens across the session)
    expect(call.inputTokens).toBe(45000)
    // cache reads = re-sent context (sum of per-turn starts 90000 minus peak 45000)
    expect(call.cacheReadInputTokens).toBe(45000)
    // output = sum of per-turn growth (3 turns x 5000)
    expect(call.outputTokens).toBe(15000)
    expect(call.costIsEstimated).toBe(true)
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.tools).toEqual(['Read', 'Grep', 'Bash', 'Agent'])
    expect(call.bashCommands).toContain('git')
    expect(call.subagentTypes).toEqual(['general-purpose'])
    expect(call.project).toBe('myproject')
    expect(call.deduplicationKey).toContain('grok:')
  })

  it('uses one turn_completed usage record as authoritative and splits cache subsets from input', async () => {
    await writeSession({
      turns: [],
      completedTurns: [{
        promptId: 'real-prompt-1',
        usage: authoritativeUsage({
          input: 12851663,
          output: 36633,
          cacheRead: 12092032,
          cacheCreation: 0,
          reasoning: 29077,
        }),
      }],
    })

    const calls = await parse()
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('grok-build')
    expect(call.inputTokens).toBe(759631) // 12851663 - 12092032 - 0
    expect(call.cacheReadInputTokens).toBe(12092032)
    expect(call.cacheCreationInputTokens).toBe(0)
    // Grok reports reasoning inside outputTokens; the repo contract wants them
    // split, so output is emitted exclusive of reasoning and the two sum back
    // to the 36633 the record reported.
    expect(call.outputTokens).toBe(7556) // 36633 - 29077
    expect(call.reasoningTokens).toBe(29077)
    expect(call.outputTokens + call.reasoningTokens).toBe(36633)
    expect(call.costIsEstimated).toBe(false)
    expect(call.costUSD).toBe(calculateCost('grok-build', 759631, 36633, 0, 12092032, 0))
  })

  it('sums distinct turn_completed prompt ids exactly once each', async () => {
    await writeSession({
      turns: [],
      completedTurns: [
        { promptId: 'p1', usage: authoritativeUsage({ input: 1000, output: 100, cacheRead: 600, cacheCreation: 50, reasoning: 10 }) },
        { promptId: 'p2', usage: authoritativeUsage({ input: 2000, output: 200, cacheRead: 1000, cacheCreation: 100, reasoning: 20 }) },
      ],
    })

    const [call] = await parse()
    expect(call).toMatchObject({
      inputTokens: 1250,
      cacheReadInputTokens: 1600,
      cacheCreationInputTokens: 150,
      outputTokens: 270, // 300 reported - 30 reasoning
      reasoningTokens: 30,
    })
  })

  it('keeps one authoritative call and uses top-level totals for multi-model usage', async () => {
    await writeSession({
      turns: [],
      completedTurns: [{
        promptId: 'multi-model',
        usage: authoritativeUsage({
          input: 3000,
          output: 300,
          cacheRead: 600,
          cacheCreation: 100,
          reasoning: 30,
          modelUsage: {
            'grok-build-0.1': {
              inputTokens: 1000,
              outputTokens: 100,
              cachedReadTokens: 100,
              cacheCreationTokens: 0,
              reasoningTokens: 10,
            },
            'grok-latest': {
              inputTokens: 2000,
              outputTokens: 200,
              cachedReadTokens: 500,
              cacheCreationTokens: 100,
              reasoningTokens: 20,
            },
          },
        }),
      }],
    })

    const calls = await parse()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'grok-build-0.1',
      inputTokens: 2300,
      outputTokens: 270,
      reasoningTokens: 30,
      costUSD: calculateCost('grok-build-0.1', 2300, 300, 100, 600, 0),
    })
    expect(calls[0]!.outputTokens + calls[0]!.reasoningTokens).toBe(300)
    expect(calls[0]!.turnId).toBeUndefined()
  })

  it('uses the last turn_completed record for a duplicate prompt id', async () => {
    await writeSession({
      turns: [],
      completedTurns: [
        { promptId: 'same-prompt', usage: authoritativeUsage({ input: 500, output: 50, cacheRead: 100, reasoning: 5 }) },
        { promptId: 'same-prompt', usage: authoritativeUsage({ input: 800, output: 80, cacheRead: 200, cacheCreation: 25, reasoning: 8 }) },
      ],
    })

    const [call] = await parse()
    expect(call).toMatchObject({
      inputTokens: 575,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 25,
      outputTokens: 72, // 80 reported - 8 reasoning
      reasoningTokens: 8,
    })
  })

  it('uses unique fallback keys when completed records omit prompt_id', async () => {
    await writeSession({
      turns: [],
      completedTurns: [
        { usage: authoritativeUsage({ input: 100, output: 10 }) },
        { usage: authoritativeUsage({ input: 200, output: 20 }) },
      ],
    })

    const [call] = await parse()
    expect(call).toMatchObject({ inputTokens: 300, outputTokens: 30, reasoningTokens: 0 })
  })

  it('ignores a still-streaming turn but marks mixed coverage estimated', async () => {
    await writeSession({
      turns: [{ promptId: 'still-streaming', totals: [10000, 15000] }],
      completedTurns: [{ promptId: 'completed', usage: authoritativeUsage({ input: 900, output: 90, cacheRead: 300, reasoning: 20 }) }],
    })

    const [call] = await parse()
    expect(call).toMatchObject({
      inputTokens: 600,
      cacheReadInputTokens: 300,
      outputTokens: 70, // 90 reported - 20 reasoning
      reasoningTokens: 20,
      costIsEstimated: true,
    })
  })

  it('treats malformed authoritative fields as absent without throwing or corrupting totals', async () => {
    await writeSession({
      turns: [],
      completedTurns: [{
        promptId: 'malformed',
        usage: {
          inputTokens: -1,
          outputTokens: 4,
          totalTokens: 'not-a-number',
          cachedReadTokens: Number.NaN,
          cacheCreationTokens: 'not-a-number',
          reasoningTokens: -2,
          modelUsage: {},
        },
      }],
    })

    const [call] = await parse()
    expect(call).toBeDefined()
    expect(call!.inputTokens).toBe(0)
    expect(call!.outputTokens).toBe(4)
    expect(call!.cacheReadInputTokens).toBe(0)
    expect(call!.cacheCreationInputTokens).toBe(0)
    expect(call!.reasoningTokens).toBe(0)
    expect(Number.isFinite(call!.costUSD)).toBe(true)
    expect(call!.costUSD).toBeGreaterThanOrEqual(0)
  })

  it('keeps the heuristic when a completed record reports all-zero usage', async () => {
    await writeSession({
      turns: [
        { promptId: 'streaming-1', totals: [20000, 25000] },
        { promptId: 'streaming-2', totals: [30000, 35000] },
      ],
      completedTurns: [{
        promptId: 'zero-usage',
        usage: authoritativeUsage({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 }),
      }],
    })

    const [call] = await parse()
    expect(call).toBeDefined()
    expect(call!.inputTokens).toBe(35000)
    expect(call!.cacheReadInputTokens).toBe(15000)
    expect(call!.outputTokens).toBe(10000)
    expect(call!.costIsEstimated).toBe(true)
  })

  it('clamps cache-exclusive input per completed record before summing', async () => {
    await writeSession({
      turns: [],
      completedTurns: [
        { promptId: 'inconsistent', usage: authoritativeUsage({ input: 100, output: 10, cacheRead: 80, cacheCreation: 50 }) },
        { promptId: 'consistent', usage: authoritativeUsage({ input: 100, output: 20 }) },
      ],
    })

    const [call] = await parse()
    expect(call).toMatchObject({
      inputTokens: 100,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 50,
      outputTokens: 30,
    })
  })

  it('does not add reasoning tokens on top of provider-reported output for cost', async () => {
    await writeSession({
      turns: [],
      model: 'grok-build',
      completedTurns: [{
        promptId: 'reasoning-subset',
        usage: authoritativeUsage({
          input: 1000,
          output: 200,
          cacheRead: 500,
          cacheCreation: 100,
          reasoning: 150,
          model: 'grok-build',
        }),
      }],
    })

    const [call] = await parse()
    expect(call).toBeDefined()
    expect(call!.inputTokens).toBe(400)
    // Output is emitted exclusive of reasoning, and the two sum to the 200 the
    // record reported. The cost prices that full 200 once - the downstream
    // `outputTokens + reasoningTokens` recompute lands on the same number.
    expect(call!.outputTokens).toBe(50) // 200 - 150
    expect(call!.reasoningTokens).toBe(150)
    expect(call!.outputTokens + call!.reasoningTokens).toBe(200)
    expect(call!.costUSD).toBe(calculateCost('grok-build', 400, 200, 100, 500, 0))
    expect(call!.costUSD).not.toBe(calculateCost('grok-build', 400, 350, 100, 500, 0))
  })

  it('skips a session with no token growth', async () => {
    await writeSession({ turns: [{ promptId: 'p1', totals: [0, 0] }] })
    expect(await parse()).toHaveLength(0)
  })

  it('deduplicates across repeated parses', async () => {
    await writeSession()
    const seen = new Set<string>()
    expect(await parse(seen)).toHaveLength(1)
    expect(await parse(seen)).toHaveLength(0)
  })

  it('sums fresh input across a compaction instead of only the last peak', async () => {
    await writeSession({ turns: [
      { promptId: 'p1', totals: [100000, 400000] },
      { promptId: 'p2', totals: [20000, 50000] },
    ] })
    const calls = await parse()
    expect(calls).toHaveLength(1)
    // 400k (segment 1 peak) + 50k (post-compaction segment), not just the 400k global peak
    expect(calls[0]!.inputTokens).toBe(450000)
  })
})

describe('grok provider - unified log', () => {
  const SID_A = '019f0000-0000-7000-8000-00000000000a'
  const SID_B = '019f0000-0000-7000-8000-00000000000b'

  function logLine(msg: string, sid: string | undefined, ts: string, ctx?: Record<string, unknown>) {
    return JSON.stringify({ ts, src: 'shell', pid: 4242, lvl: 'info', msg, ...(sid ? { sid } : {}), ...(ctx ? { ctx } : {}) })
  }

  function inferenceDone(sid: string, ts: string, loopIndex: number, prompt: number, cached: number, completion: number, reasoning: number) {
    return logLine('shell.turn.inference_done', sid, ts, {
      loop_index: loopIndex, model_elapsed_ms: 1000, attempts: 1,
      prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion, reasoning_tokens: reasoning,
    })
  }

  async function writeLog(lines: string[]) {
    await mkdir(join(tmpDir, 'logs'), { recursive: true })
    await writeFile(join(tmpDir, 'logs', 'unified.jsonl'), [
      logLine('AuthManager::new', undefined, '2026-07-28T09:59:59.000Z', { result: 'ok' }),
      ...lines,
    ].join('\n') + '\n')
  }

  async function parseAll() {
    const provider = createGrokProvider(join(tmpDir, 'sessions'))
    const calls: ParsedProviderCall[] = []
    const seen = new Set<string>()
    for (const source of await provider.discoverSessions()) {
      for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
    }
    return calls
  }

  it('reads each inference as a call with cached and reasoning split out', async () => {
    await writeLog([
      logLine('session created', SID_A, '2026-07-28T10:00:00.000Z', { cwd: '/Users/test/grok-cwd' }),
      logLine('model changed', SID_A, '2026-07-28T10:00:00.100Z', { model: 'grok-4.5' }),
      logLine('shell.handle_prompt.start', SID_A, '2026-07-28T10:00:01.000Z', { prompt_id: 'p1', block_count: 1 }),
      inferenceDone(SID_A, '2026-07-28T10:00:18.000Z', 1, 36828, 21888, 1522, 903),
      inferenceDone(SID_A, '2026-07-28T10:00:30.000Z', 2, 40000, 36000, 500, 100),
    ])
    const calls = await parseAll()
    expect(calls).toHaveLength(2)
    const [first] = calls
    expect(first).toMatchObject({
      model: 'grok-4.5',
      inputTokens: 36828 - 21888,
      cacheReadInputTokens: 21888,
      cachedInputTokens: 21888,
      outputTokens: 1522 - 903,
      reasoningTokens: 903,
      cacheCreationInputTokens: 0,
      costIsEstimated: false,
      timestamp: '2026-07-28T10:00:18.000Z',
      sessionId: SID_A,
      project: 'grok-cwd',
      projectPath: '/Users/test/grok-cwd',
    })
    expect(first!.costUSD).toBeCloseTo((14940 * 2 + 21888 * 0.3 + 1522 * 6) / 1e6, 10)
    expect(first!.costUSD).toBeCloseTo(calculateCost('grok-4.5', 14940, 1522, 0, 21888, 0), 10)
    expect(new Set(calls.map(c => c.deduplicationKey)).size).toBe(2)
  })

  it('reads a logged session from the log instead of its session dir, and keeps session-only sessions', async () => {
    const SID_C = '019f0000-0000-7000-8000-00000000000c'
    const sessionsCwd = join('sessions', '%2FUsers%2Ftest')
    await writeSession({ cwdEncoded: sessionsCwd, uuid: SID_A, completedTurns: [{ promptId: 'p1', usage: authoritativeUsage() }] })
    await writeSession({ cwdEncoded: sessionsCwd, uuid: SID_C, completedTurns: [{ promptId: 'p1', usage: authoritativeUsage() }] })
    await writeLog([
      logLine('model changed', SID_A, '2026-07-28T10:00:00.000Z', { model: 'grok-4.5' }),
      inferenceDone(SID_A, '2026-07-28T10:00:18.000Z', 1, 1000, 0, 100, 0),
      inferenceDone(SID_A, '2026-07-28T10:00:30.000Z', 2, 1200, 1000, 50, 0),
      logLine('model changed', SID_B, '2026-07-28T11:00:00.000Z', { model: 'grok-4.5' }),
      inferenceDone(SID_B, '2026-07-28T11:00:18.000Z', 1, 2000, 500, 200, 50),
    ])
    const calls = await parseAll()
    const a = calls.filter(c => c.sessionId === SID_A)
    expect(a).toHaveLength(2)
    expect(a.every(c => c.deduplicationKey.startsWith('grok:unified:'))).toBe(true)
    const c = calls.filter(c => c.sessionId === SID_C)
    expect(c).toHaveLength(1)
    expect(c[0]!.deduplicationKey).not.toContain('unified')
    expect(calls.filter(c => c.sessionId === SID_B)).toHaveLength(1)
    expect(calls.find(c => c.sessionId === SID_B)!.project).toBe('grok')
  })

  it('prices the long-context tier per request, not on the session total', async () => {
    await writeLog([
      logLine('model changed', SID_B, '2026-07-28T11:00:00.000Z', { model: 'grok-4.6' }),
      inferenceDone(SID_B, '2026-07-28T11:00:18.000Z', 1, 150000, 0, 1000, 0),
      inferenceDone(SID_B, '2026-07-28T11:01:18.000Z', 1, 150000, 0, 1000, 0),
    ])
    const calls = await parseAll()
    const total = calls.reduce((sum, c) => sum + c.costUSD, 0)
    expect(total).toBeCloseTo(2 * calculateCost('grok-4.6', 150000, 1000, 0, 0, 0), 10)
    expect(total).toBeLessThan(calculateCost('grok-4.6', 300000, 2000, 0, 0, 0))
  })

  it('takes the model from the process when the session never names one', async () => {
    await writeLog([
      logLine('model catalog: notifying clients', undefined, '2026-07-28T11:00:00.000Z', { current_model_id: 'grok-4.5', model_count: 3 }),
      inferenceDone(SID_B, '2026-07-28T11:00:18.000Z', 1, 2000, 0, 200, 0),
    ])
    const [call] = await parseAll()
    expect(call!.model).toBe('grok-4.5')
  })

  it('falls back to grok-build, marked estimated, when nothing names the model', async () => {
    await writeLog([inferenceDone(SID_B, '2026-07-28T11:00:18.000Z', 1, 2000, 0, 200, 0)])
    const [call] = await parseAll()
    expect(call!.model).toBe('grok-build')
    expect(call!.costIsEstimated).toBe(true)
  })

  it('discovers nothing extra when there is no unified log', async () => {
    expect(await createGrokProvider(join(tmpDir, 'sessions')).discoverSessions()).toEqual([])
  })
})

describe('grok provider - display names', () => {
  const provider = createGrokProvider('/tmp')

  it('has the right name and displayName', () => {
    expect(provider.name).toBe('grok')
    expect(provider.displayName).toBe('Grok Build')
  })

  it('labels grok-build', () => {
    expect(provider.modelDisplayName('grok-build')).toBe('Grok Build')
  })

  // Two distinct ids, so two rows; identical names made them look like one row
  // printed twice (#1029).
  it('distinguishes the build variant of a model from the model itself', () => {
    expect(provider.modelDisplayName('grok-4.5')).toBe('Grok 4.5')
    expect(provider.modelDisplayName('grok-4.5-build')).toBe('Grok 4.5 (build)')
  })

  it('normalizes tool names', () => {
    expect(provider.toolDisplayName('run_terminal_command')).toBe('Bash')
    expect(provider.toolDisplayName('mystery_tool')).toBe('mystery_tool')
  })
})
