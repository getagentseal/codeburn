import { describe, it, expect } from 'vitest'

import { renderOverview } from '../src/overview.js'
import type { ProjectSummary } from '../src/types.js'

function makeProject(opts: {
  project: string
  projectPath: string
  cost: number
  calls: number
  model: string
  provider: string
  tokens: { input: number; output: number; cacheR: number; cacheW: number }
}): ProjectSummary {
  const usage = {
    inputTokens: opts.tokens.input,
    outputTokens: opts.tokens.output,
    cacheReadInputTokens: opts.tokens.cacheR,
    cacheCreationInputTokens: opts.tokens.cacheW,
  }
  return {
    project: opts.project,
    projectPath: opts.projectPath,
    totalCostUSD: opts.cost,
    totalSavingsUSD: 0,
    totalProxiedCostUSD: 0,
    totalApiCalls: opts.calls,
    sessions: [{
      sessionId: 's1',
      project: opts.project,
      totalInputTokens: opts.tokens.input,
      totalOutputTokens: opts.tokens.output,
      totalCacheReadTokens: opts.tokens.cacheR,
      totalCacheWriteTokens: opts.tokens.cacheW,
      apiCalls: opts.calls,
      modelBreakdown: { [opts.model]: { calls: opts.calls, costUSD: opts.cost, savingsUSD: 0, tokens: usage } },
      categoryBreakdown: { coding: { turns: 1, costUSD: opts.cost, savingsUSD: 0, retries: 0, editTurns: 1, oneShotTurns: 1 } },
      toolBreakdown: { Bash: { calls: 5 }, Read: { calls: 2 } },
      mcpBreakdown: {},
      bashBreakdown: {},
      skillBreakdown: {},
      subagentBreakdown: {},
      turns: [{
        userMessage: 'hi',
        timestamp: '2026-06-15T10:00:00Z',
        sessionId: 's1',
        category: 'coding',
        retries: 0,
        hasEdits: true,
        assistantCalls: [{ provider: opts.provider, model: opts.model, costUSD: opts.cost, usage }],
      }],
    }],
  } as unknown as ProjectSummary
}

describe('renderOverview', () => {
  it('renders the detailed sections from real aggregation', () => {
    const out = renderOverview([makeProject({
      project: 'myproject',
      projectPath: '/Users/test/myproject',
      cost: 12.5,
      calls: 3,
      model: 'claude-opus-4-8',
      provider: 'claude',
      tokens: { input: 1000, output: 200, cacheR: 5000, cacheW: 100 },
    })], { label: 'June 2026', color: false })

    for (const section of ['Totals', 'By tool', 'Top models', 'Highest-value days', 'Top projects', 'Daily', 'By activity', 'Tools']) {
      expect(out).toContain(section)
    }
    expect(out).toContain('Opus 4.8')   // model display name
    expect(out).toContain('claude')     // provider in By tool
    expect(out).toContain('myproject')  // clean project name from path basename
    expect(out).toContain('$12.50')
    expect(out).toContain('2026-06-15')
    expect(out).toContain('Coding')
    expect(out).toContain('Bash')
  })

  it('uses thousands separators and a B unit, and strips color in no-color mode', () => {
    const out = renderOverview([makeProject({
      project: 'big',
      projectPath: '/Users/test/big',
      cost: 1234.56,
      calls: 10,
      model: 'claude-opus-4-8',
      provider: 'claude',
      tokens: { input: 1_000_000, output: 1_000_000, cacheR: 2_000_000_000, cacheW: 0 },
    })], { label: 'June 2026', color: false })

    expect(out).toContain('$1,234.56')
    // tokens render as full, comma-grouped numbers (not abbreviated)
    expect(out).toContain('2,002,000,000')
    // no-color mode must not emit ANSI escape codes
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/)
  })

  it('reports no usage for an empty range', () => {
    const out = renderOverview([], { label: 'June 2026', color: false })
    expect(out).toContain('No usage found for June 2026')
  })

  it('does not split a slug-only Claude project path into fake path segments', () => {
    const out = renderOverview([makeProject({
      project: 'Projects-Content-OS',
      projectPath: 'Projects/Content/OS',
      cost: 3.25,
      calls: 1,
      model: 'claude-sonnet-4-5',
      provider: 'claude',
      tokens: { input: 1000, output: 200, cacheR: 0, cacheW: 0 },
    })], { label: 'June 2026', color: false })

    expect(out).toContain('Projects-Content-OS')
    expect(out).not.toContain(' OS ')
  })
})

describe('renderOverview unpriced models', () => {
  it('warns when a model with usage has no pricing data', () => {
    const out = renderOverview([makeProject({
      project: 'mystery',
      projectPath: '/Users/test/mystery',
      cost: 0,
      calls: 4,
      model: 'zz-mystery-paid-model-999',
      provider: 'claude',
      tokens: { input: 1000, output: 200, cacheR: 0, cacheW: 0 },
    })], { label: 'June 2026', color: false })

    expect(out).toContain('Unpriced')
    expect(out).toContain('1 model at $0')
    expect(out).toContain('zz-mystery-paid-model-999')
    expect(out).toContain('codeburn model-alias')
  })

  it('stays silent when every model is priced', () => {
    const out = renderOverview([makeProject({
      project: 'priced',
      projectPath: '/Users/test/priced',
      cost: 5,
      calls: 2,
      model: 'claude-opus-4-8',
      provider: 'claude',
      tokens: { input: 100, output: 50, cacheR: 0, cacheW: 0 },
    })], { label: 'June 2026', color: false })

    expect(out).not.toContain('Unpriced')
  })
})
