import { getDaysInRange, type DailyCache, type DailyEntry } from './daily-cache.js'
import type { DateRange, ProjectSummary } from './types.js'
import { buildPeriodData, canonicalSessionCountKey } from './usage-aggregator.js'
import { inferSessionProvider } from './session-output.js'
import { spendProjectIdentity } from './spend-flow.js'

/// Period-vs-period difference engine (Compare periods). Pure functions only:
/// no clock reads, no filesystem, no parsing. The caller parses each range with
/// `parseAllSessions(range, provider)` — which slices at CALL granularity
/// (src/parser.ts `callsInRange`, issue #852) — and hands the sliced
/// ProjectSummary[] trees in. A session that straddles the A/B boundary is
/// therefore split across both ranges at the same granularity every other
/// CodeBurn report uses; nothing here re-derives attribution from session start
/// dates. All differences are B − A. A is the reference period, B the analyzed
/// one.

export type PeriodRangeKey = { from: string; to: string }

export type PeriodRangeInfo = {
  from: string
  to: string
  /// Inclusive count of local calendar days, counted by walking local
  /// midnights (never millisecond division, which DST breaks).
  days: number
}

export type ContributionStatus = 'new' | 'gone' | 'up' | 'down' | 'flat'

export type Contribution = {
  /// Canonical project path or canonical model id (the keys every other
  /// report uses — never a display title or short name).
  key: string
  costA: number
  costB: number
  diff: number
  /// diff / |costA| × 100. Null when costA is exactly 0 — the row is labeled
  /// `new` instead of inventing an infinite percentage.
  pct: number | null
  status: ContributionStatus
  callsA: number
  callsB: number
}

export type PeriodTotals = {
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  savingsUSD: number
  estimatedCostUSD: number
}

export type TotalsDiff = {
  A: PeriodTotals
  B: PeriodTotals
  /// B − A for every component, unrounded.
  diff: PeriodTotals
  /// Per-component B−A percent, null where the A component is 0.
  pct: Record<Exclude<keyof PeriodTotals, 'sessions'>, number | null> & { sessions: number | null }
}

export type NormalizedMetric = {
  a: number | null
  b: number | null
  diff: number | null
  pct: number | null
}

export type NormalizedView = {
  /// Cost per calendar day of each range.
  perDay: NormalizedMetric
  /// Cost per 100 (behavioral) API calls of each range.
  per100Calls: NormalizedMetric
  /// What each denominator counts, so a normalized number can always be
  /// checked against the raw totals on screen.
  denominators: {
    perDay: string
    per100Calls: string
  }
}

export type CoverageBlock = {
  /// Models with calls but no price data — "unknown", never zero — per range,
  /// straight from the shared buildPeriodData rules.
  unpricedModelsA: Array<{ model: string; calls: number }>
  unpricedModelsB: Array<{ model: string; calls: number }>
  pricingCoverageA: number | null
  pricingCoverageB: number | null
}

export type AggregateDayRow = {
  date: string
  /// Cost the durable daily history holds for that day (all providers, or the
  /// selected provider's slice when a provider filter is active).
  historyCost: number
  /// Cost the session-detail basis explains for that day.
  detailCost: number
  /// historyCost − detailCost when the durable history holds more than the
  /// session detail can explain: usage whose sources aged off disk and survives
  /// only as the aggregate carried history. Shown separately, never folded into
  /// the totals or the contribution lenses.
  aggregateOnly: number
}

export type HistoryBasis = {
  historyCost: { A: number; B: number }
  detailCost: { A: number; B: number }
  /// Days in each range whose durable history exceeds what the session detail
  /// explains, sorted by date. Empty arrays when everything reconciles.
  days: { A: AggregateDayRow[]; B: AggregateDayRow[] }
  aggregateOnly: { A: number; B: number }
  /// One-line explanation of the basis, rendered verbatim in the UI/report.
  basis: string
}

export type PeriodDiffReport = {
  schema: 1
  provider: string
  rangeA: PeriodRangeInfo
  rangeB: PeriodRangeInfo
  /// Inclusive local-day overlap of A and B, 0 when disjoint.
  overlapDays: number
  /// days(B) − days(A); 0 when the ranges are equally long.
  durationDeltaDays: number
  totals: TotalsDiff
  /// Same global difference seen per project. Lenses are never summed together:
  /// each one alone reconciles the global diff (before display rounding).
  projects: Contribution[]
  /// Separate lens: the same global difference seen per model.
  models: Contribution[]
  normalized: NormalizedView
  coverage: CoverageBlock
  history?: HistoryBasis
}

