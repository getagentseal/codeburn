import { Command } from 'commander'
import { installMenubarApp } from './menubar-installer.js'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing } from './models.js'
import { parseAllSessions, filterProjectsByName } from './parser.js'
import { convertCost } from './currency.js'
import { renderStatusBar } from './format.js'
import { type PeriodData, type ProviderCost } from './menubar-json.js'
import { buildMenubarPayload } from './menubar-json.js'
import { addNewDays, getDaysInRange, loadDailyCache, saveDailyCache, withDailyCacheLock } from './daily-cache.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays, dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { renderDashboard } from './dashboard.js'
import { parseDateRangeFlags } from './cli-date.js'
import { runOptimize, scanAndDetect } from './optimize.js'
import { renderCompare } from './compare.js'
import { getAllProviders } from './providers/index.js'
import { clearPlan, readConfig, readPlan, saveConfig, savePlan, getConfigFilePath } from './config.js'
import { clampResetDay, getPlanUsageOrNull, type PlanUsage } from './plan-usage.js'
import { getPresetPlan, isPlanId, isPlanProvider, planDisplayName } from './plans.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const BACKFILL_DAYS = 365

function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function getDateRange(period: string): { range: DateRange; label: string } {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

  switch (period) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return { range: { start, end }, label: `Today (${toDateString(start)})` }
    }
    case 'yesterday': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999)
      return { range: { start, end: yesterdayEnd }, label: `Yesterday (${toDateString(start)})` }
    }
    case 'week': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
      return { range: { start, end }, label: 'Last 7 Days' }
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { range: { start, end }, label: `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}` }
    }
    case '30days': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
      return { range: { start, end }, label: 'Last 30 Days' }
    }
    case 'all': {
      // Cap "All Time" to the last 6 months. Older data is rarely actionable for a cost
      // tracker and keeps the parse path bounded so providers like Codex/Cursor with sparse
      // data still load in seconds.
      const start = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())
      return { range: { start, end }, label: 'Last 6 months' }
    }
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
      return { range: { start, end }, label: 'Last 7 Days' }
    }
  }
}

type Period = 'today' | 'week' | '30days' | 'month' | 'all'

function toPeriod(s: string): Period {
  if (s === 'today') return 'today'
  if (s === 'month') return 'month'
  if (s === '30days') return '30days'
  if (s === 'all') return 'all'
  return 'week'
}

function collect(val: string, acc: string[]): string[] {
  acc.push(val)
  return acc
}

function parseNumber(value: string): number {
  return Number(value)
}

function parseInteger(value: string): number {
  return parseInt(value, 10)
}

type JsonPlanSummary = {
  id: 'claude-pro' | 'claude-max' | 'cursor-pro' | 'custom'
  budget: number
  spent: number
  percentUsed: number
  status: 'under' | 'near' | 'over'
  projectedMonthEnd: number
  daysUntilReset: number
  periodStart: string
  periodEnd: string
}

function toJsonPlanSummary(planUsage: PlanUsage): JsonPlanSummary {
  return {
    id: planUsage.plan.id,
    budget: convertCost(planUsage.budgetUsd),
    spent: convertCost(planUsage.spentApiEquivalentUsd),
    percentUsed: Math.round(planUsage.percentUsed * 10) / 10,
    status: planUsage.status,
    projectedMonthEnd: convertCost(planUsage.projectedMonthUsd),
    daysUntilReset: planUsage.daysUntilReset,
    periodStart: planUsage.periodStart.toISOString(),
    periodEnd: planUsage.periodEnd.toISOString(),
  }
}

async function runJsonReport(period: Period, provider: string, project: string[], exclude: string[]): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const projects = filterProjectsByName(await parseAllSessions(range, provider), project, exclude)
  const report: ReturnType<typeof buildJsonReport> & { plan?: JsonPlanSummary } = buildJsonReport(projects, label, period)
  const planUsage = await getPlanUsageOrNull()
  if (planUsage) {
    report.plan = toJsonPlanSummary(planUsage)
  }
  console.log(JSON.stringify(report, null, 2))
}

const program = new Command()
  .name('codeburn')
  .description('See where your AI coding tokens go - by task, tool, model, and project')
  .version(version)
  .option('--verbose', 'print warnings to stderr on read failures and skipped files')

program.hook('preAction', async (thisCommand) => {
  if (thisCommand.opts<{ verbose?: boolean }>().verbose) {
    process.env['CODEBURN_VERBOSE'] = '1'
  }
  await loadCurrency()
})

