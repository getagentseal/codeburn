import chalk from 'chalk'
import type { ProjectSummary } from './types.js'
import { loadBillingConfig } from './billing.js'

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

/// Format Augment credits for display.
/// null returns '—' (no billing data), 0 returns '0', positive returns the number.
export function formatCredits(credits: number | null): string {
  if (credits === null) return '—'
  if (credits >= 1_000_000) return `${(credits / 1_000_000).toFixed(1)}M`
  if (credits >= 1_000) return `${(credits / 1_000).toFixed(1)}K`
  return credits.toFixed(0)
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
  const billingConfig = loadBillingConfig()
  const now = new Date()
  const today = localDateString(now)
  const monthStart = `${today.slice(0, 7)}-01`

  let todayValue = 0, todayCalls = 0, monthValue = 0, monthCalls = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        // Bucket by the session timestamp's local date so the user's "today" and "this month"
        // match the wall clock on their machine. Session timestamps are stored as UTC ISO
        // strings; naively slicing `timestamp.slice(0,10)` bucketed them by UTC date, which
        // showed `Today $0` during the UTC-midnight-to-local-midnight window.
        const day = localDateString(new Date(turn.timestamp))
        // Use billing-mode aware value: credits in credits mode, billedAmountUsd in token_plus
        const turnValue = turn.assistantCalls.reduce((s, c) => {
          if (billingConfig.mode === 'credits') {
            return s + (c.billing?.creditsAugment ?? c.credits ?? 0)
          } else {
            return s + (c.billing?.billedAmountUsd ?? c.costUSD)
          }
        }, 0)
        const turnCalls = turn.assistantCalls.length
        if (day === today) { todayValue += turnValue; todayCalls += turnCalls }
        if (day >= monthStart) { monthValue += turnValue; monthCalls += turnCalls }
      }
    }
  }

  const lines: string[] = ['']
  if (billingConfig.mode === 'credits') {
    lines.push(`  ${chalk.bold('Today')}  ${chalk.yellowBright(formatCredits(todayValue))}  ${chalk.dim(`${todayCalls} calls`)}    ${chalk.bold('Month')}  ${chalk.yellowBright(formatCredits(monthValue))}  ${chalk.dim(`${monthCalls} calls`)}`)
  } else {
    lines.push(`  ${chalk.bold('Today')}  ${chalk.yellowBright(formatCost(todayValue))}  ${chalk.dim(`${todayCalls} calls`)}    ${chalk.bold('Month')}  ${chalk.yellowBright(formatCost(monthValue))}  ${chalk.dim(`${monthCalls} calls`)}`)
  }
  lines.push('')

  return lines.join('\n')
}
