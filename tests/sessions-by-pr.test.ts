import { describe, expect, it } from 'vitest'

import { aggregateByPr, allocateEven, attributeSessionPrSpend, prLinkedTotals, shortenPrUrl } from '../src/sessions-report.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary, TokenUsage } from '../src/types.js'

const A = 'https://github.com/o/r/pull/1'
const B = 'https://github.com/o/r/pull/2'

// A legacy session: session-level prLinks but NO per-turn refs (turns: []), so
// the by-PR path takes the even-split fallback.
function session(id: string, cost: number, calls: number, prLinks?: string[], first = '2026-07-01T10:00:00Z', last = '2026-07-01T11:00:00Z'): SessionSummary {
  return {
    sessionId: id, project: 'p',
    firstTimestamp: first, lastTimestamp: last,
    totalCostUSD: cost, totalSavingsUSD: 0, totalEstimatedCostUSD: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: calls, turns: [],
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {} as SessionSummary['skillBreakdown'],
    subagentBreakdown: {} as SessionSummary['subagentBreakdown'],
    ...(prLinks ? { prLinks } : {}),
  }
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
}

let keySeq = 0
function call(cost: number): ParsedApiCall {
  return {
    provider: 'claude', model: 'claude', usage: ZERO_USAGE, costUSD: cost,
    tools: [], mcpTools: [], skills: [], subagentTypes: [],
    hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
    timestamp: '2026-07-01T10:00:00Z', bashCommands: [], deduplicationKey: `k${keySeq++}`,
  }
}

// A turn whose total cost `cost` is split across `calls` API calls, optionally
// referencing `prRefs` (the PRs touched during the turn).
function cturn(cost: number, calls = 1, prRefs?: string[]): ClassifiedTurn {
  return {
    userMessage: '',
    assistantCalls: Array.from({ length: calls }, () => call(cost / calls)),
    timestamp: '2026-07-01T10:00:00Z', sessionId: 's',
    category: 'coding', retries: 0, hasEdits: false,
    ...(prRefs ? { prRefs } : {}),
  }
}

function sessionWithTurns(id: string, prLinks: string[], turns: ClassifiedTurn[], first = '2026-07-01T10:00:00Z', last = '2026-07-01T11:00:00Z'): SessionSummary {
  return { ...session(id, 0, 0, prLinks, first, last), turns }
}

// A turn referencing `prRefs` whose calls each carry a [model, cost] pair.
function turnModels(prRefs: string[], calls: Array<[string, number]>): ClassifiedTurn {
  return {
    userMessage: '', timestamp: '2026-07-01T10:00:00Z', sessionId: 's',
    category: 'coding', retries: 0, hasEdits: false, prRefs,
    assistantCalls: calls.map(([model, cost]) => ({ ...call(cost), model })),
  }
}

function project(sessions: SessionSummary[]): ProjectSummary {
  return { project: 'p', projectPath: '/p', sessions, totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0, totalProxiedCostUSD: 0 }
}

describe('shortenPrUrl', () => {
  it('shortens GitHub PR URLs and passes anything else through', () => {
    expect(shortenPrUrl('https://github.com/getagentseal/codeburn/pull/755')).toBe('getagentseal/codeburn#755')
    expect(shortenPrUrl('https://gitlab.com/x/y/-/merge_requests/3')).toBe('https://gitlab.com/x/y/-/merge_requests/3')
  })
})

