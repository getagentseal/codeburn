import { describe, it, expect } from 'vitest'

import {
  billingDisplayValue,
  billingModeLabel,
  compactBillingMetricLabel,
  dashboardInputAction,
  formatInlineOptimizeFindingSavings,
  formatInlineOptimizeSummary,
  projectAverageHeaderLabel,
  statusBarHelpLabels,
} from '../src/dashboard.js'
import { formatCost } from '../src/format.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'
import type { WasteFinding } from '../src/optimize.js'

const EMPTY_CATEGORY_BREAKDOWN = {
  coding: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  debugging: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  feature: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  refactoring: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  testing: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  exploration: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  planning: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  delegation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  git: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  'build/deploy': { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  conversation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  brainstorming: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  general: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
} satisfies SessionSummary['categoryBreakdown']

function makeSession(id: string, cost: number, timestamp = '2026-04-14T10:00:00Z'): SessionSummary {
  return {
    sessionId: id,
    project: 'test-project',
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    totalCostUSD: cost,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: { ...EMPTY_CATEGORY_BREAKDOWN },
  }
}

function makeProject(name: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: name,
    projectPath: name,
    sessions,
    totalCostUSD: sessions.reduce((s, x) => s + x.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((s, x) => s + x.apiCalls, 0),
  }
}

// Logic replicated from TopSessions component
function getTopSessions(projects: ProjectSummary[], n = 5) {
  const all = projects.flatMap(p => p.sessions.map(s => ({ ...s, projectName: p.project })))
  return [...all].sort((a, b) => b.totalCostUSD - a.totalCostUSD).slice(0, n)
}

// Logic replicated from ProjectBreakdown component
function avgCostLabel(project: ProjectSummary): string {
  return project.sessions.length > 0
    ? formatCost(project.totalCostUSD / project.sessions.length)
    : '-'
}

describe('TopSessions - top-5 selection', () => {
  it('returns all sessions when fewer than 5 exist', () => {
    const project = makeProject('proj', [
      makeSession('s1', 1.0),
      makeSession('s2', 2.0),
    ])
    const top = getTopSessions([project])
    expect(top).toHaveLength(2)
    expect(top[0].totalCostUSD).toBe(2.0)
    expect(top[1].totalCostUSD).toBe(1.0)
  })

  it('returns exactly 5 when more than 5 sessions exist', () => {
    const sessions = [0.1, 0.5, 3.0, 1.0, 0.8, 2.0].map((cost, i) =>
      makeSession(`s${i}`, cost)
    )
    const project = makeProject('proj', sessions)
    const top = getTopSessions([project])
    expect(top).toHaveLength(5)
    expect(top[0].totalCostUSD).toBe(3.0)
    expect(top[4].totalCostUSD).toBe(0.5)
  })

  it('is stable on tied costs - preserves input order for equal values', () => {
    const sessions = [
      makeSession('s1', 1.0),
      makeSession('s2', 1.0),
      makeSession('s3', 1.0),
    ]
    const project = makeProject('proj', sessions)
    const top = getTopSessions([project])
    expect(top.map(s => s.sessionId)).toEqual(['s1', 's2', 's3'])
  })
})

describe('avg/run in ProjectBreakdown', () => {
  it('returns dash for a project with no sessions', () => {
    const project = makeProject('proj', [])
    expect(avgCostLabel(project)).toBe('-')
  })

  it('returns formatted average cost across sessions', () => {
    const sessions = [makeSession('s1', 2.0), makeSession('s2', 4.0)]
    const project = makeProject('proj', sessions)
    expect(avgCostLabel(project)).toBe(formatCost(3.0))
  })

  it('uses avg/run header wording instead of per-second wording', () => {
    expect(projectAverageHeaderLabel()).toBe('avg/run')
  })
})

describe('interactive billing mode helpers', () => {
  it('uses approved customer-facing billing labels', () => {
    expect(billingModeLabel('credits')).toBe('Credits')
    expect(billingModeLabel('token_plus')).toBe('Billed Cost')
    expect(compactBillingMetricLabel('credits')).toBe('credits')
    expect(compactBillingMetricLabel('token_plus')).toBe('billed')
  })

  it('maps c and d keys to session-local billing mode actions in dashboard and optimize views', () => {
    expect(dashboardInputAction('c', {}, 'dashboard', 2)).toBe('billingCredits')
    expect(dashboardInputAction('d', {}, 'dashboard', 2)).toBe('billingBilledCost')
    expect(dashboardInputAction('c', {}, 'optimize', 2)).toBe('billingCredits')
    expect(dashboardInputAction('d', {}, 'optimize', 2)).toBe('billingBilledCost')
  })

  it('keeps existing navigation actions intact', () => {
    expect(dashboardInputAction('o', {}, 'dashboard', 2)).toBe('openOptimize')
    expect(dashboardInputAction('b', {}, 'optimize', 2)).toBe('backToDashboard')
    expect(dashboardInputAction('', { escape: true }, 'optimize', 2)).toBe('backToDashboard')
    expect(dashboardInputAction('q', {}, 'dashboard', 2)).toBe('quit')
  })

  it('advertises footer shortcuts in the approved order', () => {
    expect(statusBarHelpLabels('dashboard', 2)).toEqual([
      '<> switch',
      'c credits',
      'd billed cost',
      'q quit',
      '1 today',
      '2 week',
      '3 30 days',
      '4 month',
      '5 all time',
      'o optimize (2)',
    ])
    expect(statusBarHelpLabels('optimize', 2).slice(0, 4)).toEqual(['b back', 'c credits', 'd billed cost', 'q quit'])
  })

  it('derives the toggled display value without changing env/config state', () => {
    expect(billingDisplayValue({ credits: 42, baseCostUsd: 0.01 }, 'credits')).toBe(42)
    expect(billingDisplayValue({ credits: null, baseCostUsd: 0.01 }, 'credits')).toBe(16)
    expect(billingDisplayValue({ baseCostUsd: 1, billedAmountUsd: null }, 'token_plus', 0.3)).toBe(1.3)
    expect(billingDisplayValue({ billedAmountUsd: 2, baseCostUsd: 1 }, 'token_plus', 0.3)).toBe(2)
  })
})

function makeFinding(tokensSaved: number, savingsScope?: WasteFinding['savingsScope']): WasteFinding {
  return {
    title: 'Test finding',
    explanation: 'Test explanation',
    impact: 'medium',
    tokensSaved,
    savingsScope,
    fix: { type: 'paste', label: 'Fix', text: 'test' },
  }
}

describe('inline optimize wording', () => {
  it('labels aggregate savings as token-pricing and token-priced spend estimates', () => {
    const lines = formatInlineOptimizeSummary([makeFinding(10_000)], 0.00001, 1)

    expect(lines).toEqual([
      'Potential aggregate savings: ~10.0K tokens (~$0.100 token-pricing estimate, ~10% of token-priced spend)',
    ])
  })

  it('separates aggregate totals from per-call savings', () => {
    const lines = formatInlineOptimizeSummary([
      makeFinding(10_000),
      makeFinding(2_000, 'per-call'),
    ], 0.00001, 1)

    expect(lines).toEqual([
      'Potential aggregate savings: ~10.0K tokens (~$0.100 token-pricing estimate, ~10% of token-priced spend)',
      'Potential per-call savings: ~2.0K tokens (~$0.020 token-pricing estimate)',
    ])
  })

  it('labels per-call finding savings per affected call', () => {
    expect(formatInlineOptimizeFindingSavings(makeFinding(2_000, 'per-call'), 0.00001))
      .toBe('Potential savings per affected call: ~2.0K tokens (~$0.020 token-pricing estimate)')
  })

  it('suppresses USD estimates in credits-mode inline optimize output', () => {
    expect(formatInlineOptimizeSummary([makeFinding(10_000)], 0.00001, 1, false)).toEqual([
      'Potential aggregate savings: ~10.0K tokens',
    ])
    expect(formatInlineOptimizeFindingSavings(makeFinding(2_000, 'per-call'), 0.00001, false))
      .toBe('Potential savings per affected call: ~2.0K tokens')
  })
})
