import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  setLocalModelSavings,
  setModelAliases,
  loadPricing,
} from '../src/models.js'
import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import type { DateRange } from '../src/types.js'

const FIXTURE_DAY = Date.UTC(2026, 3, 16)
const RANGE_START = new Date(FIXTURE_DAY - 24 * 60 * 60 * 1000)
const RANGE_END = new Date(FIXTURE_DAY + 24 * 60 * 60 * 1000)

function makeRange(): DateRange {
  return { start: RANGE_START, end: RANGE_END }
}

let tmpDirs: string[] = []

beforeAll(async () => {
  await loadPricing()
})

beforeEach(() => {
  setLocalModelSavings({})
  setModelAliases({})
})

afterEach(async () => {
  delete (Object.prototype as Record<string, unknown>).calls
  clearSessionCache()
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

async function setupLocalModelSession(modelName: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'codeburn-savings-'))
  tmpDirs.push(base)
  const projectDir = join(base, 'projects', 'p')
  await mkdir(projectDir, { recursive: true })
  // Use a synthetic local-style model name and a small known token count.
  const file = join(projectDir, 's1.jsonl')
  const ts = '2026-04-16T10:00:00.000Z'
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: 's1',
    message: {
      type: 'message',
      role: 'assistant',
      model: modelName,
      id: 'msg-1',
      content: [],
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
  await writeFile(file, line + '\n', 'utf-8')
  process.env['CLAUDE_CONFIG_DIR'] = base
  return base
}

describe('local-model savings: end-to-end', () => {
  it('keeps an unconfigured local model at $0 with no savings recorded', async () => {
    await setupLocalModelSession('llama3.1:8b')
    const projects = await parseAllSessions(makeRange(), 'all')
    const allCalls = projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
    expect(allCalls.length).toBeGreaterThan(0)
    for (const c of allCalls) {
      expect(c.costUSD).toBe(0)
      expect(c.savingsUSD ?? 0).toBe(0)
      expect(c.isLocalSavings).toBeFalsy()
    }
  })

  it('records savings and forces cost to 0 when a local model has a savings mapping', async () => {
    await setupLocalModelSession('llama3.1:8b')
    setLocalModelSavings({ 'llama3.1:8b': 'gpt-4o' })
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')
    const allCalls = projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
    expect(allCalls.length).toBeGreaterThan(0)
    for (const c of allCalls) {
      expect(c.costUSD).toBe(0)
      expect(c.savingsUSD).toBeGreaterThan(0)
      expect(c.savingsBaselineModel).toBe('gpt-4o')
      expect(c.isLocalSavings).toBe(true)
    }
    // Session and project rollups surface the savings total.
    const totalSavings = projects.reduce((s, p) => s + p.totalSavingsUSD, 0)
    expect(totalSavings).toBeGreaterThan(0)
  })

  it('does not apply savings for a model that has no mapping', async () => {
    await setupLocalModelSession('qwen2.5:32b')
    setLocalModelSavings({ 'unrelated:1b': 'gpt-4o' })
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')
    const allCalls = projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
    for (const c of allCalls) {
      expect(c.savingsUSD ?? 0).toBe(0)
    }
  })

  it('forces a $0 cost even when the same model is also in modelAliases', async () => {
    // The local-savings path is meant to win for actual cost: spending
    // config semantics say "this is local, track counterfactual", so
    // even a stale modelAliases entry must not cause us to charge real
    // dollars for a local call.
    await setupLocalModelSession('llama3.1:8b')
    setModelAliases({ 'llama3.1:8b': 'gpt-4o' })
    setLocalModelSavings({ 'llama3.1:8b': 'gpt-4o' })
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')
    const allCalls = projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
    for (const c of allCalls) {
      expect(c.costUSD).toBe(0)
      expect(c.savingsUSD).toBeGreaterThan(0)
    }
  })
})
