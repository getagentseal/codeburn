import { Command } from 'commander'
import { exportCsv, exportJson, type PeriodExport } from './export.js'
import { loadPricing } from './models.js'
import { parseAllSessions, type Source } from './parser.js'
import { renderStatusBar } from './format.js'
import { installMenubar, renderMenubarFormat, type PeriodData, uninstallMenubar } from './menubar.js'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { renderDashboard } from './dashboard.js'

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
    case 'all': {
      return { range: { start: new Date(0), end }, label: 'All Time' }
    }
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
      return { range: { start, end }, label: 'Last 7 Days' }
    }
  }
}

function toPeriod(s: string): 'today' | 'week' | 'month' {
  if (s === 'today') return 'today'
  if (s === 'month') return 'month'
  return 'week'
}

function toSource(s: string): Source {
  if (s === 'claude') return 'claude'
  if (s === 'codex') return 'codex'
  return 'all'
}

const program = new Command()
  .name('codeburn')
  .description('See where your AI coding tokens go - by task, tool, model, and project')
  .version('0.3.1')

program
  .command('report', { isDefault: true })
  .description('Interactive usage dashboard (Claude + Codex)')
  .option('-p, --period <period>', 'Starting period: today, week, month', 'week')
  .option('-s, --source <source>', 'Filter source: all, claude, codex', 'all')
  .action(async (opts) => {
    await renderDashboard(toPeriod(opts.period), toSource(opts.source))
  })

program
  .command('claude')
  .description('Interactive usage dashboard (Claude Code only)')
  .option('-p, --period <period>', 'Starting period: today, week, month', 'week')
  .action(async (opts) => {
    await renderDashboard(toPeriod(opts.period), 'claude')
  })

program
  .command('codex')
  .description('Interactive usage dashboard (Codex only)')
  .option('-p, --period <period>', 'Starting period: today, week, month', 'week')
  .action(async (opts) => {
    await renderDashboard(toPeriod(opts.period), 'codex')
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
  .action(async (opts) => {
    await loadPricing()
    if (opts.format === 'menubar') {
      const todayData = buildPeriodData('Today', await parseAllSessions(getDateRange('today').range))
      const weekData = buildPeriodData('7 Days', await parseAllSessions(getDateRange('week').range))
      const monthData = buildPeriodData('Month', await parseAllSessions(getDateRange('month').range))
      console.log(renderMenubarFormat(todayData, weekData, monthData))
      return
    }

    if (opts.format === 'json') {
      const todayData = buildPeriodData('today', await parseAllSessions(getDateRange('today').range))
      const monthData = buildPeriodData('month', await parseAllSessions(getDateRange('month').range))
      console.log(JSON.stringify({ today: { cost: todayData.cost, calls: todayData.calls }, month: { cost: monthData.cost, calls: monthData.calls } }))
      return
    }

    const monthProjects = await parseAllSessions(getDateRange('month').range)
    console.log(renderStatusBar(monthProjects))
  })

program
  .command('today')
  .description('Today\'s usage dashboard')
  .action(async () => {
    await renderDashboard('today')
  })

program
  .command('month')
  .description('This month\'s usage dashboard')
  .action(async () => {
    await renderDashboard('month')
  })

program
  .command('export')
  .description('Export usage data to CSV or JSON (includes 1 day, 7 days, 30 days)')
  .option('-f, --format <format>', 'Export format: csv, json', 'csv')
  .option('-o, --output <path>', 'Output file path')
  .action(async (opts) => {
    await loadPricing()
    const periods: PeriodExport[] = [
      { label: 'Today', projects: await parseAllSessions(getDateRange('today').range) },
      { label: '7 Days', projects: await parseAllSessions(getDateRange('week').range) },
      { label: '30 Days', projects: await parseAllSessions(getDateRange('month').range) },
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

program.parse()
