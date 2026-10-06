// VS Code's agent host (and Copilot CLI 1.0.8x) write assistant.message events
// with no outputTokens. The fixture is a real redacted session; its
// session.shutdown rollup is the ground truth.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'node:url'

import { copilot } from '../src/providers/copilot.js'
import { calculateCost } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { clearLoadCacheMemo } from '../src/session-cache.js'
import { behavioralCallCount } from '../src/behavioral-weight.js'
import { copilotCreditSpend } from '../src/plan-usage.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

const SID = 'd700c59c-59d8-4928-bdd6-142587956874'
const FIXTURE = fileURLToPath(new URL('./fixtures/copilot/agent-host-session/events.jsonl', import.meta.url))

const TRUTH = { calls: 10, input: 76_541, output: 2_171, cacheRead: 169_728, cacheWrite: 0, reasoning: 576, nanoAiu: 2_772_045_000 }

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'copilot-agent-host-'))
  vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', join(tmp, 'no-store.db'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tmp, { recursive: true, force: true })
})

async function fixtureLines(): Promise<string[]> {
  return (await readFile(FIXTURE, 'utf-8')).split('\n').filter(l => l.trim())
}

async function writeSession(lines: string[]): Promise<string> {
  const dir = join(tmp, 'session-state', SID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workspace.yaml'), `id: ${SID}\ncwd: /home/dev/cb-verify/copilot-test\n`)
  const path = join(dir, 'events.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

async function parse(lines: string[]): Promise<ParsedProviderCall[]> {
  const path = await writeSession(lines)
  const calls: ParsedProviderCall[] = []
  for await (const c of copilot.createSessionParser({ path, project: 'copilot-test', provider: 'copilot' }, new Set()).parse()) calls.push(c)
  return calls
}

const sum = (calls: ParsedProviderCall[], k: keyof ParsedProviderCall) => calls.reduce((s, c) => s + (c[k] as number), 0)

describe('copilot VS Code agent-host sessions', () => {
  it('closed session: one call per request, rollup totals equal the ground truth', async () => {
    const calls = await parse(await fixtureLines())
    const perTurn = calls.filter(c => !c.deduplicationKey.includes(':shutdown:'))
    const rollup = calls.filter(c => c.deduplicationKey.includes(':shutdown:'))

    expect(perTurn).toHaveLength(TRUTH.calls)
    expect(perTurn.every(c => c.model === 'gpt-5-mini' && c.costUSD === 0 && c.outputTokens === 0)).toBe(true)
    expect(perTurn.some(c => c.costIsEstimated)).toBe(false)
    expect(perTurn.flatMap(c => c.tools)).toHaveLength(8)

    expect(rollup).toHaveLength(1)
    expect(sum(calls, 'inputTokens')).toBe(TRUTH.input)
    expect(sum(calls, 'outputTokens')).toBe(TRUTH.output)
    expect(sum(calls, 'cacheReadInputTokens')).toBe(TRUTH.cacheRead)
    expect(sum(calls, 'cacheCreationInputTokens')).toBe(TRUTH.cacheWrite)
    expect(sum(calls, 'reasoningTokens')).toBe(TRUTH.reasoning)
    expect(rollup[0]!.nanoAiu).toBe(TRUTH.nanoAiu)
    expect(sum(calls, 'costUSD')).toBeCloseTo(
      calculateCost('gpt-5-mini', TRUTH.input, TRUTH.output, 0, TRUTH.cacheRead, 0), 12)
  })

  it('open session: requests count as calls, no tokens or credits before shutdown', async () => {
    const lines = (await fixtureLines()).filter(l => JSON.parse(l).type !== 'session.shutdown')
    expect(lines.filter(l => JSON.parse(l).type === 'session.usage_checkpoint')).toHaveLength(2)

    const calls = await parse(lines)
    expect(calls).toHaveLength(TRUTH.calls)
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'costUSD'] as const) expect(sum(calls, k)).toBe(0)
    expect(calls.some(c => c.nanoAiu !== undefined || c.costIsEstimated)).toBe(false)
  })

  it('older CLI with per-turn outputTokens: the rollup does not count output again', async () => {
    let n = 0
    const lines = (await fixtureLines()).map(l => {
      const e = JSON.parse(l)
      if (e.type !== 'assistant.message') return l
      e.data.outputTokens = n++ === 0 ? 217 + 1 : 217
      return JSON.stringify(e)
    })
    const calls = await parse(lines)
    const rollup = calls.find(c => c.deduplicationKey.includes(':shutdown:'))!

    expect(calls.filter(c => c !== rollup)).toHaveLength(TRUTH.calls)
    expect(rollup.outputTokens).toBe(0)
    expect(sum(calls, 'outputTokens')).toBe(TRUTH.output)
    expect(sum(calls, 'inputTokens')).toBe(TRUTH.input)
  })

  async function serve(lines: string[]) {
    await writeSession(lines)
    vi.stubEnv('HOME', tmp)
    vi.stubEnv('USERPROFILE', tmp)
    vi.stubEnv('CODEBURN_CACHE_DIR', join(tmp, 'cache'))
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(tmp, 'session-state'))
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', join(tmp, 'no-ws'))
    vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(tmp, 'no-global'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(tmp, 'no-jb'))
    clearSessionCache()
    clearLoadCacheMemo()
    try {
      const projects = await parseAllSessions(undefined, 'copilot')
      const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
      return { projects, calls }
    } finally {
      clearSessionCache()
      clearLoadCacheMemo()
    }
  }

  it('serves 10 calls and exact credits for the closed session', async () => {
    const { projects, calls } = await serve(await fixtureLines())
    expect(projects.map(p => p.project)).toEqual(['copilot-test'])
    expect(behavioralCallCount(calls)).toBe(TRUTH.calls)
    expect(calls.reduce((s, c) => s + c.usage.outputTokens, 0)).toBe(TRUTH.output)
    expect(calls.reduce((s, c) => s + c.usage.inputTokens, 0)).toBe(TRUTH.input)
    expect(calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0)).toBe(TRUTH.cacheRead)
    expect(copilotCreditSpend(projects).spentCredits).toBe(2.772045)
  })

  it('serves an open session as 10 calls with no tokens', async () => {
    const lines = (await fixtureLines()).filter(l => JSON.parse(l).type !== 'session.shutdown')
    const { projects, calls } = await serve(lines)
    expect(projects.map(p => p.project)).toEqual(['copilot-test'])
    expect(behavioralCallCount(calls)).toBe(TRUTH.calls)
    expect(calls.reduce((s, c) => s + c.usage.inputTokens + c.usage.outputTokens + c.costUSD, 0)).toBe(0)
  })
})
