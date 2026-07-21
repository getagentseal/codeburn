import { isAbsolute } from 'path'
import { Command, Option } from 'commander'
import { installMenubarApp } from './menubar-installer.js'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { findUnpricedModels, loadPricing, setModelAliases, setPriceOverrides, setLocalModelSavings, setProxyPaths, normalizeProxyPath } from './models.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDateRange, clearSessionCache, setInteractiveScanUI } from './parser.js'
import { allProviderNames, getAllProviders } from './providers/index.js'
import { convertCost, formatCost } from './currency.js'
import { renderStatusBar } from './format.js'
import { toDateString } from './daily-cache.js'
import { dateKey } from './day-aggregator.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { buildPeriodData, buildMenubarPayloadForRange, buildDurablePeriod, type DurablePeriod } from './usage-aggregator.js'
import { renderDashboard } from './dashboard.js'
import { renderOverview } from './overview.js'
import { runWebDashboard } from './web-dashboard.js'
import { hostname } from 'os'
import { runShareServer } from './sharing/share-run.js'
import { addRemote, linkRemote, pullDevices, renderDevices, summarizeDeviceUsage } from './sharing/host.js'
import { browse } from './sharing/discovery.js'
import { promptChoice } from './sharing/prompt.js'
import { loadOrCreateIdentity } from './sharing/identity.js'
import { pairingCode } from './sharing/pairing.js'
import { ShareController } from './sharing/share-controller.js'
import { getSharingDir, loadRemotes, saveRemotes } from './sharing/store.js'
import type { UsageQuery } from './sharing/share-server.js'
import { formatDateRangeLabel, parseDateRangeFlags, parseDayFlag, parseDaysFlag, getDateRange, toPeriod, type Period } from './cli-date.js'
import { runOptimize } from './optimize.js'
import { registerActCommands } from './act/cli.js'
import { registerGuardCommands } from './guard/cli.js'
import { registerSyncCommands } from './sync/cli.js'
import { runContextCommand } from './context-tree.js'
import { renderCompare } from './compare.js'
import { computeBudgetStatus, daysInMonth, diffCalendarDays, type BudgetStatus, type BudgetTier } from './budget.js'
import {
  installAntigravityStatusLineHook,
  runAgyStatusLineHook,
  uninstallAntigravityStatusLineHook,
} from './antigravity-statusline.js'
import { clearPlan, readConfig, readPlan, readPlans, saveConfig, savePlan, getConfigFilePath, type CodeburnConfig, type Plan, type PlanId, type PlanProvider } from './config.js'
import { clampResetDay, getPlanUsageOrNull, getPlanUsages, type PlanUsage } from './plan-usage.js'
import { getPresetPlan, isPlanId, isPlanProvider, PLAN_IDS, PLAN_PROVIDERS, planDisplayName } from './plans.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

// A downstream reader that closes the pipe early (`| head`, quitting `less`, or
// a missing command) makes stdout writes fail with EPIPE. Exit cleanly rather
// than crashing with an unhandled error event.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

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

type PriceOverrideConfig = NonNullable<CodeburnConfig['priceOverrides']>[string]

type PriceOverrideOptions = {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  remove?: string
  list?: boolean
  format?: string
}

type PriceOverrideRow = {
  model: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
  cacheCreationPerM?: number
}

function toPriceOverrideRows(overrides: Map<string, PriceOverrideConfig>): PriceOverrideRow[] {
  return [...overrides.entries()]
    .map(([model, rates]) => ({
      model,
      inputPerM: rates.input,
      outputPerM: rates.output,
      ...(typeof rates.cacheRead === 'number' ? { cacheReadPerM: rates.cacheRead } : {}),
      ...(typeof rates.cacheCreation === 'number' ? { cacheCreationPerM: rates.cacheCreation } : {}),
    }))
    .sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
}

function invalidUsdPerMillionRate(option: string, value: number | undefined): string | null {
  if (value === undefined) return null
  if (Number.isFinite(value) && value >= 0) return null
  return `Invalid ${option}: expected a finite number >= 0 (USD per 1,000,000 tokens).`
}

