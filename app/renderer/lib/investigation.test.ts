import { describe, expect, it } from 'vitest'

import {
  applyInvestigation,
  branchFilters,
  categoryFilters,
  dayFilters,
  EMPTY_FILTERS,
  filtersActive,
  filtersToKey,
  modelFilters,
  normalizeFilters,
  prFilters,
  projectFilters,
  providerFilters,
  sessionFilters,
  withFilterValue,
  withoutFilterValue,
} from './investigation'
import type { ContributionSegment, SessionDrillRow } from './types'

function segment(overrides: Partial<ContributionSegment>): ContributionSegment {
  return {
    day: '2026-09-10',
    category: 'coding',
    branch: null,
    models: { 'Sonnet 4.5': 0 },
    prs: [],
    cost: 0,
    calls: 0,
    savingsUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  }
}

function row(overrides: Partial<SessionDrillRow> & Pick<SessionDrillRow, 'sessionId'>): SessionDrillRow {
  return {
    title: '',
    project: '/repo/app',
    provider: 'claude',
    models: ['Sonnet 4.5'],
    cost: 0,
    savingsUSD: 0,
    calls: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    startedAt: '2026-09-10T10:00:00.000Z',
    endedAt: '2026-09-10T11:00:00.000Z',
    durationMs: 3_600_000,
    ...overrides,
  }
}

const PR_X = 'https://github.com/owner/repo-x/pull/123'
const PR_Y = 'https://github.com/owner/repo-y/pull/456'

describe('filters normalization', () => {
  it('dedupes, sorts, and gives identical selections identical keys', () => {
    const a = normalizeFilters({ ...EMPTY_FILTERS, days: ['2026-09-11', '2026-09-10', '2026-09-10'], models: ['B', 'A'] })
    const b = normalizeFilters({ ...EMPTY_FILTERS, days: ['2026-09-10', '2026-09-11'], models: ['A', 'B'] })
    expect(a.days).toEqual(['2026-09-10', '2026-09-11'])
    expect(a.models).toEqual(['A', 'B'])
    expect(filtersToKey(a)).toBe(filtersToKey(b))
  })

  it('reports activity and empty state', () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(false)
    expect(filtersActive(categoryFilters('coding'))).toBe(true)
  })

  it('adds and removes a value within a dimension (the OR rule)', () => {
    const next = withFilterValue(dayFilters('2026-09-10'), 'days', '2026-09-11')
    expect(next.days).toEqual(['2026-09-10', '2026-09-11'])
    const back = withoutFilterValue(next, 'days', '2026-09-10')
    expect(back.days).toEqual(['2026-09-11'])
  })
})