export type SessionDiffRow = {
  /// `provider\0projectPath\0sessionId` — the canonical session identity. A
  /// bare sessionId is not globally unique and is never used as the key.
  identity: string
  provider: string
  sessionId: string
  project: string
  title?: string
  costA: number
  costB: number
  diff: number
  callsA: number
  callsB: number
}

const EPSILON = 1e-9

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/// Count inclusive local calendar days from `from` to `to` by walking local
/// midnights. Millisecond division would miscount across a DST transition; a
/// calendar walk does not, in any timezone.
export function countLocalDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  const cursor = localDayStart(new Date(fy, fm - 1, fd))
  const end = localDayStart(new Date(ty, tm - 1, td))
  if (cursor > end) return 0
  let days = 0
  while (cursor <= end) {
    days++
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

export function rangeInfo(range: PeriodRangeKey): PeriodRangeInfo {
  return { ...range, days: countLocalDays(range.from, range.to) }
}

/// Key a parser DateRange (local start/end Dates, end inclusive at 23:59:59.999)
/// into from/to strings plus its inclusive local-day count.
export function localRangeInfo(range: DateRange): PeriodRangeInfo {
  return rangeInfo({ from: localDateKey(range.start), to: localDateKey(range.end) })
}

/// Local 'YYYY-MM-DD' day keys (inclusive) back into the parser DateRange
/// shape: [from 00:00:00.000, to 23:59:59.999] in LOCAL time — the same
/// convention `--from/--to` uses everywhere else in the CLI.
export function dayKeyToRange(from: string, to: string): DateRange {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  return { start: new Date(fy, fm - 1, fd), end: new Date(ty, tm - 1, td, 23, 59, 59, 999) }
}

/// The default horizon: B = the last seven COMPLETE local calendar days
/// (today is never complete), A = the seven before that. All local time —
/// never UTC.
export function defaultSevenDayRanges(now = new Date()): { A: PeriodRangeKey; B: PeriodRangeKey } {
  const day = (offset: number): string => {
    const d = localDayStart(now)
    d.setDate(d.getDate() + offset)
    return localDateKey(d)
  }
  return {
    A: { from: day(-14), to: day(-8) },
    B: { from: day(-7), to: day(-1) },
  }
}

/// Inclusive local-day overlap between two [from..to] key ranges.
export function overlapDays(a: PeriodRangeKey, b: PeriodRangeKey): number {
  const start = a.from > b.from ? a.from : b.from
  const end = a.to < b.to ? a.to : b.to
  if (start > end) return 0
  return countLocalDays(start, end)
}

function pct(diff: number, base: number): number | null {
  if (Math.abs(base) < EPSILON) return null
  return (diff / Math.abs(base)) * 100
}

function statusOf(costA: number, costB: number): ContributionStatus {
  if (Math.abs(costA) < EPSILON && Math.abs(costB) >= EPSILON) return 'new'
  if (Math.abs(costB) < EPSILON && Math.abs(costA) >= EPSILON) return 'gone'
  if (costB > costA) return 'up'
  if (costB < costA) return 'down'
  return 'flat'
}

/// Deterministic order: largest absolute movement first, then B size, then key.
function byMovement(a: Contribution, b: Contribution): number {
  const delta = Math.abs(b.diff) - Math.abs(a.diff)
  if (delta !== 0) return delta
  if (b.costB !== a.costB) return b.costB - a.costB
  return a.key.localeCompare(b.key)
}

function contribution(key: string, costA: number, costB: number, callsA: number, callsB: number): Contribution {
  const diff = costB - costA
  return { key, costA, costB, diff, pct: pct(diff, costA), status: statusOf(costA, costB), callsA, callsB }
}

function totalsOf(projects: ProjectSummary[], label: string): { totals: PeriodTotals; unpriced: Array<{ model: string; calls: number }>; pricingCoverage: number | null } {
  const data = buildPeriodData(label, projects)
  return {
    totals: {
      cost: data.cost,
      calls: data.calls,
      sessions: data.sessions,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheReadTokens: data.cacheReadTokens,
      cacheWriteTokens: data.cacheWriteTokens,
      savingsUSD: data.savingsUSD,
      estimatedCostUSD: data.estimatedCostUSD ?? 0,
    },
    unpriced: (data.unpricedModels ?? []).map(m => ({ model: m.model, calls: m.calls })),
    pricingCoverage: data.pricingCoverage ?? null,
  }
}

function diffTotals(a: PeriodTotals, b: PeriodTotals): TotalsDiff {
  const diff: PeriodTotals = {
    cost: b.cost - a.cost,
    calls: b.calls - a.calls,
    sessions: b.sessions - a.sessions,
    inputTokens: b.inputTokens - a.inputTokens,
    outputTokens: b.outputTokens - a.outputTokens,
    cacheReadTokens: b.cacheReadTokens - a.cacheReadTokens,
    cacheWriteTokens: b.cacheWriteTokens - a.cacheWriteTokens,
    savingsUSD: b.savingsUSD - a.savingsUSD,
    estimatedCostUSD: b.estimatedCostUSD - a.estimatedCostUSD,
  }
  const pctRow = (fn: (t: PeriodTotals) => number): number | null => {
    const va = fn(a)
    return pct(fn(diff), va)
  }
  return {
    A: a,
    B: b,
    diff,
    pct: {
      cost: pctRow(t => t.cost),
      calls: pctRow(t => t.calls),
      sessions: pctRow(t => t.sessions),
      inputTokens: pctRow(t => t.inputTokens),
      outputTokens: pctRow(t => t.outputTokens),
      cacheReadTokens: pctRow(t => t.cacheReadTokens),
      cacheWriteTokens: pctRow(t => t.cacheWriteTokens),
      savingsUSD: pctRow(t => t.savingsUSD),
      estimatedCostUSD: pctRow(t => t.estimatedCostUSD),
    },
  }
}

function normalize(numeratorA: number, numeratorB: number, denominatorA: number, denominatorB: number): NormalizedMetric {
  // Denominator 0 or unknown → unavailable (null), never an invented value.
  const a = denominatorA > 0 ? numeratorA / denominatorA : null
  const b = denominatorB > 0 ? numeratorB / denominatorB : null
  if (a === null || b === null) return { a, b, diff: null, pct: null }
  const delta = b - a
  return { a, b, diff: delta, pct: pct(delta, a) }
}

function normalizedView(totalsA: PeriodTotals, totalsB: PeriodTotals, rangeA: PeriodRangeInfo, rangeB: PeriodRangeInfo): NormalizedView {
  return {
    perDay: normalize(totalsA.cost, totalsB.cost, rangeA.days, rangeB.days),
    per100Calls: normalize(totalsA.cost * 100, totalsB.cost * 100, totalsA.calls, totalsB.calls),
    denominators: {
      perDay: `calendar days in the range (A: ${rangeA.days}, B: ${rangeB.days})`,
      per100Calls: `API calls × 100 (A: ${totalsA.calls.toLocaleString('en-US')}, B: ${totalsB.calls.toLocaleString('en-US')})`,
    },
  }
}

function projectContributions(projectsA: ProjectSummary[], projectsB: ProjectSummary[]): Contribution[] {
  const fold = (projects: ProjectSummary[]) => {
    const totals = new Map<string, { cost: number; calls: number }>()
    for (const project of projects) {
      const { id } = spendProjectIdentity(project)
      const value = totals.get(id) ?? { cost: 0, calls: 0 }
      value.cost += project.totalCostUSD
      value.calls += project.totalApiCalls
      totals.set(id, value)
    }
    return totals
  }
  const costsA = fold(projectsA)
  const costsB = fold(projectsB)
  const keys = new Set([...costsA.keys(), ...costsB.keys()])
  const rows: Contribution[] = []
  for (const key of keys) {
    const a = costsA.get(key)
    const b = costsB.get(key)
    const costA = a?.cost ?? 0
    const costB = b?.cost ?? 0
    if (Math.abs(costA) < EPSILON && Math.abs(costB) < EPSILON) continue
    rows.push(contribution(key, costA, costB, a?.calls ?? 0, b?.calls ?? 0))
  }
  return rows.sort(byMovement)
}

function modelContributions(projectsA: ProjectSummary[], projectsB: ProjectSummary[]): Contribution[] {
  const fold = (projects: ProjectSummary[]): Map<string, { cost: number; calls: number }> => {
    const map = new Map<string, { cost: number; calls: number }>()
    for (const p of projects) {
      for (const sess of p.sessions) {
        for (const [model, d] of Object.entries(sess.modelBreakdown)) {
          const acc = map.get(model) ?? { cost: 0, calls: 0 }
          acc.cost += d.costUSD
          acc.calls += d.calls
          map.set(model, acc)
        }
      }
    }
    return map
  }
  const costsA = fold(projectsA)
  const costsB = fold(projectsB)
  const keys = new Set([...costsA.keys(), ...costsB.keys()])
  const rows: Contribution[] = []
  for (const key of keys) {
    const a = costsA.get(key)
    const b = costsB.get(key)
    const costA = a?.cost ?? 0
    const costB = b?.cost ?? 0
    if (Math.abs(costA) < EPSILON && Math.abs(costB) < EPSILON) continue
    rows.push(contribution(key, costA, costB, a?.calls ?? 0, b?.calls ?? 0))
  }
  return rows.sort(byMovement)
}

/// Cross-check the session-detail totals against the durable daily history
/// (the ONLY record of days whose sources aged off disk, flagged `carried`).
/// Days where the history holds more than the detail explains are listed with
/// their aggregate-only amount so a reader can always see how much of the
/// picture has no session detail behind it. The aggregate-only amount is
/// reported separately and is NEVER folded into totals or lenses.
export function historyBasis(
  cache: DailyCache,
  rangeA: PeriodRangeKey,
  rangeB: PeriodRangeKey,
  provider: string,
  freshDaysA: DailyEntry[],
  freshDaysB: DailyEntry[],
): HistoryBasis {
  const dayCost = (entry: DailyEntry): number => {
    if (provider === 'all' || provider === '') return entry.cost
    return entry.providers[provider]?.cost ?? 0
  }
  const detailByDay = (days: DailyEntry[]): Map<string, number> =>
    new Map(days.map(day => [day.date, day.cost]))

  const build = (range: PeriodRangeKey, fresh: DailyEntry[]) => {
    const detail = detailByDay(fresh)
    const rows: AggregateDayRow[] = []
    let historyCost = 0
    let detailCost = 0
    let aggregateOnly = 0
    for (const entry of getDaysInRange(cache, range.from, range.to)) {
      const history = dayCost(entry)
      const explained = detail.get(entry.date) ?? 0
      historyCost += history
      detailCost += explained
      // Only a POSITIVE unexplained remainder is aggregate history. A negative
      // one (detail exceeds history) means the durable cache is simply behind,
      // not that detail is wrong — never clamp it into a fake carried number.
      if (history > explained + EPSILON) {
        const unexplained = history - explained
        aggregateOnly += unexplained
        rows.push({ date: entry.date, historyCost: history, detailCost: explained, aggregateOnly: unexplained })
      }
    }
    return { rows, historyCost, detailCost, aggregateOnly }
  }

  const a = build(rangeA, freshDaysA)
  const b = build(rangeB, freshDaysB)
  return {
    historyCost: { A: a.historyCost, B: b.historyCost },
    detailCost: { A: a.detailCost, B: b.detailCost },
    days: { A: a.rows, B: b.rows },
    aggregateOnly: { A: a.aggregateOnly, B: b.aggregateOnly },
    basis: 'Totals come from parsed session transcripts. Days whose sources no longer exist survive only as aggregate daily history; their unexplained cost is listed here, not folded into the totals.',
  }
}

// getDaysInRange is imported at the top of this module.
function emptyHistoryBasis(): HistoryBasis {
  return {
    historyCost: { A: 0, B: 0 },
    detailCost: { A: 0, B: 0 },
    days: { A: [], B: [] },
    aggregateOnly: { A: 0, B: 0 },
    basis: 'Daily history unavailable in this run; totals reflect parsed session detail only.',
  }
}

export function buildPeriodDiffReport(args: {
  provider: string
  rangeA: PeriodRangeKey
  rangeB: PeriodRangeKey
  projectsA: ProjectSummary[]
  projectsB: ProjectSummary[]
  history?: HistoryBasis
}): PeriodDiffReport {
  const infoA = rangeInfo(args.rangeA)
  const infoB = rangeInfo(args.rangeB)
  const labelA = `${infoA.from} to ${infoA.to}`
  const labelB = `${infoB.from} to ${infoB.to}`
  const sideA = totalsOf(args.projectsA, labelA)
  const sideB = totalsOf(args.projectsB, labelB)
  const totalsA = sideA.totals
  const totalsB = sideB.totals
  return {
    schema: 1,
    provider: args.provider,
    rangeA: infoA,
    rangeB: infoB,
    overlapDays: overlapDays(args.rangeA, args.rangeB),
    durationDeltaDays: infoB.days - infoA.days,
    totals: diffTotals(totalsA, totalsB),
    projects: projectContributions(args.projectsA, args.projectsB),
    models: modelContributions(args.projectsA, args.projectsB),
    normalized: normalizedView(totalsA, totalsB, infoA, infoB),
    coverage: {
      unpricedModelsA: sideA.unpriced,
      unpricedModelsB: sideB.unpriced,
      pricingCoverageA: sideA.pricingCoverage,
      pricingCoverageB: sideB.pricingCoverage,
    },
    history: args.history ?? emptyHistoryBasis(),
  }
}

/// Sessions behind one contribution, joined across A and B on the canonical
/// session identity (provider + project path + sessionId). Costs are each
/// range's post-slice session totals, so a session with activity on both sides
/// of the boundary appears once with a cost in each column.
export function diffSessions(
  projectsA: ProjectSummary[],
  projectsB: ProjectSummary[],
  dimension: 'project' | 'model',
  key: string,
): SessionDiffRow[] {
  type Acc = { provider: string; sessionId: string; project: string; title?: string; costA: number; costB: number; callsA: number; callsB: number }
  const accs = new Map<string, Acc>()

  const fold = (projects: ProjectSummary[], side: 'A' | 'B') => {
    for (const project of projects) {
      for (const session of project.sessions) {
        // Model lens: attribute the MODEL's slice of the session (its
        // modelBreakdown entry), never the whole session cost — a session can
        // use several models and its total belongs to no single one of them.
        const modelEntry = dimension === 'model' ? session.modelBreakdown[key] : undefined
        if (dimension === 'model' && !modelEntry) continue
        if (dimension === 'project' && spendProjectIdentity(project).id !== key) continue
        const cost = dimension === 'model' ? modelEntry!.costUSD : session.totalCostUSD
        const calls = dimension === 'model' ? modelEntry!.calls : session.apiCalls
        const identity = canonicalSessionCountKey(session, project.projectPath)
        const acc = accs.get(identity) ?? {
          provider: inferSessionProvider(session),
          sessionId: session.sessionId,
          project: project.project,
          title: session.title,
          costA: 0,
          costB: 0,
          callsA: 0,
          callsB: 0,
        }
        if (side === 'A') {
          acc.costA += cost
          acc.callsA += calls
        } else {
          acc.costB += cost
          acc.callsB += calls
        }
        if (!acc.title && session.title) acc.title = session.title
        accs.set(identity, acc)
      }
    }
  }
  fold(projectsA, 'A')
  fold(projectsB, 'B')

  const rows: SessionDiffRow[] = []
  for (const [identity, acc] of accs) {
    if (Math.abs(acc.costA) < EPSILON && Math.abs(acc.costB) < EPSILON) continue
    rows.push({
      identity,
      provider: acc.provider,
      sessionId: acc.sessionId,
      project: acc.project,
      ...(acc.title ? { title: acc.title } : {}),
      costA: acc.costA,
      costB: acc.costB,
      diff: acc.costB - acc.costA,
      callsA: acc.callsA,
      callsB: acc.callsB,
    })
  }
  return rows.sort(byMovementLikeSessions)
}

function byMovementLikeSessions(a: SessionDiffRow, b: SessionDiffRow): number {
  const delta = Math.abs(b.diff) - Math.abs(a.diff)
  if (delta !== 0) return delta
  if (b.costB !== a.costB) return b.costB - a.costB
  return a.identity.localeCompare(b.identity)
}
