import { writeFile, mkdir, readdir, lstat, stat, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { getCurrency } from './currency.js'
import { loadBillingConfig, type BillingConfig } from './billing.js'
import { localDateString } from './cli-date.js'
import { EXPORT_OUTPUT_SCHEMA, MACHINE_OUTPUT_SCHEMA_VERSION } from './output-schema.js'
import {
  addBillingAggregate,
  aggregateCallsBilling,
  aggregateSessionsBilling,
  billingAggregateFromProject,
  billingCsvFields,
  billingJsonFields,
  billingMetricValue,
  buildBillingMetadata,
  emptyBillingAggregate,
  round2,
  type BillingAggregate,
} from './billing-output.js'

function escCsv(s: string): string {
  const sanitized = /^[=+\-@]/.test(s) ? `'${s}` : s
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

type Row = Record<string, string | number>

function collectPricingWarnings(projects: ProjectSummary[]): string[] {
  return [...new Set(projects.flatMap(project =>
    project.sessions.flatMap(session =>
      Object.values(session.modelBreakdown).flatMap(model => model.warnings ?? []),
    ),
  ))]
}

function rowsToCsv(rows: Row[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers.map(escCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => escCsv(String(row[h] ?? ''))).join(','))
  }
  return lines.join('\n') + '\n'
}

function pct(n: number, total: number): number {
  return total > 0 ? round2((n / total) * 100) : 0
}

type DailyAgg = {
  billing: BillingAggregate
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  sessions: Set<string>
}

function buildDailyRows(projects: ProjectSummary[], period: string, billingConfig: BillingConfig): Row[] {
  const daily: Record<string, DailyAgg> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = localDateString(new Date(turn.timestamp))
        if (!daily[day]) {
          daily[day] = { billing: emptyBillingAggregate(), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }
        }
        daily[day].sessions.add(session.sessionId)
        for (const call of turn.assistantCalls) {
          addBillingAggregate(daily[day].billing, aggregateCallsBilling([call]))
          daily[day].calls++
          daily[day].input += call.usage.inputTokens
          daily[day].output += call.usage.outputTokens
          daily[day].cacheRead += call.usage.cacheReadInputTokens
          daily[day].cacheWrite += call.usage.cacheCreationInputTokens
        }
      }
    }
  }
  return Object.entries(daily).sort().map(([date, d]) => ({
    Period: period,
    Date: date,
    ...billingCsvFields(d.billing, billingConfig),
    'API Calls': d.calls,
    Sessions: d.sessions.size,
    'Input Tokens': d.input,
    'Output Tokens': d.output,
    'Cache Read Tokens': d.cacheRead,
    'Cache Write Tokens': d.cacheWrite,
  }))
}

