import { describe, expect, it } from 'vitest'

import { detectFastModeBackground, detectLongContextPremium, findingClass } from '../src/optimize.js'
import { calculateCost } from '../src/models.js'
import type { ParsedApiCall, ProjectSummary, SessionSummary } from '../src/types.js'

type Tokens = { input?: number; output?: number; cacheRead?: number }

function apiCall(model: string, speed: ParsedApiCall['speed'], t: Tokens, i: number): ParsedApiCall {
  const input = t.input ?? 0
  const output = t.output ?? 0
  const cacheRead = t.cacheRead ?? 0
  return {
    provider: 'claude',
    model,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cacheRead,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: calculateCost(model, input, output, 0, cacheRead, 0, speed, 0, 'claude'),
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed,
    timestamp: `2026-10-01T10:${String(i).padStart(2, '0')}:00Z`,
    bashCommands: [],
    deduplicationKey: `call-${i}`,
  }
}

function session(id: string, calls: ParsedApiCall[], isSidechain = false): SessionSummary {
  return {
    sessionId: id,
    project: 'app',
    isSidechain,
    firstTimestamp: '2026-10-01T10:00:00Z',
    lastTimestamp: '2026-10-01T11:00:00Z',
    totalCostUSD: calls.reduce((s, c) => s + c.costUSD, 0),
    apiCalls: calls.length,
    turns: calls.map(c => ({ userMessage: 'go', assistantCalls: [c], timestamp: c.timestamp, sessionId: id, category: 'coding', retries: 0, hasEdits: false })),
  } as unknown as SessionSummary
}

function projects(...sessions: SessionSummary[]): ProjectSummary[] {
  return [{ project: 'app', projectPath: '/tmp/app', sessions } as unknown as ProjectSummary]
}

describe('detectFastModeBackground', () => {
  it('reports the fast premium of subagent calls', () => {
    // opus-4-8 fast is 2x: 100k output x $25/M = $2.50 extra.
    const finding = detectFastModeBackground(projects(session('agent-1', [apiCall('claude-opus-4-8', 'fast', { output: 100_000 }, 0)], true)))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('fast-mode-background')
    expect(findingClass(finding!)).toBe('nudge')
    expect(finding!.savingsUSD).toBeCloseTo(2.5, 10)
    expect(finding!.tokensSaved).toBe(100_000)
    expect(finding!.impact).toBe('low')
    expect(finding!.title).toContain('$2.50')
    expect(finding!.explanation).toContain('1 fast-mode call ')
    expect(finding!.explanation).toContain('Opus 4.8')
  })

  it('rates a premium above $20 high', () => {
    const calls = Array.from({ length: 10 }, (_, i) => apiCall('claude-opus-4-8', 'fast', { output: 100_000 }, i))
    expect(detectFastModeBackground(projects(session('agent-1', calls, true)))!.impact).toBe('high')
  })

  it('ignores main-thread fast calls and premiums under $1', () => {
    expect(detectFastModeBackground(projects(session('main', [apiCall('claude-opus-4-8', 'fast', { output: 100_000 }, 0)])))).toBeNull()
    expect(detectFastModeBackground(projects(session('agent-1', [apiCall('claude-opus-4-8', 'fast', { output: 800 }, 0)], true)))).toBeNull()
  })

  it('ignores a model without a fast multiplier', () => {
    expect(detectFastModeBackground(projects(session('agent-1', [apiCall('claude-opus-4-6', 'fast', { output: 100_000 }, 0)], true)))).toBeNull()
  })
})

describe('detectLongContextPremium', () => {
  // sonnet-4-5 above 200k: 10k input + 290k cache read + 1k output costs
  // $0.06 + $0.174 + $0.0225 = $0.2565 against $0.03 + $0.087 + $0.015 = $0.132.
  const over = (i: number) => apiCall('claude-sonnet-4-5', 'standard', { input: 10_000, cacheRead: 290_000, output: 1_000 }, i)

  it('reports calls priced above the tier', () => {
    const finding = detectLongContextPremium(projects(
      session('s1', Array.from({ length: 10 }, (_, i) => over(i))),
      session('s2', [apiCall('claude-sonnet-4-5', 'standard', { input: 150_000, output: 1_000 }, 20)]),
    ))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('long-context-premium')
    expect(findingClass(finding!)).toBe('keep')
    expect(finding!.apply).toBeUndefined()
    expect(finding!.savingsUSD).toBeCloseTo(10 * 0.1245, 10)
    expect(finding!.tokensSaved).toBe(10 * 100_000)
    expect(finding!.impact).toBe('low')
    expect(finding!.explanation).toContain('10 of 11 calls (90.9%) in 1 session ')
    expect(finding!.explanation).toContain('Sonnet 4.5 above 200.0K: 10 calls')
    expect(finding!.fix.type === 'paste' && finding!.fix.text).toContain('200.0K on Sonnet 4.5')
  })

  it('prices only the tier on a fast call, leaving the fast premium to its own finding', () => {
    // gpt-5.5 above 272k at standard: $0.10 + $0.29 + $0.045 = $0.435 against $0.05 + $0.145 + $0.03 = $0.225.
    const fast = Array.from({ length: 10 }, (_, i) => apiCall('gpt-5.5', 'fast', { input: 10_000, cacheRead: 290_000, output: 1_000 }, i))
    expect(detectLongContextPremium(projects(session('s1', fast)))!.savingsUSD).toBeCloseTo(10 * 0.21, 10)
  })

  it('ignores calls under the threshold and premiums under $1', () => {
    expect(detectLongContextPremium(projects(session('s1', Array.from({ length: 10 }, (_, i) =>
      apiCall('claude-sonnet-4-5', 'standard', { input: 10_000, cacheRead: 190_000, output: 1_000 }, i)))))).toBeNull()
    expect(detectLongContextPremium(projects(session('s1', [over(0)])))).toBeNull()
  })

  it('ignores a model without a long-context tier', () => {
    expect(detectLongContextPremium(projects(session('s1', Array.from({ length: 10 }, (_, i) =>
      apiCall('claude-sonnet-4-6', 'standard', { input: 10_000, cacheRead: 290_000, output: 1_000 }, i)))))).toBeNull()
  })
})
