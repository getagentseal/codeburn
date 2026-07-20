import { homedir } from 'node:os'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory, type DateRange } from './types.js'
import { type PeriodData, type ProviderCost, type BreakdownArrays, type MenubarPayload, type ClaudeConfigSelector, buildMenubarPayload } from './menubar-json.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDays, filterProjectsByClaudeConfigSource, isSessionHydrationComplete } from './parser.js'
import { findUnpricedModels, getLocalModelSavingsConfigHash, getPriceOverridesConfigHash, getShortModelName, isExpectedFreeModel } from './models.js'
import { getAllProviders, safeDiscoverSessions } from './providers/index.js'
import { claude, getClaudeConfigDirs, getDesktopSessionsDir } from './providers/claude.js'
import { stat } from 'node:fs/promises'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from './day-aggregator.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { aggregateModels } from './models-report.js'
import { scanUserCorrections, medianTimeToFirstEditMs, aggregateFileChurn, computePricingCoverage } from './workflow-insights.js'
import { aggregateByPr, prLinkedTotals, aggregateByBranch } from './sessions-report.js'
import { scanAndDetect } from './optimize.js'
import { getDaysInRange, ensureCacheHydrated, emptyCache, BACKFILL_DAYS, toDateString, type DailyCache, type DailyEntry } from './daily-cache.js'
import { buildGranularHistory } from './granular-history.js'

// Row caps for the by-PR / by-branch payload aggregations, ranked by cost.
const TOP_PULL_REQUESTS = 20
const TOP_BRANCHES = 15

export function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  const sessions = projects.flatMap(p => p.sessions)
  const catTotals: Record<string, { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number; savingsUSD: number; estimatedCostUSD: number; tokens: number }> = {}
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0

  for (const sess of sessions) {
    inputTokens += sess.totalInputTokens
    outputTokens += sess.totalOutputTokens
    cacheReadTokens += sess.totalCacheReadTokens
    cacheWriteTokens += sess.totalCacheWriteTokens
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      catTotals[cat].turns += d.turns
      catTotals[cat].cost += d.costUSD
      catTotals[cat].savingsUSD += d.savingsUSD
      catTotals[cat].editTurns += d.editTurns
      catTotals[cat].oneShotTurns += d.oneShotTurns
    }
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, savingsUSD: 0, estimatedCostUSD: 0, tokens: 0 }
      modelTotals[model].calls += d.calls
      modelTotals[model].cost += d.costUSD
      modelTotals[model].savingsUSD += d.savingsUSD
      modelTotals[model].estimatedCostUSD += d.estimatedCostUSD ?? 0
      modelTotals[model].tokens += d.tokens.inputTokens + d.tokens.outputTokens + d.tokens.cacheReadInputTokens + d.tokens.cacheCreationInputTokens
    }
  }

  const unpricedModels = findUnpricedModels(Object.entries(modelTotals)
    .map(([model, d]) => ({ model, calls: d.calls, cost: d.cost, tokens: d.tokens })))
  const costBearingCalls = Object.entries(modelTotals)
    .reduce((s, [model, d]) => s + (model === '<synthetic>' || isExpectedFreeModel(model) ? 0 : d.calls), 0)
  const unpricedCalls = unpricedModels.reduce((s, m) => s + m.calls, 0)
  const corrections = scanUserCorrections(projects)

  return {
    label,
    cost: projects.reduce((s, p) => s + p.totalCostUSD, 0),
    savingsUSD: projects.reduce((s, p) => s + p.totalSavingsUSD, 0),
    estimatedCostUSD: projects.reduce((s, p) => s + (p.totalEstimatedCostUSD ?? 0), 0),
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    sessions: projects.reduce((s, p) => s + p.sessions.length, 0),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, calls: d.calls, cost: d.cost, savingsUSD: d.savingsUSD, estimatedCostUSD: d.estimatedCostUSD })),
    unpricedModels,
    workflow: {
      corrections: corrections.corrections,
      correctionRate: corrections.correctionRate,
      medianTimeToFirstEditMs: medianTimeToFirstEditMs(projects),
    },
    topReworkedFiles: aggregateFileChurn(projects),
    pricingCoverage: computePricingCoverage(costBearingCalls, unpricedCalls),
  }
}

export function getDailyCacheConfigHash(): string {
  const savingsHash = getLocalModelSavingsConfigHash()
  const overridesHash = getPriceOverridesConfigHash()
  if (!overridesHash) return savingsHash
  return `localModelSavings=${savingsHash}\u0002priceOverrides=${overridesHash}`
}