describe('attributeSessionPrSpend (turn-level state machine)', () => {
  it('attributes each turn of interleaved A,B,A,B to its own PR', () => {
    const { perUrl, unattributed } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 40, apiCalls: 4, totalSavingsUSD: 0,
      turns: [
        { prRefs: [A], assistantCalls: [{ costUSD: 10 }] },
        { prRefs: [B], assistantCalls: [{ costUSD: 10 }] },
        { prRefs: [A], assistantCalls: [{ costUSD: 10 }] },
        { prRefs: [B], assistantCalls: [{ costUSD: 10 }] },
      ],
    })
    expect(perUrl.get(A)!.cost).toBeCloseTo(20, 6)
    expect(perUrl.get(B)!.cost).toBeCloseTo(20, 6)
    expect(perUrl.get(A)!.approx).toBe(false)
    expect(unattributed.cost).toBe(0)
  })

  it('splits a multi-PR merge-sweep turn evenly across its refs (cost and calls)', () => {
    const { perUrl } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 100, apiCalls: 4, totalSavingsUSD: 0,
      turns: [{ prRefs: [A, B], assistantCalls: [{ costUSD: 25 }, { costUSD: 25 }, { costUSD: 25 }, { costUSD: 25 }] }],
    })
    expect(perUrl.get(A)!.cost).toBeCloseTo(50, 6)
    expect(perUrl.get(B)!.cost).toBeCloseTo(50, 6)
    expect(perUrl.get(A)!.calls).toBeCloseTo(2, 6)
    expect(perUrl.get(B)!.calls).toBeCloseTo(2, 6)
  })

  it('accumulates pre-first-reference turns into the unattributed bucket', () => {
    const { perUrl, unattributed } = attributeSessionPrSpend({
      prLinks: [A], totalCostUSD: 40, apiCalls: 2, totalSavingsUSD: 0,
      turns: [
        { assistantCalls: [{ costUSD: 30 }] },
        { prRefs: [A], assistantCalls: [{ costUSD: 10 }] },
      ],
    })
    expect(unattributed.cost).toBeCloseTo(30, 6)
    expect(perUrl.get(A)!.cost).toBeCloseTo(10, 6)
  })

  it('carries the current PR forward so a single-PR session attributes everything', () => {
    const { perUrl, unattributed } = attributeSessionPrSpend({
      prLinks: [A], totalCostUSD: 60, apiCalls: 3, totalSavingsUSD: 0,
      turns: [
        { prRefs: [A], assistantCalls: [{ costUSD: 10 }] },
        { assistantCalls: [{ costUSD: 20 }] },
        { assistantCalls: [{ costUSD: 30 }] },
      ],
    })
    expect(perUrl.get(A)!.cost).toBeCloseTo(60, 6)
    expect(unattributed.cost).toBe(0)
  })

  it('falls back to an even whole-session split (approx) when no turn carries refs', () => {
    const { perUrl, unattributed } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 100, apiCalls: 8, totalSavingsUSD: 4,
      turns: [{ assistantCalls: [{ costUSD: 100, savingsUSD: 4 }] }],
    })
    expect(perUrl.get(A)!.cost).toBeCloseTo(50, 6)
    expect(perUrl.get(B)!.cost).toBeCloseTo(50, 6)
    expect(perUrl.get(A)!.calls).toBeCloseTo(4, 6)
    expect(perUrl.get(A)!.approx).toBe(true)
    expect(perUrl.get(B)!.approx).toBe(true)
    expect(unattributed.cost).toBe(0)
  })

  it('attributed + unattributed equals the sum of turn costs', () => {
    const { perUrl, unattributed } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 0, apiCalls: 0, totalSavingsUSD: 0,
      turns: [
        { assistantCalls: [{ costUSD: 7 }] },
        { prRefs: [A], assistantCalls: [{ costUSD: 13 }] },
        { prRefs: [A, B], assistantCalls: [{ costUSD: 20 }] },
      ],
    })
    const attributed = [...perUrl.values()].reduce((s, c) => s + c.cost, 0)
    expect(attributed + unattributed.cost).toBeCloseTo(40, 6)
  })
})

describe('aggregateByPr (turn-level attribution)', () => {
  it('splits a multi-PR session across turns instead of counting the full cost to each', () => {
    const rows = aggregateByPr([project([
      sessionWithTurns('s', [A, B], [
        cturn(10, 1, [A]),
        cturn(30, 1, [B]),
        cturn(20, 1),            // no refs → carries B forward
      ]),
    ])])
    const a = rows.find(r => r.url === A)!
    const b = rows.find(r => r.url === B)!
    expect(a.cost).toBeCloseTo(10, 6)   // NOT the full 60 a by-reference count would give
    expect(b.cost).toBeCloseTo(50, 6)
    expect(a.approx).toBe(false)
    expect(a.sessions).toBe(1)
  })

  it('rows are summable: attributed rows + unattributed equal the PR-linked total', () => {
    const projects = [project([
      sessionWithTurns('s', [A], [
        cturn(30, 1),            // overhead before the first PR reference
        cturn(10, 1, [A]),
      ]),
    ])]
    const rows = aggregateByPr(projects)
    const totals = prLinkedTotals(projects)
    const rowSum = rows.reduce((s, r) => s + r.cost, 0)
    expect(rowSum).toBeCloseTo(totals.attributedCost, 6)
    expect(totals.attributedCost).toBeCloseTo(10, 6)
    expect(totals.unattributedCost).toBeCloseTo(30, 6)
    expect(totals.cost).toBeCloseTo(40, 6)
  })

  it('groups legacy sessions by PR, sorted by cost, tracking the date span', () => {
    const rows = aggregateByPr([project([
      session('a', 100, 40, [A], '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z'),
      session('b', 50, 10, [A], '2026-06-20T09:00:00Z', '2026-06-20T10:00:00Z'),
      session('c', 200, 80, [B]),
    ])])
    expect(rows.map(r => r.url)).toEqual([B, A])
    const pr1 = rows[1]!
    expect(pr1.cost).toBe(150)
    expect(pr1.sessions).toBe(2)
    expect(pr1.calls).toBe(50)
    expect(pr1.firstStarted).toBe('2026-06-20T09:00:00Z')
    expect(pr1.lastEnded).toBe('2026-07-01T11:00:00Z')
  })

  it('a legacy multi-PR session splits its cost evenly and marks the rows approx', () => {
    const rows = aggregateByPr([project([
      session('a', 100, 40, [A, B]),
    ])])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.cost).toBeCloseTo(50, 6)
    expect(rows[1]!.cost).toBeCloseTo(50, 6)
    expect(rows.every(r => r.approx)).toBe(true)
  })

  it('sessions without links contribute nothing', () => {
    expect(aggregateByPr([project([session('a', 100, 40)])])).toEqual([])
  })
})

