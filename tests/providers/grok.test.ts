import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createGrokProvider } from '../../src/providers/grok.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

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
  await writeFile(join(dir, 'updates.jsonl'), lines.join('\n') + '\n')

  return { dir, uuid }
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

  it('emits one estimated call per session from the totalTokens curve', async () => {
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
    expect(call.tools).toEqual(['Read', 'Bash', 'Grep'])
    expect(call.project).toBe('myproject')
    expect(call.deduplicationKey).toContain('grok:')
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

  it('normalizes tool names', () => {
    expect(provider.toolDisplayName('run_terminal_command')).toBe('Bash')
    expect(provider.toolDisplayName('mystery_tool')).toBe('mystery_tool')
  })
})