function formatPriceOverrideParts(rates: PriceOverrideConfig): string {
  const parts = [`input ${rates.input}`, `output ${rates.output}`]
  if (typeof rates.cacheRead === 'number') parts.push(`cache read ${rates.cacheRead}`)
  if (typeof rates.cacheCreation === 'number') parts.push(`cache creation ${rates.cacheCreation}`)
  return parts.join(', ')
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

type BudgetCommandOpts = {
  daily?: number
  weekly?: number
  monthly?: number
  list?: boolean
  remove?: string
  check?: boolean
}

type OverviewBudget = {
  tier: BudgetTier
  status: BudgetStatus
  inProgress: boolean
}

type BudgetPeriodInfo = {
  tier: BudgetTier
  range: DateRange
  elapsedDays: number
  totalDays: number
  inProgress: boolean
}

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

function formatDisplayCurrencyAmount(amount: number): string {
  const { rate } = getCurrency()
  return formatCost(rate > 0 ? amount / rate : amount)
}

function isValidBudgetAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function configuredBudgetEntries(budget: CodeburnConfig['budget']): Array<{ tier: BudgetTier; amount: number }> {
  const entries: Array<{ tier: BudgetTier; amount: number }> = []
  const daily = budget?.daily
  const weekly = budget?.weekly
  const monthly = budget?.monthly
  if (isValidBudgetAmount(daily)) entries.push({ tier: 'daily', amount: daily })
  if (isValidBudgetAmount(weekly)) entries.push({ tier: 'weekly', amount: weekly })
  if (isValidBudgetAmount(monthly)) entries.push({ tier: 'monthly', amount: monthly })
  return entries
}

function budgetTierForOverview(period: Period | undefined, customRange: DateRange | null): BudgetTier | undefined {
  if (customRange) return undefined
  if (period === 'today') return 'daily'
  if (period === 'week') return 'weekly'
  if (period === 'month') return 'monthly'
  return undefined
}

function budgetAmountForTier(budget: CodeburnConfig['budget'], tier: BudgetTier): number | undefined {
  const amount = tier === 'daily'
    ? budget?.daily
    : tier === 'weekly'
      ? budget?.weekly
      : budget?.monthly
  return isValidBudgetAmount(amount) ? amount : undefined
}

function periodForBudgetTier(tier: BudgetTier): Extract<Period, 'today' | 'week' | 'month'> {
  if (tier === 'daily') return 'today'
  if (tier === 'weekly') return 'week'
  return 'month'
}

function getBudgetPeriodInfo(tier: BudgetTier): BudgetPeriodInfo {
  const { range } = getDateRange(periodForBudgetTier(tier))
  const progress = getOverviewBudgetProgress(tier, range)
  return { tier, range, ...progress }
}

function getOverviewBudgetProgress(tier: BudgetTier, range: DateRange, today = new Date()): Pick<BudgetPeriodInfo, 'elapsedDays' | 'totalDays' | 'inProgress'> {
  if (tier === 'daily') return { elapsedDays: 1, totalDays: 1, inProgress: false }
  if (tier === 'weekly') return { elapsedDays: 7, totalDays: 7, inProgress: false }

  const totalDays = daysInMonth(today)
  const elapsedDays = Math.max(1, Math.min(totalDays, diffCalendarDays(range.start, today) + 1))
  return { elapsedDays, totalDays, inProgress: elapsedDays < totalDays }
}

function totalProjectCostUSD(projects: ProjectSummary[]): number {
  return projects.reduce((sum, project) => sum + project.totalCostUSD, 0)
}

function buildOverviewBudget(projects: ProjectSummary[], budget: CodeburnConfig['budget'], tier: BudgetTier | undefined, range: DateRange): OverviewBudget | undefined {
  if (!tier) return undefined
  const amount = budgetAmountForTier(budget, tier)
  if (amount === undefined) return undefined
  const progress = getOverviewBudgetProgress(tier, range)
  return {
    tier,
    status: computeBudgetStatus({
      spent: convertCost(totalProjectCostUSD(projects)),
      budget: amount,
      elapsedDays: progress.elapsedDays,
      totalDays: progress.totalDays,
    }),
    inProgress: progress.inProgress,
  }
}

function isOverviewBudgetFilterActive(opts: { provider: string; project: string[]; exclude: string[] }): boolean {
  return opts.provider !== 'all' || opts.project.length > 0 || opts.exclude.length > 0
}

function printBudgetList(budget: CodeburnConfig['budget']): void {
  const entries = configuredBudgetEntries(budget)
  if (entries.length === 0) {
    console.log('\n  No budgets configured.')
    console.log(`  Config: ${getConfigFilePath()}`)
    console.log('  Add one with: codeburn budget --monthly <amount>\n')
    return
  }

  console.log('\n  Budgets:')
  for (const entry of entries) {
    console.log(`    ${entry.tier}: ${formatDisplayCurrencyAmount(entry.amount)}`)
  }
  console.log(`  Config: ${getConfigFilePath()}\n`)
}

function validateBudgetSetters(opts: BudgetCommandOpts): boolean {
  const invalid: Array<{ flag: string; value: number | undefined }> = []
  if (opts.daily !== undefined && !isValidBudgetAmount(opts.daily)) invalid.push({ flag: '--daily', value: opts.daily })
  if (opts.weekly !== undefined && !isValidBudgetAmount(opts.weekly)) invalid.push({ flag: '--weekly', value: opts.weekly })
  if (opts.monthly !== undefined && !isValidBudgetAmount(opts.monthly)) invalid.push({ flag: '--monthly', value: opts.monthly })

  if (invalid.length === 0) return true

  for (const item of invalid) {
    console.error(`\n  ${item.flag} must be a finite number greater than 0 (got: ${String(item.value)}).\n`)
  }
  process.exitCode = 1
  return false
}

function assignBudgetSetters(config: CodeburnConfig, opts: BudgetCommandOpts): void {
  const budget = { ...(config.budget ?? {}) }
  if (opts.daily !== undefined) budget.daily = opts.daily
  if (opts.weekly !== undefined) budget.weekly = opts.weekly
  if (opts.monthly !== undefined) budget.monthly = opts.monthly
  config.budget = budget
}

function removeBudget(config: CodeburnConfig, tier: string): boolean {
  if (tier !== 'daily' && tier !== 'weekly' && tier !== 'monthly') {
    console.error(`\n  Unknown budget period: ${tier}. Use daily, weekly, or monthly.\n`)
    process.exitCode = 1
    return false
  }

  const budget = { ...(config.budget ?? {}) }
  if (tier === 'daily') delete budget.daily
  if (tier === 'weekly') delete budget.weekly
  if (tier === 'monthly') delete budget.monthly
  config.budget = configuredBudgetEntries(budget).length > 0 ? budget : undefined
  return true
}

async function runBudgetCheck(budget: CodeburnConfig['budget']): Promise<void> {
  const entries = configuredBudgetEntries(budget)
  if (entries.length === 0) {
    console.log('\n  No budgets configured.')
    console.log('  Add one with: codeburn budget --monthly <amount>\n')
    return
  }

  await loadPricing()

  let over = false
  console.log('')
  for (const entry of entries) {
    const period = getBudgetPeriodInfo(entry.tier)
    const projects = await parseAllSessions(period.range, 'all')
    const status = computeBudgetStatus({
      spent: convertCost(totalProjectCostUSD(projects)),
      budget: entry.amount,
      elapsedDays: period.elapsedDays,
      totalDays: period.totalDays,
    })
    const label = status.state === 'over' ? 'OVER' : status.state === 'warn' ? 'WARN' : 'OK'
    if (status.state === 'over') over = true
    console.log(`  ${entry.tier}: ${formatDisplayCurrencyAmount(status.spent)} of ${formatDisplayCurrencyAmount(status.budget)} (${Math.floor(status.pct)}%) [${label}]`)
    clearSessionCache()
  }
  console.log('')

  if (over) process.exitCode = 1
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

type AliasRow = { from: string; to: string }

function toAliasRows(aliases: Record<string, string>): AliasRow[] {
  return Object.entries(aliases)
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
}

function assertProvider(value: string, command: string): void {
  const names = allProviderNames()
  if (value === 'all' || names.includes(value)) return
  process.stderr.write(
    `codeburn ${command}: unknown provider "${value}". Valid values: all, ${names.join(', ')}.\n`
  )
  process.exit(1)
}

function assertScope(value: string, allowed: readonly string[], command: string): void {
  if (!allowed.includes(value)) {
    process.stderr.write(
      `codeburn ${command}: unknown scope "${value}". Valid values: ${allowed.join(', ')}.\n`
    )
    process.exit(1)
  }
}

async function runJsonReport(period: Period, provider: string, project: string[], exclude: string[]): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const durable = await buildDurablePeriod({ range, label }, { provider, project, exclude })
  const report: ReturnType<typeof buildJsonReport> & { plan?: JsonPlanSummary; plans?: JsonPlanSummaryMap } = await attachPlanSummaries(buildJsonReport(durable.liveProjects, label, period, durable))
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
  setPriceOverrides(config.priceOverrides ?? {})
  setLocalModelSavings(config.localModelSavings ?? {})
  setProxyPaths(config.proxyPaths ?? [])
  if (thisCommand.opts<{ verbose?: boolean }>().verbose) {
    process.env['CODEBURN_VERBOSE'] = '1'
  }
  await loadCurrency()
})

