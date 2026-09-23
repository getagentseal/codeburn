import { writeFile, mkdir, readdir, open, stat, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { getCurrency, convertCost, roundForActiveCurrency } from './currency.js'
import { dateKey } from './day-aggregator.js'
import { behavioralCallWeight, behavioralTurnCount } from './behavioral-weight.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { callBillableOutputTokens, sessionModelBillableOutputTokens } from './session-output.js'
import { findUnpricedModels } from './models.js'

function escCsv(s: string): string {
  const sanitized = /^[\t\r=+\-@]/.test(s) ? `'${s}` : s
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

type Row = Record<string, string | number | boolean | undefined>

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
  savings: number
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
        const turnTs = turn.timestamp || turn.assistantCalls[0]?.timestamp || ''
        for (const call of turn.assistantCalls) {
          // Same per-call day rule as aggregateProjectsIntoDays, so the daily
          // rows sum to the summary and land on the days the history shows.
          const day = dateKey(Number.isNaN(new Date(call.timestamp).getTime()) ? turnTs : call.timestamp)
          if (!daily[day]) {
            daily[day] = { cost: 0, savings: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }
          }
          daily[day].sessions.add(session.sessionId)
          daily[day].cost += call.costUSD
          daily[day].savings += call.savingsUSD ?? 0
          // Same weight rule as aggregateProjectsIntoDays: a supplementary
          // accounting call carries cost/tokens but is not a distinct request,
          // so daily.csv call counts must reconcile with summary.csv.
          daily[day].calls += behavioralCallWeight(call)
          daily[day].input += call.usage.inputTokens
          daily[day].output += callBillableOutputTokens(call)
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
    [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost)),
    [`Saved (${code})`]: roundForActiveCurrency(convertCost(d.savings)),
    'API Calls': d.calls,
    Sessions: d.sessions.size,
    'Input Tokens': d.input,
    'Output Tokens': d.output,
    'Cache Read Tokens': d.cacheRead,
    'Cache Write Tokens': d.cacheWrite,
  }))
}