async function hydrateCache(): Promise<DailyCache> {
  try {
    return await ensureCacheHydrated(
      (range) => parseAllSessions(range, 'all'),
      aggregateProjectsIntoDays,
      getDailyCacheConfigHash(),
      // Never finalize the daily history off a partial (interrupted) session
      // hydration — that is what froze empty older days into the chart.
      isSessionHydrationComplete,
    )
  } catch (err) {
    // Previously swallowed silently, which turned any backfill failure into an
    // empty trend/history with no signal (issue #441). Per-file parse errors no
    // longer reach here (they're isolated in parseProviderSources), so anything
    // that does is exceptional and worth surfacing.
    process.stderr.write(
      `codeburn: daily history backfill failed; the trend chart may be incomplete. ` +
      `${err instanceof Error ? err.message : String(err)}\n`
    )
    return emptyCache()
  }
}

export type PeriodInfo = { range: DateRange; label: string }
export type AggregateOpts = {
  provider?: string
  project?: string[]
  exclude?: string[]
  daysSelection?: { range: DateRange; label: string; days: Set<string> } | null
  optimize?: boolean
  claudeConfigSourceId?: string | null
  /// Build the granular per-bucket timeline (`history.timeline`). Defaults to
  /// true. The desktop app never renders it, so it passes `--no-timeline` to
  /// skip the buildGranularHistory pass on every menubar poll.
  timeline?: boolean
}

type ConfigOption = { id: string; label: string; path: string }

function buildSelector(byId: Map<string, ConfigOption>, selectedId?: string | null): ClaudeConfigSelector | undefined {
  const options = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))
  if (options.length <= 1) return undefined
  const validSelectedId = selectedId && options.some(option => option.id === selectedId) ? selectedId : null
  return { selectedId: validSelectedId, options }
}

// Complete option list including configs with NO data in the period (so the
// user can still switch to one to confirm it is $0). Only worth the extra
// Claude discovery walk when the user actually has multiple config dirs; a
// single-config user can never have a >1 selector, so skip it and let the
// project-derived path (which also surfaces a Claude Desktop bucket with data)
// stand.
async function claudeConfigSelector(projects: ProjectSummary[], selectedId?: string | null): Promise<ClaudeConfigSelector | undefined> {
  const byId = new Map<string, ConfigOption>()
  for (const session of projects.flatMap(project => project.sessions)) {
    const source = session.source
    if (source?.kind !== 'claude-config' && source?.kind !== 'claude-desktop') continue
    if (!byId.has(source.id)) byId.set(source.id, { id: source.id, label: source.label, path: source.path })
  }
  // The discovery walk lists sources that have no data in the period (so an
  // idle config or Claude Desktop is still selectable). Only worth it when a
  // second source is possible: more than one config dir, or a Claude Desktop
  // sessions dir exists. A plain single-config user skips it entirely.
  const desktopExists = await stat(getDesktopSessionsDir()).then(s => s.isDirectory()).catch(() => false)
  if ((await getClaudeConfigDirs()).length > 1 || desktopExists) {
    for (const source of await claude.discoverSessions()) {
      if ((source.sourceKind !== 'claude-config' && source.sourceKind !== 'claude-desktop') || !source.sourceId || !source.sourceLabel || !source.sourcePath) continue
      if (!byId.has(source.sourceId)) byId.set(source.sourceId, { id: source.sourceId, label: source.sourceLabel, path: source.sourcePath })
    }
  }
  return buildSelector(byId, selectedId)
}

function dailyEntriesToHistory(days: ReturnType<typeof aggregateProjectsIntoDays>): MenubarPayload['history']['daily'] {
  return days.map(d => {
    const topModels = Object.entries(d.models)
      .filter(([name]) => name !== '<synthetic>')
      .sort(([, a], [, b]) => b.cost - a.cost)
      .slice(0, 5)
      .map(([name, m]) => ({
        name,
        cost: m.cost,
        savingsUSD: m.savingsUSD,
        calls: m.calls,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
      }))
    return {
      date: d.date,
      cost: d.cost,
      savingsUSD: d.savingsUSD,
      calls: d.calls,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      cacheWriteTokens: d.cacheWriteTokens,
      topModels,
    }
  })
}

