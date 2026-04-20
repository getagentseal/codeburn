import { writeFile, mkdir, readdir, lstat, stat, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { getCurrency, convertCost } from './currency.js'
import { loadBillingConfig, CREDITS_PER_DOLLAR, type BillingConfig } from './billing.js'

function escCsv(s: string): string {
  const sanitized = /^[=+\-@]/.test(s) ? `'${s}` : s
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

type Row = Record<string, string | number>

function rowsToCsv(rows: Row[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers.map(escCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => escCsv(String(row[h] ?? ''))).join(','))
  }
  return lines.join('\n') + '\n'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function pct(n: number, total: number): number {
  return total > 0 ? round2((n / total) * 100) : 0
}

type DailyAgg = {
  cost: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sessions: Set<string>
}

function buildDailyRows(projects: ProjectSummary[], period: string): Row[] {
  const daily: Record<string, DailyAgg> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = turn.timestamp.slice(0, 10)
        if (!daily[day]) {
          daily[day] = { cost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }
        }
        daily[day].sessions.add(session.sessionId)
        for (const call of turn.assistantCalls) {
          daily[day].cost += call.costUSD
          daily[day].calls++
          daily[day].input += call.usage.inputTokens
          daily[day].output += call.usage.outputTokens
          daily[day].cacheRead += call.usage.cacheReadInputTokens
          daily[day].cacheWrite += call.usage.cacheCreationInputTokens
        }
      }
    }
  }
  const { code } = getCurrency()
  return Object.entries(daily).sort().map(([date, d]) => ({
    Period: period,
    Date: date,
    [`Cost (${code})`]: round2(convertCost(d.cost)),
    'API Calls': d.calls,
    Sessions: d.sessions.size,
    'Input Tokens': d.input,
    'Output Tokens': d.output,
    'Cache Read Tokens': d.cacheRead,
    'Cache Write Tokens': d.cacheWrite,
  }))
}

function buildActivityRows(projects: ProjectSummary[], period: string): Row[] {
  const catTotals: Record<string, { turns: number; cost: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, d] of Object.entries(session.categoryBreakdown)) {
        if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0 }
        catTotals[cat].turns += d.turns
        catTotals[cat].cost += d.costUSD
      }
    }
  }
  const totalCost = Object.values(catTotals).reduce((s, d) => s + d.cost, 0)
  const { code } = getCurrency()
  return Object.entries(catTotals)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      Period: period,
      Activity: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      [`Cost (${code})`]: round2(convertCost(d.cost)),
      'Share (%)': pct(d.cost, totalCost),
      Turns: d.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[], period: string): Row[] {
  const modelTotals: Record<string, { calls: number; cost: number; credits: number | null; input: number; output: number; cacheRead: number; cacheWrite: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, credits: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        modelTotals[model].calls += d.calls
        modelTotals[model].cost += d.costUSD
        // Aggregate credits: null + null = null, null + N = N, N + M = N + M
        const existingCredits = modelTotals[model].credits
        const newCredits = d.credits
        if (existingCredits === null && newCredits === null) {
          // Both null, keep null
        } else {
          modelTotals[model].credits = (existingCredits ?? 0) + (newCredits ?? 0)
        }
        modelTotals[model].input += d.tokens.inputTokens
        modelTotals[model].output += d.tokens.outputTokens
        modelTotals[model].cacheRead += d.tokens.cacheReadInputTokens ?? 0
        modelTotals[model].cacheWrite += d.tokens.cacheCreationInputTokens ?? 0
      }
    }
  }
  const totalCost = Object.values(modelTotals).reduce((s, d) => s + d.cost, 0)
  const { code } = getCurrency()
  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([model, d]) => {
      const row: Row = {
        Period: period,
        Model: model,
        [`Cost (${code}, est.)`]: round2(convertCost(d.cost)),
        'Share (%)': pct(d.cost, totalCost),
        'API Calls': d.calls,
        'Input Tokens': d.input,
        'Output Tokens': d.output,
        'Cache Read Tokens': d.cacheRead,
        'Cache Write Tokens': d.cacheWrite,
      }
      // Include credits column: null = '—', otherwise the number
      if (d.credits !== null) {
        row['Credits (Augment)'] = d.credits
      }
      return row
    })
}