function buildActivityRows(projects: ProjectSummary[], period: string, billingConfig: BillingConfig): Row[] {
  const catTotals: Record<string, { turns: number; billing: BillingAggregate }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!catTotals[turn.category]) catTotals[turn.category] = { turns: 0, billing: emptyBillingAggregate() }
        catTotals[turn.category].turns++
        addBillingAggregate(catTotals[turn.category].billing, aggregateCallsBilling(turn.assistantCalls))
      }
    }
  }
  const total = Object.values(catTotals).reduce((s, d) => s + billingMetricValue(d.billing, billingConfig), 0)
  return Object.entries(catTotals)
    .sort(([, a], [, b]) => billingMetricValue(b.billing, billingConfig) - billingMetricValue(a.billing, billingConfig))
    .map(([cat, d]) => ({
      Period: period,
      Activity: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      ...billingCsvFields(d.billing, billingConfig),
      'Share (%)': pct(billingMetricValue(d.billing, billingConfig), total),
      Turns: d.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[], period: string, billingConfig: BillingConfig): Row[] {
  const modelTotals: Record<string, { calls: number; billing: BillingAggregate; input: number; output: number; cacheRead: number; cacheWrite: number; pricingStatus: string; warnings: Set<string> }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) modelTotals[model] = { calls: 0, billing: emptyBillingAggregate(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingStatus: d.pricingStatus ?? 'estimated', warnings: new Set() }
        if (d.pricingStatus === 'unpriced') modelTotals[model].pricingStatus = 'unpriced'
        for (const warning of d.warnings ?? []) modelTotals[model].warnings.add(warning)
        modelTotals[model].calls += d.calls
        addBillingAggregate(modelTotals[model].billing, {
          costEstimateUsd: d.costUSD,
          creditsAugment: d.credits,
          creditsSynthesizedCalls: d.creditsSynthesizedCount ?? 0,
          subAgentCreditsUsedUnconfirmed: null,
          baseCostUsd: d.baseCostUsd ?? null,
          surchargeUsd: d.surchargeUsd ?? null,
          billedAmountUsd: d.billedAmountUsd ?? null,
        })
        modelTotals[model].input += d.tokens.inputTokens
        modelTotals[model].output += d.tokens.outputTokens
        modelTotals[model].cacheRead += d.tokens.cacheReadInputTokens ?? 0
        modelTotals[model].cacheWrite += d.tokens.cacheCreationInputTokens ?? 0
      }
    }
  }
  const total = Object.values(modelTotals).reduce((s, d) => s + billingMetricValue(d.billing, billingConfig), 0)
  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => billingMetricValue(b.billing, billingConfig) - billingMetricValue(a.billing, billingConfig))
    .map(([model, d]) => {
      const row: Row = {
        Period: period,
        Model: model,
        'Pricing Status': d.pricingStatus,
        Warnings: [...d.warnings].join(' | '),
        ...billingCsvFields(d.billing, billingConfig),
        'Share (%)': pct(billingMetricValue(d.billing, billingConfig), total),
        'API Calls': d.calls,
        'Input Tokens': d.input,
        'Output Tokens': d.output,
        'Cache Read Tokens': d.cacheRead,
        'Cache Write Tokens': d.cacheWrite,
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

function buildProjectRows(projects: ProjectSummary[], billingConfig: BillingConfig): Row[] {
  const total = projects.reduce((s, p) => s + billingMetricValue(billingAggregateFromProject(p), billingConfig), 0)
  return projects
    .slice()
    .sort((a, b) => billingMetricValue(billingAggregateFromProject(b), billingConfig) - billingMetricValue(billingAggregateFromProject(a), billingConfig))
    .map(p => {
      const billing = billingAggregateFromProject(p)
      const row: Row = {
        Project: p.projectPath,
        ...billingCsvFields(billing, billingConfig),
        'Share (%)': pct(billingMetricValue(billing, billingConfig), total),
        'API Calls': p.totalApiCalls,
        Sessions: p.sessions.length,
      }
      return row
    })
}

function buildSessionRows(projects: ProjectSummary[], billingConfig: BillingConfig): Row[] {
  const rows: Row[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      const billing = aggregateSessionsBilling([s])
      rows.push({
        Project: p.projectPath,
        'Session ID': s.sessionId,
        'Started At': s.firstTimestamp ?? '',
        ...billingCsvFields(billing, billingConfig),
        'API Calls': s.apiCalls,
        Turns: s.turns.length,
      })
    }
  }
  return rows.sort((a, b) => {
    const aBilling = projects.flatMap(project => project.sessions).find(session => session.sessionId === a['Session ID'])
    const bBilling = projects.flatMap(project => project.sessions).find(session => session.sessionId === b['Session ID'])
    return billingMetricValue(bBilling ? aggregateSessionsBilling([bBilling]) : emptyBillingAggregate(), billingConfig) -
      billingMetricValue(aBilling ? aggregateSessionsBilling([aBilling]) : emptyBillingAggregate(), billingConfig)
  })
}

export type PeriodExport = {
  label: string
  projects: ProjectSummary[]
}

function buildSummaryRows(periods: PeriodExport[], billingConfig: BillingConfig): Row[] {
  return periods.map(p => {
    const billing = aggregateSessionsBilling(p.projects.flatMap(proj => proj.sessions))
    const calls = p.projects.reduce((s, proj) => s + proj.totalApiCalls, 0)
    const sessions = p.projects.reduce((s, proj) => s + proj.sessions.length, 0)
    const projectCount = p.projects.filter(proj => billingMetricValue(billingAggregateFromProject(proj), billingConfig) > 0).length
    return {
      Period: p.label,
      ...billingCsvFields(billing, billingConfig),
      'API Calls': calls,
      Sessions: sessions,
      Projects: projectCount,
    }
  })
}

function buildReadme(periods: PeriodExport[], billingConfig: BillingConfig): string {
  const { code } = getCurrency()
  const generated = new Date().toISOString()
  const billingDescription = billingConfig.mode === 'credits'
    ? 'credits mode (Augment credits; USD fields are token-pricing estimates only)'
    : 'token_plus mode (base USD + surcharge USD = billed amount USD)'
  const lines = [
    'CodeBurn Usage Export',
    '====================',
    '',
    `Generated: ${generated}`,
    `Currency:  ${code}`,
    `Billing:   ${billingDescription}`,
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
    '  Credits-mode billing columns use Augment credits. Cost Estimate (USD) columns are',
    '  token-pricing estimates and are not authoritative Augment credit billing values.',
    '  Token+ billing columns use base, surcharge, and billed USD. Tokens are raw integer',
    '  counts from provider telemetry. Share (%) is relative to the active billing metric.',
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

  const billingConfig = loadBillingConfig()
  const dailyRows = periods.flatMap(p => buildDailyRows(p.projects, p.label, billingConfig))
  const activityRows = periods.flatMap(p => buildActivityRows(p.projects, p.label, billingConfig))
  const modelRows = periods.flatMap(p => buildModelRows(p.projects, p.label, billingConfig))

  await writeFile(join(folder, 'README.txt'), buildReadme(periods, billingConfig), 'utf-8')
  await writeFile(join(folder, 'summary.csv'), rowsToCsv(buildSummaryRows(periods, billingConfig)), 'utf-8')
  await writeFile(join(folder, 'daily.csv'), rowsToCsv(dailyRows), 'utf-8')
  await writeFile(join(folder, 'activity.csv'), rowsToCsv(activityRows), 'utf-8')
  await writeFile(join(folder, 'models.csv'), rowsToCsv(modelRows), 'utf-8')
  await writeFile(join(folder, 'projects.csv'), rowsToCsv(buildProjectRows(thirtyDayProjects, billingConfig)), 'utf-8')
  await writeFile(join(folder, 'sessions.csv'), rowsToCsv(buildSessionRows(thirtyDayProjects, billingConfig)), 'utf-8')
  await writeFile(join(folder, 'tools.csv'), rowsToCsv(buildToolRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'shell-commands.csv'), rowsToCsv(buildBashRows(thirtyDayProjects)), 'utf-8')

  return folder
}

/// Build overview object with billing-aware fields
function buildOverview(projects: ProjectSummary[], billingConfig: BillingConfig): Record<string, unknown> {
  const allSessions = projects.flatMap(p => p.sessions)
  const totalCalls = projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = allSessions.length
  const totalInputTokens = allSessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutputTokens = allSessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = allSessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = allSessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  const billing = aggregateSessionsBilling(allSessions)

  return {
    calls: totalCalls,
    sessions: totalSessions,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
    ...billingJsonFields(billing, billingConfig),
    warnings: collectPricingWarnings(projects),
  }
}

/// Build byModel array with billing-aware fields
function buildByModel(projects: ProjectSummary[], billingConfig: BillingConfig): unknown[] {
  const modelTotals: Record<string, {
    calls: number
    billing: BillingAggregate
    inputTokens: number
    outputTokens: number
    cacheRead: number
    cacheWrite: number
    pricingStatus: string
    warnings: Set<string>
  }> = {}

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) {
          modelTotals[model] = {
            calls: 0, billing: emptyBillingAggregate(), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, pricingStatus: data.pricingStatus ?? 'estimated', warnings: new Set(),
          }
        }
        if (data.pricingStatus === 'unpriced') modelTotals[model].pricingStatus = 'unpriced'
        for (const warning of data.warnings ?? []) modelTotals[model].warnings.add(warning)
        modelTotals[model].calls += data.calls
        addBillingAggregate(modelTotals[model].billing, {
          costEstimateUsd: data.costUSD,
          creditsAugment: data.credits,
          creditsSynthesizedCalls: data.creditsSynthesizedCount ?? 0,
          subAgentCreditsUsedUnconfirmed: null,
          baseCostUsd: data.baseCostUsd ?? null,
          surchargeUsd: data.surchargeUsd ?? null,
          billedAmountUsd: data.billedAmountUsd ?? null,
        })
        modelTotals[model].inputTokens += data.tokens.inputTokens
        modelTotals[model].outputTokens += data.tokens.outputTokens
        modelTotals[model].cacheRead += data.tokens.cacheReadInputTokens ?? 0
        modelTotals[model].cacheWrite += data.tokens.cacheCreationInputTokens ?? 0
      }
    }
  }

  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => billingMetricValue(b.billing, billingConfig) - billingMetricValue(a.billing, billingConfig))
    .map(([model, d]) => {
      return {
        model,
        calls: d.calls,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheRead,
        cacheWriteTokens: d.cacheWrite,
        pricingStatus: d.pricingStatus,
        warnings: [...d.warnings],
        ...billingJsonFields(d.billing, billingConfig),
      }
    })
}

