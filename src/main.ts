import { Command } from 'commander'
import { installMenubarApp } from './menubar-installer.js'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing, setModelAliases } from './models.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDateRange, clearSessionCache } from './parser.js'
import { buildAccountReport, filterProjectsByAccount, projectAccount, type AccountReport } from './accounts.js'
import { convertCost } from './currency.js'
import { formatCost, renderStatusBar } from './format.js'
import { type PeriodData, type ProviderCost } from './menubar-json.js'
import { buildMenubarPayload } from './menubar-json.js'
import { getDaysInRange, ensureCacheHydrated, loadDailyCache, emptyCache, BACKFILL_DAYS, toDateString, type DailyCache } from './daily-cache.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays, dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { renderDashboard } from './dashboard.js'
import { formatDateRangeLabel, parseDateRangeFlags, getDateRange, toPeriod, type Period } from './cli-date.js'
import { runOptimize, scanAndDetect } from './optimize.js'
import { renderCompare } from './compare.js'
import { getAllProviders } from './providers/index.js'
import { clearPlan, readConfig, readPlan, readPlans, saveConfig, savePlan, getConfigFilePath, type AccountConfig, type Plan, type PlanId, type PlanProvider } from './config.js'
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

type ProjectFilterOptions = {
  project?: string[]
  exclude?: string[]
  account?: string[]
}

function applyProjectFilters(projects: ProjectSummary[], opts: ProjectFilterOptions): ProjectSummary[] {
  return filterProjectsByAccount(
    filterProjectsByName(projects, opts.project, opts.exclude),
    opts.account,
  )
}

function filterAccountConfig(
  accountConfig: Record<string, AccountConfig> | undefined,
  accountFilter?: string[],
  projects?: ProjectSummary[],
): Record<string, AccountConfig> | undefined {
  if (!accountConfig) return undefined
  const patterns = accountFilter?.map(s => s.trim().toLowerCase()).filter(Boolean) ?? []
  if (patterns.length === 0) return accountConfig
  const filteredAccounts = new Set(projects?.map(project => projectAccount(project).toLowerCase()) ?? [])
  return Object.fromEntries(
    Object.entries(accountConfig).filter(([account]) => {
      const lower = account.toLowerCase()
      return filteredAccounts.has(lower) || patterns.some(pattern => lower.includes(pattern))
    }),
  )
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

async function runJsonReport(period: Period, provider: string, filters: ProjectFilterOptions): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const config = await readConfig()
  const projects = applyProjectFilters(await parseAllSessions(range, provider), filters)
  const report: ReturnType<typeof buildJsonReport> & { plan?: JsonPlanSummary; plans?: JsonPlanSummaryMap } = await attachPlanSummaries(
    buildJsonReport(projects, label, period, filterAccountConfig(config.accounts, filters.account, projects)),
  )
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

function buildJsonReport(projects: ProjectSummary[], period: string, periodKey: string, accountConfig: Record<string, AccountConfig> = {}) {
  const sessions = projects.flatMap(p => p.sessions)
  const { code } = getCurrency()
  const accountReport = buildAccountReport(projects, accountConfig)

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

  // Per-day rollup. Mirrors parser.ts categoryBreakdown semantics so a
  // consumer summing daily[].editTurns over a period gets the same total as
  // sum(activities[].editTurns) for that period: every turn counts once for
  // `turns`, edit turns count for `editTurns`, edit turns with zero retries
  // count for `oneShotTurns`. Issue #279 — daily-resolution efficiency
  // dashboards need this without re-deriving from activity-level rollups.
  const dailyMap: Record<string, { cost: number; calls: number; turns: number; editTurns: number; oneShotTurns: number }> = {}
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
  const daily = Object.entries(dailyMap).sort().map(([date, d]) => ({
    date,
    cost: convertCost(d.cost),
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
    ...(p.account ? { account: p.account } : {}),
    ...(p.accountPath ? { accountPath: p.accountPath } : {}),
    cost: convertCost(p.totalCostUSD),
    avgCostPerSession: p.sessions.length > 0
      ? convertCost(p.totalCostUSD / p.sessions.length)
      : null,
    calls: p.totalApiCalls,
    sessions: p.sessions.length,
  }))

  const modelMap: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> = {}
  const modelEfficiency = aggregateModelEfficiency(projects)
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
    .flatMap(p => p.sessions.map(s => ({
      project: p.project,
      ...(p.account ? { account: p.account } : {}),
      sessionId: s.sessionId,
      date: s.firstTimestamp ? dateKey(s.firstTimestamp) : null,
      cost: convertCost(s.totalCostUSD),
      calls: s.apiCalls,
    })))
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
    accounts: accountReport.accounts.map(account => ({
      name: account.account,
      ...(account.accountPath ? { accountPath: account.accountPath } : {}),
      ...(account.configured?.plan ? { plan: account.configured.plan } : {}),
      ...(account.configured?.monthlyUsd ? { monthlyUSD: account.configured.monthlyUsd } : {}),
      ...(account.configured?.budgetUsd ? { budgetUSD: account.configured.budgetUsd } : {}),
      cost: convertCost(account.totalCostUSD),
      apiEquivalentUSD: Math.round(account.totalCostUSD * 100) / 100,
      calls: account.totalApiCalls,
      sessions: account.sessions,
      projects: account.projects,
      editTurns: account.editTurns,
      costPerSession: account.costPerSessionUSD !== null ? convertCost(account.costPerSessionUSD) : null,
      costPerEdit: account.costPerEditUSD !== null ? convertCost(account.costPerEditUSD) : null,
      subscriptionUtilizationPercent: account.subscriptionUtilizationPercent,
      budgetUtilizationPercent: account.budgetUtilizationPercent,
      topModels: account.topModels.map(model => ({ name: model.name, calls: model.calls, cost: convertCost(model.costUSD) })),
      topProjects: account.topProjects.map(project => ({ path: project.projectPath, sessions: project.sessions, cost: convertCost(project.costUSD) })),
    })),
    accountRisks: accountReport.risks,
    models,
    activities,
    tools: sortedMap(toolMap),
    mcpServers: sortedMap(mcpMap),
    shellCommands: sortedMap(bashMap),
    topSessions,
  }
}