function buildToolRows(projects: ProjectSummary[]): Row[] {
  const toolTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, d] of Object.entries(session.toolBreakdown)) {
        toolTotals[tool] = (toolTotals[tool] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(toolTotals).reduce((s, n) => s + n, 0)
  return Object.entries(toolTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, calls]) => ({
      Tool: tool,
      Calls: calls,
      'Share (%)': pct(calls, total),
    }))
}

function buildBashRows(projects: ProjectSummary[]): Row[] {
  const bashTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cmd, d] of Object.entries(session.bashBreakdown)) {
        bashTotals[cmd] = (bashTotals[cmd] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(bashTotals).reduce((s, n) => s + n, 0)
  return Object.entries(bashTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([cmd, calls]) => ({
      Command: cmd,
      Calls: calls,
      'Share (%)': pct(calls, total),
    }))
}

function buildProjectRows(projects: ProjectSummary[]): Row[] {
  const { code } = getCurrency()
  const total = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  return projects
    .slice()
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
    .map(p => {
      const row: Row = {
        Project: p.projectPath,
        [`Cost (${code}, est.)`]: round2(convertCost(p.totalCostUSD)),
        [`Avg/Session (${code})`]: p.sessions.length > 0 ? round2(convertCost(p.totalCostUSD / p.sessions.length)) : '',
        'Share (%)': pct(p.totalCostUSD, total),
        'API Calls': p.totalApiCalls,
        Sessions: p.sessions.length,
      }
      // Include credits column if present
      if (p.totalCredits !== null) {
        row['Credits (Augment)'] = p.totalCredits
      }
      return row
    })
}

function buildSessionRows(projects: ProjectSummary[]): Row[] {
  const { code } = getCurrency()
  const rows: Row[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      rows.push({
        Project: p.projectPath,
        'Session ID': s.sessionId,
        'Started At': s.firstTimestamp ?? '',
        [`Cost (${code})`]: round2(convertCost(s.totalCostUSD)),
        'API Calls': s.apiCalls,
        Turns: s.turns.length,
      })
    }
  }
  return rows.sort((a, b) => (b[`Cost (${code})`] as number) - (a[`Cost (${code})`] as number))
}

export type PeriodExport = {
  label: string
  projects: ProjectSummary[]
}

function buildSummaryRows(periods: PeriodExport[]): Row[] {
  const { code } = getCurrency()
  return periods.map(p => {
    const cost = p.projects.reduce((s, proj) => s + proj.totalCostUSD, 0)
    const calls = p.projects.reduce((s, proj) => s + proj.totalApiCalls, 0)
    const sessions = p.projects.reduce((s, proj) => s + proj.sessions.length, 0)
    const projectCount = p.projects.filter(proj => proj.totalCostUSD > 0).length
    // Aggregate credits: null + null = null, null + N = N, N + M = N + M
    const credits = p.projects.reduce<number | null>((acc, proj) => {
      if (acc === null && proj.totalCredits === null) return null
      return (acc ?? 0) + (proj.totalCredits ?? 0)
    }, null)
    const row: Row = {
      Period: p.label,
      [`Cost (${code}, est.)`]: round2(convertCost(cost)),
      'API Calls': calls,
      Sessions: sessions,
      Projects: projectCount,
    }
    // Include credits column if present
    if (credits !== null) {
      row['Credits (Augment)'] = credits
    }
    return row
  })
}

function buildReadme(periods: PeriodExport[]): string {
  const { code } = getCurrency()
  const generated = new Date().toISOString()
  const lines = [
    'CodeBurn Usage Export',
    '====================',
    '',
    `Generated: ${generated}`,
    `Currency:  ${code}`,
    `Periods:   ${periods.map(p => p.label).join(', ')}`,
    '',
    'Files',
    '-----',
    '  summary.csv           One row per period. Headline totals.',
    '  daily.csv             Day-by-day breakdown, Period column distinguishes the window.',
    '  activity.csv          Time spent per task category (Coding, Debugging, Exploration, etc.).',
    '  models.csv            Spend per model with token totals and cache usage.',
    '  projects.csv          Spend per project folder (30-day window).',
    '  sessions.csv          One row per session (30-day window) with session IDs and costs.',
    '  tools.csv             Tool invocations and share (30-day window).',
    '  shell-commands.csv    Shell commands executed via Bash tool (30-day window).',
    '',
    'Notes',
    '-----',
    '  Every cost column is already converted to the active currency. Tokens are raw integer',
    '  counts from provider telemetry. Share (%) is relative to the period/table total.',
    '',
  ]
  return lines.join('\n')
}

