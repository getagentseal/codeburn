import { describe, it, expect } from 'vitest'

import { detectOneHourCacheUnused } from '../src/optimize-one-hour-cache.js'
import type { ParsedApiCall, ProjectSummary } from '../src/types.js'

const START = Date.parse('2026-05-01T10:00:00Z')
const MIN = 60_000

function call(atMs: number, oneHour: number, model = 'claude-sonnet-4-6'): ParsedApiCall {
  return {
    provider: 'claude',
    model,
    usage: {
      inputTokens: 10,
      outputTokens: 100,
      cacheCreationInputTokens: oneHour,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: new Date(START + atMs).toISOString(),
    bashCommands: [],
    deduplicationKey: `c${atMs}`,
    ...(oneHour > 0 ? { cacheCreationOneHourTokens: oneHour } : {}),
  }
}

function project(calls: ParsedApiCall[]): ProjectSummary {
  return {
    project: 'app',
    sessions: [{ sessionId: 's1', turns: [{ assistantCalls: calls }] }],
  } as unknown as ProjectSummary
}

// Five 100k one-hour writes, two minutes apart, then a final call `lastGapMs` after the fifth.
function fiveWrites(lastGapMs: number, model?: string): ProjectSummary {
  const calls = Array.from({ length: 5 }, (_, i) => call(i * 2 * MIN, 100_000, model))
  calls.push(call(8 * MIN + lastGapMs, 0, model))
  return project(calls)
}

describe('detectOneHourCacheUnused', () => {
  it('prices the 60% premium on writes the next request reached within five minutes', () => {
    const finding = detectOneHourCacheUnused([fiveWrites(2 * MIN)])
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('one-hour-cache-unused')
    expect(finding!.tokensSaved).toBe(500_000)
    // 100,000 x $3.75/M x 0.6 = $0.225 per write, five writes.
    expect(finding!.savingsUSD).toBeCloseTo(1.125, 10)
    expect(finding!.impact).toBe('low')
    expect(finding!.explanation).toContain('5 writes in 1 session (100% of one-hour write tokens)')
    expect(finding!.explanation).toContain('usually came 2.0 min later')
  })

  it('keeps writes whose session paused 20 minutes before the next request', () => {
    expect(detectOneHourCacheUnused([fiveWrites(20 * MIN)])).toBeNull()
  })

  it('keeps writes that hits held warm for over an hour before a 20-minute pause', () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(i * 2 * MIN, 100_000))
    for (let t = 10 * MIN; t <= 130 * MIN; t += 2 * MIN) calls.push(call(t, 0))
    calls.push(call(150 * MIN, 0))
    expect(detectOneHourCacheUnused([project(calls)])).toBeNull()
  })

  it('counts writes whose next pause outlasted the hour too', () => {
    expect(detectOneHourCacheUnused([fiveWrites(90 * MIN)])!.savingsUSD).toBeCloseTo(1.125, 10)
  })

  it('ignores sessions with only five-minute writes', () => {
    const calls = Array.from({ length: 6 }, (_, i) => {
      const c = call(i * 2 * MIN, 0)
      return { ...c, usage: { ...c.usage, cacheCreationInputTokens: 100_000 } }
    })
    expect(detectOneHourCacheUnused([project(calls)])).toBeNull()
  })

  it('ignores models with no cache-write price', () => {
    expect(detectOneHourCacheUnused([fiveWrites(2 * MIN, 'codeburn-test-unpriced-model')])).toBeNull()
  })
})