function buildJsonReport(projects: ProjectSummary[], period: string, periodKey: string) {
  const sessions = projects.flatMap(p => p.sessions)
  const { code } = getCurrency()

  const totalCostUSD = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const totalInput = sessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = sessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = sessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = sessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  // Match src/menubar-json.ts:cacheHitPercent: reads over reads+fresh-input. cache_write
  // counts tokens being stored, not served, so it doesn't belong in the denominator.
  const cacheHitDenom = totalInput + totalCacheRead
  const cacheHitPercent = cacheHitDenom > 0 ? Math.round((totalCacheRead / cacheHitDenom) * 1000) / 10 : 0

  const dailyMap: Record<string, { cost: number; calls: number }> = {}
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      if (!turn.timestamp) { continue }
      const day = dateKey(turn.timestamp)
      if (!dailyMap[day]) { dailyMap[day] = { cost: 0, calls: 0 } }
      for (const call of turn.assistantCalls) {
        dailyMap[day].cost += call.costUSD
        dailyMap[day].calls += 1
      }
    }
  }
  const daily = Object.entries(dailyMap).sort().map(([date, d]) => ({
    date,
    cost: convertCost(d.cost),
    calls: d.calls,
  }))

  const projectList = projects.map(p => ({
    name: p.project,
    path: p.projectPath,
    cost: convertCost(p.totalCostUSD),
    avgCostPerSession: p.sessions.length > 0
      ? convertCost(p.totalCostUSD / p.sessions.length)
      : null,
    calls: p.totalApiCalls,
    sessions: p.sessions.length,
  }))

  const modelMap: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> = {}
  for (const sess of sessions) {
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelMap[model]) { modelMap[model] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      modelMap[model].calls += d.calls
      modelMap[model].cost += d.costUSD
      modelMap[model].inputTokens += d.tokens.inputTokens
      modelMap[model].outputTokens += d.tokens.outputTokens
      modelMap[model].cacheReadTokens += d.tokens.cacheReadInputTokens
      modelMap[model].cacheWriteTokens += d.tokens.cacheCreationInputTokens
    }
  }
  const models = Object.entries(modelMap)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, { cost, ...rest }]) => ({ name, ...rest, cost: convertCost(cost) }))

  const catMap: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = {}
  for (const sess of sessions) {
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catMap[cat]) { catMap[cat] = { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 } }
      catMap[cat].turns += d.turns
      catMap[cat].cost += d.costUSD
      catMap[cat].editTurns += d.editTurns
      catMap[cat].oneShotTurns += d.oneShotTurns
    }
  }
  const activities = Object.entries(catMap)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      category: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      cost: convertCost(d.cost),
      turns: d.turns,
      editTurns: d.editTurns,
      oneShotTurns: d.oneShotTurns,
      oneShotRate: d.editTurns > 0 ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10 : null,
    }))

  const toolMap: Record<string, number> = {}
  const mcpMap: Record<string, number> = {}
  const bashMap: Record<string, number> = {}
  for (const sess of sessions) {
    for (const [tool, d] of Object.entries(sess.toolBreakdown)) {
      toolMap[tool] = (toolMap[tool] ?? 0) + d.calls
    }
    for (const [server, d] of Object.entries(sess.mcpBreakdown)) {
      mcpMap[server] = (mcpMap[server] ?? 0) + d.calls
    }
    for (const [cmd, d] of Object.entries(sess.bashBreakdown)) {
      bashMap[cmd] = (bashMap[cmd] ?? 0) + d.calls
    }
  }

  const sortedMap = (m: Record<string, number>) =>
    Object.entries(m).sort(([, a], [, b]) => b - a).map(([name, calls]) => ({ name, calls }))

  const topSessions = projects
    .flatMap(p => p.sessions.map(s => ({ project: p.project, sessionId: s.sessionId, date: s.firstTimestamp ? dateKey(s.firstTimestamp) : null, cost: convertCost(s.totalCostUSD), calls: s.apiCalls })))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)

  return {
    generated: new Date().toISOString(),
    currency: code,
    period,
    periodKey,
    overview: {
      cost: convertCost(totalCostUSD),
      calls: totalCalls,
      sessions: totalSessions,
      cacheHitPercent,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
      },
    },
    daily,
    projects: projectList,
    models,
    activities,
    tools: sortedMap(toolMap),
    mcpServers: sortedMap(mcpMap),
    shellCommands: sortedMap(bashMap),
    topSessions,
  }
}

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard')
  .option('-p, --period <period>', 'Starting period: today, week, 30days, month, all', 'week')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInt, 30)
  .action(async (opts) => {
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    const period = toPeriod(opts.period)
    if (opts.format === 'json') {
      await loadPricing()
      if (customRange) {
        const label = `${opts.from ?? 'all'} to ${opts.to ?? 'today'}`
        const projects = filterProjectsByName(
          await parseAllSessions(customRange, opts.provider),
          opts.project,
          opts.exclude,
        )
        console.log(JSON.stringify(buildJsonReport(projects, label, 'custom'), null, 2))
      } else {
        await runJsonReport(period, opts.provider, opts.project, opts.exclude)
      }
      return
    }
    await renderDashboard(period, opts.provider, opts.refresh, opts.project, opts.exclude, customRange)
  })