/// Build byProject array with billing-aware fields
function buildByProject(projects: ProjectSummary[], billingConfig: BillingConfig): unknown[] {
  return projects
    .slice()
    .sort((a, b) => billingMetricValue(billingAggregateFromProject(b), billingConfig) - billingMetricValue(billingAggregateFromProject(a), billingConfig))
    .map(p => {
      const billing = billingAggregateFromProject(p)
      return {
        project: p.projectPath,
        calls: p.totalApiCalls,
        sessions: p.sessions.length,
        ...billingJsonFields(billing, billingConfig),
      }
    })
}

export async function exportJson(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1].projects
  const { code, rate, symbol } = getCurrency()
  const billingConfig = loadBillingConfig()

  const billingMeta = buildBillingMetadata(billingConfig)

  const data = {
    schema: EXPORT_OUTPUT_SCHEMA,
    schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
    generated: new Date().toISOString(),
    currency: { code, rate, symbol },
    billing: billingMeta,
    warnings: collectPricingWarnings(thirtyDayProjects),
    overview: buildOverview(thirtyDayProjects, billingConfig),
    byModel: buildByModel(thirtyDayProjects, billingConfig),
    byProject: buildByProject(thirtyDayProjects, billingConfig),
    // Legacy fields for compatibility
    summary: buildSummaryRows(periods, billingConfig),
    periods: periods.map(p => ({
      label: p.label,
      daily: buildDailyRows(p.projects, p.label, billingConfig),
      activity: buildActivityRows(p.projects, p.label, billingConfig),
      models: buildModelRows(p.projects, p.label, billingConfig),
    })),
    projects: buildProjectRows(thirtyDayProjects, billingConfig),
    sessions: buildSessionRows(thirtyDayProjects, billingConfig),
    tools: buildToolRows(thirtyDayProjects),
    shellCommands: buildBashRows(thirtyDayProjects),
  }

  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(data, null, 2), 'utf-8')
  return target
}