function buildRecordRows(projects: ProjectSummary[]): Row[] {
  const rows: Row[] = []
  const unpricedModels = new Map<string, boolean>()
  const isUnpriced = (model: string, cost: number): boolean => {
    if (cost > 0) return false
    let unpriced = unpricedModels.get(model)
    if (unpriced === undefined) {
      unpriced = findUnpricedModels([{ model, calls: 1, cost: 0 }]).length > 0
      unpricedModels.set(model, unpriced)
    }
    return unpriced
  }
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          rows.push({
            project: project.projectPath,
            sessionId: session.sessionId,
            timestamp: call.timestamp || turn.timestamp || undefined,
            category: turn.category,
            provider: call.provider,
            subagentType: session.agentType?.trim() || undefined,
            model: call.model || undefined,
            inputTokens: call.usage.inputTokens,
            outputTokens: call.usage.outputTokens,
            reasoningTokens: call.usage.reasoningTokens,
            cacheWriteTokens: call.usage.cacheCreationInputTokens,
            cacheReadTokens: Math.max(call.usage.cacheReadInputTokens, call.usage.cachedInputTokens),
            cost: convertCost(call.costUSD),
            savings: convertCost(call.savingsUSD ?? 0),
            // Records are the raw serve ledger and keep every supplementary
            // accounting row; the marker is how a "one row per API call"
            // consumer tells them apart. Key present on every row (undefined
            // when false) so rowsToCsv, which reads headers off the first row,
            // always emits the column; JSON drops the undefined ones.
            supplementary: call.supplementaryAccounting ? true : undefined,
            estimated: call.isEstimated ? true : undefined,
            unpriced: isUnpriced(call.model, call.costUSD) ? true : undefined,
          })
        }
      }
    }
  }
  return rows
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
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost)),
      'Share (%)': pct(d.cost, totalCost),
      Turns: d.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[], period: string): Row[] {
  const modelTotals: Record<string, { calls: number; cost: number; savings: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {}
  const modelEfficiency = aggregateModelEfficiency(projects)
  const ensure = (model: string) => {
    if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, savings: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    return modelTotals[model]
  }
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        const acc = ensure(model)
        acc.calls += d.calls
        acc.cost += d.costUSD
        acc.savings += d.savingsUSD
        acc.input += d.tokens.inputTokens
        acc.cacheRead += d.tokens.cacheReadInputTokens ?? 0
        acc.cacheWrite += d.tokens.cacheCreationInputTokens ?? 0
      }
      // Output must be billed per call while provider identity is still known.
      // Join on the same key as parser modelBreakdown (getShortModelName), not raw call.model.
      for (const [model, output] of Object.entries(sessionModelBillableOutputTokens(session))) {
        ensure(model).output += output
      }
    }
  }
  const totalCost = Object.values(modelTotals).reduce((s, d) => s + d.cost, 0)
  const { code } = getCurrency()
  return Object.entries(modelTotals)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => (b.cost + b.savings) - (a.cost + a.savings))
    .map(([model, d]) => {
      const efficiency = modelEfficiency.get(model)
      return {
        Period: period,
        Model: model,
        [`Cost (${code})`]: roundForActiveCurrency(convertCost(d.cost)),
        [`Saved (${code})`]: roundForActiveCurrency(convertCost(d.savings)),
        'Share (%)': pct(d.cost, totalCost),
        'API Calls': d.calls,
        'Edit Turns': efficiency?.editTurns ?? 0,
        'One-shot Rate (%)': efficiency?.oneShotRate ?? '',
        'Retries/Edit': efficiency?.retriesPerEdit ?? '',
        [`Cost/Edit (${code})`]: efficiency?.costPerEditUSD !== null && efficiency?.costPerEditUSD !== undefined
          ? roundForActiveCurrency(convertCost(efficiency.costPerEditUSD))
          : '',
        'Input Tokens': d.input,
        'Output Tokens': d.output,
        'Cache Read Tokens': d.cacheRead,
        'Cache Write Tokens': d.cacheWrite,
      }
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

function buildMcpRows(projects: ProjectSummary[]): Row[] {
  const mcpTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [server, d] of Object.entries(session.mcpBreakdown)) {
        mcpTotals[server] = (mcpTotals[server] ?? 0) + d.calls
      }
    }
  }
  const total = Object.values(mcpTotals).reduce((s, n) => s + n, 0)
  return Object.entries(mcpTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([server, calls]) => ({
      Server: server,
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
    .sort((a, b) => (b.totalCostUSD + b.totalSavingsUSD) - (a.totalCostUSD + a.totalSavingsUSD))
    .map(p => ({
      Project: p.projectPath,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(p.totalCostUSD)),
      [`Saved (${code})`]: roundForActiveCurrency(convertCost(p.totalSavingsUSD)),
      [`Avg/Session (${code})`]: p.sessions.length > 0 ? roundForActiveCurrency(convertCost(p.totalCostUSD / p.sessions.length)) : '',
      'Share (%)': pct(p.totalCostUSD, total),
      'API Calls': p.totalApiCalls,
      Sessions: p.sessions.length,
    }))
}

function buildSessionRows(projects: ProjectSummary[]): Row[] {
  const { code } = getCurrency()
  const rows: Row[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      const models = new Set(
        s.turns.flatMap(turn => turn.assistantCalls.map(call => call.model).filter(Boolean)),
      )
      rows.push({
        Project: p.projectPath,
        'Session ID': s.sessionId,
        'Started At': s.firstTimestamp ?? '',
        [`Cost (${code})`]: roundForActiveCurrency(convertCost(s.totalCostUSD)),
        [`Saved (${code})`]: roundForActiveCurrency(convertCost(s.totalSavingsUSD)),
        'API Calls': s.apiCalls,
        Turns: behavioralTurnCount(s.turns),
        subagentType: s.agentType?.trim() || undefined,
        model: models.size === 1 ? [...models][0] : undefined,
      })
    }
  }
  return rows.sort((a, b) => ((b[`Cost (${code})`] as number) + (b[`Saved (${code})`] as number)) - ((a[`Cost (${code})`] as number) + (a[`Saved (${code})`] as number)))
}

export type PeriodExport = {
  label: string
  projects: ProjectSummary[]
}

