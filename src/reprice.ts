import chalk from 'chalk'

import { formatCost } from './currency.js'
import { calculateCost, getModelCosts, getShortModelName } from './models.js'
import type { ParsedApiCall, ProjectSummary } from './types.js'

const ORANGE = '#ff8c42'
const GREEN = '#5bf5a0'
const RED = '#ff6b6b'
const GOLD = '#ffd700'
const DIM = '#888888'
const PANEL_WIDTH = 76
const TOP_LIMIT = 10

export type RepriceSummary = {
  targetModel: string
  actualCostUSD: number
  repricedCostUSD: number
  savingsUSD: number
  savingsPercent: number | null
  projects: number
  sessions: number
  calls: number
}

export type RepriceBreakdownRow = {
  name: string
  actualCostUSD: number
  repricedCostUSD: number
  savingsUSD: number
  calls: number
}

export type RepriceSessionImpact = {
  project: string
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  actualCostUSD: number
  repricedCostUSD: number
  savingsUSD: number
  calls: number
}

export type RepriceResult = {
  label: string
  summary: RepriceSummary
  topSessions: RepriceSessionImpact[]
  projects: RepriceBreakdownRow[]
  sourceModels: RepriceBreakdownRow[]
}

type MutableBreakdown = {
  actualCostUSD: number
  repricedCostUSD: number
  calls: number
}

function addBreakdown(map: Map<string, MutableBreakdown>, name: string, actualCostUSD: number, repricedCostUSD: number): void {
  const row = map.get(name) ?? { actualCostUSD: 0, repricedCostUSD: 0, calls: 0 }
  row.actualCostUSD += actualCostUSD
  row.repricedCostUSD += repricedCostUSD
  row.calls += 1
  map.set(name, row)
}

function toBreakdownRows(map: Map<string, MutableBreakdown>): RepriceBreakdownRow[] {
  return [...map.entries()]
    .map(([name, row]) => ({
      name,
      actualCostUSD: row.actualCostUSD,
      repricedCostUSD: row.repricedCostUSD,
      savingsUSD: row.actualCostUSD - row.repricedCostUSD,
      calls: row.calls,
    }))
    .sort((a, b) => Math.abs(b.savingsUSD) - Math.abs(a.savingsUSD))
}