function accountReportToJson(report: AccountReport) {
  const { code } = getCurrency()
  return {
    currency: code,
    accounts: report.accounts.map(account => ({
      name: account.account,
      accountPath: account.accountPath ?? null,
      plan: account.configured?.plan ?? null,
      monthlyUSD: account.configured?.monthlyUsd ?? null,
      budgetUSD: account.configured?.budgetUsd ?? null,
      cost: convertCost(account.totalCostUSD),
      apiEquivalentUSD: Math.round(account.totalCostUSD * 100) / 100,
      calls: account.totalApiCalls,
      sessions: account.sessions,
      projects: account.projects,
      editTurns: account.editTurns,
      costPerSession: account.costPerSessionUSD !== null ? convertCost(account.costPerSessionUSD) : null,
      costPerEdit: account.costPerEditUSD !== null ? convertCost(account.costPerEditUSD) : null,
      subscriptionCostPerSessionUSD: account.subscriptionCostPerSessionUSD,
      subscriptionCostPerEditUSD: account.subscriptionCostPerEditUSD,
      subscriptionUtilizationPercent: account.subscriptionUtilizationPercent,
      budgetUtilizationPercent: account.budgetUtilizationPercent,
      topModels: account.topModels.map(model => ({ name: model.name, calls: model.calls, cost: convertCost(model.costUSD) })),
      topProjects: account.topProjects.map(project => ({ path: project.projectPath, sessions: project.sessions, cost: convertCost(project.costUSD) })),
    })),
    risks: report.risks,
  }
}

function formatPercent(value: number | null): string {
  if (value === null) return '-'
  return `${value.toFixed(1)}%`
}

function formatUSD(value: number): string {
  const decimals = value > 0 && Math.abs(value) < 1 ? 3 : 2
  return `USD ${value.toFixed(decimals)}`
}