function buildJsonReport(projects: ProjectSummary[], period: string, periodKey: string, durable?: DurablePeriod) {
  const sessions = projects.flatMap(p => p.sessions)
  const { code } = getCurrency()

  // Headline totals come from the durable daily cache (carry-forward days whose
  // session files have expired still count), matching the menubar exactly. The
  // proxied/net split is a surviving-session concept (subscription attribution
  // isn't stored per day), so it stays live; net is taken off the durable total.
  const totalCostUSD = durable ? durable.data.cost : projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalSavingsUSD = durable ? durable.data.savingsUSD : projects.reduce((s, p) => s + p.totalSavingsUSD, 0)
  const totalEstimatedUSD = durable ? (durable.data.estimatedCostUSD ?? 0) : projects.reduce((s, p) => s + (p.totalEstimatedCostUSD ?? 0), 0)
  // Subscription-covered (proxied) portion of totalCostUSD, and the resulting
  // out-of-pocket figure. `cost` stays the full billable/would-be amount.
  const totalProxiedUSD = projects.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
  const netCostUSD = totalCostUSD - totalProxiedUSD
  const totalCalls = durable ? durable.data.calls : projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = durable ? durable.data.sessions : projects.reduce((s, p) => s + p.sessions.length, 0)
  const totalInput = durable ? durable.data.inputTokens : sessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = durable ? durable.data.outputTokens : sessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = durable ? durable.data.cacheReadTokens : sessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = durable ? durable.data.cacheWriteTokens : sessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
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
  // Daily rows come from the same durable day set as the headline so they sum
  // to it, carried days included. The live per-turn rollup (dailyMap) is only
  // the fallback for callers that pass no durable period.
  const daily = durable
    ? durable.days.map(d => {
        const turns = Object.values(d.categories).reduce((s, c) => s + c.turns, 0)
        return {
          date: d.date,
          cost: convertCost(d.cost),
          savings: convertCost(d.savingsUSD),
          calls: d.calls,
          turns,
          editTurns: d.editTurns,
          oneShotTurns: d.oneShotTurns,
          oneShotRate: d.editTurns > 0
            ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10
            : null,
        }
      })
    : Object.entries(dailyMap).sort().map(([date, d]) => ({
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

  const modelMap: Record<string, { calls: number; cost: number; savings: number; estimatedCost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; baselineModel: string }> = {}
  const modelEfficiency = aggregateModelEfficiency(projects)
  for (const sess of sessions) {
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelMap[model]) { modelMap[model] = { calls: 0, cost: 0, savings: 0, estimatedCost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, baselineModel: '' } }
      modelMap[model].calls += d.calls
      modelMap[model].cost += d.costUSD
      modelMap[model].savings += d.savingsUSD
      modelMap[model].estimatedCost += d.estimatedCostUSD ?? 0
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
    .map(([name, { cost, savings, estimatedCost, baselineModel, ...rest }]) => {
      const efficiency = modelEfficiency.get(name)
      return {
        name,
        ...rest,
        cost: convertCost(cost),
        savings: convertCost(savings),
        estimatedCost: convertCost(estimatedCost),
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
  // Claude Code only: real subagent-transcript spend grouped by agentType
  // (workflow-subagent / Explore / general-purpose / …). Distinct from
  // subagentMap, which is Task-tool-input based and never sees workflow agents.
  const agentTypeMap: Record<string, { calls: number; cost: number; savings: number }> = {}
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
    if (sess.agentType) {
      if (!agentTypeMap[sess.agentType]) agentTypeMap[sess.agentType] = { calls: 0, cost: 0, savings: 0 }
      agentTypeMap[sess.agentType].calls += sess.apiCalls
      agentTypeMap[sess.agentType].cost += sess.totalCostUSD
      agentTypeMap[sess.agentType].savings += sess.totalSavingsUSD
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
      // Portion of `cost` priced from estimated tokens (issue #639). Display/
      // metadata only; never subtracted from `cost`. 0 when nothing is estimated.
      estimatedCost: convertCost(totalEstimatedUSD),
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
    // Models with recorded usage that resolve to no pricing data right now
    // (#638). Their calls contribute $0 to every cost figure above, so
    // consumers can tell "cheap" from "uncounted". Empty when all models
    // priced. Fix entries via `codeburn model-alias` or `price-override`.
    unpricedModels: findUnpricedModels(Object.entries(modelMap).map(([model, d]) => ({
      model,
      calls: d.calls,
      cost: d.cost,
      tokens: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens,
    }))),
    activities,
    tools: sortedMap(toolMap),
    mcpServers: sortedMap(mcpMap),
    shellCommands: sortedMap(bashMap),
    skills: Object.entries(skillMap).sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings)).map(([name, d]) => ({ name, turns: d.turns, cost: convertCost(d.cost), savings: convertCost(d.savings) })),
    subagents: Object.entries(subagentMap).sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings)).map(([name, d]) => ({ name, calls: d.calls, cost: convertCost(d.cost), savings: convertCost(d.savings) })),
    claudeAgentTypes: Object.entries(agentTypeMap).sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings)).map(([name, d]) => ({ name, calls: d.calls, cost: convertCost(d.cost), savings: convertCost(d.savings) })),
    topSessions,
  }
}

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard')
  .option('-p, --period <period>', 'Starting period: today, week, 30days, month, all, lifetime', 'week')
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
    assertProvider(opts.provider, 'report')
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
        const durable = await buildDurablePeriod({ range, label }, { provider: opts.provider, project: opts.project, exclude: opts.exclude })
        console.log(JSON.stringify(await attachPlanSummaries(buildJsonReport(durable.liveProjects, label, periodKey, durable)), null, 2))
      } else {
        await runJsonReport(period, opts.provider, opts.project, opts.exclude)
      }
      return
    }
    const customRangeLabel = customRange ? formatDateRangeLabel(opts.from, opts.to) : undefined
    await renderDashboard(period, opts.provider, opts.refresh, opts.project, opts.exclude, customRange, customRangeLabel, daySelection?.day)
  })