/// Sentinel file dropped into every folder we create so we can safely overwrite an older
/// codeburn export without ever deleting a user's unrelated files by accident.
const EXPORT_MARKER_FILE = '.codeburn-export'

async function isCodeburnExportFolder(path: string): Promise<boolean> {
  // lstat (not stat) so a symlinked .codeburn-export pointing at a real file elsewhere does
  // NOT trick us into treating an arbitrary directory as a codeburn export. That symlink
  // confusion would let an `export -o ~/Documents` blow away the user's documents on the next
  // run because the marker would be "valid" via the symlink target while clearCodeburnExportFolder
  // operates on the directory itself.
  const markerStat = await lstat(join(path, EXPORT_MARKER_FILE)).catch(() => null)
  if (!markerStat) return false
  if (markerStat.isSymbolicLink()) return false
  return markerStat.isFile()
}

async function clearCodeburnExportFolder(path: string): Promise<void> {
  const entries = await readdir(path)
  for (const entry of entries) {
    await rm(join(path, entry), { recursive: true, force: true })
  }
}

/// Writes a folder of one-table-per-file CSVs. The outputPath is treated as a directory. If it
/// ends in `.csv` the extension is stripped to form the folder name. Refuses to delete a
/// pre-existing file or a non-codeburn folder, so a typo like `-o ~/.ssh/id_ed25519` can't
/// wipe a sensitive file (prior versions did `rm(path, { force: true })` unconditionally).
export async function exportCsv(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1].projects

  let folder = resolve(outputPath)
  if (folder.toLowerCase().endsWith('.csv')) {
    folder = folder.slice(0, -4)
  }

  const existingStat = await stat(folder).catch(() => null)
  if (existingStat?.isFile()) {
    throw new Error(`Refusing to overwrite existing file at ${folder}. Pass a directory path instead.`)
  }
  if (existingStat?.isDirectory()) {
    if (!(await isCodeburnExportFolder(folder))) {
      throw new Error(
        `Refusing to reuse non-empty directory ${folder}: no ${EXPORT_MARKER_FILE} marker. ` +
        `Delete it manually or pick a different -o path.`
      )
    }
    await clearCodeburnExportFolder(folder)
  }
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, EXPORT_MARKER_FILE), '', 'utf-8')

  const dailyRows = periods.flatMap(p => buildDailyRows(p.projects, p.label))
  const activityRows = periods.flatMap(p => buildActivityRows(p.projects, p.label))
  const modelRows = periods.flatMap(p => buildModelRows(p.projects, p.label))

  await writeFile(join(folder, 'README.txt'), buildReadme(periods), 'utf-8')
  await writeFile(join(folder, 'summary.csv'), rowsToCsv(buildSummaryRows(periods)), 'utf-8')
  await writeFile(join(folder, 'daily.csv'), rowsToCsv(dailyRows), 'utf-8')
  await writeFile(join(folder, 'activity.csv'), rowsToCsv(activityRows), 'utf-8')
  await writeFile(join(folder, 'models.csv'), rowsToCsv(modelRows), 'utf-8')
  await writeFile(join(folder, 'projects.csv'), rowsToCsv(buildProjectRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'sessions.csv'), rowsToCsv(buildSessionRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'tools.csv'), rowsToCsv(buildToolRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'shell-commands.csv'), rowsToCsv(buildBashRows(thirtyDayProjects)), 'utf-8')

  return folder
}

