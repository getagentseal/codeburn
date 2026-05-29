import { homedir } from 'node:os'
import { Command } from 'commander'
import { installMenubarApp } from './menubar-installer.js'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing, setModelAliases } from './models.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDateRange, filterProjectsByDays, clearSessionCache } from './parser.js'
import { convertCost } from './currency.js'
import { renderStatusBar } from './format.js'
import { type PeriodData, type ProviderCost, type BreakdownArrays } from './menubar-json.js'
import { buildMenubarPayload } from './menubar-json.js'
import { getDaysInRange, ensureCacheHydrated, loadDailyCache, emptyCache, BACKFILL_DAYS, toDateString, type DailyCache } from './daily-cache.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays, dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { renderDashboard } from './dashboard.js'
import { formatDateRangeLabel, parseDateRangeFlags, parseDayFlag, parseDaysFlag, getDateRange, toPeriod, type Period } from './cli-date.js'
import { runOptimize, scanAndDetect } from './optimize.js'
import { renderCompare } from './compare.js'
import { getAllProviders } from './providers/index.js'
import {
  installAntigravityStatusLineHook,
  runAgyStatusLineHook,
  uninstallAntigravityStatusLineHook,
} from './antigravity-statusline.js'
import { collectStorageEntries, formatStorageTable, isStorageProvider, storageProviderNames } from './storage-debug.js'
import { clearPlan, readConfig, readPlan, readPlans, saveConfig, savePlan, getConfigFilePath, type Plan, type PlanId, type PlanProvider } from './config.js'
import { clampResetDay, getPlanUsageOrNull, getPlanUsages, type PlanUsage } from './plan-usage.js'
import { getPresetPlan, isPlanId, isPlanProvider, PLAN_IDS, PLAN_PROVIDERS, planDisplayName } from './plans.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

async function hydrateCache() {
  try {
    return await ensureCacheHydrated(
      (range) => parseAllSessions(range, 'all'),
      aggregateProjectsIntoDays,
    )
  } catch {
    return emptyCache()
  }
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
  id: PlanId
  provider: PlanProvider
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
    provider: planUsage.plan.provider,
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

type JsonPlanSummaryMap = Partial<Record<PlanProvider, JsonPlanSummary>>

function toJsonPlanSummaryMap(planUsages: PlanUsage[]): JsonPlanSummaryMap {
  const summaries: JsonPlanSummaryMap = {}
  for (const usage of planUsages) {
    summaries[usage.plan.provider] = toJsonPlanSummary(usage)
  }
  return summaries
}

async function attachPlanSummaries<T extends object>(payload: T): Promise<T & { plan?: JsonPlanSummary; plans?: JsonPlanSummaryMap }> {
  const planUsages = await getPlanUsages()
  if (planUsages.length > 0) {
    return {
      ...payload,
      plan: toJsonPlanSummary(planUsages[0]!),
      plans: toJsonPlanSummaryMap(planUsages),
    }
  }
  return payload
}

function planLabel(plan: Plan): string {
  const name = planDisplayName(plan.id)
  return plan.id === 'custom' ? `${name} (${plan.provider})` : name
}

function toPlanDisplay(plan: Plan) {
  return {
    id: plan.id,
    monthlyUsd: plan.monthlyUsd,
    provider: plan.provider,
    resetDay: clampResetDay(plan.resetDay),
    setAt: plan.setAt || null,
  }
}

function sortedPlans(plans: Partial<Record<PlanProvider, Plan>>): Plan[] {
  return PLAN_PROVIDERS
    .map(provider => plans[provider])
    .filter((plan): plan is Plan => plan !== undefined)
}

function assertFormat(value: string, allowed: readonly string[], command: string): void {
  if (!allowed.includes(value)) {
    process.stderr.write(
      `codeburn ${command}: unknown format "${value}". Valid values: ${allowed.join(', ')}.\n`
    )
    process.exit(1)
  }
}

async function runJsonReport(period: Period, provider: string, project: string[], exclude: string[]): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const projects = filterProjectsByName(await parseAllSessions(range, provider), project, exclude)
  const report: ReturnType<typeof buildJsonReport> & { plan?: JsonPlanSummary; plans?: JsonPlanSummaryMap } = await attachPlanSummaries(buildJsonReport(projects, label, period))
  console.log(JSON.stringify(report, null, 2))
}