program
  .command('share [action]')
  .description("Securely share this device's usage with your other devices. Actions: status. Supports --format json for status.")
  .option('--port <number>', 'Port to listen on', parseInteger, 7777)
  .option('--pair', 'Open a pairing window and print a PIN to add a new device')
  .option('--always', 'Keep sharing until stopped (default stops after 10 min idle)')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (action: string | undefined, opts) => {
    assertFormat(opts.format, ['text', 'json'], 'share')
    if (action === 'status') {
      const share = new ShareController(async () => ({}), opts.port)
      const status = await share.status()
      if (opts.format === 'json') {
        console.log(JSON.stringify(status))
        return
      }
      console.log(`\n  Sharing: ${status.sharing ? 'on' : 'off'}\n  Name: ${status.name}\n  Port: ${status.port}\n  Paired peers: ${status.peers}\n`)
      return
    }
    if (action !== undefined) {
      process.stderr.write('codeburn share: unknown action. Valid values: status.\n')
      process.exit(1)
    }
    if (opts.format === 'json') {
      process.stderr.write('codeburn share: --format json is only supported for `share status`.\n')
      process.exit(1)
    }
    await runShareServer({ port: opts.port, pair: !!opts.pair, always: !!opts.always })
  })

program
  .command('devices [action] [target]')
  .description('Combined usage across your devices. Actions: scan | add (find nearby & pair) | add <host> --pin <pin> (manual) | rm <name>. Supports --format json for read-only output and scan.')
  .option('--pin <pin>', 'Pairing PIN shown on the device you are adding')
  .option('-p, --period <period>', 'Period: today, week, 30days, month, all, lifetime', 'month')
  .option('--port <number>', 'Default port when adding a device', parseInteger, 7777)
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (action: string | undefined, target: string | undefined, opts) => {
    assertFormat(opts.format, ['text', 'json'], 'devices')
    await loadPricing()
    if (action === 'scan') {
      const dir = getSharingDir()
      const id = await loadOrCreateIdentity(dir)
      const pairedFps = new Set((await loadRemotes(dir)).map((r) => r.fingerprint))
      const found = (await browse(2500))
        .filter((d) => d.fingerprint !== id.fingerprint)
        .map((d) => ({
          name: d.name,
          host: d.host,
          port: d.port,
          fingerprint: d.fingerprint,
          code: pairingCode(id.fingerprint, d.fingerprint),
          paired: pairedFps.has(d.fingerprint),
        }))
      if (opts.format === 'json') {
        console.log(JSON.stringify({ found }))
        return
      }
      if (found.length === 0) {
        console.log('\n  No devices found. On the other Mac run `codeburn share`, and make sure both are on the same Wi-Fi.\n')
        return
      }
      process.stdout.write('\n  Found devices:\n')
      for (const d of found) {
        process.stdout.write(`    ${d.name} (${d.host}:${d.port}) ${d.paired ? '[paired]' : `[code ${d.code}]`}\n`)
      }
      process.stdout.write('\n')
      return
    }
    if (opts.format === 'json' && action !== undefined) {
      process.stderr.write('codeburn devices: --format json is only supported for read-only devices output and scan.\n')
      process.exit(1)
    }
    if (action === 'add') {
      if (target && opts.pin) {
        const device = await addRemote(target, opts.pin, { defaultPort: opts.port })
        console.log(`\n  Paired with "${device.name}" (${device.host}:${device.port}).\n`)
        return
      }
      process.stdout.write('\n  Looking for devices on your network...\n')
      const found = await browse(3000)
      if (found.length === 0) {
        console.error('  No devices found. On the other Mac run `codeburn share`, and make sure both are on the same Wi-Fi.\n')
        process.exit(1)
      }
      let chosen = found[0]!
      if (found.length > 1) {
        found.forEach((d, i) => process.stdout.write(`    ${i + 1}) ${d.name} (${d.host})\n`))
        const n = await promptChoice('  Connect to which? [number]', found.length)
        if (n < 1) {
          console.error('  Cancelled.\n')
          process.exit(1)
        }
        chosen = found[n - 1]!
      }
      const device = await linkRemote(chosen, {
        onCode: (code) =>
          process.stdout.write(`\n  Connecting to "${chosen.name}". Confirm this code on that device:  ${code}\n  Waiting for approval...\n`),
      })
      console.log(`\n  Paired with "${device.name}".\n`)
      return
    }
    if (action === 'rm' || action === 'remove') {
      const remotes = await loadRemotes()
      const next = remotes.filter((r) => r.name !== target && `${r.host}:${r.port}` !== target)
      await saveRemotes(next)
      console.log(`\n  Removed ${remotes.length - next.length} device(s).\n`)
      return
    }
    const localGetUsage = async (q: { period?: string; from?: string; to?: string }) => {
      const customRange = parseDateRangeFlags(q.from, q.to)
      const periodInfo = customRange
        ? { range: customRange, label: formatDateRangeLabel(q.from, q.to) }
        : getDateRange(toPeriod(q.period ?? opts.period))
      return buildMenubarPayloadForRange(periodInfo, { provider: 'all', optimize: false })
    }
    const results = await pullDevices(localGetUsage, { period: opts.period }, hostname(), {})
    if (opts.format === 'json') {
      console.log(JSON.stringify(summarizeDeviceUsage(results)))
      return
    }
    process.stdout.write('\n' + renderDevices(results))
  })

program
  .command('identity')
  .description('Show this device identity for sharing')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (opts) => {
    assertFormat(opts.format, ['text', 'json'], 'identity')
    const id = await loadOrCreateIdentity(getSharingDir())
    const publicIdentity = { name: id.name, fingerprint: id.fingerprint }
    if (opts.format === 'json') {
      console.log(JSON.stringify(publicIdentity))
      return
    }
    console.log(`\n  Name: ${publicIdentity.name}\n  Fingerprint: ${publicIdentity.fingerprint}\n`)
  })

program
  .command('overview')
  .description('Plain-text usage overview, copy-pasteable (defaults to this month)')
  .option('-p, --period <period>', 'Period: today, week, 30days, month, all, lifetime', 'month')
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--no-color', 'Disable ANSI colors')
  .action(async (opts) => {
    assertProvider(opts.provider, 'overview')
    await loadPricing()
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
    const period = customRange ? undefined : toPeriod(opts.period)
    const { range, label } = customRange
      ? { range: customRange, label: formatDateRangeLabel(opts.from, opts.to) }
      : getDateRange(period!)
    const durable = await buildDurablePeriod({ range, label }, { provider: opts.provider, project: opts.project, exclude: opts.exclude })
    const projects = durable.liveProjects
    const config = await readConfig()
    const budget = isOverviewBudgetFilterActive(opts)
      ? undefined
      : buildOverviewBudget(projects, config.budget, budgetTierForOverview(period, customRange), range)
    process.stdout.write(renderOverview(projects, {
      label,
      color: opts.color,
      budget,
      durable: {
        cost: durable.data.cost,
        savingsUSD: durable.data.savingsUSD,
        calls: durable.data.calls,
        sessions: durable.data.sessions,
        inputTokens: durable.data.inputTokens,
        outputTokens: durable.data.outputTokens,
        cacheReadTokens: durable.data.cacheReadTokens,
        cacheWriteTokens: durable.data.cacheWriteTokens,
        days: durable.days,
        carriedCostUSD: durable.carriedCostUSD,
      },
    }))
  })