describe('range-carry seed (finding 2)', () => {
  it('seeds current from a PR referenced before the range, not a legacy split', () => {
    // turn1 ref A, turn2 ref B are both before the range; the parser passes B as
    // the seed. The 8 in-range ref-less turns ($100) must all go to B, not split
    // $50/$50 approx across A and B.
    const { perUrl, unattributed } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 100, apiCalls: 8, totalSavingsUSD: 0,
      prRefsAtRangeStart: [B],
      turns: Array.from({ length: 8 }, () => ({ category: 'coding', assistantCalls: [{ costUSD: 12.5, model: 'm' }] })),
    })
    expect(perUrl.get(B)!.cost).toBeCloseTo(100, 6)
    expect(perUrl.get(B)!.approx).toBe(false)
    expect(perUrl.has(A)).toBe(false)
    expect(unattributed.cost).toBe(0)
  })

  it('lets an in-range reference override the seed', () => {
    const { perUrl } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 0, apiCalls: 0, totalSavingsUSD: 0,
      prRefsAtRangeStart: [A],
      turns: [
        { assistantCalls: [{ costUSD: 10 }] },            // seeded -> A
        { prRefs: [B], assistantCalls: [{ costUSD: 20 }] }, // switch -> B
        { assistantCalls: [{ costUSD: 5 }] },              // carries B
      ],
    })
    expect(perUrl.get(A)!.cost).toBeCloseTo(10, 6)
    expect(perUrl.get(B)!.cost).toBeCloseTo(25, 6)
  })
})

describe('call allocation (finding 5)', () => {
  it('allocateEven gives the remainder to the first buckets and sums to total', () => {
    expect(allocateEven(1, 2)).toEqual([1, 0])
    expect(allocateEven(5, 2)).toEqual([3, 2])
    expect(allocateEven(4, 2)).toEqual([2, 2])
    expect(allocateEven(0, 3)).toEqual([0, 0, 0])
    expect(allocateEven(7, 3)).toEqual([3, 2, 2])
  })

  it('a 1-call, 2-PR turn stays whole (no 0.5 that rounds up to 1 on each row)', () => {
    const { perUrl } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 0, apiCalls: 0, totalSavingsUSD: 0,
      turns: [{ prRefs: [A, B], category: 'coding', assistantCalls: [{ costUSD: 4 }] }],
    })
    expect(perUrl.get(A)!.calls + perUrl.get(B)!.calls).toBe(1)
    expect(perUrl.get(A)!.calls).toBe(1)
    expect(perUrl.get(B)!.calls).toBe(0)
  })
})

describe('models + categories attribution', () => {
  it('records per-model attributed cost and spreads a multi-PR turn to each PR', () => {
    const { perUrl } = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 0, apiCalls: 0, totalSavingsUSD: 0,
      turns: [
        { prRefs: [A], category: 'coding', assistantCalls: [{ costUSD: 10, model: 'claude-opus-4-6' }, { costUSD: 5, model: 'claude-haiku-4' }] },
        { prRefs: [A, B], category: 'coding', assistantCalls: [{ costUSD: 20, model: 'claude-opus-4-6' }] },
      ],
    })
    // A: opus 10 + haiku 5 + half of turn2 opus (10) = opus 20, haiku 5
    expect(perUrl.get(A)!.models.get('claude-opus-4-6')).toBeCloseTo(20, 6)
    expect(perUrl.get(A)!.models.get('claude-haiku-4')).toBeCloseTo(5, 6)
    // B: half of turn2 opus = 10
    expect(perUrl.get(B)!.models.get('claude-opus-4-6')).toBeCloseTo(10, 6)
  })

  it('accumulates category cost per PR (turn-level) and omits categories for legacy', () => {
    const { perUrl } = attributeSessionPrSpend({
      prLinks: [A], totalCostUSD: 0, apiCalls: 0, totalSavingsUSD: 0,
      turns: [
        { prRefs: [A], category: 'coding', assistantCalls: [{ costUSD: 10 }] },
        { category: 'debugging', assistantCalls: [{ costUSD: 6 }] },
      ],
    })
    expect(perUrl.get(A)!.categories.get('coding')).toBeCloseTo(10, 6)
    expect(perUrl.get(A)!.categories.get('debugging')).toBeCloseTo(6, 6)

    const legacy = attributeSessionPrSpend({
      prLinks: [A, B], totalCostUSD: 100, apiCalls: 8, totalSavingsUSD: 0,
      turns: [{ assistantCalls: [{ costUSD: 100, model: 'claude-opus-4-6' }] }],
    })
    expect(legacy.perUrl.get(A)!.categories.size).toBe(0)          // no faked categories
    expect(legacy.perUrl.get(A)!.models.get('claude-opus-4-6')).toBeCloseTo(50, 6) // model union still split
  })

  it('exposes short model names and display category labels on aggregated rows', () => {
    const rows = aggregateByPr([project([
      sessionWithTurns('s', [A], [cturn(10, 1, [A])]),
    ])])
    expect(rows[0]!.models.length).toBe(1)
    expect(rows[0]!.categories).toEqual([{ name: 'Coding', cost: 10 }])
  })
})

