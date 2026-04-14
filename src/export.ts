import { writeFile } from 'fs/promises'
import { resolve } from 'path'

import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory } from './types.js'
import { getCostColumnHeader, convertCost } from './currency.js'

function escCsv(s: string): string {
  const sanitized = /^[=+\-@]/.test(s) ? `'${s}` : s
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

function buildDailyRows(projects: ProjectSummary[]): Array<Record<string, string | number>> {
  const daily: Record<string, { cost: number; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {}

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = turn.timestamp.slice(0, 10)
        if (!daily[day]) daily[day] = { cost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
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

  return Object.entries(daily).sort().map(([date, d]) => ({
    Date: date,
    [getCostColumnHeader()]: convertCost(d.cost),
    'API Calls': d.calls,
    'Input Tokens': d.input,
    'Output Tokens': d.output,
    'Cache Read Tokens': d.cacheRead,
    'Cache Write Tokens': d.cacheWrite,
  }))
}

function buildActivityRows(projects: ProjectSummary[]): Array<Record<string, string | number>> {
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
  return Object.entries(catTotals)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([cat, d]) => ({
      Activity: CATEGORY_LABELS[cat as TaskCategory] ?? cat,
      [getCostColumnHeader()]: convertCost(d.cost),
      Turns: d.turns,
    }))
}

function buildModelRows(projects: ProjectSummary[]): Array<Record<string, string | number>> {
  const modelTotals: Record<string, { calls: number; cost: number; input: number; output: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, input: 0, output: 0 }
        modelTotals[model].calls += d.calls
        modelTotals[model].cost += d.costUSD
        modelTotals[model].input += d.tokens.inputTokens
        modelTotals[model].output += d.tokens.outputTokens
      }
    }
  }
  return Object.entries(modelTotals)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([model, d]) => ({
      Model: model,
      [getCostColumnHeader()]: convertCost(d.cost),
      'API Calls': d.calls,
      'Input Tokens': d.input,
      'Output Tokens': d.output,
    }))
}

function buildToolRows(projects: ProjectSummary[]): Array<Record<string, string | number>> {
  const toolTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, d] of Object.entries(session.toolBreakdown)) {
        toolTotals[tool] = (toolTotals[tool] ?? 0) + d.calls
      }
    }
  }
  return Object.entries(toolTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, calls]) => ({ Tool: tool, Calls: calls }))
}

function buildBashRows(projects: ProjectSummary[]): Array<Record<string, string | number>> {
  const bashTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cmd, d] of Object.entries(session.bashBreakdown)) {
        bashTotals[cmd] = (bashTotals[cmd] ?? 0) + d.calls
      }
    }
  }
  return Object.entries(bashTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([cmd, calls]) => ({ Command: cmd, Calls: calls }))
}

function buildProjectRows(projects: ProjectSummary[]): Array<Record<string, string | number>> {
  return projects.map(p => ({
    Project: p.projectPath,
    [getCostColumnHeader()]: convertCost(p.totalCostUSD),
    'API Calls': p.totalApiCalls,
    Sessions: p.sessions.length,
  }))
}

function rowsToCsv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers.map(escCsv).join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => escCsv(String(row[h] ?? ''))).join(','))
  }
  return lines.join('\n')
}

export type PeriodExport = {
  label: string
  projects: ProjectSummary[]
}

function buildSummaryRow(period: PeriodExport): Record<string, string | number> {
  const cost = period.projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const calls = period.projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const sessions = period.projects.reduce((s, p) => s + p.sessions.length, 0)
  return { Period: period.label, [getCostColumnHeader()]: convertCost(cost), 'API Calls': calls, Sessions: sessions }
}

export async function exportCsv(periods: PeriodExport[], outputPath: string): Promise<string> {
  const allProjects = periods.find(p => p.label === '30 Days')?.projects
    ?? periods[periods.length - 1].projects

  const parts: string[] = []

  parts.push('# Summary')
  parts.push(rowsToCsv(periods.map(buildSummaryRow)))
  parts.push('')

  for (const period of periods) {
    parts.push(`# Daily - ${period.label}`)
    parts.push(rowsToCsv(buildDailyRows(period.projects)))
    parts.push('')

    parts.push(`# Activity - ${period.label}`)
    parts.push(rowsToCsv(buildActivityRows(period.projects)))
    parts.push('')

    parts.push(`# Models - ${period.label}`)
    parts.push(rowsToCsv(buildModelRows(period.projects)))
    parts.push('')
  }

  parts.push('# Tools - All')
  parts.push(rowsToCsv(buildToolRows(allProjects)))
  parts.push('')

  parts.push('# Shell Commands - All')
  parts.push(rowsToCsv(buildBashRows(allProjects)))
  parts.push('')

  parts.push('# Projects - All')
  parts.push(rowsToCsv(buildProjectRows(allProjects)))
  parts.push('')

  const fullPath = resolve(outputPath)
  await writeFile(fullPath, parts.join('\n'), 'utf-8')
  return fullPath
}

export async function exportJson(periods: PeriodExport[], outputPath: string): Promise<string> {
  const allProjects = periods.find(p => p.label === '30 Days')?.projects
    ?? periods[periods.length - 1].projects

  const periodData: Record<string, unknown> = {}
  for (const period of periods) {
    periodData[period.label] = {
      summary: buildSummaryRow(period),
      daily: buildDailyRows(period.projects),
      activity: buildActivityRows(period.projects),
      models: buildModelRows(period.projects),
    }
  }

  const data = {
    generated: new Date().toISOString(),
    periods: periodData,
    tools: buildToolRows(allProjects),
    shellCommands: buildBashRows(allProjects),
    projects: buildProjectRows(allProjects),
  }

  const fullPath = resolve(outputPath)
  await writeFile(fullPath, JSON.stringify(data, null, 2), 'utf-8')
  return fullPath
}