function finiteCost(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function repriceCall(targetModel: string, call: ParsedApiCall): number {
  if (call.model === '<synthetic>') return 0
  return calculateCost(
    targetModel,
    call.usage.inputTokens,
    call.usage.outputTokens,
    call.usage.cacheCreationInputTokens,
    call.usage.cacheReadInputTokens,
    call.usage.webSearchRequests,
    call.speed,
  )
}

export function canRepriceToModel(model: string): boolean {
  return getModelCosts(model) !== null
}

export function analyzeReprice(projects: ProjectSummary[], label: string, targetModel: string): RepriceResult {
  const projectBreakdown = new Map<string, MutableBreakdown>()
  const sourceModelBreakdown = new Map<string, MutableBreakdown>()
  const topSessions: RepriceSessionImpact[] = []
  let actualCostUSD = 0
  let repricedCostUSD = 0
  let sessions = 0
  let calls = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      let sessionActualCostUSD = 0
      let sessionRepricedCostUSD = 0
      let sessionCalls = 0

      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (call.model === '<synthetic>') continue
          const actual = finiteCost(call.costUSD)
          const repriced = repriceCall(targetModel, call)

          actualCostUSD += actual
          repricedCostUSD += repriced
          sessionActualCostUSD += actual
          sessionRepricedCostUSD += repriced
          sessionCalls += 1
          calls += 1

          addBreakdown(projectBreakdown, project.project, actual, repriced)
          addBreakdown(sourceModelBreakdown, call.model, actual, repriced)
        }
      }

      if (sessionCalls > 0) {
        sessions += 1
        topSessions.push({
          project: project.project,
          sessionId: session.sessionId,
          firstTimestamp: session.firstTimestamp,
          lastTimestamp: session.lastTimestamp,
          actualCostUSD: sessionActualCostUSD,
          repricedCostUSD: sessionRepricedCostUSD,
          savingsUSD: sessionActualCostUSD - sessionRepricedCostUSD,
          calls: sessionCalls,
        })
      }
    }
  }

  topSessions.sort((a, b) => Math.abs(b.savingsUSD) - Math.abs(a.savingsUSD))

  const savingsUSD = actualCostUSD - repricedCostUSD
  return {
    label,
    summary: {
      targetModel,
      actualCostUSD,
      repricedCostUSD,
      savingsUSD,
      savingsPercent: actualCostUSD > 0 ? (savingsUSD / actualCostUSD) * 100 : null,
      projects: projects.length,
      sessions,
      calls,
    },
    topSessions: topSessions.slice(0, TOP_LIMIT),
    projects: toBreakdownRows(projectBreakdown),
    sourceModels: toBreakdownRows(sourceModelBreakdown),
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function formatPercent(value: number | null): string {
  if (value === null) return '-'
  return `${Math.abs(value).toFixed(1)}%`
}

function formatSignedCost(value: number): string {
  const abs = formatCost(Math.abs(value))
  if (value > 0) return chalk.hex(GREEN)(`save ${abs}`)
  if (value < 0) return chalk.hex(RED)(`cost +${abs}`)
  return chalk.dim('no change')
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function renderBreakdown(title: string, rows: RepriceBreakdownRow[], limit: number): string[] {
  if (rows.length === 0) return []
  const lines: string[] = []
  lines.push(`  ${chalk.bold(title)}`)
  for (const row of rows.slice(0, limit)) {
    lines.push(`  ${formatSignedCost(row.savingsUSD)}  ${chalk.bold(truncate(row.name, 34))}  ${chalk.dim(`${formatCost(row.actualCostUSD)} -> ${formatCost(row.repricedCostUSD)}`)}${chalk.dim(`  ${plural(row.calls, 'call')}`)}`)
  }
  lines.push('')
  return lines
}

export function renderRepriceText(result: RepriceResult): string {
  const { summary } = result
  const lines: string[] = []
  const targetLabel = getShortModelName(summary.targetModel)
  lines.push('')
  lines.push(`  ${chalk.bold.hex(ORANGE)('CodeBurn what-if pricing')}${chalk.dim('  ' + result.label)}`)
  lines.push(chalk.hex(DIM)('  ' + '-'.repeat(PANEL_WIDTH)))
  lines.push(`  Reprice target: ${chalk.bold(targetLabel)}${targetLabel !== summary.targetModel ? chalk.dim(` (${summary.targetModel})`) : ''}`)
  lines.push('  ' + [
    plural(summary.projects, 'project'),
    plural(summary.sessions, 'session'),
    plural(summary.calls, 'call'),
  ].join(chalk.hex(DIM)('   ')))
  lines.push('')

  if (summary.calls === 0) {
    lines.push(chalk.dim('  No usage data found for this period.'))
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`  Actual spend:     ${chalk.hex(GOLD)(formatCost(summary.actualCostUSD))}`)
  lines.push(`  What-if spend:    ${chalk.hex(GOLD)(formatCost(summary.repricedCostUSD))}`)
  lines.push(`  Difference:       ${formatSignedCost(summary.savingsUSD)} ${chalk.dim(`(${formatPercent(summary.savingsPercent)})`)}`)
  lines.push('')

  if (result.topSessions.length > 0) {
    lines.push(`  ${chalk.bold('Top session impacts')}`)
    for (const session of result.topSessions) {
      const target = `${session.project}/${session.sessionId}`
      lines.push(`  ${formatSignedCost(session.savingsUSD)}  ${chalk.bold(truncate(target, 38))}  ${chalk.dim(`${formatCost(session.actualCostUSD)} -> ${formatCost(session.repricedCostUSD)}`)}${chalk.dim(`  ${plural(session.calls, 'call')}`)}`)
    }
    lines.push('')
  }

  lines.push(...renderBreakdown('By project', result.projects, 5))
  lines.push(...renderBreakdown('By source model', result.sourceModels, 5))
  lines.push(chalk.dim('  Uses recorded token counts and tool/web-search usage; model quality and output length are not simulated.'))
  lines.push('')
  return lines.join('\n')
}
