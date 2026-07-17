import { homedir } from 'node:os'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory, type DateRange } from './types.js'
import { type PeriodData, type ProviderCost, type BreakdownArrays, type MenubarPayload, type ClaudeConfigSelector, buildMenubarPayload } from './menubar-json.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDays, filterProjectsByClaudeConfigSource, isSessionHydrationComplete } from './parser.js'
import { findUnpricedModels, getLocalModelSavingsConfigHash, getPriceOverridesConfigHash, getShortModelName } from './models.js'
import { getAllProviders, safeDiscoverSessions } from './providers/index.js'
import { claude, getClaudeConfigDirs, getDesktopSessionsDir } from './providers/claude.js'
import { stat } from 'node:fs/promises'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from './day-aggregator.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { aggregateModels } from './models-report.js'
import { scanAndDetect } from './optimize.js'
import { getDaysInRange, ensureCacheHydrated, loadDailyCache, emptyCache, BACKFILL_DAYS, toDateString, type DailyCache } from './daily-cache.js'
import { buildGranularHistory } from './granular-history.js'

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
    unpricedModels: findUnpricedModels(Object.entries(modelTotals)
      .map(([model, d]) => ({ model, calls: d.calls, cost: d.cost, tokens: d.tokens }))),
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
  let todayProviderData: PeriodData | null = null
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
    if (isAllProviders) {
      cache = await hydrateCache()
      const isTodayOnly = rangeStartStr === todayStr && rangeEndStr === todayStr
      // Single all-provider scan for the requested window. Previously the overview
      // parsed every provider TWICE — once over todayRange and once over the full
      // period — even though the period scan already contains today's turns. Scan
      // once here and derive the "today" slice from it below: aggregateProjects-
      // IntoDays buckets by each turn's own timestamp, so a period scan's today
      // slice is identical to a dedicated today scan's. A purely historical window
      // (ends before today) never reaches today, so its separate today scan — the
      // one the always-on daily-history strip needs — is left to run.
      let rawScan: ProjectSummary[]
      if (isTodayOnly) {
        rawScan = fp(await parseAllSessions(todayRange, 'all'))
        scanProjects = rawScan
        scanRange = todayRange
      } else {
        rawScan = fp(await parseAllSessions(periodInfo.range, 'all'))
        scanProjects = daysSelection ? filterProjectsByDays(rawScan, daysSelection.days) : rawScan
        scanRange = periodInfo.range
      }
      // Seed the today memo from the un-daysSelection rawScan so the always-on
      // daily-history strip still shows today even when the heatmap day filter
      // excludes it (matching the old dedicated today scan, which ignored it).
      if (rangeEndStr >= todayStr) {
        todayAllDays = aggregateProjectsIntoDays(rawScan).filter(d => d.date === todayStr)
      }
      const todayDays = await getTodayAllDays()
      const historicalDays = rangeStartStr <= historicalRangeEndStr
        ? getDaysInRange(cache, rangeStartStr, historicalRangeEndStr)
        : []
      const todayInRange = todayDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
      const unfilteredDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
      const allDays = daysSelection ? unfilteredDays.filter(d => daysSelection.days.has(d.date)) : unfilteredDays
      currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
    } else {
      cache = await loadDailyCache()
      const rawProviderProjects = fp(await parseAllSessions(periodInfo.range, pf))
      const fullProjects = daysSelection ? filterProjectsByDays(rawProviderProjects, daysSelection.days) : rawProviderProjects
      todayProviderData = buildPeriodData(periodInfo.label, fullProjects)
      currentData = todayProviderData
      scanProjects = fullProjects
      scanRange = periodInfo.range
    }
  }
  if (isAllProviders) {
    // Load-bearing overwrite: the daily-cache path above never carries
    // estimatedCostUSD (DailyEntry has no such field), so this fresh-parse
    // rebuild is what keeps the estimated marker alive on cached periods.
    // Removing it as redundant silently drops the flag.
    currentData = buildPeriodData(periodInfo.label, scanProjects)
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
  const friendlyProject = (p: ProjectSummary) => {
    const resolved = p.projectPath || p.project
    if (resolved === home || resolved === home + '/') return 'Home'
    return resolved.split('/').filter(Boolean).pop() || p.project
  }

  currentData.projects = scanProjects.map(p => ({
    name: friendlyProject(p),
    cost: p.totalCostUSD,
    savingsUSD: p.totalSavingsUSD,
    sessions: p.sessions.length,
    sessionDetails: [...p.sessions]
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
      })),
  }))

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