/// Collapse a day to a single provider's slice, promoting the slice's totals to
/// the day-level fields buildPeriodDataFromDays reads. A day with no slice for
/// the provider becomes a zero day (so the date is still present but contributes
/// nothing). The `carried` flag is inherited so a per-provider total can still
/// account for expired-source days.
function sliceDayToProvider(day: DailyEntry, provider: string): DailyEntry {
  const s = Object.hasOwn(day.providers, provider) ? day.providers[provider] : undefined
  if (!s) {
    return {
      date: day.date, cost: 0, savingsUSD: 0, calls: 0, sessions: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      editTurns: 0, oneShotTurns: 0, models: {}, categories: {}, providers: {},
      ...(day.carried ? { carried: true as const } : {}),
    }
  }
  return {
    date: day.date,
    cost: s.cost,
    savingsUSD: s.savingsUSD ?? 0,
    calls: s.calls,
    sessions: s.sessions ?? 0,
    inputTokens: s.inputTokens ?? 0,
    outputTokens: s.outputTokens ?? 0,
    cacheReadTokens: s.cacheReadTokens ?? 0,
    cacheWriteTokens: s.cacheWriteTokens ?? 0,
    editTurns: s.editTurns ?? 0,
    oneShotTurns: s.oneShotTurns ?? 0,
    models: s.models ?? {},
    categories: s.categories ?? {},
    providers: { [provider]: s },
    ...(s.projects ? { projects: s.projects } : {}),
    ...(day.carried ? { carried: true as const } : {}),
  }
}

/// The durable day set behind a period's headline: historical days from the
/// carry-forward cache (up to yesterday, INCLUDING days whose session files have
/// expired) unioned with today parsed live, then narrowed to the requested range
/// and (when given) the heatmap day selection. Identical construction to the
/// menubar's all-provider headline — this IS that construction, extracted.
function unionDaysForPeriod(
  cache: DailyCache,
  todayAllDays: DailyEntry[],
  periodInfo: PeriodInfo,
  daysSelection: Set<string> | null,
): DailyEntry[] {
  const now = new Date()
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const rangeStartStr = toDateString(periodInfo.range.start)
  const rangeEndStr = toDateString(periodInfo.range.end)
  const historicalRangeEndStr = rangeEndStr < yesterdayStr ? rangeEndStr : yesterdayStr
  const historicalDays = rangeStartStr <= historicalRangeEndStr
    ? getDaysInRange(cache, rangeStartStr, historicalRangeEndStr)
    : []
  const todayInRange = todayAllDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
  const unfiltered = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
  return daysSelection ? unfiltered.filter(d => daysSelection.has(d.date)) : unfiltered
}

/// The single durable-totals builder every CLI/TUI surface and the menubar share.
/// Headline totals (cost/calls/sessions/tokens/models/categories/savings) come
/// from the carry-forward daily cache unioned with today's live parse and sliced
/// to the requested provider, so a period that includes days whose session files
/// have expired still counts them — the invariant the menubar already relies on.
/// Detail-only fields that day entries can't carry (estimatedCost, unpriced
/// models, workflow intelligence, per-session drill-down) are enriched from a
/// fresh parse of the surviving sessions.
export type DurablePeriod = {
  /// Durable headline totals for the period.
  data: PeriodData
  /// The exact provider-sliced, day-filtered day set behind `data`. Daily rows
  /// rendered by report/overview come from here so they reconcile to `data`.
  days: DailyEntry[]
  /// Sum of `cost` on `carried` days included in the period (footnote source).
  carriedCostUSD: number
  /// Fresh per-period parse (provider + name filtered) for detail views that
  /// still need surviving session files.
  liveProjects: ProjectSummary[]
  /// Hydrated all-provider cache (reused by the menubar's provider list + daily
  /// history sections).
  cache: DailyCache
  /// Today-only slice, all providers, name-filtered (memo seed for the menubar).
  todayAllDays: DailyEntry[]
  /// The scan range the live parse covered (today-only when the period is today).
  scanRange: DateRange
}

