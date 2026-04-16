import { Command } from 'commander'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing } from './models.js'
import { parseAllSessions, filterProjectsByName } from './parser.js'
import { convertCost } from './currency.js'
import { renderStatusBar } from './format.js'
import { installMenubar, renderMenubarFormat, type PeriodData, type ProviderCost, uninstallMenubar } from './menubar.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { renderDashboard } from './dashboard.js'
import { getAllProviders } from './providers/index.js'
import { readConfig, saveConfig, getConfigFilePath } from './config.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')
import { loadCurrency, getCurrency, isValidCurrencyCode } from './currency.js'

function getDateRange(period: string): { range: DateRange; label: string } {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

  switch (period) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return { range: { start, end }, label: `Today (${start.toISOString().slice(0, 10)})` }
    }
    case 'yesterday': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999)
      return { range: { start, end: yesterdayEnd }, label: `Yesterday (${start.toISOString().slice(0, 10)})` }
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
      return { range: { start: new Date(0), end }, label: 'All Time' }
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

async function runJsonReport(period: Period, provider: string, project: string[], exclude: string[]): Promise<void> {
  await loadPricing()
  const { range, label } = getDateRange(period)
  const projects = filterProjectsByName(await parseAllSessions(range, provider), project, exclude)
  console.log(JSON.stringify(buildJsonReport(projects, label, period), null, 2))
}

const program = new Command()
  .name('codeburn')
  .description('See where your AI coding tokens go - by task, tool, model, and project')
  .version(version)

program.hook('preAction', async () => {
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
  const allInput = totalInput + totalCacheRead + totalCacheWrite
  const cacheHitPercent = allInput > 0 ? Math.round((totalCacheRead / allInput) * 1000) / 10 : 0

  const dailyMap: Record<string, { cost: number; calls: number }> = {}
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      if (!turn.timestamp) { continue }
      const day = turn.timestamp.slice(0, 10)
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
    .flatMap(p => p.sessions.map(s => ({ project: p.project, sessionId: s.sessionId, date: s.firstTimestamp?.slice(0, 10) ?? null, cost: convertCost(s.totalCostUSD), calls: s.apiCalls })))
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
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--format <format>', 'Output format: tui, json', 'tui')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', parseInt)
  .action(async (opts) => {
    const period = toPeriod(opts.period)
    if (opts.format === 'json') {
      await runJsonReport(period, opts.provider, opts.project, opts.exclude)
      return
    }
    await renderDashboard(period, opts.provider, opts.refresh, opts.project, opts.exclude)
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
  .option('--format <format>', 'Output format: terminal, menubar, json', 'terminal')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--project <name>', 'Show only projects matching name (repeatable)', collect, [])
  .option('--exclude <name>', 'Exclude projects matching name (repeatable)', collect, [])
  .action(async (opts) => {
    await loadPricing()
    const pf = opts.provider
    const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project, opts.exclude)
    if (opts.format === 'menubar') {
      const todayRange = getDateRange('today').range
      const todayData = buildPeriodData('Today', fp(await parseAllSessions(todayRange, pf)))
      const weekData = buildPeriodData('7 Days', fp(await parseAllSessions(getDateRange('week').range, pf)))
      const thirtyDayData = buildPeriodData('30 Days', fp(await parseAllSessions(getDateRange('30days').range, pf)))
      const monthData = buildPeriodData('Month', fp(await parseAllSessions(getDateRange('month').range, pf)))
      const todayProviders: ProviderCost[] = []
      for (const p of await getAllProviders()) {
        const data = await parseAllSessions(todayRange, p.name)
        const cost = data.reduce((s, proj) => s + proj.totalCostUSD, 0)
        if (cost > 0) todayProviders.push({ name: p.displayName, cost })
      }
      console.log(renderMenubarFormat(todayData, weekData, thirtyDayData, monthData, todayProviders))
      return
    }

    if (opts.format === 'json') {
      const todayData = buildPeriodData('today', fp(await parseAllSessions(getDateRange('today').range, pf)))
      const monthData = buildPeriodData('month', fp(await parseAllSessions(getDateRange('month').range, pf)))
      const { code, rate } = getCurrency()
      console.log(JSON.stringify({
        currency: code,
        today: { cost: Math.round(todayData.cost * rate * 100) / 100, calls: todayData.calls },
        month: { cost: Math.round(monthData.cost * rate * 100) / 100, calls: monthData.calls },
      }))
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
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', parseInt)
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
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', parseInt)
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

    const defaultName = `codeburn-${new Date().toISOString().slice(0, 10)}`
    const outputPath = opts.output ?? `${defaultName}.${opts.format}`

    let savedPath: string
    if (opts.format === 'json') {
      savedPath = await exportJson(periods, outputPath)
    } else {
      savedPath = await exportCsv(periods, outputPath)
    }

    console.log(`\n  Exported (Today + 7 Days + 30 Days) to: ${savedPath}\n`)
  })

program
  .command('install-menubar')
  .description('Install macOS menu bar plugin (SwiftBar/xbar)')
  .action(async () => {
    const result = await installMenubar()
    console.log(result)
  })

program
  .command('uninstall-menubar')
  .description('Remove macOS menu bar plugin')
  .action(async () => {
    const result = await uninstallMenubar()
    console.log(result)
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

program.parse()