function buildSummaryRows(periods: PeriodExport[]): Row[] {
  const { code } = getCurrency()
  return periods.map(p => {
    const cost = p.projects.reduce((s, proj) => s + proj.totalCostUSD, 0)
    const savings = p.projects.reduce((s, proj) => s + proj.totalSavingsUSD, 0)
    const calls = p.projects.reduce((s, proj) => s + proj.totalApiCalls, 0)
    const sessions = p.projects.reduce((s, proj) => s + proj.sessions.length, 0)
    const projectCount = p.projects.filter(proj => proj.totalCostUSD > 0 || proj.totalSavingsUSD > 0).length
    return {
      Period: p.label,
      [`Cost (${code})`]: roundForActiveCurrency(convertCost(cost)),
      [`Saved (${code})`]: roundForActiveCurrency(convertCost(savings)),
      'API Calls': calls,
      Sessions: sessions,
      Projects: projectCount,
    }
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
    '  records.csv           One row per served call, with optional subagentType and model.',
    '                        supplementary marks accounting-only rows: recovered tokens/cost that',
    '                        are not distinct requests. estimated marks costs priced from',
    '                        estimated or missing token counts; unpriced marks $0 rows whose',
    '                        model has no known price. cost is unrounded.',
    '  projects.csv          Spend per project folder for the selected detail period.',
    '  sessions.csv          One row per session for the selected detail period.',
    '  tools.csv             Tool invocations and share for the selected detail period.',
    '  mcp.csv               MCP server invocations and share for the selected detail period.',
    '  shell-commands.csv    Shell commands executed via Bash tool for the selected detail period.',
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
  const markerStat = await stat(join(path, EXPORT_MARKER_FILE)).catch(() => null)
  return markerStat?.isFile() ?? false
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
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1]?.projects ?? []

  let folder = resolve(outputPath)
  if (folder.toLowerCase().endsWith('.csv')) {
    folder = folder.slice(0, -4)
  }

  // The desktop app (and any `-o <existing dir>`) hands us a real folder like the
  // Desktop, not a slot to fill: writing our ~11 files straight in would trip the
  // reuse guard below. Nest the export in a dated subfolder of our own and let the
  // guard apply to that. A folder we made earlier (marker present) is reused as-is.
  const targetStat = await stat(folder).catch(() => null)
  if (targetStat?.isDirectory() && !(await isCodeburnExportFolder(folder))) {
    folder = join(folder, `codeburn-export-${new Date().toISOString().slice(0, 10)}`)
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
  await writeFile(join(folder, 'records.csv'), rowsToCsv(buildRecordRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'projects.csv'), rowsToCsv(buildProjectRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'sessions.csv'), rowsToCsv(buildSessionRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'tools.csv'), rowsToCsv(buildToolRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'mcp.csv'), rowsToCsv(buildMcpRows(thirtyDayProjects)), 'utf-8')
  await writeFile(join(folder, 'shell-commands.csv'), rowsToCsv(buildBashRows(thirtyDayProjects)), 'utf-8')

  return folder
}

export async function exportJson(periods: PeriodExport[], outputPath: string): Promise<string> {
  const thirtyDays = periods.find(p => p.label === '30 Days')
  const thirtyDayProjects = thirtyDays?.projects ?? periods[periods.length - 1]?.projects ?? []
  const { code, rate, symbol } = getCurrency()

  const data = {
    schema: 'codeburn.export.v2',
    generated: new Date().toISOString(),
    currency: { code, rate, symbol },
    summary: buildSummaryRows(periods),
    periods: periods.map(p => ({
      label: p.label,
      daily: buildDailyRows(p.projects, p.label),
      activity: buildActivityRows(p.projects, p.label),
      models: buildModelRows(p.projects, p.label),
    })),
    projects: buildProjectRows(thirtyDayProjects),
    sessions: buildSessionRows(thirtyDayProjects),
    records: buildRecordRows(thirtyDayProjects),
    tools: buildToolRows(thirtyDayProjects),
    mcp: buildMcpRows(thirtyDayProjects),
    shellCommands: buildBashRows(thirtyDayProjects),
  }

  // The desktop app (and any `-o <existing dir>`) hands us a real folder, not a slot to
  // fill: appending `.json` to it wrote a sibling *of* the folder. Name a dated file
  // inside it instead, the same name exportCsv gives its dated subfolder. A path written
  // with a trailing separator says folder just as plainly, whether or not it exists yet.
  const namedAsFolder = /[\\/]$/.test(outputPath)
  let target = resolve(outputPath)
  if (namedAsFolder || (await stat(target).catch(() => null))?.isDirectory()) {
    target = join(target, `codeburn-export-${new Date().toISOString().slice(0, 10)}.json`)
  } else if (!target.toLowerCase().endsWith('.json')) {
    target = `${target}.json`
  }
  // Refuse to overwrite an existing file that wasn't produced by codeburn
  // export. CSV path has the same guard via the .codeburn-export marker; JSON
  // was missing it, so a stray `-o ~/important.json` would silently clobber.
  const existing = await stat(target).catch(() => null)
  if (existing?.isFile()) {
    // Read just the first 4KB to look for the schema marker. The schema key
    // is the first field in the JSON object so a partial read is enough;
    // loading the whole file (potentially gigabytes) into memory could OOM
    // on Node's ~512MB string limit.
    const fh = await open(target, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const head = buf.toString('utf-8', 0, bytesRead)
      if (!head.includes('"schema": "codeburn.export.v')) {
        throw new Error(
          `Refusing to overwrite ${target}: file does not look like a codeburn export. ` +
          `Delete it manually or pick a different -o path.`
        )
      }
    } finally {
      await fh.close()
    }
  }
  if (existing?.isDirectory()) {
    throw new Error(`Refusing to overwrite directory at ${target}. Pass a file path instead.`)
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(data, null, 2), 'utf-8')
  return target
}
