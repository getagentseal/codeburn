import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { calculateCost } from '../../src/models.js'
import { clearSessionCache, filterProjectsByDateRange, parseAllSessions } from '../../src/parser.js'
import { allProviderNames } from '../../src/providers/index.js'
import { createOpenDesignProvider } from '../../src/providers/open-design.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

const fixtureRoot = join(import.meta.dirname, '../fixtures/open-design')
const dataDir = join(fixtureRoot, 'namespaces', 'release-stable', 'data')

let previousOverride: string | undefined
let previousCacheDir: string | undefined
let cacheDir: string | undefined

async function collect(source: SessionSource, seenKeys = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createOpenDesignProvider()
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
  return calls
}

async function fixtureSource(runId: string): Promise<SessionSource> {
  const provider = createOpenDesignProvider()
  const sources = await provider.discoverSessions()
  const source = sources.find(s => s.path.includes(`${runId}/events.jsonl`))
  expect(source).toBeDefined()
  return source!
}

describe('open-design provider', () => {
  beforeEach(async () => {
    previousOverride = process.env['CODEBURN_OPEN_DESIGN_DIR']
    previousCacheDir = process.env['CODEBURN_CACHE_DIR']
    cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-open-design-cache-'))
    process.env['CODEBURN_OPEN_DESIGN_DIR'] = dataDir
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    clearSessionCache()
  })

  afterEach(async () => {
    clearSessionCache()
    if (previousOverride === undefined) {
      delete process.env['CODEBURN_OPEN_DESIGN_DIR']
    } else {
      process.env['CODEBURN_OPEN_DESIGN_DIR'] = previousOverride
    }
    if (previousCacheDir === undefined) {
      delete process.env['CODEBURN_CACHE_DIR']
    } else {
      process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
    }
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
    cacheDir = undefined
  })

  it('discovers per-run events.jsonl files from the env override data dir', async () => {
    const provider = createOpenDesignProvider()
    const sources = await provider.discoverSessions()

    expect(sources.map(s => s.provider).every(p => p === 'open-design')).toBe(true)
    expect(sources.map(s => s.project)).toEqual(['release-stable', 'release-stable', 'release-stable'])
    expect(sources.map(s => s.path).sort()).toEqual([
      join(dataDir, 'runs', 'run-mixed', 'events.jsonl'),
      join(dataDir, 'runs', 'run-no-usage', 'events.jsonl'),
      join(dataDir, 'runs', 'run-start-seeded', 'events.jsonl'),
    ].sort())
  })

  it('parses a mixed-model run into separate per-model usage calls', async () => {
    const calls = await collect(await fixtureSource('run-mixed'))

    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.model)).toEqual(['openai-codex:gpt-5.5', 'glm-5.2'])

    const codex = calls[0]!
    expect(codex.provider).toBe('open-design')
    expect(codex.sessionId).toBe('run-mixed')
    expect(codex.inputTokens).toBe(950)
    expect(codex.outputTokens).toBe(200)
    expect(codex.cacheCreationInputTokens).toBe(0)
    expect(codex.cacheReadInputTokens).toBe(50)
    expect(codex.cachedInputTokens).toBe(50)
    expect(codex.reasoningTokens).toBe(25)
    expect(codex.timestamp).toBe('2026-06-22T10:00:05.000Z')
    expect(new Date(codex.timestamp).toISOString()).toBe(codex.timestamp)
    expect(codex.costUSD).toBeCloseTo(
      calculateCost(codex.model, 950, 225, 0, 50, 0),
      12,
    )

    const glm = calls[1]!
    expect(glm.inputTokens).toBe(2900)
    expect(glm.outputTokens).toBe(400)
    expect(glm.cacheCreationInputTokens).toBe(0)
    expect(glm.cacheReadInputTokens).toBe(100)
    expect(glm.cachedInputTokens).toBe(100)
    expect(glm.reasoningTokens).toBe(60)
    expect(glm.timestamp).toBe('2026-06-22T10:00:15.000Z')
    expect(glm.costUSD).toBeGreaterThan(0)
  })

  it('does not emit calls for a run with no usage events', async () => {
    const calls = await collect(await fixtureSource('run-no-usage'))
    expect(calls).toHaveLength(0)
  })

  it('uses the start-seeded model before any status transition', async () => {
    const calls = await collect(await fixtureSource('run-start-seeded'))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('glm-5.2')
    expect(calls[0]!.inputTokens).toBe(770)
    expect(calls[0]!.outputTokens).toBe(33)
    expect(calls[0]!.cacheReadInputTokens).toBe(7)
    expect(calls[0]!.reasoningTokens).toBe(3)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('keeps numeric epoch timestamp usage in date-scoped aggregation', async () => {
    const projects = await parseAllSessions(undefined, 'open-design')
    const filtered = filterProjectsByDateRange(projects, {
      start: new Date('2026-06-22T00:00:00.000Z'),
      end: new Date('2026-06-22T23:59:59.999Z'),
    })
    const calls = filtered.flatMap(project =>
      project.sessions.flatMap(session =>
        session.turns.flatMap(turn => turn.assistantCalls),
      ),
    )
    const numericTimestampCall = calls.find(call =>
      call.deduplicationKey === 'open-design:run-mixed:evt-codex-usage',
    )

    expect(numericTimestampCall?.timestamp).toBe('2026-06-22T10:00:05.000Z')
  })

  it('deduplicates usage events per run and event id across parser runs', async () => {
    const source = await fixtureSource('run-mixed')
    const seenKeys = new Set<string>()

    const first = await collect(source, seenKeys)
    const second = await collect(source, seenKeys)

    expect(first).toHaveLength(2)
    expect(second).toHaveLength(0)
  })

  it('registers open-design as a core provider', () => {
    expect(allProviderNames()).toContain('open-design')
  })
})
