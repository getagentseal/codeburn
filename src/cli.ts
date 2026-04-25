import { Command, InvalidArgumentError, Option } from 'commander'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing } from './models.js'
import { parseAllSessions, filterProjectsByName } from './parser.js'
import { renderStatusBar } from './format.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { renderDashboard } from './dashboard.js'
import { formatCustomDateRangeLabel, getDateRange, localDateString, parseDateRangeFlags, PERIOD_LABELS, PERIODS, type Period } from './cli-date.js'
import { runOptimize } from './optimize.js'
import { readConfig, saveConfig, getConfigFilePath } from './config.js'
import { loadBillingConfig } from './billing.js'
import { MACHINE_OUTPUT_SCHEMA_VERSION, REPORT_OUTPUT_SCHEMA, STATUS_OUTPUT_SCHEMA } from './output-schema.js'
import {
  addBillingAggregate,
  aggregateCallsBilling,
  aggregateSessionsBilling,
  billingAggregateFromProject,
  billingJsonFields,
  billingMetricValue,
  buildBillingMetadata,
  emptyBillingAggregate,
  round2,
  type BillingAggregate,
} from './billing-output.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

const TUI_FORMATS = ['tui', 'json'] as const
const STATUS_FORMATS = ['terminal', 'json'] as const
const EXPORT_FORMATS = ['csv', 'json'] as const

function parseRefreshSeconds(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError('must be a positive integer')
  }
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds)) {
    throw new InvalidArgumentError('must be a safe integer')
  }
  return seconds
}

function periodOption(description: string, defaultValue: Period): Option {
  return new Option('-p, --period <period>', description).choices(PERIODS).default(defaultValue)
}

function formatOption(description: string, choices: readonly string[], defaultValue: string, flags = '--format <format>'): Option {
  return new Option(flags, description).choices(choices).default(defaultValue)
}

function refreshOption(): Option {
  return new Option('--refresh <seconds>', 'Auto-refresh interval in seconds').argParser(parseRefreshSeconds)
}

function collect(val: string, acc: string[]): string[] {
  acc.push(val)
  return acc
}

async function runJsonReport(period: Period, project: string[], exclude: string[]): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const projects = filterProjectsByName(await parseAllSessions(range), project, exclude)
  console.log(JSON.stringify(buildJsonReport(projects, label, period), null, 2))
}