describe('contribution math', () => {
  it('the 100/20 category fixture: selection sums 20, full cost labeled 100', () => {
    // Session cost 1.00 with 0.20 coding and 0.80 debugging. The coding
    // selection must show 0.20 — never the whole 1.00 — and the full cost
    // stays available as a separate labeled figure.
    const subject = row({
      sessionId: 's1',
      cost: 1.0,
      calls: 10,
      contributions: { segments: [
        segment({ category: 'coding', cost: 0.2, calls: 2 }),
        segment({ category: 'debugging', cost: 0.8, calls: 8 }),
      ] },
    })
    const result = applyInvestigation([subject], categoryFilters('coding'))
    expect(result.cost).toBeCloseTo(0.2, 10)
    expect(result.calls).toBe(2)
    expect(result.fullCost).toBeCloseTo(1.0, 10)
    expect(result.included).toHaveLength(1)
  })

  it('a day selection includes sessions started earlier that were active that day', () => {
    const early = row({
      sessionId: 'early',
      project: '/repo/app',
      cost: 1.0,
      startedAt: '2026-09-09T08:00:00.000Z',
      contributions: { segments: [
        segment({ day: '2026-09-09', cost: 0.6 }),
        segment({ day: '2026-09-10', cost: 0.4 }),
      ] },
    })
    const result = applyInvestigation([early], dayFilters('2026-09-10'))
    expect(result.cost).toBeCloseTo(0.4, 10)
    // Both days together union within the dimension and reconcile the session.
    const both = applyInvestigation([early], dayFilters('2026-09-09', '2026-09-10'))
    expect(both.cost).toBeCloseTo(1.0, 10)
  })

  it('different dimensions intersect with AND, same dimension unions with OR', () => {
    const subject = row({
      sessionId: 'mixed',
      cost: 0.8,
      contributions: { segments: [
        segment({ day: '2026-09-10', category: 'coding', cost: 0.1 }),
        segment({ day: '2026-09-10', category: 'debugging', cost: 0.3 }),
        segment({ day: '2026-09-11', category: 'coding', cost: 0.4 }),
      ] },
    })
    // day1 AND coding = 0.1 (not the day total 0.4, not the category total 0.5).
    const andResult = applyInvestigation([subject], withFilterValue(dayFilters('2026-09-10'), 'categories', 'coding'))
    expect(andResult.cost).toBeCloseTo(0.1, 10)
    // day1 OR day2 over coding = 0.1 + 0.4.
    const orResult = applyInvestigation(
      [subject],
      withFilterValue(withFilterValue(dayFilters('2026-09-10'), 'days', '2026-09-11'), 'categories', 'coding'),
    )
    expect(orResult.cost).toBeCloseTo(0.5, 10)
  })

  it('exact project identity keeps prefix-similar projects apart', () => {
    const app = row({ sessionId: 'a', project: '-work-app', projectId: '/work/app', cost: 1 })
    const appBeta = row({ sessionId: 'b', project: '-work-app-beta', projectId: '/work/app-beta', cost: 2 })
    const result = applyInvestigation([app, appBeta], projectFilters('/work/app'))
    expect(result.included.map(entry => entry.row.sessionId)).toEqual(['a'])
    expect(result.cost).toBeCloseTo(1, 10)
    // Rows from an older CLI without projectId still match their exact raw path.
    const legacyApp = row({ sessionId: 'legacy', project: '/work/app', cost: 0.5 })
    const legacyResult = applyInvestigation([legacyApp, appBeta], projectFilters('/work/app'))
    expect(legacyResult.included.map(entry => entry.row.sessionId)).toEqual(['legacy'])
  })

  it('two repositories with PR #123 stay distinct; a multi-PR set contributes its share', () => {
    const repoX = row({
      sessionId: 'x',
      cost: 0.6,
      contributions: { segments: [segment({ prs: [PR_X], cost: 0.6 })] },
    })
    const repoY = row({
      sessionId: 'y',
      cost: 0.8,
      contributions: { segments: [segment({ prs: [PR_Y], cost: 0.8 })] },
    })
    const merged = row({
      sessionId: 'm',
      cost: 1.0,
      contributions: { segments: [segment({ prs: [PR_X, PR_Y], cost: 1.0 })] },
    })
    const xSelection = applyInvestigation([repoX, repoY, merged], prFilters(PR_X))
    // repoX's own 0.6 plus HALF of the merge-sweep session's 1.0.
    expect(xSelection.cost).toBeCloseTo(0.6 + 0.5, 10)
    expect(xSelection.included.map(entry => entry.row.sessionId).sort()).toEqual(['m', 'x'])
  })

  it('branch is scoped by project: two projects sharing main stay separate', () => {
    const p1 = row({
      sessionId: 'p1',
      project: '-work-one',
      projectId: '/work/one',
      cost: 0.5,
      contributions: { segments: [segment({ branch: 'main', cost: 0.5 })] },
    })
    const p2 = row({
      sessionId: 'p2',
      project: '-work-two',
      projectId: '/work/two',
      cost: 0.7,
      contributions: { segments: [segment({ branch: 'main', cost: 0.7 })] },
    })
    const result = applyInvestigation([p1, p2], branchFilters('/work/two', 'main'))
    expect(result.included.map(entry => entry.row.sessionId)).toEqual(['p2'])
    expect(result.cost).toBeCloseTo(0.7, 10)
  })

  it('the same session id under two providers opens the right session', () => {
    const claude = row({ sessionId: 'shared-id', provider: 'claude', cost: 1 })
    const codex = row({ sessionId: 'shared-id', provider: 'codex', cost: 2 })
    const claudeSelection = applyInvestigation([claude, codex], sessionFilters({ provider: 'codex', sessionId: 'shared-id' }))
    expect(claudeSelection.cost).toBeCloseTo(2, 10)
    expect(claudeSelection.included[0]!.row.provider).toBe('codex')
  })

  it('model selections use the canonical short-name identity', () => {
    const subject = row({
      sessionId: 'mm',
      cost: 0.9,
      contributions: { segments: [segment({
        models: { 'Sonnet 4.5': 0.3, 'GPT-5.5': 0.6 },
        modelUsage: { 'Sonnet 4.5': { calls: 1, inputTokens: 100, outputTokens: 20 }, 'GPT-5.5': { calls: 1, inputTokens: 200, outputTokens: 40 } },
        cost: 0.9,
      })] },
    })
    expect(applyInvestigation([subject], modelFilters(['GPT-5.5'])).cost).toBeCloseTo(0.6, 10)
    expect(applyInvestigation([subject], modelFilters(['Sonnet 4.5'])).cost).toBeCloseTo(0.3, 10)
  })

  it('provider and project chips gate whole rows and intersect with segment dimensions', () => {
    const claude = row({
      sessionId: 'c', provider: 'claude', cost: 0.5,
      contributions: { segments: [segment({ category: 'coding', cost: 0.5 })] },
    })
    const codex = row({
      sessionId: 'x', provider: 'codex', cost: 0.9,
      contributions: { segments: [segment({ category: 'coding', cost: 0.9 })] },
    })
    // Provider dimension alone: whole-session contributions.
    const providers = applyInvestigation([claude, codex], withFilterValue(providerFilters('claude'), 'providers', 'codex'))
    expect(providers.cost).toBeCloseTo(1.4, 10)
    // Provider AND category: only the matching provider's category spend.
    const andResult = applyInvestigation([claude, codex], withFilterValue(providerFilters('codex'), 'categories', 'coding'))
    expect(andResult.cost).toBeCloseTo(0.9, 10)
  })

  it('uses actual per-model requests and tokens, including zero-cost usage', () => {
    const subject = row({ sessionId: 'priced-differently', cost: 10, contributions: { segments: [segment({
      cost: 10, calls: 3, inputTokens: 1050,
      models: { expensive: 9, cheap: 1, free: 0 },
      modelUsage: {
        expensive: { calls: 1, inputTokens: 100, outputTokens: 0 },
        cheap: { calls: 1, inputTokens: 900, outputTokens: 0 },
        free: { calls: 1, inputTokens: 50, outputTokens: 0 },
      },
    })] } })
    expect(applyInvestigation([subject], modelFilters(['expensive']))).toMatchObject({ cost: 9, calls: 1, tokens: 100 })
    expect(applyInvestigation([subject], modelFilters(['free']))).toMatchObject({ cost: 0, calls: 1, tokens: 50 })
    expect(applyInvestigation([subject], modelFilters(['expensive', 'cheap', 'free']))).toMatchObject({ cost: 10, calls: 3, tokens: 1050 })
  })

  it('discloses old model payloads without counting rows excluded by provider', () => {
    const legacy = row({ sessionId: 'legacy', cost: 2, contributions: { segments: [segment({ cost: 2, models: { old: 2 } })] } })
    const otherProvider = row({ sessionId: 'other', provider: 'codex', cost: 3 })
    const result = applyInvestigation([legacy, otherProvider], withFilterValue(modelFilters(['old']), 'providers', 'claude'))
    expect(result.included).toEqual([])
    expect(result.unattributable).toBe(1)
  })

  it('rows without contribution segments are excluded and disclosed, not silently zero', () => {
    const plain = row({ sessionId: 'plain', cost: 3 })
    const result = applyInvestigation([plain], categoryFilters('coding'))
    expect(result.included).toHaveLength(0)
    expect(result.unattributable).toBe(1)
    // Session-level-only selections still work on plain rows.
    const sessionOnly = applyInvestigation([plain], providerFilters('claude'))
    expect(sessionOnly.cost).toBeCloseTo(3, 10)
    expect(sessionOnly.unattributable).toBe(0)
  })

  it('subagent rows carry lineage but contribute like any row', () => {
    const child = row({
      sessionId: 'agent-1',
      cost: 0.4,
      parentSessionId: 'root-1',
      isSidechain: true,
      contributions: { segments: [segment({ category: 'coding', cost: 0.4 })] },
    })
    const result = applyInvestigation([child], categoryFilters('coding'))
    expect(result.cost).toBeCloseTo(0.4, 10)
    expect(result.included[0]!.row.parentSessionId).toBe('root-1')
  })
})