describe('mixed live + legacy category reconciliation (round-3 finding 1)', () => {
  it('adds a synthetic legacy line so a mixed row reconciles to its cost', () => {
    const rows = aggregateByPr([project([
      sessionWithTurns('live', [A], [cturn(10, 1, [A])]), // live: Coding $10
      session('legacy', 90, 5, [A]),                       // legacy: $90, no turn data
    ])])
    const row = rows.find(r => r.url === A)!
    expect(row.cost).toBeCloseTo(100, 6)
    expect(row.approx).toBe(true)
    const cats = row.categories!
    expect(cats.reduce((s, c) => s + c.cost, 0)).toBeCloseTo(row.cost, 6) // reconciles
    expect(cats.find(c => c.name === 'Coding')!.cost).toBeCloseTo(10, 6)
    expect(cats.find(c => c.name === 'Legacy estimate (no per-turn detail)')!.cost).toBeCloseTo(90, 6)
  })

  it('a legacy-only row still omits categories (surfaces the no-detail note)', () => {
    const rows = aggregateByPr([project([session('legacy', 90, 5, [A])])])
    expect(rows[0]!.categories).toBeUndefined()
  })
})

describe('model list ordering', () => {
  it('keeps every model ordered by attributed cost', () => {
    const rows = aggregateByPr([project([
      sessionWithTurns('s', [A], [turnModels([A], [['<synthetic>', 70], ['m-f', 60], ['m-e', 50], ['m-d', 40], ['m-c', 30], ['m-b', 20], ['m-a', 10]])]),
    ])])
    expect(rows[0]!.models).toEqual(['m-f', 'm-e', 'm-d', 'm-c', 'm-b', 'm-a'])
  })

  it('breaks model ties by name ascending for a stable order', () => {
    const rows = aggregateByPr([project([
      sessionWithTurns('s', [A], [turnModels([A], [['m-d', 10], ['m-a', 10], ['m-c', 10], ['m-b', 10]])]),
    ])])
    expect(rows[0]!.models).toEqual(['m-a', 'm-b', 'm-c', 'm-d'])
  })
})

describe('distinct-session keying (finding 7)', () => {
  it('counts two same-sessionId sessions in different projects as two', () => {
    const s1 = sessionWithTurns('same-id', [A], [cturn(10, 1, [A])])
    const s2 = { ...sessionWithTurns('same-id', [A], [cturn(10, 1, [A])]), project: 'other' }
    const rows = aggregateByPr([project([s1, s2])])
    expect(rows[0]!.sessions).toBe(2)
  })
})

describe('prLinkedTotals', () => {
  it('splits attributed vs unattributed and counts each PR-linked session once', () => {
    const totals = prLinkedTotals([project([
      session('a', 100, 40, [A, B]),   // legacy: 50 + 50 attributed
      session('b', 50, 10, [A]),       // legacy: 50 attributed
      session('c', 999, 1),            // no links → excluded
    ])])
    expect(totals).toEqual({ cost: 150, sessions: 2, subagentSessions: 0, attributedCost: 150, unattributedCost: 0 })
  })

  it('captures the unattributed remainder from pre-reference overhead', () => {
    const totals = prLinkedTotals([project([
      sessionWithTurns('s', [A], [cturn(30, 1), cturn(10, 1, [A])]),
    ])])
    expect(totals.attributedCost).toBeCloseTo(10, 6)
    expect(totals.unattributedCost).toBeCloseTo(30, 6)
    expect(totals.cost).toBeCloseTo(40, 6)
    expect(totals.sessions).toBe(1)
  })
})
