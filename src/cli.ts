import { Command } from 'commander'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing } from './models.js'
import { parseAllSessions, filterProjectsByDateRange } from './parser.js'
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

function toPeriod(s: string): 'today' | 'week' | '30days' | 'month' {
  if (s === 'today') return 'today'
  if (s === 'month') return 'month'
  if (s === '30days') return '30days'
  return 'week'
}

const program = new Command()
  .name('codeburn')
  .description('See where your AI coding tokens go - by task, tool, model, and project')
  .version(version)

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard')
  .option('-p, --period <period>', 'Starting period: today, week, 30days, month', 'week')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', parseInt)
  .action(async (opts) => {
    await loadCurrency()
    await renderDashboard(toPeriod(opts.period), opts.provider, opts.refresh)
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
  .action(async (opts) => {
    await loadCurrency()
    await loadPricing()
    const pf = opts.provider
    const monthRange = getDateRange('month').range
    const monthProjects = await parseAllSessions({ dateRange: monthRange, providerFilter: pf, extractBash: false })

    if (opts.format === 'menubar') {
      const todayRange = getDateRange('today').range
      const todayFiltered = filterProjectsByDateRange(monthProjects, todayRange)
      const todayData = buildPeriodData('Today', todayFiltered)
      const weekData = buildPeriodData('7 Days', filterProjectsByDateRange(monthProjects, getDateRange('week').range))
      const monthData = buildPeriodData('Month', monthProjects)
      const todayProviders: ProviderCost[] = []
      for (const p of await getAllProviders()) {
        const cost = todayFiltered
          .flatMap(proj => proj.sessions)
          .flatMap(s => s.turns)
          .flatMap(t => t.assistantCalls)
          .filter(c => c.provider === p.name)
          .reduce((s, c) => s + c.costUSD, 0)
        if (cost > 0) todayProviders.push({ name: p.displayName, cost })
      }
      console.log(renderMenubarFormat(todayData, weekData, monthData, todayProviders))
      return
    }

    if (opts.format === 'json') {
      const todayData = buildPeriodData('today', filterProjectsByDateRange(monthProjects, getDateRange('today').range))
      const monthData = buildPeriodData('month', monthProjects)
      const { code, rate } = getCurrency()
      console.log(JSON.stringify({
        currency: code,
        today: { cost: Math.round(todayData.cost * rate * 100) / 100, calls: todayData.calls },
        month: { cost: Math.round(monthData.cost * rate * 100) / 100, calls: monthData.calls },
      }))
      return
    }

    console.log(renderStatusBar(monthProjects))
  })

program
  .command('today')
  .description('Today\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', parseInt)
  .action(async (opts) => {
    await loadCurrency()
    await renderDashboard('today', opts.provider, opts.refresh)
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .option('--refresh <seconds>', 'Auto-refresh interval in seconds', parseInt)
  .action(async (opts) => {
    await loadCurrency()
    await renderDashboard('month', opts.provider, opts.refresh)
  })

program
  .command('export')
  .description('Export usage data to CSV or JSON (includes 1 day, 7 days, 30 days)')
  .option('-f, --format <format>', 'Export format: csv, json', 'csv')
  .option('-o, --output <path>', 'Output file path')
  .option('--provider <provider>', 'Filter by provider: all, claude, codex, cursor', 'all')
  .action(async (opts) => {
    await loadCurrency()
    await loadPricing()
    const pf = opts.provider
    const allData = await parseAllSessions({ dateRange: getDateRange('30days').range, providerFilter: pf, extractBash: true })
    const periods: PeriodExport[] = [
      { label: 'Today', projects: filterProjectsByDateRange(allData, getDateRange('today').range) },
      { label: '7 Days', projects: filterProjectsByDateRange(allData, getDateRange('week').range) },
      { label: '30 Days', projects: allData },
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