function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  const sessions = projects.flatMap(p => p.sessions)
  const catTotals: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number }> = {}
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0

  for (const sess of sessions) {
    inputTokens += sess.totalInputTokens
    outputTokens += sess.totalOutputTokens
    cacheReadTokens += sess.totalCacheReadTokens
    cacheWriteTokens += sess.totalCacheWriteTokens
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 }
      catTotals[cat].turns += d.turns
      catTotals[cat].cost += d.costUSD
      catTotals[cat].editTurns += d.editTurns
      catTotals[cat].oneShotTurns += d.oneShotTurns
    }
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0 }
      modelTotals[model].calls += d.calls
      modelTotals[model].cost += d.costUSD
    }
  }

  return {
    label,
    cost: projects.reduce((s, p) => s + p.totalCostUSD, 0),
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    sessions: projects.reduce((s, p) => s + p.sessions.length, 0),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}

program
  .command('status')
  .description('Compact status output (today + week + month)')
  .option('--format <format>', 'Output format: terminal, menubar-json, json', 'terminal')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--period <period>', 'Primary period for menubar-json: today, week, 30days, month, all', 'today')
  .option('--no-optimize', 'Skip optimize findings (menubar-json only, faster)')
  .action(async (opts) => {
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
    if (opts.format === 'menubar-json') {
      const periodInfo = getDateRange(opts.period)
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const yesterdayEnd = new Date(todayStart.getTime() - 1)
      const yesterdayStr = toDateString(new Date(todayStart.getTime() - MS_PER_DAY))
      const isAllProviders = pf === 'all'

      // The daily cache is provider-agnostic: always backfill it from .all so subsequent
      // provider-filtered reads can derive per-provider cost+calls from DailyEntry.providers.
      // Yesterday is always recomputed: it may have been cached mid-day with partial data.
      const cache = await withDailyCacheLock(async () => {
        let c = await loadDailyCache()

        // Evict yesterday (and any stale future entries) so the gap fill recomputes them.
        const hadYesterday = c.days.some(d => d.date >= yesterdayStr)
        if (hadYesterday) {
          const freshDays = c.days.filter(d => d.date < yesterdayStr)
          const latestFresh = freshDays.length > 0 ? freshDays[freshDays.length - 1].date : null
          c = { ...c, days: freshDays, lastComputedDate: latestFresh }
        }

        const gapStart = c.lastComputedDate
          ? new Date(
              parseInt(c.lastComputedDate.slice(0, 4)),
              parseInt(c.lastComputedDate.slice(5, 7)) - 1,
              parseInt(c.lastComputedDate.slice(8, 10)) + 1
            )
          : new Date(todayStart.getTime() - BACKFILL_DAYS * MS_PER_DAY)

        if (gapStart.getTime() <= yesterdayEnd.getTime()) {
          const gapRange: DateRange = { start: gapStart, end: yesterdayEnd }
          const gapProjects = filterProjectsByName(await parseAllSessions(gapRange, 'all'), opts.project, opts.exclude)
          const gapDays = aggregateProjectsIntoDays(gapProjects)
          c = addNewDays(c, gapDays, yesterdayStr)
          await saveDailyCache(c)
        }
        return c
      })

      // CURRENT PERIOD DATA
      // - .all provider: assemble from cache + today (fast)
      // - specific provider: parse the period range with provider filter (correct, but slower)
      let currentData: PeriodData
      let scanProjects: ProjectSummary[]
      let scanRange: DateRange

      if (isAllProviders) {
        const todayRange: DateRange = { start: todayStart, end: now }
        const todayProjects = fp(await parseAllSessions(todayRange, 'all'))
        const todayDays = aggregateProjectsIntoDays(todayProjects)
        const rangeStartStr = toDateString(periodInfo.range.start)
        const rangeEndStr = toDateString(periodInfo.range.end)
        const historicalDays = getDaysInRange(cache, rangeStartStr, yesterdayStr)
        const todayInRange = todayDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
        const allDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
        currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
        scanProjects = todayProjects
        scanRange = todayRange
      } else {
        const projects = fp(await parseAllSessions(periodInfo.range, pf))
        currentData = buildPeriodData(periodInfo.label, projects)
        scanProjects = projects
        scanRange = periodInfo.range
      }

      // PROVIDERS
      // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
      // For specific: just this single provider with its scoped cost.
      const allProviders = await getAllProviders()
      const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
      const providers: ProviderCost[] = []
      if (isAllProviders) {
        const todayRangeForProviders: DateRange = { start: todayStart, end: now }
        const todayDaysForProviders = aggregateProjectsIntoDays(fp(await parseAllSessions(todayRangeForProviders, 'all')))
        const rangeStartStr = toDateString(periodInfo.range.start)
        const allDaysForProviders = [
          ...getDaysInRange(cache, rangeStartStr, yesterdayStr),
          ...todayDaysForProviders.filter(d => d.date >= rangeStartStr),
        ]
        const providerTotals: Record<string, number> = {}
        for (const d of allDaysForProviders) {
          for (const [name, p] of Object.entries(d.providers)) {
            providerTotals[name] = (providerTotals[name] ?? 0) + p.cost
          }
        }
        for (const [name, cost] of Object.entries(providerTotals)) {
          providers.push({ name: displayNameByName.get(name) ?? name, cost })
        }
        for (const p of allProviders) {
          if (providers.some(pc => pc.name === p.displayName)) continue
          const sources = await p.discoverSessions()
          if (sources.length > 0) providers.push({ name: p.displayName, cost: 0 })
        }
      } else {
        const display = displayNameByName.get(pf) ?? pf
        providers.push({ name: display, cost: currentData.cost })
      }

      // DAILY HISTORY (last 365 days)
      // Cache stores per-provider cost+calls per day in DailyEntry.providers, so we can derive
      // a provider-filtered history without re-parsing. Tokens aren't broken down per provider
      // in the cache, so the filtered view shows zero tokens (heatmap/trend still works on cost).
      const historyStartStr = toDateString(new Date(todayStart.getTime() - BACKFILL_DAYS * MS_PER_DAY))
      const allCacheDays = getDaysInRange(cache, historyStartStr, yesterdayStr)
      const allTodayDaysForHistory = aggregateProjectsIntoDays(fp(await parseAllSessions({ start: todayStart, end: now }, 'all')))
      const fullHistory = [...allCacheDays, ...allTodayDaysForHistory]
      const dailyHistory = fullHistory.map(d => {
        if (isAllProviders) {
          const topModels = Object.entries(d.models)
            .filter(([name]) => name !== '<synthetic>')
            .sort(([, a], [, b]) => b.cost - a.cost)
            .slice(0, 5)
            .map(([name, m]) => ({
              name,
              cost: m.cost,
              calls: m.calls,
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
            }))
          return {
            date: d.date,
            cost: d.cost,
            calls: d.calls,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            cacheReadTokens: d.cacheReadTokens,
            cacheWriteTokens: d.cacheWriteTokens,
            topModels,
          }
        }
        const prov = d.providers[pf] ?? { calls: 0, cost: 0 }
        return {
          date: d.date,
          cost: prov.cost,
          calls: prov.calls,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topModels: [],
        }
      })

      const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
      console.log(JSON.stringify(buildMenubarPayload(currentData, providers, optimize, dailyHistory)))
      return
    }

    if (opts.format === 'json') {
      const todayData = buildPeriodData('today', fp(await parseAllSessions(getDateRange('today').range, pf)))
      const monthData = buildPeriodData('month', fp(await parseAllSessions(getDateRange('month').range, pf)))
      const { code, rate } = getCurrency()
      const payload: {
        currency: string
        today: { cost: number; calls: number }
        month: { cost: number; calls: number }
        plan?: JsonPlanSummary
      } = {
        currency: code,
        today: { cost: Math.round(todayData.cost * rate * 100) / 100, calls: todayData.calls },
        month: { cost: Math.round(monthData.cost * rate * 100) / 100, calls: monthData.calls },
      }
      const planUsage = await getPlanUsageOrNull()
      if (planUsage) {
        payload.plan = toJsonPlanSummary(planUsage)
      }
      console.log(JSON.stringify(payload))
      return
    }

    const monthProjects = fp(await parseAllSessions(getDateRange('month').range, pf))
    console.log(renderStatusBar(monthProjects))
  })