/// Build overview object with billing-aware fields
function buildOverview(projects: ProjectSummary[], billingConfig: BillingConfig): Record<string, unknown> {
  const allSessions = projects.flatMap(p => p.sessions)
  const totalCostUSD = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = allSessions.length
  const totalInputTokens = allSessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutputTokens = allSessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = allSessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = allSessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)

  // Aggregate billing fields — use simple summation (null → 0 contribution, no short-circuit).
  // This ensures all sessions contribute equally to base, surcharge, and billed.
  let totalCredits: number | null = null
  let totalBaseCostUsd: number | null = null
  let totalSurchargeUsd: number | null = null
  let totalBilledAmountUsd: number | null = null
  let creditsSynthesizedCount = 0

  for (const sess of allSessions) {
    if (sess.totalCredits != null) totalCredits = (totalCredits ?? 0) + sess.totalCredits
    if (sess.totalBaseCostUsd != null) totalBaseCostUsd = (totalBaseCostUsd ?? 0) + sess.totalBaseCostUsd
    if (sess.totalSurchargeUsd != null) totalSurchargeUsd = (totalSurchargeUsd ?? 0) + sess.totalSurchargeUsd
    if (sess.totalBilledAmountUsd != null) totalBilledAmountUsd = (totalBilledAmountUsd ?? 0) + sess.totalBilledAmountUsd
    creditsSynthesizedCount += sess.creditsSynthesizedCount ?? 0
  }

  const base: Record<string, unknown> = {
    calls: totalCalls,
    sessions: totalSessions,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
  }

  if (billingConfig.mode === 'credits') {
    // Credits mode: cost = null, add creditsAugment and creditsSynthesized
    base.cost = null
    base.creditsAugment = totalCredits
    base.creditsSynthesized = creditsSynthesizedCount
  } else {
    // Token+ mode: add baseCostUsd, surchargeUsd, billedAmountUsd; keep cost = billedAmountUsd for back-compat
    base.baseCostUsd = totalBaseCostUsd !== null ? round2(totalBaseCostUsd) : null
    base.surchargeUsd = totalSurchargeUsd !== null ? round2(totalSurchargeUsd) : null
    base.billedAmountUsd = totalBilledAmountUsd !== null ? round2(totalBilledAmountUsd) : null
    base.cost = totalBilledAmountUsd !== null ? round2(totalBilledAmountUsd) : round2(totalCostUSD)
  }

  return base
}

/// Build byModel array with billing-aware fields
function buildByModel(projects: ProjectSummary[], billingConfig: BillingConfig): unknown[] {
  const modelTotals: Record<string, {
    calls: number
    costUSD: number
    credits: number | null
    baseCostUsd: number | null
    surchargeUsd: number | null
    billedAmountUsd: number | null
    creditsSynthesizedCount: number
    inputTokens: number
    outputTokens: number
    cacheRead: number
    cacheWrite: number
  }> = {}

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) {
          modelTotals[model] = {
            calls: 0, costUSD: 0, credits: null, baseCostUsd: null, surchargeUsd: null, billedAmountUsd: null,
            creditsSynthesizedCount: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
          }
        }
        modelTotals[model].calls += data.calls
        modelTotals[model].costUSD += data.costUSD
        // Aggregate credits
        if (modelTotals[model].credits === null && data.credits === null) {
          // Both null, keep null
        } else {
          modelTotals[model].credits = (modelTotals[model].credits ?? 0) + (data.credits ?? 0)
        }
        // Aggregate billing fields
        if (modelTotals[model].baseCostUsd === null && data.baseCostUsd == null) {
          // Both null, keep null
        } else {
          modelTotals[model].baseCostUsd = (modelTotals[model].baseCostUsd ?? 0) + (data.baseCostUsd ?? 0)
        }
        if (modelTotals[model].surchargeUsd === null && data.surchargeUsd == null) {
          // Both null, keep null
        } else {
          modelTotals[model].surchargeUsd = (modelTotals[model].surchargeUsd ?? 0) + (data.surchargeUsd ?? 0)
        }
        if (modelTotals[model].billedAmountUsd === null && data.billedAmountUsd == null) {
          // Both null, keep null
        } else {
          modelTotals[model].billedAmountUsd = (modelTotals[model].billedAmountUsd ?? 0) + (data.billedAmountUsd ?? 0)
        }
        modelTotals[model].creditsSynthesizedCount += data.creditsSynthesizedCount ?? 0
        modelTotals[model].inputTokens += data.tokens.inputTokens
        modelTotals[model].outputTokens += data.tokens.outputTokens
        modelTotals[model].cacheRead += data.tokens.cacheReadInputTokens ?? 0
        modelTotals[model].cacheWrite += data.tokens.cacheCreationInputTokens ?? 0
      }
    }
  }

  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => (billingConfig.mode === 'credits' ? (b.credits ?? 0) - (a.credits ?? 0) : b.costUSD - a.costUSD))
    .map(([model, d]) => {
      const base: Record<string, unknown> = {
        model,
        calls: d.calls,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheRead,
        cacheWriteTokens: d.cacheWrite,
      }
      if (billingConfig.mode === 'credits') {
        base.cost = null
        base.creditsAugment = d.credits
        base.creditsSynthesized = d.creditsSynthesizedCount
      } else {
        base.baseCostUsd = d.baseCostUsd !== null ? round2(d.baseCostUsd) : null
        base.surchargeUsd = d.surchargeUsd !== null ? round2(d.surchargeUsd) : null
        base.billedAmountUsd = d.billedAmountUsd !== null ? round2(d.billedAmountUsd) : null
        base.cost = d.billedAmountUsd !== null ? round2(d.billedAmountUsd) : round2(d.costUSD)
      }
      return base
    })
}