program
  .command('budget')
  .description('Set spend budgets and check current spend against them')
  .option('--daily <amt>', 'Set daily spend budget in the active display currency', parseNumber)
  .option('--weekly <amt>', 'Set weekly spend budget in the active display currency', parseNumber)
  .option('--monthly <amt>', 'Set monthly spend budget in the active display currency', parseNumber)
  .option('--list', 'List configured spend budgets')
  .option('--remove <period>', 'Remove one budget: daily, weekly, or monthly')
  .option('--check', 'Check current spend and exit 1 if any configured budget is over')
  .action(async (opts: BudgetCommandOpts) => {
    const config = await readConfig()
    const hasSetter = opts.daily !== undefined || opts.weekly !== undefined || opts.monthly !== undefined

    if (opts.list || (!hasSetter && !opts.remove && !opts.check)) {
      printBudgetList(config.budget)
      return
    }

    if (opts.remove) {
      if (!removeBudget(config, opts.remove)) return
      await saveConfig(config)
      console.log(`\n  Removed ${opts.remove} budget.`)
      console.log(`  Config: ${getConfigFilePath()}\n`)
      return
    }

    if (opts.check) {
      await runBudgetCheck(config.budget)
      return
    }

    if (!validateBudgetSetters(opts)) return
    assignBudgetSetters(config, opts)
    await saveConfig(config)
    console.log('\n  Budget saved.')
    printBudgetList(config.budget)
  })

program
  .command('web')
  .description('Open the local web dashboard in your browser')
  .option('-p, --period <period>', 'Initial period: today, week, 30days, month, all, lifetime', 'today')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--port <number>', 'Port to listen on (falls back to a free port if taken)', parseInteger, 4747)
  .option('--no-open', 'Do not open the browser automatically')
  .action(async (opts) => {
    assertProvider(opts.provider, 'web')
    await runWebDashboard({
      period: opts.period,
      provider: opts.provider,
      from: opts.from,
      to: opts.to,
      project: opts.project,
      exclude: opts.exclude,
      port: opts.port,
      open: opts.open,
    })
  })

