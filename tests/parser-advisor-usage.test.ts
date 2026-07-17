import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseApiCall, parseAdvisorCalls, compactEntry, parseAllSessions, clearSessionCache } from '../src/parser.js'
import { calculateCost, loadPricing } from '../src/models.js'
import type { JournalEntry } from '../src/types.js'

const MAIN_MODEL = 'claude-sonnet-4-20250514'
const ADVISOR_MODEL = 'claude-opus-4-20250514'

// Shape mirrors a real Claude Code /advisor turn: the top-level usage covers
// only the main model, and the advisor's tokens live in an `advisor_message`
// iteration under its own model. The two `message` iterations sum to the
// top-level usage (verified against real Claude Code session data).
function advisorEntry(): JournalEntry {
  return {
    type: 'assistant',
    timestamp: '2026-07-10T10:00:00.000Z',
    sessionId: 's1',
    message: {
      type: 'message',
      role: 'assistant',
      model: MAIN_MODEL,
      id: 'msg-advisor-1',
      content: [],
      usage: {
        input_tokens: 2,
        output_tokens: 491,
        cache_creation_input_tokens: 7853,
        cache_read_input_tokens: 226584,
        iterations: [
          { type: 'message', input_tokens: 1, output_tokens: 45, cache_creation_input_tokens: 7192, cache_read_input_tokens: 109696 },
          { type: 'advisor_message', model: ADVISOR_MODEL, input_tokens: 159419, output_tokens: 7805, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          { type: 'message', input_tokens: 1, output_tokens: 446, cache_creation_input_tokens: 661, cache_read_input_tokens: 116888 },
        ],
      },
    },
  } as unknown as JournalEntry
}

describe('advisor usage parsing', () => {
  beforeAll(async () => {
    await loadPricing()
  })

  it('leaves the main-model call attributed to the main model and its top-level totals', () => {
    const call = parseApiCall(advisorEntry())
    expect(call).not.toBeNull()
    expect(call!.model).toBe(MAIN_MODEL)
    expect(call!.usage.inputTokens).toBe(2)
    expect(call!.usage.outputTokens).toBe(491)
    expect(call!.usage.cacheReadInputTokens).toBe(226584)
    expect(call!.deduplicationKey).toBe('msg-advisor-1')
  })

  it('emits a separate call for the advisor iteration, priced under the advisor model', () => {
    const advisorCalls = parseAdvisorCalls(advisorEntry())
    expect(advisorCalls).toHaveLength(1)
    const a = advisorCalls[0]!
    expect(a.model).toBe(ADVISOR_MODEL)
    expect(a.usage.inputTokens).toBe(159419)
    expect(a.usage.outputTokens).toBe(7805)
    expect(a.deduplicationKey).toBe('msg-advisor-1:advisor:0')

    const expectedCost = calculateCost(ADVISOR_MODEL, 159419, 7805, 0, 0, 0, 'standard', 0)
    expect(a.costUSD).toBeCloseTo(expectedCost, 10)
    expect(a.costUSD).toBeGreaterThan(0)
  })

  it('does not double-count: advisor tokens are absent from the main call', () => {
    const call = parseApiCall(advisorEntry())!
    // 159419 is the advisor input; it must never appear on the main call.
    expect(call.usage.inputTokens).not.toBe(159419)
  })

  it('returns no advisor calls when iterations hold only main-model messages', () => {
    const entry = advisorEntry()
    // Strip the advisor_message iteration.
    const usage = (entry.message as { usage: { iterations: unknown[] } }).usage
    usage.iterations = usage.iterations.filter((it: unknown) => (it as { type?: string }).type !== 'advisor_message')
    expect(parseAdvisorCalls(entry)).toHaveLength(0)
  })

  it('returns no advisor calls when there is no iterations array', () => {
    const entry = advisorEntry()
    delete (entry.message as { usage: { iterations?: unknown } }).usage.iterations
    expect(parseAdvisorCalls(entry)).toHaveLength(0)
  })

  it('survives compaction: compactEntry keeps advisor iterations so the call is still emitted', () => {
    const compacted = compactEntry(advisorEntry())
    const advisorCalls = parseAdvisorCalls(compacted)
    expect(advisorCalls).toHaveLength(1)
    expect(advisorCalls[0]!.model).toBe(ADVISOR_MODEL)
    expect(advisorCalls[0]!.usage.inputTokens).toBe(159419)
    expect(advisorCalls[0]!.deduplicationKey).toBe('msg-advisor-1:advisor:0')
  })
})

describe('advisor usage end-to-end through parseAllSessions', () => {
  let tmpDir: string | null = null
  const savedEnv = { config: process.env['CLAUDE_CONFIG_DIR'], cache: process.env['CODEBURN_CACHE_DIR'] }

  beforeAll(async () => {
    await loadPricing()
  })

  afterEach(async () => {
    clearSessionCache()
    if (savedEnv.config === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedEnv.config
    if (savedEnv.cache === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = savedEnv.cache
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it('attributes advisor spend to the advisor model in the session breakdown', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-advisor-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
    const proj = join(tmpDir, 'projects', 'p')
    await mkdir(proj, { recursive: true })
    const user = JSON.stringify({ type: 'user', timestamp: '2026-07-10T09:59:59.000Z', sessionId: 's1', message: { role: 'user', content: 'hi' } })
    const assistant = JSON.stringify(advisorEntry())
    await writeFile(join(proj, 's1.jsonl'), `${user}\n${assistant}\n`)

    clearSessionCache()
    const projects = await parseAllSessions(undefined, 'claude')
    const inputByModel: Record<string, number> = {}
    for (const p of projects) {
      for (const s of p.sessions) {
        for (const [model, b] of Object.entries(s.modelBreakdown ?? {})) {
          inputByModel[model] = (inputByModel[model] ?? 0) + (b.tokens?.inputTokens ?? 0)
        }
      }
    }
    // Main model keeps only its top-level tokens; advisor model carries its own.
    const advisorModelKey = Object.keys(inputByModel).find(m => m.toLowerCase().includes('opus'))
    expect(advisorModelKey).toBeDefined()
    expect(inputByModel[advisorModelKey!]).toBe(159419)
    const mainModelKey = Object.keys(inputByModel).find(m => m.toLowerCase().includes('sonnet'))
    expect(inputByModel[mainModelKey!]).toBe(2)
  })

  it('counts advisor spend even when the assistant line exceeds the large-line (32KB) threshold', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-advisor-big-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
    const proj = join(tmpDir, 'projects', 'p')
    await mkdir(proj, { recursive: true })

    // Pad the content past 32KB so parseJsonlLine routes to the large-line
    // byte-scanner path (which previously dropped iterations entirely).
    const entry = advisorEntry()
    ;(entry.message as { content: unknown[] }).content = [{ type: 'text', text: 'x'.repeat(40_000) }]
    const assistant = JSON.stringify(entry)
    expect(Buffer.byteLength(assistant, 'utf8')).toBeGreaterThan(32 * 1024)
    const user = JSON.stringify({ type: 'user', timestamp: '2026-07-10T09:59:59.000Z', sessionId: 's1', message: { role: 'user', content: 'hi' } })
    await writeFile(join(proj, 's1.jsonl'), `${user}\n${assistant}\n`)

    clearSessionCache()
    const projects = await parseAllSessions(undefined, 'claude')
    const inputByModel: Record<string, number> = {}
    for (const p of projects) {
      for (const s of p.sessions) {
        for (const [model, b] of Object.entries(s.modelBreakdown ?? {})) {
          inputByModel[model] = (inputByModel[model] ?? 0) + (b.tokens?.inputTokens ?? 0)
        }
      }
    }
    const advisorModelKey = Object.keys(inputByModel).find(m => m.toLowerCase().includes('opus'))
    expect(advisorModelKey).toBeDefined()
    expect(inputByModel[advisorModelKey!]).toBe(159419)
  })
})