export async function buildDurablePeriod(periodInfo: PeriodInfo, opts: AggregateOpts = {}): Promise<DurablePeriod> {
  const pf = opts.provider ?? 'all'
  const daysSelection = opts.daysSelection ?? null
  const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project ?? [], opts.exclude ?? [])

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayRange: DateRange = { start: todayStart, end: now }
  const todayStr = toDateString(todayStart)
  const rangeStartStr = toDateString(periodInfo.range.start)
  const rangeEndStr = toDateString(periodInfo.range.end)
  const isTodayOnly = rangeStartStr === todayStr && rangeEndStr === todayStr

  const cache = await hydrateCache()

  // Today's live data always comes from an all-provider parse so the union (and
  // any per-provider slice of it) sees every provider's today. `todayAllDays` is
  // the today bucket only — the union filters the historical remainder out of the
  // cache.
  let liveProjects: ProjectSummary[]
  let todayAllDays: DailyEntry[]
  let scanRange: DateRange
  if (pf === 'all') {
    if (isTodayOnly) {
      const raw = fp(await parseAllSessions(todayRange, 'all'))
      liveProjects = raw
      scanRange = todayRange
      todayAllDays = aggregateProjectsIntoDays(raw).filter(d => d.date === todayStr)
    } else {
      const raw = fp(await parseAllSessions(periodInfo.range, 'all'))
      liveProjects = daysSelection ? filterProjectsByDays(raw, daysSelection.days) : raw
      scanRange = periodInfo.range
      // A period that reaches today contains today's turns already, so derive the
      // today slice from the same parse instead of scanning today again.
      todayAllDays = rangeEndStr >= todayStr
        ? aggregateProjectsIntoDays(raw).filter(d => d.date === todayStr)
        : aggregateProjectsIntoDays(fp(await parseAllSessions(todayRange, 'all'))).filter(d => d.date === todayStr)
    }
  } else {
    // Provider-filtered: today's all-provider parse feeds the union (sliced
    // below); the provider-scoped parse feeds the detail/enrichment fields.
    todayAllDays = aggregateProjectsIntoDays(fp(await parseAllSessions(todayRange, 'all'))).filter(d => d.date === todayStr)
    const rawProv = fp(await parseAllSessions(isTodayOnly ? todayRange : periodInfo.range, pf))
    liveProjects = daysSelection && !isTodayOnly ? filterProjectsByDays(rawProv, daysSelection.days) : rawProv
    scanRange = isTodayOnly ? todayRange : periodInfo.range
  }

  const allDays = unionDaysForPeriod(cache, todayAllDays, periodInfo, daysSelection?.days ?? null)
  const days = pf === 'all' ? allDays : allDays.map(d => sliceDayToProvider(d, pf))
  const data = buildPeriodDataFromDays(days, periodInfo.label)

  // Enrich the cache-authoritative headline with fields DailyEntry cannot carry.
  // These are all derivable only from surviving sessions (estimated-cost markers,
  // unpriced-model detection, per-turn workflow intelligence), so they describe
  // the live population, a subset of the carried headline.
  const scanData = buildPeriodData(periodInfo.label, liveProjects)
  data.estimatedCostUSD = scanData.estimatedCostUSD
  data.unpricedModels = scanData.unpricedModels
  data.workflow = scanData.workflow
  data.topReworkedFiles = scanData.topReworkedFiles
  data.pricingCoverage = scanData.pricingCoverage
  // Cache buckets a session on its START day, the scan on any ACTIVE day; both
  // are lower bounds of distinct sessions, so max is the tightest safe bound.
  data.sessions = Math.max(data.sessions, scanData.sessions)
  const estimatedByModel = new Map(
    scanData.models.filter(m => m.estimatedCostUSD != null).map(m => [m.name, m.estimatedCostUSD!]),
  )
  if (estimatedByModel.size > 0) {
    data.models = data.models.map(m =>
      estimatedByModel.has(m.name) ? { ...m, estimatedCostUSD: estimatedByModel.get(m.name) } : m,
    )
  }

  const carriedCostUSD = days.reduce((s, d) => s + (d.carried ? d.cost : 0), 0)
  return { data, days, carriedCostUSD, liveProjects, cache, todayAllDays, scanRange }
}

/**
 * Resolved-range aggregation shared by `status --format menubar-json` and the MCP server.
 * Pricing must already be loaded (callers run loadPricing first). When opts.optimize is
 * false, the expensive scanAndDetect pass is skipped (retryTax/routingWaste still computed).
 */
