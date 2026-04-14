import chalk from 'chalk'
import type { ProjectSummary } from './types.js'

import { GLOBAL_CURRENCY } from './cli.js'

const rates: Record<string, number> = {
  USD: 1,
  INR: 83 // fixed rate for now
}

export function formatCost(cost: number): string {
  const rate = rates[GLOBAL_CURRENCY] || 1
  const converted = cost * rate

  if (GLOBAL_CURRENCY === 'INR') {
    if (converted >= 1) return `₹${converted.toFixed(2)}`
    if (converted >= 0.01) return `₹${converted.toFixed(3)}`
    return `₹${converted.toFixed(4)}`
  }

  if (converted >= 1) return `$${converted.toFixed(2)}`
  if (converted >= 0.01) return `$${converted.toFixed(3)}`
  return `$${converted.toFixed(4)}`
}
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

export function renderStatusBar(projects: ProjectSummary[]): string {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const monthStart = `${today.slice(0, 7)}-01`

  let todayCost = 0, todayCalls = 0, monthCost = 0, monthCalls = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = turn.timestamp.slice(0, 10)
        const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        const turnCalls = turn.assistantCalls.length
        if (day === today) { todayCost += turnCost; todayCalls += turnCalls }
        if (day >= monthStart) { monthCost += turnCost; monthCalls += turnCalls }
      }
    }
  }

  const lines: string[] = ['']
  lines.push(`  ${chalk.bold('Today')}  ${chalk.yellowBright(formatCost(todayCost))}  ${chalk.dim(`${todayCalls} calls`)}    ${chalk.bold('Month')}  ${chalk.yellowBright(formatCost(monthCost))}  ${chalk.dim(`${monthCalls} calls`)}`)
  lines.push('')

  return lines.join('\n')
}