const program = new Command()
  .name('codeburn')
  .description('See where your AI coding tokens go - by task, tool, model, and project')
  .version(version)
  .option('--verbose', 'print warnings to stderr on read failures and skipped files')
  .option('--timezone <zone>', 'IANA timezone for date grouping (e.g. Asia/Tokyo, America/New_York)')

program.hook('preAction', async (thisCommand) => {
  const tz = thisCommand.opts<{ timezone?: string }>().timezone ?? process.env['CODEBURN_TZ']
  if (tz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz })
    } catch {
      console.error(`\n  Invalid timezone: "${tz}". Use an IANA timezone like "America/New_York" or "Asia/Tokyo".\n`)
      process.exit(1)
    }
    process.env.TZ = tz
  }
  const config = await readConfig()
  setModelAliases(config.modelAliases ?? {})
  if (thisCommand.opts<{ verbose?: boolean }>().verbose) {
    process.env['CODEBURN_VERBOSE'] = '1'
  }
  await loadCurrency()
})

function buildJsonReport(projects: ProjectSummary[], period: string, periodKey: string) {
  const { code } = getCurrency()

  // Single-pass aggregation over all sessions
  let totalCostUSD = 0
  let totalCalls = 0
  let totalSessions = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0

  const dailyMap: Record<string, { cost: number; calls: number; turns: number; editTurns: number; oneShotTurns: number }> = {}
  const modelMap: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> = {}
  const catMap: Record<string, { turns: number; cost: number; editTurns: number; oneShotTurns: number }> = {}
  const toolMap: Record<string, number> = {}
  const mcpMap: Record<string, number> = {}
  const bashMap: Record<string, number> = {}
  const skillMap: Record<string, { turns: number; cost: number }> = {}
  const subagentMap: Record<string, { calls: number; cost: number }> = {}

  for (const p of projects) {
    totalCostUSD += p.totalCostUSD
    totalCalls += p.totalApiCalls
    totalSessions += p.sessions.length

    for (const sess of p.sessions) {
      totalInput += sess.totalInputTokens
      totalOutput += sess.totalOutputTokens
      totalCacheRead += sess.totalCacheReadTokens
      totalCacheWrite += sess.totalCacheWriteTokens

      for (const [model, d] of Object.entries(sess.modelBreakdown)) {
        if (!modelMap[model]) { modelMap[model] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        modelMap[model].calls += d.calls
        modelMap[model].cost += d.costUSD
        modelMap[model].inputTokens += d.tokens.inputTokens
        modelMap[model].outputTokens += d.tokens.outputTokens
        modelMap[model].cacheReadTokens += d.tokens.cacheReadInputTokens
        modelMap[model].cacheWriteTokens += d.tokens.cacheCreationInputTokens
      }
      for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
        if (!catMap[cat]) { catMap[cat] = { turns: 0, cost: 0, editTurns: 0, oneShotTurns: 0 } }
        catMap[cat].turns += d.turns
        catMap[cat].cost += d.costUSD
        catMap[cat].editTurns += d.editTurns
        catMap[cat].oneShotTurns += d.oneShotTurns
      }
      for (const [tool, d] of Object.entries(sess.toolBreakdown)) {
        toolMap[tool] = (toolMap[tool] ?? 0) + d.calls
      }
      for (const [server, d] of Object.entries(sess.mcpBreakdown)) {
        mcpMap[server] = (mcpMap[server] ?? 0) + d.calls
      }
      for (const [cmd, d] of Object.entries(sess.bashBreakdown)) {
        bashMap[cmd] = (bashMap[cmd] ?? 0) + d.calls
      }
      for (const [skill, d] of Object.entries(sess.skillBreakdown)) {
        if (!skillMap[skill]) skillMap[skill] = { turns: 0, cost: 0 }
        skillMap[skill].turns += d.turns
        skillMap[skill].cost += d.costUSD
      }
      for (const [sat, d] of Object.entries(sess.subagentBreakdown)) {
        if (!subagentMap[sat]) subagentMap[sat] = { calls: 0, cost: 0 }
        subagentMap[sat].calls += d.calls
        subagentMap[sat].cost += d.costUSD
      }

      for (const turn of sess.turns) {
        const ts = turn.timestamp || turn.assistantCalls[0]?.timestamp
        if (!ts) { continue }
        const day = dateKey(ts)
        if (!dailyMap[day]) { dailyMap[day] = { cost: 0, calls: 0, turns: 0, editTurns: 0, oneShotTurns: 0 } }
        dailyMap[day].turns += 1
        if (turn.hasEdits) {
          dailyMap[day].editTurns += 1
          if (turn.retries === 0) dailyMap[day].oneShotTurns += 1
        }
        for (const call of turn.assistantCalls) {
          dailyMap[day].cost += call.costUSD
          dailyMap[day].calls += 1
        }
      }
    }
  }

  // Match src/menubar-json.ts:cacheHitPercent semantics
  const cacheHitDenom = totalInput + totalCacheRead
  const cacheHitPercent = cacheHitDenom > 0 ? Math.round((totalCacheRead / cacheHitDenom) * 1000) / 10 : 0

  const daily = Object.entries(dailyMap).sort().map(([date, d]) => ({
    date,
    cost: convertCost(d.cost),
    calls: d.calls,
    turns: d.turns,
    editTurns: d.editTurns,
    oneShotTurns: d.oneShotTurns,
    oneShotRate: d.editTurns > 0
      ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10
      : null,
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

  const modelEfficiency = aggregateModelEfficiency(projects)
  const models = Object.entries(modelMap)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, { cost, ...rest }]) => {
      const efficiency = modelEfficiency.get(name)
      return {
        name,
        ...rest,
        cost: convertCost(cost),
        editTurns: efficiency?.editTurns ?? 0,
        oneShotTurns: efficiency?.oneShotTurns ?? 0,
        oneShotRate: efficiency?.oneShotRate ?? null,
        retriesPerEdit: efficiency?.retriesPerEdit ?? null,
        costPerEdit: efficiency?.costPerEditUSD !== null && efficiency?.costPerEditUSD !== undefined
          ? convertCost(efficiency.costPerEditUSD)
          : null,
      }
    })

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
    skills: Object.entries(skillMap).sort(([, a], [, b]) => b.cost - a.cost).map(([name, d]) => ({ name, turns: d.turns, cost: convertCost(d.cost) })),
    subagents: Object.entries(subagentMap).sort(([, a], [, b]) => b.cost - a.cost).map(([name, d]) => ({ name, calls: d.calls, cost: convertCost(d.cost) })),
    topSessions,
  }
}

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard')
  .option('-p, --period <period>', 'Starting period: today, week, 30days, month, all', 'week')
  .option('--day <date>', 'Single day to review (YYYY-MM-DD, today, or yesterday). Overrides --period when set')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'report')
    let customRange: DateRange | null = null
    let daySelection: ReturnType<typeof parseDayFlag> = null
    try {
      if (opts.day && (opts.from || opts.to)) {
        throw new Error('--day cannot be combined with --from or --to')
      }
      daySelection = parseDayFlag(opts.day)
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    const period = toPeriod(opts.period)
    if (opts.format === 'json') {
      await loadPricing()
      if (daySelection || customRange) {
        const range = daySelection?.range ?? customRange!
        const label = daySelection?.label ?? formatDateRangeLabel(opts.from, opts.to)
        const periodKey = daySelection ? 'day' : 'custom'
        const projects = filterProjectsByName(
          await parseAllSessions(range, opts.provider),
          opts.project,
          opts.exclude,
        )
        console.log(JSON.stringify(await attachPlanSummaries(buildJsonReport(projects, label, periodKey)), null, 2))
      } else {
        await runJsonReport(period, opts.provider, opts.project, opts.exclude)
      }
      return
    }
    const customRangeLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : undefined
    await renderDashboard(period, opts.provider, opts.refresh, opts.project, opts.exclude, customRange, customRangeLabel, daySelection?.day)
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
  .description('Compact status output (today + month)')
  .option('--format <format>', 'Output format: terminal, menubar-json, json', 'terminal')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--period <period>', 'Primary period for menubar-json: today, week, 30days, month, all', 'today')
  .option('--day <date>', 'Single day for menubar-json (YYYY-MM-DD, today, or yesterday). Overrides --period when set')
  .option('--from <date>', 'Start date (YYYY-MM-DD) for custom range')
  .option('--to <date>', 'End date (YYYY-MM-DD) for custom range')
  .option('--days <dates>', 'Comma-separated dates (YYYY-MM-DD) for multi-day selection')
  .option('--no-optimize', 'Skip optimize findings (menubar-json only, faster)')
  .action(async (opts) => {
    assertFormat(opts.format, ['terminal', 'menubar-json', 'json'], 'status')
    if (opts.day && (opts.from || opts.to)) {
      process.stderr.write('error: --day cannot be combined with --from or --to\n')
      process.exit(1)
    }
    if (opts.days && (opts.day || opts.from || opts.to)) {
      process.stderr.write('error: --days cannot be combined with --day, --from, or --to\n')
      process.exit(1)
    }
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
    if (opts.format === 'menubar-json') {
      const daysSelection = parseDaysFlag(opts.days)
      const customRange = daysSelection ? null : parseDateRangeFlags(opts.from, opts.to)
      const daySelection = parseDayFlag(opts.day)
      const periodInfo = daysSelection
        ? { range: daysSelection.range, label: daysSelection.label }
        : customRange
        ? { range: customRange, label: formatDateRangeLabel(opts.from, opts.to) }
        : daySelection ?? getDateRange(opts.period)
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

      let currentData: PeriodData
      let scanProjects: ProjectSummary[]
      let scanRange: DateRange
      let cache: DailyCache
      let todayProviderData: PeriodData | null = null

      if (isAllProviders) {
        cache = await hydrateCache()
        const todayProjects = await getTodayAllProjects()
        const todayDays = await getTodayAllDays()
        const historicalDays = rangeStartStr <= historicalRangeEndStr
          ? getDaysInRange(cache, rangeStartStr, historicalRangeEndStr)
          : []
        const todayInRange = todayDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
        const unfilteredDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
        const allDays = daysSelection ? unfilteredDays.filter(d => daysSelection.days.has(d.date)) : unfilteredDays
        currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
        const isTodayOnly = rangeStartStr === todayStr && rangeEndStr === todayStr
        if (isTodayOnly) {
          scanProjects = todayProjects
          scanRange = todayRange
        } else {
          const rawProjects = fp(await parseAllSessions(periodInfo.range, 'all'))
          scanProjects = daysSelection ? filterProjectsByDays(rawProjects, daysSelection.days) : rawProjects
          scanRange = periodInfo.range
        }
      } else {
        cache = await loadDailyCache()
        const rawProviderProjects = fp(await parseAllSessions(periodInfo.range, pf))
        const fullProjects = daysSelection ? filterProjectsByDays(rawProviderProjects, daysSelection.days) : rawProviderProjects
        todayProviderData = buildPeriodData(periodInfo.label, fullProjects)
        currentData = todayProviderData
        scanProjects = fullProjects
        scanRange = periodInfo.range
      }
      if (isAllProviders) {
        currentData = buildPeriodData(periodInfo.label, scanProjects)
      }

      // PROVIDERS
      // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
      // For specific: just this single provider with its scoped cost.
      const allProviders = await getAllProviders()
      const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
      const providers: ProviderCost[] = []
      if (isAllProviders) {
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
      const historyStartStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS))
      const allCacheDays = getDaysInRange(cache, historyStartStr, yesterdayStr)

      let dailyHistory
      if (isAllProviders) {
        const todayDays = (await getTodayAllDays()).filter(d => d.date === todayStr)
        const fullHistory = [...allCacheDays, ...todayDays]
        dailyHistory = fullHistory.map(d => {
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
        })
      } else {
        const emptyModels = [] as { name: string; cost: number; calls: number; inputTokens: number; outputTokens: number }[]
        const historyFromCache = allCacheDays.map(d => {
          const prov = d.providers[pf] ?? { calls: 0, cost: 0 }
          return {
            date: d.date,
            cost: prov.cost,
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
            const prov = d.providers[pf] ?? { calls: 0, cost: 0 }
            return {
              date: d.date,
              cost: prov.cost,
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
        sessions: p.sessions.length,
        sessionDetails: [...p.sessions]
          .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
          .slice(0, 10)
          .map(s => ({
            cost: s.totalCostUSD,
            calls: s.apiCalls,
            inputTokens: s.totalInputTokens,
            outputTokens: s.totalOutputTokens,
            date: s.firstTimestamp?.split('T')[0] ?? '',
            models: Object.entries(s.modelBreakdown)
              .map(([name, m]) => ({ name, cost: m.costUSD }))
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
          calls: s.apiCalls,
          date: s.firstTimestamp?.split('T')[0] ?? '',
        }))
      ).sort((a, b) => b.cost - a.cost).slice(0, 5)

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
        for (const p of scanProjects) for (const s of p.sessions) {
          for (const [t, d] of Object.entries(s.toolBreakdown)) { if (!t.startsWith('lang:')) toolMap[t] = (toolMap[t] ?? 0) + d.calls }
          for (const [sk, d] of Object.entries(s.skillBreakdown)) { const e = skillMap[sk] ?? { turns: 0, cost: 0 }; e.turns += d.turns; e.cost += d.costUSD; skillMap[sk] = e }
          for (const [sa, d] of Object.entries(s.subagentBreakdown)) { const e = subagentMap[sa] ?? { calls: 0, cost: 0 }; e.calls += d.calls; e.cost += d.costUSD; subagentMap[sa] = e }
          for (const [m, d] of Object.entries(s.mcpBreakdown)) { mcpMap[m] = (mcpMap[m] ?? 0) + d.calls }
        }
        return {
          tools: Object.entries(toolMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
          skills: Object.entries(skillMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
          subagents: Object.entries(subagentMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
          mcpServers: Object.entries(mcpMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
        }
      })()

      const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
      console.log(JSON.stringify(buildMenubarPayload(currentData, providers, optimize, dailyHistory, retryTax, routingWaste, breakdowns)))
      return
    }

    if (opts.format === 'json') {
      const todayProjects = fp(await parseAllSessions(getDateRange('today').range, pf))
      const todayData = buildPeriodData('today', todayProjects)
      clearSessionCache()
      const monthProjects = fp(await parseAllSessions(getDateRange('month').range, pf))
      const monthData = buildPeriodData('month', monthProjects)
      clearSessionCache()
      const { code, rate } = getCurrency()
      const payload: {
        currency: string
        today: { cost: number; calls: number }
        month: { cost: number; calls: number }
        plan?: JsonPlanSummary
        plans?: JsonPlanSummaryMap
      } = {
        currency: code,
        today: { cost: Math.round(todayData.cost * rate * 100) / 100, calls: todayData.calls },
        month: { cost: Math.round(monthData.cost * rate * 100) / 100, calls: monthData.calls },
      }
      console.log(JSON.stringify(await attachPlanSummaries(payload)))
      return
    }

    const monthProjects2 = fp(await parseAllSessions(getDateRange('month').range, pf))
    clearSessionCache()
    console.log(renderStatusBar(monthProjects2))
  })

program
  .command('today')
  .description('Today\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'today')
    if (opts.format === 'json') {
      await runJsonReport('today', opts.provider, opts.project, opts.exclude)
      return
    }
    await renderDashboard('today', opts.provider, opts.refresh, opts.project, opts.exclude)
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'month')
    if (opts.format === 'json') {
      await runJsonReport('month', opts.provider, opts.project, opts.exclude)
      return
    }
    await renderDashboard('month', opts.provider, opts.refresh, opts.project, opts.exclude)
  })

program
  .command('export')
  .description('Export usage data to CSV or JSON')
  .option('-f, --format <format>', 'Export format: csv, json', 'csv')
  .option('-o, --output <path>', 'Output file path')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Exports a single custom period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .action(async (opts) => {
    assertFormat(opts.format, ['csv', 'json'], 'export')
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    let periods: PeriodExport[]
    if (customRange) {
      periods = [{ label: formatDateRangeLabel(opts.from, opts.to), projects: fp(await parseAllSessions(customRange, pf)) }]
      clearSessionCache()
    } else {
      const thirtyDayProjects = fp(await parseAllSessions(getDateRange('30days').range, pf))
      clearSessionCache()
      periods = [
        { label: 'Today', projects: filterProjectsByDateRange(thirtyDayProjects, getDateRange('today').range) },
        { label: '7 Days', projects: filterProjectsByDateRange(thirtyDayProjects, getDateRange('week').range) },
        { label: '30 Days', projects: thirtyDayProjects },
      ]
    }

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

    const exportedLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : 'Today + 7 Days + 30 Days'
    console.log(`\n  Exported (${exportedLabel}) to: ${savedPath}\n`)
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
  .command('model-alias [from] [to]')
  .description('Map a provider model name to a canonical one for pricing (e.g. codeburn model-alias my-model claude-opus-4-6)')
  .option('--remove <from>', 'Remove an alias')
  .option('--list', 'List configured aliases')
  .action(async (from?: string, to?: string, opts?: { remove?: string; list?: boolean }) => {
    const config = await readConfig()
    const aliases = config.modelAliases ?? {}

    if (opts?.list || (!from && !opts?.remove)) {
      const entries = Object.entries(aliases)
      if (entries.length === 0) {
        console.log('\n  No model aliases configured.')
        console.log(`  Config: ${getConfigFilePath()}\n`)
      } else {
        console.log('\n  Model aliases:')
        for (const [src, dst] of entries) {
          console.log(`    ${src} -> ${dst}`)
        }
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    if (opts?.remove) {
      if (!(opts.remove in aliases)) {
        console.error(`\n  Alias not found: ${opts.remove}\n`)
        process.exitCode = 1
        return
      }
      delete aliases[opts.remove]
      config.modelAliases = Object.keys(aliases).length > 0 ? aliases : undefined
      await saveConfig(config)
      console.log(`\n  Removed alias: ${opts.remove}\n`)
      return
    }

    if (!from || !to) {
      console.error('\n  Usage: codeburn model-alias <from> <to>\n')
      process.exitCode = 1
      return
    }

    aliases[from] = to
    config.modelAliases = aliases
    await saveConfig(config)
    console.log(`\n  Alias saved: ${from} -> ${to}`)
    console.log(`  Config: ${getConfigFilePath()}\n`)
  })

program
  .command('plan [action] [id]')
  .description('Show or configure a subscription plan for overage tracking')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--monthly-usd <n>', 'Monthly plan price in USD (for custom)', parseNumber)
  .option('--provider <name>', 'Provider scope: all, claude, codex, cursor')
  .option('--reset-day <n>', 'Day of month plan resets (1-28)', parseInteger, 1)
  .action(async (action?: string, id?: string, opts?: { format?: string; monthlyUsd?: number; provider?: string; resetDay?: number }) => {
    assertFormat(opts?.format ?? 'text', ['text', 'json'], 'plan')
    const mode = action ?? 'show'
    const providerOption = opts?.provider
    if (providerOption !== undefined && !isPlanProvider(providerOption)) {
      console.error(`\n  --provider must be one of: all, claude, codex, cursor; got "${providerOption}".\n`)
      process.exitCode = 1
      return
    }

    if (mode === 'show') {
      const plans = sortedPlans(await readPlans())
        .filter(plan => plan.id !== 'none')
        .filter(plan => !providerOption || providerOption === 'all' || plan.provider === providerOption)
      if (opts?.format === 'json') {
        if (plans.length === 0) {
          console.log(JSON.stringify({ id: 'none', monthlyUsd: 0, provider: 'all', resetDay: 1, setAt: null }))
          return
        }
        console.log(JSON.stringify({
          ...toPlanDisplay(plans[0]!),
          plans: Object.fromEntries(plans.map(plan => [plan.provider, toPlanDisplay(plan)])),
        }))
        return
      }
      if (plans.length === 0) {
        console.log('\n  Plan: none')
        console.log('  API-pricing view is active.')
        console.log(`  Config: ${getConfigFilePath()}\n`)
        return
      }
      console.log(`\n  Plans: ${plans.length}`)
      for (const plan of plans) {
        console.log(`  ${plan.provider}: ${planLabel(plan)} (${plan.id})`)
        console.log(`    Budget: $${plan.monthlyUsd}/month`)
        console.log(`    Reset day: ${clampResetDay(plan.resetDay)}`)
        if (plan.setAt) console.log(`    Set at: ${plan.setAt}`)
      }
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (mode === 'reset') {
      await clearPlan(providerOption)
      if (providerOption) {
        console.log(`\n  Plan reset for ${providerOption}.\n`)
      } else {
        console.log('\n  Plan reset. API-pricing view is active.\n')
      }
      return
    }

    if (mode !== 'set') {
      console.error('\n  Usage: codeburn plan [set <id> | reset]\n')
      process.exitCode = 1
      return
    }

    if (!id || !isPlanId(id)) {
      console.error(`\n  Plan id must be one of: ${PLAN_IDS.join(', ')}; got "${id ?? ''}".\n`)
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
      await clearPlan(providerOption)
      if (providerOption) {
        console.log(`\n  Plan reset for ${providerOption}.\n`)
      } else {
        console.log('\n  Plan reset. API-pricing view is active.\n')
      }
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
      const provider = providerOption ?? 'all'
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

    if (providerOption === 'all') {
      console.error(`\n  ${id} is a ${preset.provider} plan; omit --provider or use --provider ${preset.provider}.\n`)
      process.exitCode = 1
      return
    }

    if (providerOption && providerOption !== preset.provider) {
      console.error(`\n  ${id} is a ${preset.provider} plan; use --provider ${preset.provider} or omit --provider.\n`)
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
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
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
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .action(async (opts) => {
    await loadPricing()
    const { range } = getDateRange(opts.period)
    await renderCompare(range, opts.provider)
  })

program
  .command('models')
  .description('Per-model token + cost table, optionally exploded by task type')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--task <category>', 'Filter to one task type (e.g. feature, debugging, refactoring)')
  .option('--by-task', 'One row per (provider, model, task) instead of one row per (provider, model)')
  .option('--top <n>', 'Show only the top N rows', (v: string) => parseInt(v, 10))
  .option('--min-cost <usd>', 'Hide rows below this cost threshold', (v: string) => parseFloat(v))
  .option('--no-totals', 'Suppress the footer totals row')
  .option('--format <format>', 'Output format: table, markdown, json, csv', 'table')
  .action(async (opts) => {
    const { aggregateModels, renderTable, renderMarkdown, renderJson, renderCsv } = await import('./models-report.js')
    await loadPricing()

    let range
    if (opts.from || opts.to) {
      const customRange = parseDateRangeFlags(opts.from, opts.to)
      if (!customRange) {
        process.stderr.write('codeburn: --from and --to must be valid YYYY-MM-DD dates\n')
        process.exit(1)
      }
      range = customRange
    } else {
      range = getDateRange(opts.period).range
    }

    const projects = await parseAllSessions(range, opts.provider)
    const rows = await aggregateModels(projects, {
      byTask: !!opts.byTask,
      taskFilter: opts.task,
      topN: typeof opts.top === 'number' && Number.isFinite(opts.top) ? opts.top : undefined,
      minCost: typeof opts.minCost === 'number' && Number.isFinite(opts.minCost) ? opts.minCost : 0.01,
    })

    const fmt = (opts.format ?? 'table').toLowerCase()
    if (rows.length === 0 && (fmt === 'table' || fmt === 'markdown')) {
      process.stdout.write('No model usage found for the selected period.\n')
      return
    }
    if (fmt === 'json') {
      process.stdout.write(renderJson(rows) + '\n')
    } else if (fmt === 'csv') {
      process.stdout.write(renderCsv(rows, { byTask: !!opts.byTask }) + '\n')
    } else if (fmt === 'markdown' || fmt === 'md') {
      process.stdout.write(renderMarkdown(rows, { byTask: !!opts.byTask, showTotals: opts.totals !== false }) + '\n')
    } else if (fmt === 'table') {
      process.stdout.write(renderTable(rows, { byTask: !!opts.byTask, showTotals: opts.totals !== false }) + '\n')
    } else {
      process.stderr.write(`codeburn: unknown --format "${opts.format}". Choose table, markdown, json, or csv.\n`)
      process.exit(1)
    }
  })

program
  .command('yield')
  .description('Track which AI spend shipped to main vs reverted/abandoned (experimental)')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'week')
  .action(async (opts) => {
    const { computeYield, formatYieldSummary } = await import('./yield.js')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    console.log(`\n  Analyzing yield for ${label}...\n`)
    const summary = await computeYield(range, process.cwd())
    console.log(formatYieldSummary(summary))
  })

const debug = program
  .command('debug')
  .description('Inspect CodeBurn local state')

debug
  .command('storage')
  .description('Show provider storage usage and paths')
  .option('--provider <provider>', 'Provider to inspect (default: all)', 'all')
  .option('--format <format>', 'Output format: table or json', 'table')
  .action(async (opts) => {
    assertFormat(opts.format, ['table', 'json'], 'debug storage')
    if (!isStorageProvider(opts.provider)) {
      process.stderr.write(
        `codeburn debug storage: unknown provider "${opts.provider}". Valid values: all, ${storageProviderNames().join(', ')}.\n`
      )
      process.exit(1)
    }
    const entries = await collectStorageEntries(opts.provider)
    if (opts.format === 'json') {
      console.log(JSON.stringify({ generated: new Date().toISOString(), entries }, null, 2))
      return
    }
    console.log(formatStorageTable(entries))
  })

program
  .command('providers')
  .description('List, enable, or disable providers')
  .argument('[action]', 'list (default), enable, or disable')
  .argument('[names...]', 'Provider names to enable/disable')
  .action(async (action: string | undefined, names: string[]) => {
    const config = await readConfig()
    const disabled = new Set(config.disabledProviders ?? [])
    const allProviders = await getAllProviders()

    if (!action || action === 'list') {
      console.log('\n  Providers:\n')
      for (const p of allProviders) {
        const status = disabled.has(p.name) ? '\x1b[31m✗ disabled\x1b[0m' : '\x1b[32m✓ enabled\x1b[0m'
        console.log(`    ${p.displayName.padEnd(20)} (${p.name.padEnd(16)}) ${status}`)
      }
      console.log(`\n  Use: codeburn providers enable <name>  or  codeburn providers disable <name>\n`)
      return
    }

    if (action === 'enable') {
      if (names.length === 0) {
        console.error('\n  Usage: codeburn providers enable <provider-name> [provider-name...]\n')
        process.exit(1)
      }
      const validNames = new Set(allProviders.map(p => p.name))
      for (const name of names) {
        if (!validNames.has(name)) {
          console.error(`\n  Unknown provider: "${name}". Run \`codeburn providers\` to see available providers.\n`)
          process.exit(1)
        }
        disabled.delete(name)
      }
      config.disabledProviders = disabled.size > 0 ? [...disabled] : undefined
      await saveConfig(config)
      console.log(`\n  Enabled: ${names.join(', ')}\n`)
      return
    }

    if (action === 'disable') {
      if (names.length === 0) {
        console.error('\n  Usage: codeburn providers disable <provider-name> [provider-name...]\n')
        process.exit(1)
      }
      const validNames = new Set(allProviders.map(p => p.name))
      for (const name of names) {
        if (!validNames.has(name)) {
          console.error(`\n  Unknown provider: "${name}". Run \`codeburn providers\` to see available providers.\n`)
          process.exit(1)
        }
        disabled.add(name)
      }
      config.disabledProviders = [...disabled]
      await saveConfig(config)
      console.log(`\n  Disabled: ${names.join(', ')}\n`)
      return
    }

    console.error(`\n  Unknown action: "${action}". Use: list, enable, or disable.\n`)
    process.exit(1)
  })

program
  .command('antigravity-hook')
  .description('Install or remove exact Antigravity CLI usage capture')
  .argument('<action>', 'install or uninstall')
  .option('--force', 'Replace an existing custom Antigravity CLI statusLine command')
  .action(async (action: string, opts: { force?: boolean }) => {
    try {
      if (action === 'install') {
        const result = await installAntigravityStatusLineHook(!!opts.force)
        console.log(result === 'already-installed'
          ? '\n  Antigravity CLI usage capture is already installed.\n'
          : '\n  Antigravity CLI usage capture installed.\n')
        return
      }
      if (action === 'uninstall') {
        const result = await uninstallAntigravityStatusLineHook()
        console.log(result === 'not-installed'
          ? '\n  Antigravity CLI usage capture is not installed.\n'
          : result === 'restored'
            ? '\n  Antigravity CLI usage capture removed; previous statusLine restored.\n'
          : '\n  Antigravity CLI usage capture removed.\n')
        return
      }
      console.error('\n  Usage: codeburn antigravity-hook <install|uninstall>\n')
      process.exit(1)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Antigravity hook failed: ${message}\n`)
      process.exit(1)
    }
  })

program
  .command('agy-statusline-hook', { hidden: true })
  .description('Internal Antigravity CLI statusLine hook')
  .action(async () => {
    await runAgyStatusLineHook()
  })

program.parse()