program
  .command('status')
  .description('Compact status output (today + month)')
  .option('--format <format>', 'Output format: terminal, menubar-json, json', 'terminal')
  .option('--scope <scope>', 'Usage scope for menubar-json: local, combined', 'local')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--period <period>', 'Primary period for menubar-json: today, week, 30days, month, all, lifetime', 'today')
  .option('--day <date>', 'Single day for menubar-json (YYYY-MM-DD, today, or yesterday). Overrides --period when set')
  .option('--from <date>', 'Start date (YYYY-MM-DD) for custom range')
  .option('--to <date>', 'End date (YYYY-MM-DD) for custom range')
  .option('--days <dates>', 'Comma-separated dates (YYYY-MM-DD) for multi-day selection')
  .option('--no-optimize', 'Skip optimize findings (menubar-json only, faster)')
  .option('--no-timeline', 'Skip the granular timeline (menubar-json only, faster)')
  .addOption(new Option('--claude-config-source <id>').hideHelp())
  .action(async (opts) => {
    assertFormat(opts.format, ['terminal', 'menubar-json', 'json'], 'status')
    assertScope(opts.scope, ['local', 'combined'], 'status')
    assertProvider(opts.provider, 'status')
    if (opts.day && (opts.from || opts.to)) {
      process.stderr.write('error: --day cannot be combined with --from or --to\n')
      process.exit(1)
    }
    if (opts.days && (opts.day || opts.from || opts.to)) {
      process.stderr.write('error: --days cannot be combined with --day, --from, or --to\n')
      process.exit(1)
    }
    if (opts.format === 'menubar-json' && opts.scope === 'combined' && opts.days) {
      process.stderr.write('error: --scope combined cannot be combined with --days\n')
      process.exit(1)
    }
    if (opts.format === 'menubar-json' && opts.scope === 'combined' && opts.claudeConfigSource) {
      process.stderr.write('error: --scope combined cannot be combined with --claude-config-source\n')
      process.exit(1)
    }
    // A Claude config source scopes Claude usage only, so it is contradictory
    // with a non-Claude provider filter. 'all' is fine (it resolves to that
    // config's Claude data).
    if (opts.claudeConfigSource && opts.provider !== 'all' && opts.provider !== 'claude') {
      process.stderr.write(`error: --claude-config-source cannot be combined with --provider ${opts.provider} (a Claude config scopes Claude usage only)\n`)
      process.exit(1)
    }
    if (opts.scope === 'combined' && (opts.provider !== 'all' || opts.project.length > 0 || opts.exclude.length > 0)) {
      process.stderr.write('error: --scope combined cannot be combined with --provider, --project, or --exclude (paired devices report unfiltered usage)\n')
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
        timeline: opts.timeline !== false,
        claudeConfigSourceId: opts.claudeConfigSource,
      })
      if (opts.scope === 'combined') {
        // Combined multi-device usage is best-effort enrichment on the menubar's
        // hot path. Never let pulling peers (or a corrupt remotes store) take
        // down the base local payload: on any failure, emit local data with
        // `combined` omitted so the menubar always gets a valid response.
        try {
          const query: UsageQuery = customRange
            ? { from: opts.from, to: opts.to }
            : daySelection
            ? { from: daySelection.day, to: daySelection.day }
            : { period: opts.period }
          const localGetUsage = async (): Promise<typeof payload> => payload
          const results = await pullDevices(localGetUsage, query, hostname(), {})
          payload.combined = summarizeDeviceUsage(results, {
            start: toDateString(periodInfo.range.start),
            end: toDateString(periodInfo.range.end),
          })
        } catch {
          // best-effort only: the local payload is still emitted below
        }
      }
      console.log(JSON.stringify(payload))
      return
    }

    if (opts.format === 'json') {
      // Durable totals so the compact status matches the menubar / report.
      const todayDurable = await buildDurablePeriod(getDateRange('today'), { provider: pf, project: opts.project, exclude: opts.exclude })
      const todayData = todayDurable.data
      const todayProjects = todayDurable.liveProjects
      const monthDurable = await buildDurablePeriod(getDateRange('month'), { provider: pf, project: opts.project, exclude: opts.exclude })
      const monthData = monthDurable.data
      const monthProjects = monthDurable.liveProjects
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

    const todayDurable = await buildDurablePeriod(getDateRange('today'), { provider: pf, project: opts.project, exclude: opts.exclude })
    const monthDurable = await buildDurablePeriod(getDateRange('month'), { provider: pf, project: opts.project, exclude: opts.exclude })
    console.log(renderStatusBar([], {
      today: { cost: todayDurable.data.cost, calls: todayDurable.data.calls },
      month: { cost: monthDurable.data.cost, calls: monthDurable.data.calls },
    }))
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
    assertProvider(opts.provider, 'today')
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
    assertProvider(opts.provider, 'month')
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
    assertProvider(opts.provider, 'export')
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

    if (periods.every(p => p.projects.length === 0) && opts.format !== 'json') {
      // Human-readable prose for CSV / interactive use. JSON falls through and
      // writes a valid, schema-matching file with empty arrays so programmatic
      // consumers always get parseable output, never prose.
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
      const result = await installMenubarApp({ force: opts.force, cliVersion: version })
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
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (from?: string, to?: string, opts?: { remove?: string; list?: boolean; format?: string }) => {
    const format = opts?.format ?? 'text'
    assertFormat(format, ['text', 'json'], 'model-alias')
    const config = await readConfig()
    const aliases = config.modelAliases ?? {}

    if (opts?.list || (!from && !opts?.remove)) {
      if (format === 'json') {
        console.log(JSON.stringify(toAliasRows(aliases), null, 2))
        return
      }
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
  .command('price-override [model]')
  .description('Override or add local model pricing. Rates are USD per 1,000,000 tokens (e.g. --input 0.27).')
  .option('--input <usd-per-1M>', 'Input token price in USD per 1,000,000 tokens', parseNumber)
  .option('--output <usd-per-1M>', 'Output token price in USD per 1,000,000 tokens', parseNumber)
  .option('--cache-read <usd-per-1M>', 'Cache-read token price in USD per 1,000,000 tokens', parseNumber)
  .option('--cache-creation <usd-per-1M>', 'Cache-creation token price in USD per 1,000,000 tokens', parseNumber)
  .option('--remove <model>', 'Remove a price override')
  .option('--list', 'List configured price overrides')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (model?: string, opts?: PriceOverrideOptions) => {
    const format = opts?.format ?? 'text'
    assertFormat(format, ['text', 'json'], 'price-override')
    const config = await readConfig()
    const overrides = new Map<string, PriceOverrideConfig>(Object.entries(config.priceOverrides ?? {}))

    if (opts?.list || (!model && !opts?.remove)) {
      if (format === 'json') {
        console.log(JSON.stringify({ overrides: toPriceOverrideRows(overrides), configPath: getConfigFilePath() }, null, 2))
        return
      }
      const entries = [...overrides.entries()]
      if (entries.length === 0) {
        console.log('\n  No price overrides configured.')
        console.log('  Rates use USD per 1,000,000 tokens.')
        console.log(`  Config: ${getConfigFilePath()}`)
        console.log('  Add one with: codeburn price-override <model> --input <usd-per-1M> --output <usd-per-1M>\n')
      } else {
        console.log('\n  Price overrides (USD per 1,000,000 tokens):')
        for (const [name, rates] of entries) {
          console.log(`    ${name}: ${formatPriceOverrideParts(rates)}`)
        }
        console.log(`  Config: ${getConfigFilePath()}\n`)
      }
      return
    }

    if (opts?.remove) {
      if (!overrides.has(opts.remove)) {
        console.error(`\n  Price override not found: ${opts.remove}\n`)
        process.exitCode = 1
        return
      }
      overrides.delete(opts.remove)
      config.priceOverrides = overrides.size > 0 ? Object.fromEntries(overrides) : undefined
      await saveConfig(config)
      console.log(`\n  Removed price override: ${opts.remove}\n`)
      return
    }

    const input = opts?.input
    const output = opts?.output
    const cacheRead = opts?.cacheRead
    const cacheCreation = opts?.cacheCreation
    if (!model || input === undefined || output === undefined) {
      console.error('\n  Usage: codeburn price-override <model> --input <usd-per-1M> --output <usd-per-1M> [--cache-read <usd-per-1M>] [--cache-creation <usd-per-1M>]\n')
      process.exitCode = 1
      return
    }

    const invalidRate = [
      invalidUsdPerMillionRate('--input', input),
      invalidUsdPerMillionRate('--output', output),
      invalidUsdPerMillionRate('--cache-read', cacheRead),
      invalidUsdPerMillionRate('--cache-creation', cacheCreation),
    ].find((message): message is string => message !== null)
    if (invalidRate) {
      console.error(`\n  ${invalidRate}\n`)
      process.exitCode = 1
      return
    }

    const override: PriceOverrideConfig = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheCreation !== undefined ? { cacheCreation } : {}),
    }
    overrides.set(model, override)
    config.priceOverrides = Object.fromEntries(overrides)
    await saveConfig(config)
    console.log(`\n  Price override saved: ${model}: ${formatPriceOverrideParts(override)}`)
    console.log('  Unit: USD per 1,000,000 tokens')
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
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (path?: string, opts?: { remove?: string; list?: boolean; format?: string }) => {
    const format = opts?.format ?? 'text'
    assertFormat(format, ['text', 'json'], 'proxy-path')
    const config = await readConfig()
    // Sanitize the on-disk shape the same way setProxyPaths does: a hand-edited
    // config.json could have proxyPaths as a non-array or hold non-string
    // entries, which would otherwise throw when spread or normalized below.
    const paths = (Array.isArray(config.proxyPaths) ? config.proxyPaths : [])
      .filter((p): p is string => typeof p === 'string')
    const samePath = (a: string, b: string) => normalizeProxyPath(a) === normalizeProxyPath(b)

    if (opts?.list || (!path && !opts?.remove)) {
      if (format === 'json') {
        console.log(JSON.stringify(paths, null, 2))
        return
      }
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
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all, lifetime', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: text, json', 'text')
  .option('--json', 'Output findings as JSON (alias for --format json)')
  .option('--apply', 'Interactively apply config-class fixes (backed up, journaled, undoable)')
  .option('--yes', 'With --apply: apply every appliable fix without prompting')
  .option('--dry-run', 'With --apply: print the plan and exit without changing anything')
  .option('--only <ids>', 'With --apply: restrict to a comma-separated list of finding ids')
  .action(async (opts) => {
    assertProvider(opts.provider, 'optimize')
    const format = opts.json ? 'json' : opts.format
    if (opts.apply && format === 'json') {
      process.stderr.write('codeburn optimize: --apply cannot be combined with --json\n')
      process.exit(2)
    }
    await loadPricing()
    let range: DateRange
    let label: string
    if (opts.from || opts.to) {
      try {
        range = parseDateRangeFlags(opts.from, opts.to)!
        label = formatDateRangeLabel(opts.from, opts.to)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`\n  Error: ${message}\n`)
        process.exit(1)
      }
    } else {
      ({ range, label } = getDateRange(opts.period))
    }
    const projects = await parseAllSessions(range, opts.provider)
    if (opts.apply) {
      const { runOptimizeApply } = await import('./act/optimize-apply.js')
      await runOptimizeApply(projects, range, { yes: opts.yes, dryRun: opts.dryRun, only: opts.only })
      return
    }
    assertFormat(format, ['text', 'json'], 'optimize')
    if (format === 'text') {
      // Surface realized savings from applied actions. Best effort: optimize
      // must never fail because of journal contents, so any error just drops
      // the header. computeActReport returns fast without scanning when the
      // journal has no eligible applied actions, so users who never opted in
      // see identical output.
      let appliedHeader: string | undefined
      let previouslyApplied: Record<string, string> | undefined
      try {
        const { computeActReport, buildOptimizeAppliedHeader } = await import('./act/report.js')
        const applied = await computeActReport()
        appliedHeader = buildOptimizeAppliedHeader(applied) ?? undefined
        previouslyApplied = applied.appliedByFinding
      } catch { /* the header is optional; never block the findings */ }
      await runOptimize(projects, label, range, { format, appliedHeader, previouslyApplied })
    } else {
      await runOptimize(projects, label, range, { format })
    }
  })

program
  .command('context [session]')
  .description('Context token breakdown per session: what fills the window, by role, block type, and tool (experimental). No session argument opens an interactive browser.')
  .option('--list', 'List recent sessions to pick from')
  .option('--full', 'Cover the whole session history instead of the live (post-compaction) window')
  .option('--json', 'JSON output')
  .option('--provider <provider>', 'Session source: claude or codex', 'claude')
  .action(async (session: string | undefined, opts: { list?: boolean; full?: boolean; json?: boolean; provider?: string }) => {
    if (opts.provider !== 'claude' && opts.provider !== 'codex') {
      console.error('context: --provider must be claude or codex')
      process.exitCode = 1
      return
    }
    if (!session && !opts.list && !opts.json && process.stdout.isTTY && process.stdin.isTTY) {
      const { runContextTui } = await import('./context-tui.js')
      await runContextTui({ initialScope: opts.full ? 'full' : 'effective' })
      return
    }
    await runContextCommand(session, opts)
  })

program
  .command('compare')
  .description('Compare two AI models side-by-side')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all, lifetime', 'all')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, gemini, cursor, copilot)', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--model-a <model>', 'First model to compare')
  .option('--model-b <model>', 'Second model to compare')
  .action(async (opts) => {
    assertProvider(opts.provider, 'compare')
    assertFormat(opts.format, ['tui', 'json'], 'compare')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    if (opts.format === 'json') {
      const { aggregateModelStats, buildCompareJson, renderCompareJson, scanSelfCorrections } = await import('./compare-stats.js')
      const projects = await parseAllSessions(range, opts.provider)
      const models = aggregateModelStats(projects)

      const providers = await getAllProviders()
      const dirs: string[] = []
      for (const provider of providers) {
        const sessions = await provider.discoverSessions()
        for (const session of sessions) dirs.push(session.path)
      }
      const corrections = await scanSelfCorrections(dirs)
      for (const model of models) {
        model.selfCorrections = corrections.get(model.model) ?? 0
      }

      if (!opts.modelA && !opts.modelB) {
        process.stdout.write(JSON.stringify(models, null, 2) + '\n')
        return
      }
      if (!opts.modelA || !opts.modelB) {
        process.stderr.write('codeburn compare: --model-a and --model-b must be provided together.\n')
        process.exit(1)
      }
      const modelA = models.find(model => model.model === opts.modelA)
      const modelB = models.find(model => model.model === opts.modelB)
      if (!modelA) {
        process.stderr.write(`codeburn compare: model not found: "${opts.modelA}".\n`)
        process.exit(1)
      }
      if (!modelB) {
        process.stderr.write(`codeburn compare: model not found: "${opts.modelB}".\n`)
        process.exit(1)
      }
      process.stdout.write(renderCompareJson(buildCompareJson(projects, modelA, modelB, label, opts.provider)) + '\n')
      return
    }
    await renderCompare(range, opts.provider)
  })

program
  .command('audit')
  .description("Token audit: raw provider token fields vs codeburn's displayed totals and cost derivation")
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all, lifetime', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--format <format>', 'Output format: table, json', 'table')
  .action(async (opts) => {
    assertProvider(opts.provider, 'audit')
    const { aggregateAudit, renderAuditTable, renderAuditJson } = await import('./audit-report.js')
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
    const rows = await aggregateAudit(projects)

    const fmt = (opts.format ?? 'table').toLowerCase()
    if (fmt === 'json') {
      process.stdout.write(renderAuditJson(rows) + '\n')
    } else {
      if (rows.length === 0) {
        process.stdout.write('No model usage found for the selected period.\n')
        return
      }
      process.stdout.write(renderAuditTable(rows) + '\n')
    }
  })

program
  .command('models')
  .description('Per-model token + cost table, optionally exploded by task type or agent')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all, lifetime', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--task <category>', 'Filter to one task type (e.g. feature, debugging, refactoring)')
  .option('--by-task', 'One row per (provider, model, task) instead of one row per (provider, model)')
  .option('--by-agent', 'One row per (provider, model, agent) instead of one row per (provider, model). Claude subagent transcripts only; other providers and main sessions bucket under "main"')
  .option('--top <n>', 'Show only the top N rows', (v: string) => parseInt(v, 10))
  .option('--min-cost <usd>', 'Hide rows below this cost threshold', (v: string) => parseFloat(v))
  .option('--no-totals', 'Suppress the footer totals row')
  .option('--format <format>', 'Output format: table, markdown, json, csv', 'table')
  .action(async (opts) => {
    assertProvider(opts.provider, 'models')
    if (opts.byTask && opts.byAgent) {
      process.stderr.write('codeburn: --by-task and --by-agent cannot be combined. Pick one breakdown.\n')
      process.exit(1)
    }
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
      byAgent: !!opts.byAgent,
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
      process.stdout.write(renderCsv(rows, { byTask: !!opts.byTask, byAgent: !!opts.byAgent }) + '\n')
    } else if (fmt === 'markdown' || fmt === 'md') {
      process.stdout.write(renderMarkdown(rows, { byTask: !!opts.byTask, byAgent: !!opts.byAgent, showTotals: opts.totals !== false }) + '\n')
    } else if (fmt === 'table') {
      process.stdout.write(renderTable(rows, { byTask: !!opts.byTask, byAgent: !!opts.byAgent, showTotals: opts.totals !== false }) + '\n')
    } else {
      process.stderr.write(`codeburn: unknown --format "${opts.format}". Choose table, markdown, json, or csv.\n`)
      process.exit(1)
    }
  })

