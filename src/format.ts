import chalk from 'chalk'
import type { ProjectSummary } from './types.js'

// Re-exported from currency.ts so existing imports from './format.js' keep working.
// The currency-aware version applies exchange rate and symbol automatically.
// Imported locally too since renderStatusBar below uses it directly.
import { formatCost } from './currency.js'
export { formatCost }

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

/// Returns YYYY-MM-DD for the given date in the process-local timezone. Cheaper than shelling
/// out to Intl.DateTimeFormat for every turn in a loop and avoids the UTC drift that bites
/// `Date.toISOString().slice(0,10)` whenever the user runs this between local midnight and
/// UTC midnight.
function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function renderStatusBar(projects: ProjectSummary[]): string {
  const now = new Date()
  const today = localDateString(now)
  const monthStart = `${today.slice(0, 7)}-01`

  let todayCost = 0, todayCalls = 0, monthCost = 0, monthCalls = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (turn.assistantCalls.length === 0) continue
        // Bucket by the first assistant call's local date -- the moment the cost was
        // incurred. Bucketing by `turn.timestamp` (the user message time) drops turns
        // that straddle midnight (user asked at 23:58, response arrived at 00:30) and
        // disagrees with parseAllSessions' dateRange filter which is also on assistant
        // time.
        const bucketTs = turn.assistantCalls[0]!.timestamp
        if (!bucketTs) continue
        const day = localDateString(new Date(bucketTs))
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