function printAccountReport(report: AccountReport, label: string): void {
  console.log(`\n  Accounts (${label})`)
  if (report.accounts.length === 0) {
    console.log('  No account-labelled usage found for this filter.')
    console.log(`  Config: ${getConfigFilePath()}\n`)
    return
  }

  console.log('  Account              Cost      Sessions  Projects  Calls   Plan/Budget')
  for (const account of report.accounts) {
    const plan = account.configured?.plan
      ? `${account.configured.plan}${account.configured.monthlyUsd ? ` ${formatUSD(account.configured.monthlyUsd)}/mo` : ''}`
      : ''
    const budget = account.configured?.budgetUsd
      ? `budget ${formatPercent(account.budgetUtilizationPercent)}`
      : ''
    const right = [plan, budget].filter(Boolean).join(', ') || '-'
    console.log(
      `  ${account.account.padEnd(20)} ` +
      `${formatCost(account.totalCostUSD).padStart(9)} ` +
      `${String(account.sessions).padStart(9)} ` +
      `${String(account.projects).padStart(8)} ` +
      `${String(account.totalApiCalls).padStart(6)}   ` +
      right,
    )
  }

  const configured = report.accounts.filter(a => a.configured?.monthlyUsd || a.configured?.budgetUsd)
  if (configured.length > 0) {
    console.log('\n  Subscription efficiency')
    for (const account of configured) {
      const subSession = account.subscriptionCostPerSessionUSD !== null
        ? `${formatUSD(account.subscriptionCostPerSessionUSD)}/session`
        : '-'
      const subEdit = account.subscriptionCostPerEditUSD !== null
        ? `${formatUSD(account.subscriptionCostPerEditUSD)}/edit`
        : '-'
      console.log(`  ${account.account.padEnd(20)} api-equivalent ${formatPercent(account.subscriptionUtilizationPercent).padStart(7)}   ${subSession.padStart(14)}   ${subEdit.padStart(12)}`)
    }
  }

  if (report.risks.length > 0) {
    console.log('\n  Signals')
    for (const risk of report.risks.slice(0, 8)) {
      console.log(`  - ${risk.message}`)
    }
  }
  console.log(`\n  Config: ${getConfigFilePath()}\n`)
}

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard')
  .option('-p, --period <period>', 'Starting period: today, week, 30days, month, all', 'week')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'report')
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
        const label = formatDateRangeLabel(opts.from, opts.to)
        const config = await readConfig()
        const projects = applyProjectFilters(await parseAllSessions(customRange, opts.provider), opts)
        console.log(JSON.stringify(await attachPlanSummaries(buildJsonReport(projects, label, 'custom', filterAccountConfig(config.accounts, opts.account, projects))), null, 2))
      } else {
        await runJsonReport(period, opts.provider, opts)
      }
      return
    }
    const customRangeLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : undefined
    await renderDashboard(period, opts.provider, opts.refresh, opts.project, opts.exclude, customRange, customRangeLabel, opts.account)
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
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .option('--period <period>', 'Primary period for menubar-json: today, week, 30days, month, all', 'today')
  .option('--no-optimize', 'Skip optimize findings (menubar-json only, faster)')
  .action(async (opts) => {
    assertFormat(opts.format, ['terminal', 'menubar-json', 'json'], 'status')
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => applyProjectFilters(p, opts)
    if (opts.format === 'menubar-json') {
      const periodInfo = getDateRange(opts.period)
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const todayRange: DateRange = { start: todayStart, end: now }
      const todayStr = toDateString(todayStart)
      const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
      const rangeStartStr = toDateString(periodInfo.range.start)
      const rangeEndStr = toDateString(periodInfo.range.end)
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
      let usedPerProviderCachePath = false

      if (isAllProviders) {
        cache = await hydrateCache()
        const todayProjects = await getTodayAllProjects()
        const todayDays = await getTodayAllDays()
        const historicalDays = getDaysInRange(cache, rangeStartStr, yesterdayStr)
        const todayInRange = todayDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
        const allDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
        currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
        scanProjects = todayProjects
        scanRange = todayRange
      } else {
        cache = await loadDailyCache()
        const cacheIsCurrent = cache.lastComputedDate !== null
          && cache.lastComputedDate >= yesterdayStr
        if (cacheIsCurrent && rangeStartStr < todayStr) {
          const todayProviderProjects = fp(await parseAllSessions(todayRange, pf))
          todayProviderData = buildPeriodData(periodInfo.label, todayProviderProjects)
          const historicalDays = getDaysInRange(cache, rangeStartStr, yesterdayStr)
          let histCost = 0, histCalls = 0
          for (const d of historicalDays) {
            const prov = d.providers[pf]
            if (prov) { histCost += prov.cost; histCalls += prov.calls }
          }
          currentData = {
            ...todayProviderData,
            cost: todayProviderData.cost + histCost,
            calls: todayProviderData.calls + histCalls,
          }
          scanProjects = todayProviderProjects
          scanRange = todayRange
          usedPerProviderCachePath = true
        } else {
          const fullProjects = fp(await parseAllSessions(periodInfo.range, pf))
          todayProviderData = buildPeriodData(periodInfo.label, fullProjects)
          currentData = todayProviderData
          scanProjects = fullProjects
          scanRange = periodInfo.range
        }
      }

      // PROVIDERS
      // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
      // For specific: just this single provider with its scoped cost.
      const allProviders = await getAllProviders()
      const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
      const providers: ProviderCost[] = []
      if (isAllProviders) {
        const allDaysForProviders = [
          ...getDaysInRange(cache, rangeStartStr, yesterdayStr),
          ...(await getTodayAllDays()).filter(d => d.date === todayStr),
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
      } else if (usedPerProviderCachePath) {
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
            topModels: [] as { name: string; cost: number; calls: number; inputTokens: number; outputTokens: number }[],
          }
        })
        const todayCost = todayProviderData!.cost
        const todayCalls = todayProviderData!.calls
        if (todayCost > 0 || todayCalls > 0) {
          historyFromCache.push({
            date: todayStr,
            cost: todayCost,
            calls: todayCalls,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            topModels: [],
          })
        }
        dailyHistory = historyFromCache
      } else {
        const histFromCache = allCacheDays.map(d => {
          const prov = d.providers[pf] ?? { calls: 0, cost: 0 }
          return {
            date: d.date,
            cost: prov.cost,
            calls: prov.calls,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            topModels: [] as { name: string; cost: number; calls: number; inputTokens: number; outputTokens: number }[],
          }
        })
        const fallbackDays = aggregateProjectsIntoDays(scanProjects)
        const liveDays = fallbackDays.map(d => {
          const prov = d.providers[pf] ?? { calls: 0, cost: 0 }
          return {
            date: d.date,
            cost: prov.cost,
            calls: prov.calls,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            topModels: [] as { name: string; cost: number; calls: number; inputTokens: number; outputTokens: number }[],
          }
        })
        dailyHistory = [...histFromCache, ...liveDays]
      }

      const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
      console.log(JSON.stringify(buildMenubarPayload(currentData, providers, optimize, dailyHistory)))
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
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'today')
    if (opts.format === 'json') {
      await runJsonReport('today', opts.provider, opts)
      return
    }
    await renderDashboard('today', opts.provider, opts.refresh, opts.project, opts.exclude, null, undefined, opts.account)
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds (0 to disable)', parseInteger, 30)
  .action(async (opts) => {
    assertFormat(opts.format, ['tui', 'json'], 'month')
    if (opts.format === 'json') {
      await runJsonReport('month', opts.provider, opts)
      return
    }
    await renderDashboard('month', opts.provider, opts.refresh, opts.project, opts.exclude, null, undefined, opts.account)
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
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .action(async (opts) => {
    assertFormat(opts.format, ['csv', 'json'], 'export')
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => applyProjectFilters(p, opts)
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
    const config = await readConfig()
    const accountConfig = filterAccountConfig(
      config.accounts,
      opts.account,
      periods.flatMap(p => p.projects),
    ) ?? {}

    let savedPath: string
    try {
      if (opts.format === 'json') {
        savedPath = await exportJson(periods, outputPath, accountConfig)
      } else {
        savedPath = await exportCsv(periods, outputPath, accountConfig)
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
  .command('accounts [action] [account]')
  .description('Inspect and configure per-account usage, budgets, and subscriptions')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'month')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .option('--plan <name>', 'Subscription/plan label for accounts set')
  .option('--monthly-usd <n>', 'Monthly subscription cost in USD', parseNumber)
  .option('--budget-usd <n>', 'Monthly budget/allowance in USD', parseNumber)
  .option('--reset-day <n>', 'Day of month account budget resets (1-28)', parseInteger)
  .action(async (
    action?: string,
    target?: string,
    opts?: {
      format?: string
      period?: string
      from?: string
      to?: string
      provider?: string
      project?: string[]
      exclude?: string[]
      account?: string[]
      plan?: string
      monthlyUsd?: number
      budgetUsd?: number
      resetDay?: number
    },
  ) => {
    assertFormat(opts?.format ?? 'text', ['text', 'json'], 'accounts')
    let mode = action ?? 'show'
    let accountFilter = opts?.account

    if (!['show', 'list', 'set', 'reset'].includes(mode)) {
      if (target) {
        console.error('\n  Usage: codeburn accounts [show | set <account> | reset <account>]\n')
        process.exitCode = 1
        return
      }
      accountFilter = [mode, ...(accountFilter ?? [])]
      mode = 'show'
    }

    if (mode === 'set') {
      if (!target) {
        console.error('\n  Usage: codeburn accounts set <account> [--plan name] [--monthly-usd n] [--budget-usd n]\n')
        process.exitCode = 1
        return
      }
      const account = target.trim().toLowerCase()
      if (!account) {
        console.error('\n  Account name cannot be empty.\n')
        process.exitCode = 1
        return
      }
      if (opts?.monthlyUsd !== undefined && opts.monthlyUsd < 0) {
        console.error('\n  --monthly-usd must be >= 0.\n')
        process.exitCode = 1
        return
      }
      if (opts?.budgetUsd !== undefined && opts.budgetUsd < 0) {
        console.error('\n  --budget-usd must be >= 0.\n')
        process.exitCode = 1
        return
      }
      if (opts?.resetDay !== undefined && (opts.resetDay < 1 || opts.resetDay > 28)) {
        console.error('\n  --reset-day must be between 1 and 28.\n')
        process.exitCode = 1
        return
      }

      const config = await readConfig()
      const existing = config.accounts?.[account] ?? {}
      const updated: AccountConfig = {
        ...existing,
        ...(opts?.plan ? { plan: opts.plan } : {}),
        ...(opts?.monthlyUsd !== undefined ? { monthlyUsd: opts.monthlyUsd } : {}),
        ...(opts?.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
        ...(opts?.resetDay !== undefined ? { resetDay: opts.resetDay } : {}),
        setAt: new Date().toISOString(),
      }
      config.accounts = { ...(config.accounts ?? {}), [account]: updated }
      await saveConfig(config)
      console.log(`\n  Account saved: ${account}`)
      if (updated.plan) console.log(`  Plan: ${updated.plan}`)
      if (updated.monthlyUsd) console.log(`  Subscription: ${formatUSD(updated.monthlyUsd)}/month`)
      if (updated.budgetUsd) console.log(`  Budget: ${formatUSD(updated.budgetUsd)}/month`)
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (mode === 'reset') {
      if (!target) {
        console.error('\n  Usage: codeburn accounts reset <account>\n')
        process.exitCode = 1
        return
      }
      const account = target.trim().toLowerCase()
      if (!account) {
        console.error('\n  Account name cannot be empty.\n')
        process.exitCode = 1
        return
      }
      const config = await readConfig()
      if (config.accounts) {
        delete config.accounts[account]
        if (account !== target.trim()) delete config.accounts[target.trim()]
        if (Object.keys(config.accounts).length === 0) delete config.accounts
        await saveConfig(config)
      }
      console.log(`\n  Account config reset: ${account}\n`)
      return
    }

    if (mode !== 'show' && mode !== 'list') {
      console.error('\n  Usage: codeburn accounts [show | set <account> | reset <account>]\n')
      process.exitCode = 1
      return
    }

    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts?.from, opts?.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    await loadPricing()
    const period = toPeriod(opts?.period ?? 'month')
    const { range, label } = customRange
      ? { range: customRange, label: formatDateRangeLabel(opts?.from, opts?.to) }
      : getDateRange(period)
    const config = await readConfig()
    const projects = applyProjectFilters(
      await parseAllSessions(range, opts?.provider ?? 'all'),
      { project: opts?.project, exclude: opts?.exclude, account: accountFilter },
    )
    const report = buildAccountReport(projects, filterAccountConfig(config.accounts, accountFilter, projects) ?? {})

    if (opts?.format === 'json') {
      console.log(JSON.stringify({ generated: new Date().toISOString(), period: label, ...accountReportToJson(report) }, null, 2))
      return
    }

    printAccountReport(report, label)
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
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .action(async (opts) => {
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = filterProjectsByAccount(await parseAllSessions(range, opts.provider), opts.account)
    await runOptimize(projects, label, range)
  })

program
  .command('compare')
  .description('Compare two AI models side-by-side')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all', 'all')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--account <name>', 'Show only accounts matching label/path (repeatable)', collect, [])
  .action(async (opts) => {
    await loadPricing()
    const { range } = getDateRange(opts.period)
    await renderCompare(range, opts.provider, opts.account)
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

program.parse()
