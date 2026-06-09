import { isAbsolute } from 'path'
import { Command } from 'commander'
import { installMenubarApp } from './menubar-installer.js'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing, setModelAliases, setLocalModelSavings, setProxyPaths, normalizeProxyPath } from './models.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDateRange, clearSessionCache } from './parser.js'
import { convertCost } from './currency.js'
import { renderStatusBar } from './format.js'
import { toDateString } from './daily-cache.js'
import { dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { buildPeriodData, buildMenubarPayloadForRange } from './usage-aggregator.js'
import { renderDashboard } from './dashboard.js'
import { formatDateRangeLabel, parseDateRangeFlags, parseDayFlag, parseDaysFlag, getDateRange, toPeriod, type Period } from './cli-date.js'
import { runOptimize } from './optimize.js'
import { renderCompare } from './compare.js'
import {
  installAntigravityStatusLineHook,
  runAgyStatusLineHook,
  uninstallAntigravityStatusLineHook,
} from './antigravity-statusline.js'
import { clearPlan, readConfig, readPlan, readPlans, saveConfig, savePlan, getConfigFilePath, type Plan, type PlanId, type PlanProvider } from './config.js'
import { clampResetDay, getPlanUsageOrNull, getPlanUsages, type PlanUsage } from './plan-usage.js'
import { getPresetPlan, isPlanId, isPlanProvider, PLAN_IDS, PLAN_PROVIDERS, planDisplayName } from './plans.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

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
  setLocalModelSavings(config.localModelSavings ?? {})
  setProxyPaths(config.proxyPaths ?? [])
  if (thisCommand.opts<{ verbose?: boolean }>().verbose) {
    process.env['CODEBURN_VERBOSE'] = '1'
  }
  await loadCurrency()
})