export async function buildMenubarPayloadForRange(periodInfo: PeriodInfo, opts: AggregateOpts = {}): Promise<MenubarPayload> {
  const pf = opts.provider ?? 'all'
  const daysSelection = opts.daysSelection ?? null
  const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project ?? [], opts.exclude ?? [])

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayRange: DateRange = { start: todayStart, end: now }
  const todayStr = toDateString(todayStart)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const rangeStartStr = toDateString(periodInfo.range.start)
  const rangeEndStr = toDateString(periodInfo.range.end)
  const historicalRangeEndStr = rangeEndStr < yesterdayStr ? rangeEndStr : yesterdayStr
  const isAllProviders = pf === 'all'

  let todayAllProjects: ProjectSummary[] | null = null
  let todayAllDays: ReturnType<typeof aggregateProjectsIntoDays> | null = null

  const getTodayAllProjects = async (): Promise<ProjectSummary[]> => {
    if (!todayAllProjects) {
      todayAllProjects = fp(await parseAllSessions(todayRange, 'all'))
    }
    return todayAllProjects
  }

  const getTodayAllDays = async (): Promise<ReturnType<typeof aggregateProjectsIntoDays>> => {
    if (!todayAllDays) {
      todayAllDays = aggregateProjectsIntoDays(await getTodayAllProjects())
    }
    return todayAllDays
  }

  // Assigned in every branch below (scoped-valid, or the !effectivelyScoped
  // fallthrough); the `!` tells the compiler what the flag guarantees.
  let currentData!: PeriodData
  let scanProjects!: ProjectSummary[]
  let scanRange!: DateRange
  let cache: DailyCache = emptyCache()
  /// The exact day set behind the all-provider headline (cache-backed
  /// historical days + today's live days, day-filtered). Non-null only on the
  /// unscoped all-provider path; it is the authority the projects view merges
  /// from, so carried days count even after their session files are gone.
  let cacheDaysForPeriod: DailyEntry[] | null = null
  let claudeConfigs: ClaudeConfigSelector | undefined
  const requestedClaudeConfigSourceId = opts.claudeConfigSourceId?.trim() || null
  const isClaudeConfigScoped = requestedClaudeConfigSourceId !== null

  let effectivelyScoped = false
  if (isClaudeConfigScoped) {
    // A config source scopes Claude usage only, so scan just Claude (main.ts
    // rejects a contradictory non-Claude --provider). This also avoids parsing
    // every other provider's corpus on each scoped refresh.
    const rawProjects = fp(await parseAllSessions(periodInfo.range, 'claude'))
    const fullProjects = daysSelection ? filterProjectsByDays(rawProjects, daysSelection.days) : rawProjects
    claudeConfigs = await claudeConfigSelector(fullProjects, requestedClaudeConfigSourceId)
    const selectedSourceId = claudeConfigs?.selectedId ?? null
    if (selectedSourceId) {
      effectivelyScoped = true
      scanProjects = filterProjectsByClaudeConfigSource(fullProjects, selectedSourceId)
      scanRange = periodInfo.range
      currentData = buildPeriodData(periodInfo.label, scanProjects)
    }
    // A stale/invalid id does NOT validate: fall through to the normal path so
    // an --provider all query returns real all-provider totals instead of the
    // Claude-only scan. claudeConfigs (selectedId null) is kept so the selector
    // still renders.
  }
  if (!effectivelyScoped) {
    // Every non-scoped headline — all-provider AND provider-filtered — is built
    // by the one shared durable-totals builder. It unions the carry-forward
    // cache with today's live parse (slicing to the provider when filtered), so
    // days whose session files have expired still count. The provider list and
    // daily-history sections below reuse its cache + today slice.
    const durable = await buildDurablePeriod(periodInfo, {
      provider: pf,
      project: opts.project,
      exclude: opts.exclude,
      daysSelection,
    })
    currentData = durable.data
    scanProjects = durable.liveProjects
    scanRange = durable.scanRange
    cacheDaysForPeriod = durable.days
    cache = durable.cache
    todayAllDays = durable.todayAllDays
  }
  claudeConfigs = claudeConfigs ?? await claudeConfigSelector(scanProjects, null)

  // Codex credits for the period. Reuses the models aggregation (folds reasoning
  // into output, keeps non-cached input + cached-read separate) so the figure
  // matches the official credit rates.
  const modelRows = await aggregateModels(scanProjects)
  currentData.codexCredits = modelRows.reduce(
    (sum, r) => sum + (r.provider === 'codex' && r.credits != null ? r.credits : 0),
    0,
  )

  // PROVIDERS
  // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
  // For specific: just this single provider with its scoped cost.
  const allProviders = await getAllProviders()
  const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
  const providers: ProviderCost[] = []
  if (isClaudeConfigScoped) {
    const providerTotals: Record<string, number> = {}
    for (const d of aggregateProjectsIntoDays(scanProjects)) {
      for (const [name, p] of Object.entries(d.providers)) {
        providerTotals[name] = (providerTotals[name] ?? 0) + p.cost
      }
    }
    for (const [name, cost] of Object.entries(providerTotals)) {
      providers.push({ name, displayName: displayNameByName.get(name) ?? name, cost })
    }
    if (providers.length === 0 && claudeConfigs?.selectedId) {
      providers.push({ name: 'claude', displayName: displayNameByName.get('claude') ?? 'Claude', cost: 0 })
    }
  } else if (isAllProviders) {
    const unfilteredProviderDays = [
      ...(rangeStartStr <= historicalRangeEndStr ? getDaysInRange(cache, rangeStartStr, historicalRangeEndStr) : []),
      ...(await getTodayAllDays()).filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr),
    ]
    const allDaysForProviders = daysSelection ? unfilteredProviderDays.filter(d => daysSelection.days.has(d.date)) : unfilteredProviderDays
    const providerTotals: Record<string, number> = {}
    for (const d of allDaysForProviders) {
      for (const [name, p] of Object.entries(d.providers)) {
        providerTotals[name] = (providerTotals[name] ?? 0) + p.cost
      }
    }
    for (const [name, cost] of Object.entries(providerTotals)) {
      providers.push({ name, displayName: displayNameByName.get(name) ?? name, cost })
    }
    for (const p of allProviders) {
      if (providers.some(pc => pc.name === p.name)) continue
      const sources = await safeDiscoverSessions(p)
      if (sources.length > 0) providers.push({ name: p.name, displayName: p.displayName, cost: 0 })
    }
  } else {
    providers.push({ name: pf, displayName: displayNameByName.get(pf) ?? pf, cost: currentData.cost })
  }

  // DAILY HISTORY (last 365 days)
  // Cache stores per-provider cost+calls per day in DailyEntry.providers, so we can derive
  // a provider-filtered history without re-parsing. Tokens aren't broken down per provider
  // in the cache, so the filtered view shows zero tokens (heatmap/trend still works on cost).
  const historyStartStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS))
  const allCacheDays = getDaysInRange(cache, historyStartStr, yesterdayStr)

  let dailyHistory
  if (isClaudeConfigScoped && claudeConfigs?.selectedId) {
    const historyRange: DateRange = {
      start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS),
      end: now,
    }
    const historyProjects = filterProjectsByClaudeConfigSource(
      fp(await parseAllSessions(historyRange, 'claude')),
      claudeConfigs.selectedId,
    )
    dailyHistory = dailyEntriesToHistory(aggregateProjectsIntoDays(historyProjects))
  } else if (isAllProviders) {
    const todayDays = (await getTodayAllDays()).filter(d => d.date === todayStr)
    const fullHistory = [...allCacheDays, ...todayDays]
    dailyHistory = dailyEntriesToHistory(fullHistory)
  } else {
    const emptyModels = [] as { name: string; cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number }[]
    const historyFromCache = allCacheDays.map(d => {
      const prov = d.providers[pf] ?? { calls: 0, cost: 0, savingsUSD: 0 }
      return {
        date: d.date,
        cost: prov.cost,
        savingsUSD: prov.savingsUSD,
        calls: prov.calls,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: emptyModels,
      }
    })
    const todayFromParse = aggregateProjectsIntoDays(scanProjects)
      .filter(d => d.date === todayStr)
      .map(d => {
        const prov = d.providers[pf] ?? { calls: 0, cost: 0, savingsUSD: 0 }
        return {
          date: d.date,
          cost: prov.cost,
          savingsUSD: prov.savingsUSD,
          calls: prov.calls,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topModels: emptyModels,
        }
      })
    dailyHistory = [...historyFromCache, ...todayFromParse]
  }

  const home = homedir()
  const friendlyFromPath = (path: string | undefined, fallback: string): string => {
    if (!path) return fallback
    if (path === home || path === home + '/') return 'Home'
    return path.split('/').filter(Boolean).pop() || fallback
  }
  const friendlyProject = (p: ProjectSummary) => friendlyFromPath(p.projectPath || p.project, p.project)
  const sessionDetailsOf = (p: ProjectSummary) => [...p.sessions]
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
    .slice(0, 10)
    .map(s => ({
      cost: s.totalCostUSD,
      savingsUSD: s.totalSavingsUSD,
      calls: s.apiCalls,
      inputTokens: s.totalInputTokens,
      outputTokens: s.totalOutputTokens,
      date: s.firstTimestamp?.split('T')[0] ?? '',
      models: Object.entries(s.modelBreakdown)
        .map(([name, m]) => ({ name, cost: m.costUSD, savingsUSD: m.savingsUSD }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 3),
    }))

  if (cacheDaysForPeriod !== null) {
    // Project totals come from the SAME day set as the headline, so carried
    // days count here too. The surviving-session parse contributes only what
    // day entries cannot: the per-session drill-down and a fresher project
    // path. Days recorded before the projects rollup existed have totals but
    // no project split, so this list can sum to less than the headline — an
    // honest gap, not a bug.
    type CachedProjectTotal = { cost: number; savingsUSD: number; sessions: number; path?: string }
    const cachedTotals = new Map<string, CachedProjectTotal>()
    for (const d of cacheDaysForPeriod) {
      for (const [name, p] of Object.entries(d.projects ?? {})) {
        const acc = cachedTotals.get(name) ?? { cost: 0, savingsUSD: 0, sessions: 0 }
        acc.cost += p.cost
        acc.savingsUSD += p.savingsUSD
        acc.sessions += p.sessions
        if (!acc.path && p.path) acc.path = p.path
        cachedTotals.set(name, acc)
      }
    }
    const liveByName = new Map(scanProjects.map(p => [p.project, p]))
    const names = new Set([...cachedTotals.keys(), ...liveByName.keys()])
    currentData.projects = [...names].map(name => {
      const cached = cachedTotals.get(name)
      const live = liveByName.get(name)
      return {
        name: live ? friendlyProject(live) : friendlyFromPath(cached?.path, name),
        cost: cached?.cost ?? live!.totalCostUSD,
        savingsUSD: cached?.savingsUSD ?? live!.totalSavingsUSD,
        // max for the same reason as the headline: start-day bucketing vs
        // active-day counting, both lower bounds of distinct sessions.
        sessions: Math.max(cached?.sessions ?? 0, live?.sessions.length ?? 0),
        ...(live ? { sessionDetails: sessionDetailsOf(live) } : {}),
      }
    }).sort((a, b) => b.cost - a.cost)
  } else {
    currentData.projects = scanProjects.map(p => ({
      name: friendlyProject(p),
      cost: p.totalCostUSD,
      savingsUSD: p.totalSavingsUSD,
      sessions: p.sessions.length,
      sessionDetails: sessionDetailsOf(p),
    }))
  }

  const effMap = aggregateModelEfficiency(scanProjects)
  currentData.modelEfficiency = [...effMap.entries()].map(([name, eff]) => ({
    name,
    costPerEdit: eff.costPerEditUSD,
    oneShotRate: eff.oneShotRate,
  }))

  const retryTaxByModel = [...effMap.values()]
    .filter(m => m.retries > 0 && m.editTurns > 0)
    .map(m => ({
      name: m.model,
      taxUSD: m.retries * (m.editCostUSD / m.editTurns),
      retries: m.retries,
      retriesPerEdit: m.retriesPerEdit,
    }))
    .sort((a, b) => b.taxUSD - a.taxUSD)
  const retryTax = {
    totalUSD: retryTaxByModel.reduce((s, m) => s + m.taxUSD, 0),
    retries: retryTaxByModel.reduce((s, m) => s + m.retries, 0),
    editTurns: [...effMap.values()].filter(m => m.retries > 0).reduce((s, m) => s + m.editTurns, 0),
    byModel: retryTaxByModel.slice(0, 5),
  }

  currentData.topSessions = scanProjects.flatMap(p =>
    p.sessions.map(s => ({
      project: friendlyProject(p),
      cost: s.totalCostUSD,
      savingsUSD: s.totalSavingsUSD,
      calls: s.apiCalls,
      date: s.firstTimestamp?.split('T')[0] ?? '',
    }))
  ).sort((a, b) => (b.cost + b.savingsUSD) - (a.cost + a.savingsUSD)).slice(0, 5)

  // PULL REQUESTS + BRANCHES (all-provider path only). Both are session-layer
  // aggregations over the surviving-session parse, so carried history cannot
  // contribute — expected and fine. PR links and per-turn git branches are
  // captured only from Claude transcripts today; other providers add nothing.
  // Set only when non-empty so the payload omits them (and the app renders its
  // quiet empty state) whenever there is nothing to show. Excluded on the
  // Claude-config-scoped path (which replaces scanProjects with one config's
  // sessions) so this stays the genuine unscoped all-provider aggregation.
  if (isAllProviders && !effectivelyScoped) {
    const prRows = aggregateByPr(scanProjects)
    if (prRows.length > 0) {
      const prTotals = prLinkedTotals(scanProjects)
      currentData.pullRequests = {
        rows: prRows.slice(0, TOP_PULL_REQUESTS),
        distinctCost: prTotals.cost,
        distinctSessions: prTotals.sessions,
      }
    }
    const branchRows = aggregateByBranch(scanProjects)
    if (branchRows.length > 0) currentData.byBranch = branchRows.slice(0, TOP_BRANCHES)
  }

  // Routing waste: find cheapest reliable model (≥90% 1-shot, ≥5 edits),
  // then compute how much each pricier model overpaid.
  const reliableModels = [...effMap.values()]
    .filter(m => m.oneShotRate !== null && m.oneShotRate >= 90 && m.editTurns >= 5
      && (m.costPerEditUSD ?? 0) >= 0.01)
    .sort((a, b) => (a.costPerEditUSD ?? Infinity) - (b.costPerEditUSD ?? Infinity))
  const baseline = reliableModels[0]
  const routingWasteByModel = baseline
    ? [...effMap.values()]
        .filter(m => m.model !== baseline.model && m.editTurns > 0 && (m.costPerEditUSD ?? 0) > (baseline.costPerEditUSD ?? 0))
        .map(m => {
          const counterfactual = m.editTurns * (baseline.costPerEditUSD ?? 0)
          return {
            name: m.model,
            costPerEdit: m.costPerEditUSD ?? 0,
            editTurns: m.editTurns,
            actualUSD: m.editCostUSD,
            counterfactualUSD: counterfactual,
            savingsUSD: m.editCostUSD - counterfactual,
          }
        })
        .filter(m => m.savingsUSD > 0)
        .sort((a, b) => b.savingsUSD - a.savingsUSD)
    : []
  const routingWaste = {
    totalSavingsUSD: routingWasteByModel.reduce((s, m) => s + m.savingsUSD, 0),
    baselineModel: baseline?.model ?? '',
    baselineCostPerEdit: baseline?.costPerEditUSD ?? 0,
    byModel: routingWasteByModel.slice(0, 5),
  }

  const breakdowns: BreakdownArrays = (() => {
    const toolMap: Record<string, number> = {}
    const skillMap: Record<string, { turns: number; cost: number }> = {}
    const subagentMap: Record<string, { calls: number; cost: number }> = {}
    const mcpMap: Record<string, number> = {}
    // Local-model savings rollup: avoided spend (cost forced to $0, baseline
    // recorded) grouped by model and provider. Mirrors the per-call savingsUSD
    // that applyLocalModelSavings stamps in the parser.
    const savingsByModel = new Map<string, { calls: number; actualUSD: number; savingsUSD: number; baselineModel: string; inputTokens: number; outputTokens: number }>()
    const savingsByProvider = new Map<string, { calls: number; savingsUSD: number }>()
    let totalSavings = 0
    let totalSavingsCalls = 0
    for (const p of scanProjects) for (const s of p.sessions) {
      for (const [t, d] of Object.entries(s.toolBreakdown)) { if (!t.startsWith('lang:')) toolMap[t] = (toolMap[t] ?? 0) + d.calls }
      for (const [sk, d] of Object.entries(s.skillBreakdown)) { const e = skillMap[sk] ?? { turns: 0, cost: 0 }; e.turns += d.turns; e.cost += d.costUSD; skillMap[sk] = e }
      for (const [sa, d] of Object.entries(s.subagentBreakdown)) { const e = subagentMap[sa] ?? { calls: 0, cost: 0 }; e.calls += d.calls; e.cost += d.costUSD; subagentMap[sa] = e }
      for (const [m, d] of Object.entries(s.mcpBreakdown)) { mcpMap[m] = (mcpMap[m] ?? 0) + d.calls }
      for (const turn of s.turns) for (const call of turn.assistantCalls) {
        if (!call.savingsUSD || call.savingsUSD <= 0) continue
        totalSavings += call.savingsUSD
        totalSavingsCalls += 1
        const modelKey = getShortModelName(call.model)
        const acc = savingsByModel.get(modelKey) ?? { calls: 0, actualUSD: 0, savingsUSD: 0, baselineModel: call.savingsBaselineModel ?? '', inputTokens: 0, outputTokens: 0 }
        acc.calls += 1
        acc.actualUSD += call.costUSD
        acc.savingsUSD += call.savingsUSD
        acc.baselineModel = acc.baselineModel || (call.savingsBaselineModel ?? '')
        acc.inputTokens += call.usage.inputTokens
        acc.outputTokens += call.usage.outputTokens
        savingsByModel.set(modelKey, acc)
        const provAcc = savingsByProvider.get(call.provider) ?? { calls: 0, savingsUSD: 0 }
        provAcc.calls += 1
        provAcc.savingsUSD += call.savingsUSD
        savingsByProvider.set(call.provider, provAcc)
      }
    }
    const localModelSavings = {
      totalUSD: totalSavings,
      calls: totalSavingsCalls,
      byModel: Array.from(savingsByModel.entries()).sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD).slice(0, 5).map(([name, d]) => ({ name, ...d })),
      byProvider: Array.from(savingsByProvider.entries()).sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD).slice(0, 5).map(([name, d]) => ({ name, ...d })),
    }
    return {
      tools: Object.entries(toolMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
      skills: Object.entries(skillMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
      subagents: Object.entries(subagentMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
      mcpServers: Object.entries(mcpMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
      localModelSavings,
    }
  })()

  const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
  const granularRange = opts.daysSelection?.range ?? scanRange
  const granularHistory = opts.timeline === false ? undefined : buildGranularHistory(scanProjects, granularRange)
  return buildMenubarPayload(currentData, providers, optimize, dailyHistory, retryTax, routingWaste, breakdowns, claudeConfigs, granularHistory)
}