/// Build byProject array with billing-aware fields
function buildByProject(projects: ProjectSummary[], billingConfig: BillingConfig): unknown[] {
  return projects
    .slice()
    .sort((a, b) => {
      if (billingConfig.mode === 'credits') {
        return (b.totalCredits ?? 0) - (a.totalCredits ?? 0)
      }
      // Token+ mode: sort by billed amount
      const aBilled = b.sessions.reduce((s, sess) => s + (sess.totalBilledAmountUsd ?? sess.totalCostUSD), 0)
      const bBilled = a.sessions.reduce((s, sess) => s + (sess.totalBilledAmountUsd ?? sess.totalCostUSD), 0)
      return aBilled - bBilled
    })
    .map(p => {
      const allSessions = p.sessions
      const totalBilledAmountUsd = allSessions.reduce<number | null>((acc, sess) => {
        if (acc === null && sess.totalBilledAmountUsd == null) return null
        return (acc ?? 0) + (sess.totalBilledAmountUsd ?? 0)
      }, null)
      const totalBaseCostUsd = allSessions.reduce<number | null>((acc, sess) => {
        if (acc === null && sess.totalBaseCostUsd == null) return null
        return (acc ?? 0) + (sess.totalBaseCostUsd ?? 0)
      }, null)
      const totalSurchargeUsd = allSessions.reduce<number | null>((acc, sess) => {
        if (acc === null && sess.totalSurchargeUsd == null) return null
        return (acc ?? 0) + (sess.totalSurchargeUsd ?? 0)
      }, null)
      const creditsSynthesizedCount = allSessions.reduce((s, sess) => s + (sess.creditsSynthesizedCount ?? 0), 0)

      const base: Record<string, unknown> = {
        project: p.projectPath,
        calls: p.totalApiCalls,
        sessions: p.sessions.length,
      }
      if (billingConfig.mode === 'credits') {
        base.cost = null
        base.creditsAugment = p.totalCredits
        base.creditsSynthesized = creditsSynthesizedCount
      } else {
        base.baseCostUsd = totalBaseCostUsd !== null ? round2(totalBaseCostUsd) : null
        base.surchargeUsd = totalSurchargeUsd !== null ? round2(totalSurchargeUsd) : null
        base.billedAmountUsd = totalBilledAmountUsd !== null ? round2(totalBilledAmountUsd) : null
        base.cost = totalBilledAmountUsd !== null ? round2(totalBilledAmountUsd) : round2(p.totalCostUSD)
      }
      return base
    })
}

export async function exportJson(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1].projects
  const { code, rate, symbol } = getCurrency()
  const billingConfig = loadBillingConfig()

  // Build billing metadata for top-level
  const billingMeta: Record<string, unknown> = {
    mode: billingConfig.mode,
  }
  if (billingConfig.mode === 'credits') {
    billingMeta.creditsPerDollar = CREDITS_PER_DOLLAR
  } else {
    billingMeta.surchargeRate = billingConfig.surchargeRate
  }

  const data = {
    schema: 'codeburn.export.v2',
    generated: new Date().toISOString(),
    currency: { code, rate, symbol },
    billing: billingMeta,
    overview: buildOverview(thirtyDayProjects, billingConfig),
    byModel: buildByModel(thirtyDayProjects, billingConfig),
    byProject: buildByProject(thirtyDayProjects, billingConfig),
    // Legacy fields for compatibility
    summary: buildSummaryRows(periods),
    periods: periods.map(p => ({
      label: p.label,
      daily: buildDailyRows(p.projects, p.label),
      activity: buildActivityRows(p.projects, p.label),
      models: buildModelRows(p.projects, p.label),
    })),
    projects: buildProjectRows(thirtyDayProjects),
    sessions: buildSessionRows(thirtyDayProjects),
    tools: buildToolRows(thirtyDayProjects),
    shellCommands: buildBashRows(thirtyDayProjects),
  }

  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(data, null, 2), 'utf-8')
  return target
}