const program = new Command()
  .name('codeburn')
  .description('See where your Auggie tokens (and credits) go - by task, tool, model, and project')
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
  const billingConfig = loadBillingConfig()
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const totalInput = sessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = sessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = sessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = sessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  const cacheHitDenom = totalInput + totalCacheRead
  const cacheHitPercent = cacheHitDenom > 0 ? round2((totalCacheRead / cacheHitDenom) * 100) : 0
  const overviewBilling = aggregateSessionsBilling(sessions)

  const dailyMap: Record<string, { billing: BillingAggregate; calls: number }> = {}
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      if (!turn.timestamp) continue
      const day = localDateString(new Date(turn.timestamp))
      if (!dailyMap[day]) dailyMap[day] = { billing: emptyBillingAggregate(), calls: 0 }
      addBillingAggregate(dailyMap[day].billing, aggregateCallsBilling(turn.assistantCalls))
      dailyMap[day].calls += turn.assistantCalls.length
    }
  }
  const daily = Object.entries(dailyMap).sort().map(([date, d]) => ({
    date,
    calls: d.calls,
    ...billingJsonFields(d.billing, billingConfig),
  }))

  const projectList = projects.map(p => {
    const projectBilling = billingAggregateFromProject(p)
    return {
      name: p.project,
      path: p.projectPath,
      workspaceIds: p.workspaceIds ?? [],
      calls: p.totalApiCalls,
      sessions: p.sessions.length,
      ...billingJsonFields(projectBilling, billingConfig),
    }
  })

  const modelMap: Record<string, { calls: number; billing: BillingAggregate; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; pricingStatus: string; warnings: Set<string> }> = {}
  for (const sess of sessions) {
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelMap[model]) modelMap[model] = { calls: 0, billing: emptyBillingAggregate(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, pricingStatus: d.pricingStatus ?? 'estimated', warnings: new Set() }
      if (d.pricingStatus === 'unpriced') modelMap[model].pricingStatus = 'unpriced'
      for (const warning of d.warnings ?? []) modelMap[model].warnings.add(warning)
      modelMap[model].calls += d.calls
      addBillingAggregate(modelMap[model].billing, {
        costEstimateUsd: d.costUSD,
        creditsAugment: d.credits,
        creditsSynthesizedCalls: d.creditsSynthesizedCount ?? 0,
        subAgentCreditsUsedUnconfirmed: null,
        baseCostUsd: d.baseCostUsd ?? null,
        surchargeUsd: d.surchargeUsd ?? null,
        billedAmountUsd: d.billedAmountUsd ?? null,
      })
      modelMap[model].inputTokens += d.tokens.inputTokens
      modelMap[model].outputTokens += d.tokens.outputTokens
      modelMap[model].cacheReadTokens += d.tokens.cacheReadInputTokens
      modelMap[model].cacheWriteTokens += d.tokens.cacheCreationInputTokens
    }
  }
  const models = Object.entries(modelMap)
    .sort(([, a], [, b]) => billingMetricValue(b.billing, billingConfig) - billingMetricValue(a.billing, billingConfig))
    .map(([name, { billing, warnings, ...rest }]) => ({ name, ...rest, warnings: [...warnings], ...billingJsonFields(billing, billingConfig) }))

  const catMap: Record<string, { turns: number; billing: BillingAggregate; editTurns: number; oneShotTurns: number }> = {}
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      if (!catMap[turn.category]) catMap[turn.category] = { turns: 0, billing: emptyBillingAggregate(), editTurns: 0, oneShotTurns: 0 }
      catMap[turn.category].turns++
      addBillingAggregate(catMap[turn.category].billing, aggregateCallsBilling(turn.assistantCalls))
      if (turn.hasEdits) {
        catMap[turn.category].editTurns++
        if (turn.retries === 0) catMap[turn.category].oneShotTurns++
      }
    }
  }
  const activities = Object.entries(catMap)
    .sort(([, a], [, b]) => billingMetricValue(b.billing, billingConfig) - billingMetricValue(a.billing, billingConfig))
    .map(([cat, d]) => ({
      category: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      turns: d.turns,
      editTurns: d.editTurns,
      oneShotTurns: d.oneShotTurns,
      oneShotRate: d.editTurns > 0 ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10 : null,
      ...billingJsonFields(d.billing, billingConfig),
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
    .flatMap(p => p.sessions.map(s => {
      const sessionBilling = aggregateSessionsBilling([s])
      return {
        metric: billingMetricValue(sessionBilling, billingConfig),
        row: {
          project: p.project,
          workspaceId: s.workspaceId ?? null,
          sessionId: s.sessionId,
          date: s.firstTimestamp?.slice(0, 10) ?? null,
          calls: s.apiCalls,
          ...billingJsonFields(sessionBilling, billingConfig),
        },
      }
    }))
    .sort((a, b) => b.metric - a.metric)
    .slice(0, 5)
    .map(({ row }) => row)

  const overview: Record<string, unknown> = {
    calls: totalCalls,
    sessions: totalSessions,
    cacheHitPercent,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    },
    ...billingJsonFields(overviewBilling, billingConfig),
    warnings: [...new Set(models.flatMap(model => model.warnings as string[]))],
  }

  return {
    schema: REPORT_OUTPUT_SCHEMA,
    schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
    generated: new Date().toISOString(),
    currency: code,
    billing: buildBillingMetadata(billingConfig),
    period,
    periodKey,
    overview,
    warnings: overview.warnings,
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
  .addOption(periodOption('Starting period', 'week'))
  .option('--from <date>', 'Start date (YYYY-MM-DD). Overrides --period when set')
  .option('--to <date>', 'End date (YYYY-MM-DD). Overrides --period when set')
  .addOption(formatOption('Output format', TUI_FORMATS, 'tui'))
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .addOption(refreshOption())
  .action(async (opts) => {
    let customRange: DateRange | null = null
    try {
      customRange = parseDateRangeFlags(opts.from, opts.to)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Error: ${message}\n`)
      process.exit(1)
    }

    const period = opts.period as Period
    if (opts.format === 'json') {
      await loadPricing()
      if (customRange) {
        const label = formatCustomDateRangeLabel(opts.from, opts.to)
        const projects = filterProjectsByName(
          await parseAllSessions(customRange),
          opts.project,
          opts.exclude,
        )
        console.log(JSON.stringify(buildJsonReport(projects, label, 'custom'), null, 2))
      } else {
        await runJsonReport(period, opts.project, opts.exclude)
      }
      return
    }
    await renderDashboard(period, opts.refresh, opts.project, opts.exclude, customRange, customRange ? formatCustomDateRangeLabel(opts.from, opts.to) : undefined)
  })

function collectPricingWarnings(projects: ProjectSummary[]): string[] {
  return [...new Set(projects.flatMap(project =>
    project.sessions.flatMap(session =>
      Object.values(session.modelBreakdown).flatMap(model => model.warnings ?? []),
    ),
  ))]
}

function buildStatusData(projects: ProjectSummary[], billingConfig = loadBillingConfig()): Record<string, unknown> {
  const billing = aggregateSessionsBilling(projects.flatMap(p => p.sessions))
  return {
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    ...billingJsonFields(billing, billingConfig),
    warnings: collectPricingWarnings(projects),
  }
}

program
  .command('status')
  .description('Compact status output (today + month)')
  .addOption(formatOption('Output format', STATUS_FORMATS, 'terminal'))
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .action(async (opts) => {
    await loadPricing()
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)

    if (opts.format === 'json') {
      const billingConfig = loadBillingConfig()
      const todayData = buildStatusData(fp(await parseAllSessions(getDateRange('today').range)), billingConfig)
      const monthData = buildStatusData(fp(await parseAllSessions(getDateRange('month').range)), billingConfig)
      const { code } = getCurrency()
      console.log(JSON.stringify({
        schema: STATUS_OUTPUT_SCHEMA,
        schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
        generated: new Date().toISOString(),
        currency: code,
        billing: buildBillingMetadata(billingConfig),
        today: todayData,
        month: monthData,
      }))
      return
    }

    const monthProjects = fp(await parseAllSessions(getDateRange('month').range))
    console.log(renderStatusBar(monthProjects))
  })

program
  .command('today')
  .description('Today\'s usage dashboard')
  .addOption(formatOption('Output format', TUI_FORMATS, 'tui'))
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .addOption(refreshOption())
  .action(async (opts) => {
    if (opts.format === 'json') {
      await runJsonReport('today', opts.project, opts.exclude)
      return
    }
    await renderDashboard('today', opts.refresh, opts.project, opts.exclude)
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .addOption(formatOption('Output format', TUI_FORMATS, 'tui'))
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .addOption(refreshOption())
  .action(async (opts) => {
    if (opts.format === 'json') {
      await runJsonReport('month', opts.project, opts.exclude)
      return
    }
    await renderDashboard('month', opts.refresh, opts.project, opts.exclude)
  })

program
  .command('export')
  .description('Export usage data to CSV or JSON (includes 1 day, 7 days, 30 days)')
  .addOption(formatOption('Export format', EXPORT_FORMATS, 'csv', '-f, --format <format>'))
  .option('-o, --output <path>', 'Output file path')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .action(async (opts) => {
    await loadPricing()
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
    const periods: PeriodExport[] = [
      { label: PERIOD_LABELS.today, projects: fp(await parseAllSessions(getDateRange('today').range)) },
      { label: PERIOD_LABELS.week, projects: fp(await parseAllSessions(getDateRange('week').range)) },
      { label: PERIOD_LABELS['30days'], projects: fp(await parseAllSessions(getDateRange('30days').range)) },
    ]

    if (periods.every(p => p.projects.length === 0)) {
      console.log('\n  No usage data found.\n')
      return
    }

    const defaultName = `codeburn-${new Date().toISOString().slice(0, 10)}`
    const outputPath = opts.output ?? `${defaultName}.${opts.format}`

    let savedPath: string
    try {
      if (opts.format === 'json') {
        savedPath = await exportJson(periods, outputPath)
      } else {
        savedPath = await exportCsv(periods, outputPath)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`\n  Export failed: ${message}\n`)
      process.exit(1)
    }

    console.log(`\n  Exported (Today + 7 Days + 30 Days) to: ${savedPath}\n`)
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
  .command('optimize')
  .description('Find token waste and get exact fixes')
  .addOption(periodOption('Analysis period', '30days'))
  .action(async (opts) => {
    await loadPricing()
    const { range, label } = getDateRange(opts.period)
    const projects = await parseAllSessions(range)
    await runOptimize(projects, label, range)
  })

program.parse()