program
  .command('sessions')
  .description('Full per-session usage report')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all, lifetime', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--format <format>', 'Output format: table, json', 'table')
  .option('--by-pr', 'Group spend by the pull requests each session referenced')
  .option('--no-pager', 'Print the complete table directly instead of opening the interactive browser')
  .action(async (opts) => {
    assertProvider(opts.provider, 'sessions')
    assertFormat(opts.format, ['table', 'json'], 'sessions')
    const { aggregateSessions, buildPrAttribution, renderJson, renderTable } = await import('./sessions-report.js')
    const wantsInteractive = opts.format === 'table' && !opts.byPr && opts.pager !== false && process.stdin.isTTY === true && process.stdout.isTTY === true
    if (wantsInteractive) setInteractiveScanUI()
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
    if (opts.byPr) {
      const { rows: prRows, totals } = buildPrAttribution(projects)
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify({ prs: prRows, distinct: totals }, null, 2) + '\n')
        return
      }
      if (prRows.length === 0) {
        process.stdout.write('No sessions with captured PR links in this period. Links are captured as sessions are parsed; older transcripts gain them on their next re-parse.\n')
        return
      }
      const { unattributedCost, sessions, subagentSessions } = totals
      const { renderTable: renderTextTable } = await import('./text-table.js')
      const modelsCell = (models: string[]): string =>
        models.length === 0 ? '' : models.slice(0, 2).join(', ') + (models.length > 2 ? ` +${models.length - 2}` : '')
      const table = renderTextTable(
        [
          { header: 'PR' },
          { header: 'Cost', right: true },
          { header: 'Saved', right: true },
          { header: 'Sessions', right: true },
          { header: 'Calls', right: true },
          { header: 'Models' },
          { header: 'First' },
          { header: 'Last' },
        ],
        prRows.map(r => [
          r.label,
          `${r.approx ? '~' : ''}$${r.cost.toFixed(2)}`,
          `$${r.savingsUSD.toFixed(2)}`,
          String(r.sessions),
          String(r.calls),
          modelsCell(r.models),
          r.firstStarted.slice(0, 10),
          r.lastEnded.slice(0, 10),
        ]),
      )
      // Footer reconciles to the ROUNDED row values actually printed (not the
      // exact float sum), so the visible column adds up to the stated total.
      const shownAttributed = prRows.reduce((sum, r) => sum + Number(r.cost.toFixed(2)), 0)
      const approxNote = prRows.some(r => r.approx)
        ? ' ~ marks rows estimated from a whole-session even split (transcript expired before per-turn capture).'
        : ''
      const subagentNote = subagentSessions > 0
        ? ` + ${subagentSessions} folded-in subagent run${subagentSessions === 1 ? '' : 's'}`
        : ''
      process.stdout.write(table + `\nRows sum to $${shownAttributed.toFixed(2)} attributed across ${sessions} PR-linked session${sessions === 1 ? '' : 's'}${subagentNote}. $${unattributedCost.toFixed(2)} of that spend was not tied to a specific PR.${approxNote}\n`)
      return
    }
    const rows = aggregateSessions(projects)
    if (opts.format === 'json') {
      process.stdout.write(renderJson(rows) + '\n')
      return
    }

    if (wantsInteractive) {
      const { runSessionsTui } = await import('./sessions-tui.js')
      await runSessionsTui(rows, { period: opts.from || opts.to ? formatDateRangeLabel(opts.from, opts.to) : opts.period, provider: opts.provider })
      return
    }
    process.stdout.write(renderTable(rows) + '\n')
  })

