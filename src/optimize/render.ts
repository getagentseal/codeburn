import chalk from 'chalk'

import { formatCost } from '../currency.js'
import { formatTokens } from '../format.js'
import {
  ORANGE,
  DIM,
  GOLD,
  CYAN,
  GREEN,
  RED,
  PANEL_WIDTH,
  SEP,
} from './constants.js'
import type { Impact, HealthGrade, WasteFinding, WasteAction } from './types.js'

const IMPACT_COLORS: Record<Impact, string> = { high: RED, medium: ORANGE, low: DIM }
const GRADE_COLORS: Record<HealthGrade, string> = { A: GREEN, B: GREEN, C: GOLD, D: ORANGE, F: RED }

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(indent + current)
      current = word
    } else {
      current = current ? current + ' ' + word : word
    }
  }
  if (current) lines.push(indent + current)
  return lines.join('\n')
}

/// Section header for a finding's fix block, declaring its intended
/// destination. Issue #277: users were dropping one-time session openers
/// into CLAUDE.md as permanent rules because the prompts had no labeled
/// home in the output.
function renderActionHeader(action: WasteAction): string {
  const headerWidth = PANEL_WIDTH - 4
  const fillTo = (label: string): string => {
    const inner = ` ${label} `
    const trailing = Math.max(2, headerWidth - inner.length - 4)
    return `--${inner}${SEP.repeat(trailing)}`.padEnd(headerWidth)
  }
  switch (action.type) {
    case 'file-content':
      return fillTo(`Suggested ${action.path} addition`)
    case 'command':
      return fillTo('Run this command')
    case 'paste':
      switch (action.destination) {
        case 'claude-md':       return fillTo('Suggested CLAUDE.md addition (permanent rule)')
        case 'session-opener':  return fillTo('One-time session opener (do NOT add to CLAUDE.md)')
        case 'prompt':          return fillTo('Ask Claude in the current session')
        case 'shell-config':    return fillTo('Add to your shell config')
        default:                return fillTo('Suggested action')
      }
  }
}

function renderFinding(n: number, f: WasteFinding, costRate: number): string[] {
  const lines: string[] = []
  const costSaved = f.tokensSaved * costRate
  const impactLabel = f.impact.charAt(0).toUpperCase() + f.impact.slice(1)
  const trendBadge = f.trend === 'improving' ? ' improving \u2193 ' : ''
  const savings = `~${formatTokens(f.tokensSaved)} tokens (~${formatCost(costSaved)})`
  const titlePad = PANEL_WIDTH - f.title.length - impactLabel.length - trendBadge.length - 8
  const pad = titlePad > 0 ? ' ' + SEP.repeat(titlePad) + ' ' : '  '

  lines.push(chalk.hex(DIM)(`  ${SEP}${SEP}${SEP} `) +
    chalk.bold(`${n}. ${f.title}`) +
    chalk.hex(DIM)(pad) +
    chalk.hex(IMPACT_COLORS[f.impact])(impactLabel) +
    (trendBadge ? chalk.hex(GREEN)(trendBadge) : '') +
    chalk.hex(DIM)(` ${SEP}${SEP}${SEP}`))
  lines.push('')
  lines.push(wrap(f.explanation, PANEL_WIDTH - 4, '  '))
  lines.push('')
  lines.push(chalk.hex(GOLD)(`  Potential savings: ${savings}`))
  lines.push('')

  // Destination header — issue #277. Tells the user where each suggestion
  // belongs (CLAUDE.md / session opener / current chat / shell config) so
  // permanent rules and one-time prompts are no longer interchangeable in
  // the output.
  const a = f.fix
  lines.push(chalk.hex(ORANGE)(`  ${renderActionHeader(a)}`))
  lines.push(chalk.hex(DIM)(`  ${a.label}`))
  if (a.type === 'file-content') {
    for (const line of a.content.split('\n')) lines.push(chalk.hex(CYAN)(`    ${line}`))
  } else if (a.type === 'command') {
    for (const line of a.text.split('\n')) lines.push(chalk.hex(CYAN)(`    ${line}`))
  } else {
    for (const line of a.text.split('\n')) lines.push(chalk.hex(CYAN)(`    ${line}`))
  }
  lines.push('')
  return lines
}

export function renderOptimize(
  findings: WasteFinding[],
  costRate: number,
  periodLabel: string,
  periodCost: number,
  sessionCount: number,
  callCount: number,
  healthScore: number,
  healthGrade: HealthGrade,
): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`  ${chalk.bold.hex(ORANGE)('CodeBurn config health')}${chalk.dim('  ' + periodLabel)}`)
  lines.push(chalk.hex(DIM)('  ' + SEP.repeat(PANEL_WIDTH)))

  const issueSuffix = findings.length > 0 ? `, ${findings.length} issue${findings.length > 1 ? 's' : ''}` : ''
  lines.push('  ' + [
    `${sessionCount} sessions`,
    `${callCount.toLocaleString()} calls`,
    chalk.hex(GOLD)(formatCost(periodCost)),
    `Health: ${chalk.bold.hex(GRADE_COLORS[healthGrade])(healthGrade)}${chalk.dim(` (${healthScore}/100${issueSuffix})`)}`,
  ].join(chalk.hex(DIM)('   ')))
  lines.push('')

  if (findings.length === 0) {
    lines.push(chalk.hex(GREEN)('  Nothing to fix. Your setup is lean.'))
    lines.push('')
    lines.push(chalk.dim('  CodeBurn optimize scans your Claude Code sessions and config for'))
    lines.push(chalk.dim('  token waste: junk directory reads, duplicate file reads, unused'))
    lines.push(chalk.dim('  agents/skills/MCP servers, bloated CLAUDE.md, and more.'))
    lines.push('')
    return lines.join('\n')
  }

  const totalTokens = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const totalCost = totalTokens * costRate
  const pctRaw = periodCost > 0 ? (totalCost / periodCost) * 100 : 0
  const pct = pctRaw >= 1 ? pctRaw.toFixed(0) : pctRaw.toFixed(1)

  const costText = costRate > 0 ? ` (~${formatCost(totalCost)}, ~${pct}% of spend)` : ''
  lines.push(chalk.hex(GREEN)(`  Potential savings: ~${formatTokens(totalTokens)} tokens${costText}`))
  lines.push('')

  for (let i = 0; i < findings.length; i++) {
    lines.push(...renderFinding(i + 1, findings[i], costRate))
  }

  lines.push(chalk.hex(DIM)('  ' + SEP.repeat(PANEL_WIDTH)))
  lines.push(chalk.dim('  Estimates only.'))
  lines.push('')
  return lines.join('\n')
}