program
  .command('today')
  .description('Today\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInt, 30)
  .action(async (opts) => {
    if (opts.format === 'json') {
      await runJsonReport('today', opts.provider, opts.project, opts.exclude)
      return
    }
    await renderDashboard('today', opts.provider, opts.refresh, opts.project, opts.exclude)
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInt, 30)
  .action(async (opts) => {
    if (opts.format === 'json') {
      await runJsonReport('month', opts.provider, opts.project, opts.exclude)
      return
    }
    await renderDashboard('month', opts.provider, opts.refresh, opts.project, opts.exclude)
  })

program
  .command('export')
  .description('Export usage data to CSV or JSON (includes 1 day, 7 days, 30 days)')
  .option('-f, --format <format>', 'Export format: csv, json', 'csv')
  .option('-o, --output <path>', 'Output file path')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .action(async (opts) => {
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
    const periods: PeriodExport[] = [
      { label: 'Today', projects: fp(await parseAllSessions(getDateRange('today').range, pf)) },
      { label: '7 Days', projects: fp(await parseAllSessions(getDateRange('week').range, pf)) },
      { label: '30 Days', projects: fp(await parseAllSessions(getDateRange('30days').range, pf)) },
    ]

    if (periods.every(p => p.projects.length === 0)) {
      console.log('\n  No usage data found.\n')
      return
    }

    const defaultName = `codeburn-${toDateString(new Date())}`
    const outputPath = opts.output ?? `${defaultName}.${opts.format}`

    let savedPath: string
    try {
      if (opts.format === 'json') {
        savedPath = await exportJson(periods, outputPath)
      } else {
        savedPath = await exportCsv(periods, outputPath)
      }
    } catch (err) {
      // Protection guards in export.ts (symlink refusal, non-codeburn folder refusal, etc.)
      // throw with a user-readable message. Print just the message, not the stack, so the CLI
      // doesn't spray its internals at the user.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Export failed: ${message}\n`)
      process.exit(1)
    }

    console.log(`\n  Exported (Today + 7 Days + 30 Days) to: ${savedPath}\n`)
  })

program
  .command('menubar')
  .description('Install and launch the macOS menubar app (one command, no clone)')
  .option('--force', 'Reinstall even if an older copy is already in ~/Applications')
  .action(async (opts: { force?: boolean }) => {
    try {
      const result = await installMenubarApp({ force: opts.force })
      console.log(`\n  Ready. ${result.installedPath}\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Menubar install failed: ${message}\n`)
      process.exit(1)
    }
  })

program
  .command('currency [code]')
  .description('Set display currency (e.g. codeburn currency GBP)')
  .option('--symbol <symbol>', 'Override the currency symbol')
  .option('--reset', 'Reset to USD (removes currency config)')
  .action(async (code?: string, opts?: { symbol?: string; reset?: boolean }) => {
    if (opts?.reset) {
      const config = await readConfig()
      delete config.currency
      await saveConfig(config)
      console.log('\n  Currency reset to USD.\n')
      return
    }

    if (!code) {
      const { code: activeCode, rate, symbol } = getCurrency()
      if (activeCode === 'USD' && rate === 1) {
        console.log('\n  Currency: USD (default)')
        console.log(`  Config: ${getConfigFilePath()}\n`)
      } else {
        console.log(`\n  Currency: ${activeCode}`)
        console.log(`  Symbol: ${symbol}`)
        console.log(`  Rate: 1 USD = ${rate} ${activeCode}`)
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    const upperCode = code.toUpperCase()
    if (!isValidCurrencyCode(upperCode)) {
      console.error(`\n  "${code}" is not a valid ISO 4217 currency code.\n`)
      process.exitCode = 1
      return
    }

    const config = await readConfig()
    config.currency = {
      code: upperCode,
      ...(opts?.symbol ? { symbol: opts.symbol } : {}),
    }
    await saveConfig(config)

    await loadCurrency()
    const { rate, symbol } = getCurrency()

    console.log(`\n  Currency set to ${upperCode}.`)
    console.log(`  Symbol: ${symbol}`)
    console.log(`  Rate: 1 USD = ${rate} ${upperCode}`)
    console.log(`  Config saved to ${getConfigFilePath()}\n`)
  })

program
  .command('plan [action] [id]')
  .description('Show or configure a subscription plan for overage tracking')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--monthly-usd <n>', 'Monthly plan price in USD (for custom)', parseNumber)
  .option('--provider <name>', 'Provider scope: all, claude, codex, cursor', 'all')
  .option('--reset-day <n>', 'Day of month plan resets (1-28)', parseInteger, 1)
  .action(async (action?: string, id?: string, opts?: { format?: string; monthlyUsd?: number; provider?: string; resetDay?: number }) => {
    const mode = action ?? 'show'

    if (mode === 'show') {
      const plan = await readPlan()
      const displayPlan = !plan || plan.id === 'none'
        ? { id: 'none', monthlyUsd: 0, provider: 'all', resetDay: 1, setAt: null }
        : {
            id: plan.id,
            monthlyUsd: plan.monthlyUsd,
            provider: plan.provider,
            resetDay: clampResetDay(plan.resetDay),
            setAt: plan.setAt,
          }
      if (opts?.format === 'json') {
        console.log(JSON.stringify(displayPlan))
        return
      }
      if (!plan || plan.id === 'none') {
        console.log('\n  Plan: none')
        console.log('  API-pricing view is active.')
        console.log(`  Config: ${getConfigFilePath()}\n`)
        return
      }
      console.log(`\n  Plan: ${planDisplayName(plan.id)} (${plan.id})`)
      console.log(`  Budget: $${plan.monthlyUsd}/month`)
      console.log(`  Provider: ${plan.provider}`)
      console.log(`  Reset day: ${clampResetDay(plan.resetDay)}`)
      console.log(`  Set at: ${plan.setAt}`)
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (mode === 'reset') {
      await clearPlan()
      console.log('\n  Plan reset. API-pricing view is active.\n')
      return
    }

    if (mode !== 'set') {
      console.error('\n  Usage: codeburn plan [set <id> | reset]\n')
      process.exitCode = 1
      return
    }

    if (!id || !isPlanId(id)) {
      console.error(`\n  Plan id must be one of: claude-pro, claude-max, cursor-pro, custom, none; got "${id ?? ''}".\n`)
      process.exitCode = 1
      return
    }

    const resetDay = opts?.resetDay ?? 1
    if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) {
      console.error(`\n  --reset-day must be an integer from 1 to 28; got ${resetDay}.\n`)
      process.exitCode = 1
      return
    }

    if (id === 'none') {
      await clearPlan()
      console.log('\n  Plan reset. API-pricing view is active.\n')
      return
    }

    if (id === 'custom') {
      if (opts?.monthlyUsd === undefined) {
        console.error('\n  Custom plans require --monthly-usd <positive number>.\n')
        process.exitCode = 1
        return
      }
      const monthlyUsd = opts.monthlyUsd
      if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
        console.error(`\n  --monthly-usd must be a positive number; got ${opts.monthlyUsd}.\n`)
        process.exitCode = 1
        return
      }
      const provider = opts?.provider ?? 'all'
      if (!isPlanProvider(provider)) {
        console.error(`\n  --provider must be one of: all, claude, codex, cursor; got "${provider}".\n`)
        process.exitCode = 1
        return
      }
      await savePlan({
        id: 'custom',
        monthlyUsd,
        provider,
        resetDay,
        setAt: new Date().toISOString(),
      })
      console.log(`\n  Plan set to custom ($${monthlyUsd}/month, ${provider}, reset day ${resetDay}).`)
      console.log(`  Config saved to ${getConfigFilePath()}\n`)
      return
    }

    const preset = getPresetPlan(id)
    if (!preset) {
      console.error(`\n  Unknown preset "${id}".\n`)
      process.exitCode = 1
      return
    }

    await savePlan({
      ...preset,
      resetDay,
      setAt: new Date().toISOString(),
    })
    console.log(`\n  Plan set to ${planDisplayName(preset.id)} ($${preset.monthlyUsd}/month).`)
    console.log(`  Provider: ${preset.provider}`)
    console.log(`  Reset day: ${resetDay}`)
    console.log(`  Config saved to ${getConfigFilePath()}\n`)
  })

program
  .command('optimize')
  .description('Find token waste and get exact fixes')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', '30days')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range, opts.provider)
    await runOptimize(projects, label, range)
  })

program
  .command('compare')
  .description('Compare two AI models side-by-side')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'all')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range } = getDateRange(opts.period)
    await renderCompare(range, opts.provider)
  })

program.parse()