program
  .command('yield')
  .description('Track which AI spend shipped to main vs reverted/abandoned (experimental)')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all, lifetime', 'week')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--format <format>', 'Output format: text, json', 'text')
  .action(async (opts) => {
    assertFormat(opts.format, ['text', 'json'], 'yield')
    assertProvider(opts.provider, 'yield')
    const { computeYield, formatYieldSummary, buildYieldJsonReport } = await import('./yield.js')
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    if (opts.format !== 'json') {
      console.log(`\n  Analyzing yield for ${label}...\n`)
    }
    const summary = await computeYield(range, process.cwd(), opts.provider)
    if (opts.format === 'json') {
      console.log(JSON.stringify(buildYieldJsonReport(summary, label, range), null, 2))
      return
    }
    console.log(formatYieldSummary(summary))
  })

program
  .command('spend')
  .description('Emit model x project spend flow data')
  .option('-p, --period <period>', 'Analysis period: today, week, 30days, month, all, lifetime', '30days')
  .option('--from <date>', 'Custom range start (YYYY-MM-DD)')
  .option('--to <date>', 'Custom range end (YYYY-MM-DD)')
  .option('--provider <provider>', 'Filter by provider (e.g. claude, codex, cursor)', 'all')
  .option('--format <format>', 'Output format: flow-json', 'flow-json')
  .action(async (opts) => {
    assertFormat(opts.format, ['flow-json'], 'spend')
    assertProvider(opts.provider, 'spend')
    const { computeSpendFlow } = await import('./spend-flow.js')
    await loadPricing()

    let range: DateRange
    if (opts.from || opts.to) {
      try {
        range = parseDateRangeFlags(opts.from, opts.to)!
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`\n  Error: ${message}\n`)
        process.exit(1)
      }
    } else {
      range = getDateRange(opts.period).range
    }

    console.log(JSON.stringify(await computeSpendFlow(range, opts.provider)))
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
        const headline = result === 'already-installed'
          ? 'Antigravity CLI usage capture is already installed.'
          : 'Antigravity CLI usage capture installed.'
        console.log(`\n  ${headline}\n  Note: this captures CLI (agy) sessions only. IDE sessions are read from .db files automatically.\n`)
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

program
  .command('doctor')
  .description('Per-provider detection status: paths probed, sessions found, parse health (diagnose empty or wrong numbers)')
  .option('--provider <provider>', 'Diagnose a single provider (e.g. claude, codex, opencode)', 'all')
  .option('--json', 'Output machine-readable JSON')
  .option('--no-color', 'Disable ANSI colors')
  .action(async (opts) => {
    assertProvider(opts.provider, 'doctor')
    const { collectDoctorReport, renderDoctorTable, renderDoctorJson } = await import('./doctor.js')
    const report = await collectDoctorReport(opts.provider)
    if (opts.json) {
      process.stdout.write(renderDoctorJson(report) + '\n')
      return
    }
    process.stdout.write(renderDoctorTable(report, { color: opts.color }))
  })

registerActCommands(program)
registerGuardCommands(program)
registerSyncCommands(program)

program.parse()