function buildJsonReport(projects: ProjectSummary[], period: string, periodKey: string) {
  const sessions = projects.flatMap(p => p.sessions)
  const { code } = getCurrency()

  const totalCostUSD = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalSavingsUSD = projects.reduce((s, p) => s + p.totalSavingsUSD, 0)
  // Subscription-covered (proxied) portion of totalCostUSD, and the resulting
  // out-of-pocket figure. `cost` stays the full billable/would-be amount.
  const totalProxiedUSD = projects.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
  const netCostUSD = totalCostUSD - totalProxiedUSD
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

  // Per-day rollup. Mirrors parser.ts categoryBreakdown semantics so a
  // consumer summing daily[].editTurns over a period gets the same total as
  // sum(activities[].editTurns) for that period: every turn counts once for
  // `turns`, edit turns count for `editTurns`, edit turns with zero retries
  // count for `oneShotTurns`. Issue #279 — daily-resolution efficiency
  // dashboards need this without re-deriving from activity-level rollups.
  const dailyMap: Record<string, { cost: number; savings: number; calls: number; turns: number; editTurns: number; oneShotTurns: number }> = {}
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      // Prefer the user-message timestamp on the turn; fall back to the first
      // assistant-call timestamp when the user line is missing (continuation
      // sessions where the JSONL begins mid-conversation). Previously these
      // turns dropped from daily but stayed in activities, breaking the
      // sum(daily[].editTurns) === sum(activities[].editTurns) invariant.
      const ts = turn.timestamp || turn.assistantCalls[0]?.timestamp
      if (!ts) { continue }
      const day = dateKey(ts)
      if (!dailyMap[day]) { dailyMap[day] = { cost: 0, savings: 0, calls: 0, turns: 0, editTurns: 0, oneShotTurns: 0 } }
      dailyMap[day].turns += 1
      if (turn.hasEdits) {
        dailyMap[day].editTurns += 1
        if (turn.retries === 0) dailyMap[day].oneShotTurns += 1
      }
      for (const call of turn.assistantCalls) {
        dailyMap[day].cost += call.costUSD
        dailyMap[day].savings += call.savingsUSD ?? 0
        dailyMap[day].calls += 1
      }
    }
  }
  const daily = Object.entries(dailyMap).sort().map(([date, d]) => ({
    date,
    cost: convertCost(d.cost),
    savings: convertCost(d.savings),
    calls: d.calls,
    turns: d.turns,
    editTurns: d.editTurns,
    oneShotTurns: d.oneShotTurns,
    // Pre-computed convenience for dashboards that don't want to do the math.
    // null when there are no edit turns (the rate is undefined, not zero —
    // a day where the user only had Q&A turns shouldn't read as 0% one-shot).
    oneShotRate: d.editTurns > 0
      ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10
      : null,
  }))

  const projectList = projects.map(p => ({
    name: p.project,
    path: p.projectPath,
    cost: convertCost(p.totalCostUSD),
    savings: convertCost(p.totalSavingsUSD),
    avgCostPerSession: p.sessions.length > 0
      ? convertCost(p.totalCostUSD / p.sessions.length)
      : null,
    calls: p.totalApiCalls,
    sessions: p.sessions.length,
  }))

  const modelMap: Record<string, { calls: number; cost: number; savings: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; baselineModel: string }> = {}
  const modelEfficiency = aggregateModelEfficiency(projects)
  for (const sess of sessions) {
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelMap[model]) { modelMap[model] = { calls: 0, cost: 0, savings: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, baselineModel: '' } }
      modelMap[model].calls += d.calls
      modelMap[model].cost += d.costUSD
      modelMap[model].savings += d.savingsUSD
      modelMap[model].inputTokens += d.tokens.inputTokens
      modelMap[model].outputTokens += d.tokens.outputTokens
      modelMap[model].cacheReadTokens += d.tokens.cacheReadInputTokens
      modelMap[model].cacheWriteTokens += d.tokens.cacheCreationInputTokens
    }
  }
  // Pull the active baseline model name out of the savings config so the
  // report can show what the local calls were mapped against without
  // forcing the consumer to cross-reference a separate file. Empty when
  // no savings are configured for this period.
  for (const [model, acc] of Object.entries(modelMap)) {
    if (acc.savings <= 0) continue
    for (const sess of sessions) {
      const bucket = sess.modelBreakdown[model]
      if (!bucket || bucket.savingsUSD <= 0) continue
      for (const turn of sess.turns) {
        for (const call of turn.assistantCalls) {
          if (call.model === model && call.savingsBaselineModel) {
            acc.baselineModel = call.savingsBaselineModel
            break
          }
        }
        if (acc.baselineModel) break
      }
      if (acc.baselineModel) break
    }
  }
  const models = Object.entries(modelMap)
    .sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings))
    .map(([name, { cost, savings, baselineModel, ...rest }]) => {
      const efficiency = modelEfficiency.get(name)
      return {
        name,
        ...rest,
        cost: convertCost(cost),
        savings: convertCost(savings),
        savingsBaselineModel: baselineModel,
        editTurns: efficiency?.editTurns ?? 0,
        oneShotTurns: efficiency?.oneShotTurns ?? 0,
        oneShotRate: efficiency?.oneShotRate ?? null,
        retriesPerEdit: efficiency?.retriesPerEdit ?? null,
        costPerEdit: efficiency?.costPerEditUSD !== null && efficiency?.costPerEditUSD !== undefined
          ? convertCost(efficiency.costPerEditUSD)
          : null,
      }
    })

  const catMap: Record<string, { turns: number; cost: number; savings: number; editTurns: number; oneShotTurns: number }> = {}
  for (const sess of sessions) {
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catMap[cat]) { catMap[cat] = { turns: 0, cost: 0, savings: 0, editTurns: 0, oneShotTurns: 0 } }
      catMap[cat].turns += d.turns
      catMap[cat].cost += d.costUSD
      catMap[cat].savings += d.savingsUSD
      catMap[cat].editTurns += d.editTurns
      catMap[cat].oneShotTurns += d.oneShotTurns
    }
  }
  const activities = Object.entries(catMap)
    .sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings))
    .map(([cat, d]) => ({
      category: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      cost: convertCost(d.cost),
      savings: convertCost(d.savings),
      turns: d.turns,
      editTurns: d.editTurns,
      oneShotTurns: d.oneShotTurns,
      oneShotRate: d.editTurns > 0 ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10 : null,
    }))

  const toolMap: Record<string, number> = {}
  const mcpMap: Record<string, number> = {}
  const bashMap: Record<string, number> = {}
  const skillMap: Record<string, { turns: number; cost: number; savings: number }> = {}
  const subagentMap: Record<string, { calls: number; cost: number; savings: number }> = {}
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
    for (const [skill, d] of Object.entries(sess.skillBreakdown)) {
      if (!skillMap[skill]) skillMap[skill] = { turns: 0, cost: 0, savings: 0 }
      skillMap[skill].turns += d.turns
      skillMap[skill].cost += d.costUSD
      skillMap[skill].savings += d.savingsUSD
    }
    for (const [sat, d] of Object.entries(sess.subagentBreakdown)) {
      if (!subagentMap[sat]) subagentMap[sat] = { calls: 0, cost: 0, savings: 0 }
      subagentMap[sat].calls += d.calls
      subagentMap[sat].cost += d.costUSD
      subagentMap[sat].savings += d.savingsUSD
    }
  }

  const sortedMap = (m: Record<string, number>) =>
    Object.entries(m).sort(([, a], [, b]) => b - a).map(([name, calls]) => ({ name, calls }))

  const topSessions = projects
    .flatMap(p => p.sessions.map(s => ({
      project: p.project,
      sessionId: s.sessionId,
      date: s.firstTimestamp ? dateKey(s.firstTimestamp) : null,
      cost: convertCost(s.totalCostUSD),
      savings: convertCost(s.totalSavingsUSD),
      calls: s.apiCalls,
    })))
    .sort((a, b) => (b.cost + b.savings) - (a.cost + a.savings))
    .slice(0, 5)

  return {
    generated: new Date().toISOString(),
    currency: code,
    period,
    periodKey,
    overview: {
      cost: convertCost(totalCostUSD),
      // Subscription-covered spend (config `proxyPaths`) and net out-of-pocket.
      // `cost` is the full API-rate figure; `proxiedCost` is the part billed to
      // a subscription; `netCost` = cost - proxiedCost. Both 0 with no proxy
      // paths configured, so existing consumers are unaffected.
      proxiedCost: convertCost(totalProxiedUSD),
      netCost: convertCost(netCostUSD),
      savings: convertCost(totalSavingsUSD),
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
    skills: Object.entries(skillMap).sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings)).map(([name, d]) => ({ name, turns: d.turns, cost: convertCost(d.cost), savings: convertCost(d.savings) })),
    subagents: Object.entries(subagentMap).sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings)).map(([name, d]) => ({ name, calls: d.calls, cost: convertCost(d.cost), savings: convertCost(d.savings) })),
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
      const payload = await buildMenubarPayloadForRange(periodInfo, {
        provider: pf,
        project: opts.project,
        exclude: opts.exclude,
        daysSelection,
        optimize: opts.optimize !== false,
      })
      console.log(JSON.stringify(payload))
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
        today: { cost: number; savings: number; calls: number }
        month: { cost: number; savings: number; calls: number }
        localModelSavings?: { today: number; month: number; callsToday: number; callsMonth: number }
        plan?: JsonPlanSummary
        plans?: JsonPlanSummaryMap
      } = {
        currency: code,
        today: { cost: Math.round(todayData.cost * rate * 100) / 100, savings: Math.round(todayData.savingsUSD * rate * 100) / 100, calls: todayData.calls },
        month: { cost: Math.round(monthData.cost * rate * 100) / 100, savings: Math.round(monthData.savingsUSD * rate * 100) / 100, calls: monthData.calls },
      }
      const savingsCallsToday = todayProjects.reduce((s, p) => s + p.sessions.reduce((s2, sess) => s2 + sess.turns.reduce((s3, turn) => s3 + turn.assistantCalls.reduce((s4, c) => s4 + (c.savingsUSD && c.savingsUSD > 0 ? 1 : 0), 0), 0), 0), 0)
      const savingsCallsMonth = monthProjects.reduce((s, p) => s + p.sessions.reduce((s2, sess) => s2 + sess.turns.reduce((s3, turn) => s3 + turn.assistantCalls.reduce((s4, c) => s4 + (c.savingsUSD && c.savingsUSD > 0 ? 1 : 0), 0), 0), 0), 0)
      if (todayData.savingsUSD > 0 || monthData.savingsUSD > 0) {
        payload.localModelSavings = {
          today: payload.today.savings,
          month: payload.month.savings,
          callsToday: savingsCallsToday,
          callsMonth: savingsCallsMonth,
        }
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
  .command('model-savings [local] [baseline]')
  .description('Track a local model as "savings" rather than cost. Maps a local-model name to a paid baseline so the dashboard can show what the same tokens would have cost on the baseline (e.g. codeburn model-savings "llama3.1:8b" gpt-4o). The local call itself still costs $0 — actual cost is left untouched.')
  .option('--remove <local>', 'Remove a savings mapping for the given local model')
  .option('--list', 'List configured savings mappings')
  .action(async (local?: string, baseline?: string, opts?: { remove?: string; list?: boolean }) => {
    const config = await readConfig()
    const mappings = { ...(config.localModelSavings ?? {}) }

    if (opts?.list || (!local && !opts?.remove)) {
      const entries = Object.entries(mappings)
      if (entries.length === 0) {
        console.log('\n  No local-model savings mappings configured.')
        console.log(`  Config: ${getConfigFilePath()}`)
        console.log('  Add one with: codeburn model-savings <local-model> <baseline-model>\n')
      } else {
        console.log('\n  Local-model savings mappings:')
        for (const [src, dst] of entries) {
          console.log(`    ${src} -> ${dst}`)
        }
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    if (opts?.remove) {
      if (!(opts.remove in mappings)) {
        console.error(`\n  No savings mapping found for: ${opts.remove}\n`)
        process.exitCode = 1
        return
      }
      delete mappings[opts.remove]
      config.localModelSavings = Object.keys(mappings).length > 0 ? mappings : undefined
      await saveConfig(config)
      console.log(`\n  Removed savings mapping: ${opts.remove}\n`)
      return
    }

    if (!local || !baseline) {
      console.error('\n  Usage: codeburn model-savings <local-model> <baseline-model>\n')
      process.exitCode = 1
      return
    }

    mappings[local] = baseline
    config.localModelSavings = mappings
    await saveConfig(config)

    // Warn when the same model is also in modelAliases so the user is
    // not surprised that `savings` wins for actual cost.
    if (config.modelAliases && Object.hasOwn(config.modelAliases, local)) {
      console.log(`\n  Note: ${local} is also in modelAliases (-> ${config.modelAliases[local]}).`)
      console.log('  Local-model savings take precedence: the call is treated as $0 actual cost and the baseline is used for counterfactual savings.')
    }

    console.log(`\n  Savings mapping saved: ${local} -> ${baseline}`)
    console.log(`  Config: ${getConfigFilePath()}\n`)
  })

program
  .command('proxy-path [path]')
  .description('Mark a project directory as routed through a subscription-backed LLM proxy (e.g. Claude Code over GitHub Copilot). Sessions whose canonical path is under it keep their full API-rate cost as the "would-be" figure, but that amount is reported as subscription-covered so the report can show net out-of-pocket (e.g. codeburn proxy-path ~/work/copilot-repo). Actual API-key sessions elsewhere are untouched.')
  .option('--remove <path>', 'Remove a configured proxy path')
  .option('--list', 'List configured proxy paths')
  .action(async (path?: string, opts?: { remove?: string; list?: boolean }) => {
    const config = await readConfig()
    // Sanitize the on-disk shape the same way setProxyPaths does: a hand-edited
    // config.json could have proxyPaths as a non-array or hold non-string
    // entries, which would otherwise throw when spread or normalized below.
    const paths = (Array.isArray(config.proxyPaths) ? config.proxyPaths : [])
      .filter((p): p is string => typeof p === 'string')
    const samePath = (a: string, b: string) => normalizeProxyPath(a) === normalizeProxyPath(b)

    if (opts?.list || (!path && !opts?.remove)) {
      if (paths.length === 0) {
        console.log('\n  No proxy paths configured.')
        console.log(`  Config: ${getConfigFilePath()}`)
        console.log('  Add one with: codeburn proxy-path <project-dir>\n')
      } else {
        console.log('\n  Proxy paths (sessions under these are subscription-covered):')
        for (const p of paths) console.log(`    ${p}`)
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    if (opts?.remove) {
      const idx = paths.findIndex(p => samePath(p, opts.remove!))
      if (idx === -1) {
        console.error(`\n  No proxy path found matching: ${opts.remove}\n`)
        process.exitCode = 1
        return
      }
      paths.splice(idx, 1)
      config.proxyPaths = paths.length > 0 ? paths : undefined
      await saveConfig(config)
      console.log(`\n  Removed proxy path: ${opts.remove}\n`)
      return
    }

    if (!path) {
      console.error('\n  Usage: codeburn proxy-path <project-dir>\n')
      process.exitCode = 1
      return
    }

    const trimmed = path.trim()
    if (!isAbsolute(trimmed) || normalizeProxyPath(trimmed) === '') {
      console.error(`\n  Proxy path must be an absolute project directory (got: ${path}).`)
      console.error('  codeburn matches sessions by their recorded absolute cwd; the')
      console.error('  filesystem root is too broad and is not accepted.\n')
      process.exitCode = 1
      return
    }
    if (paths.some(p => samePath(p, trimmed))) {
      console.log(`\n  Proxy path already configured: ${trimmed}\n`)
      return
    }
    paths.push(trimmed)
    config.proxyPaths = paths
    await saveConfig(config)
    console.log(`\n  Proxy path saved: ${trimmed}`)
    console.log('  Sessions under it keep their full API-rate cost as the would-be figure; that amount is reported as subscription-covered (net out-of-pocket excludes it).')
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

program
  .command('mcp')
  .description('Run a Model Context Protocol server (stdio) exposing usage + savings to AI agents')
  .action(async () => {
    // stdout MUST carry only JSON-RPC; route stray logs to stderr.
    // NOTE: only console.log is guarded here. process.stdout.write is left intact
    // because the MCP StdioServerTransport relies on it for JSON-RPC output.
    console.log = ((...args: unknown[]) => process.stderr.write(args.join(' ') + '\n')) as typeof console.log
    const { startStdioServer } = await import('./mcp/server.js')
    await startStdioServer(version)
  })

program.parse()
