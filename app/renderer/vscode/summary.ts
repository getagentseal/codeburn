import { t } from '../i18n'
import { estimatedPortion, formatCount, formatResetTime, formatUsd, isEstimatedCost, setActiveCurrency, type ActiveCurrency } from '../lib/format'
import { PROVIDER_NAMES } from '../lib/providers'
import type { MenubarPayload, ProviderName, QuotaProvider } from '../lib/types'

export type Figure = { cost: number; estimated: boolean }
export type Ranked = { name: string; cost: number; estimated: boolean }
export type QuotaLine = { provider: string; plan: string | null; label: string; percent: number; resetsAt: string | null }

/** Everything the status bar, its tooltip, the sidebar and Copy summary show.
 *  Small and plain so the last one is cached and painted at the next startup. */
export type Summary = {
  at: number
  currency: ActiveCurrency
  today: Figure
  week: Figure | null
  month: Figure | null
  topModels: Ranked[]
  topProjects: Ranked[]
  workspace: { label: string; today: Figure; week: Figure | null } | null
  quota: QuotaLine[]
  optimize: { findingCount: number; savingsUSD: number } | null
}

const USD: ActiveCurrency = { code: 'USD', symbol: '$', rate: 1 }

/** The #1657 rule, as every other surface applies it. Needs the payload's currency active. */
export function figureOf(payload: MenubarPayload): Figure {
  return { cost: payload.current.cost, estimated: isEstimatedCost(payload.current.cost, estimatedPortion(payload.current)) }
}

export function buildSummary(input: {
  today: MenubarPayload
  week: MenubarPayload | null
  month: MenubarPayload | null
  workspace: { label: string; today: MenubarPayload; week: MenubarPayload | null } | null
  quota: QuotaProvider[] | null
  optimize: { findingCount: number; savingsUSD: number } | null
  now?: number
}): Summary {
  const currency = input.today.currency ?? USD
  setActiveCurrency(currency)
  const ranked = input.week ?? input.today
  return {
    at: input.now ?? Date.now(),
    currency,
    today: figureOf(input.today),
    week: input.week ? figureOf(input.week) : null,
    month: input.month ? figureOf(input.month) : null,
    topModels: (ranked.current.topModels ?? []).slice(0, 5).map(row => ({ name: row.name, cost: row.cost, estimated: isEstimatedCost(row.cost, row.estimatedCostUSD) })),
    topProjects: (ranked.current.topProjects ?? []).slice(0, 5).map(row => ({ name: row.name, cost: row.cost, estimated: false })),
    workspace: input.workspace
      ? { label: input.workspace.label, today: figureOf(input.workspace.today), week: input.workspace.week ? figureOf(input.workspace.week) : null }
      : null,
    quota: quotaLines(input.quota ?? []),
    optimize: input.optimize,
  }
}

/** One line per connected provider: its most-used window, the one that runs out first. */
export function quotaLines(quota: QuotaProvider[]): QuotaLine[] {
  const lines: QuotaLine[] = []
  for (const provider of quota) {
    if (provider.connection !== 'connected' && provider.connection !== 'stale') continue
    const windows = [provider.primary, ...provider.details].filter((w): w is NonNullable<typeof w> => w !== null)
    const top = windows.reduce<typeof windows[number] | null>((best, w) => (best === null || w.percent > best.percent ? w : best), null)
    if (!top) continue
    lines.push({ provider: provider.provider, plan: provider.planLabel, label: top.label, percent: top.percent, resetsAt: top.resetsAt })
  }
  return lines
}

export function money(figure: Figure): string {
  return `${figure.estimated ? '~' : ''}${formatUsd(figure.cost)}`
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

export type StatusBarFormat = 'cost' | 'costAndQuota' | 'workspace' | 'hidden'

export function statusText(summary: Summary | null, format: StatusBarFormat): string {
  if (!summary) return '$(flame)'
  setActiveCurrency(summary.currency)
  const today = money(summary.today)
  if (format === 'costAndQuota' && summary.quota.length > 0) {
    const top = Math.max(...summary.quota.map(line => line.percent))
    return `$(flame) ${today} · ${percent(top)}`
  }
  if (format === 'workspace' && summary.workspace) return `$(flame) ${money(summary.workspace.today)} / ${today}`
  return `$(flame) ${today}`
}

function providerName(line: QuotaLine): string {
  const name = PROVIDER_NAMES[line.provider as ProviderName] ?? line.provider
  return line.plan ? `${name} ${line.plan}` : name
}

export function quotaText(line: QuotaLine): string {
  const reset = formatResetTime(line.resetsAt)
  const used = reset
    ? t('plans.quota.usedWithReset', { percent: Math.round(line.percent * 100), reset })
    : t('plans.quota.used', { percent: Math.round(line.percent * 100) })
  return `${providerName(line)} · ${line.label} · ${used}`
}

/** Names reach the tooltip from repositories and logs: keep them literal text. */
function cell(text: string): string {
  return text.replace(/[\\`*_[\]()|<>!$#~]/g, '\\$&')
}

/** The status bar tooltip: plain markdown, one command link, no HTML. */
export function tooltipMarkdown(summary: Summary): string {
  setActiveCurrency(summary.currency)
  const rows: Array<[string, string]> = [[t('common.period.today'), money(summary.today)]]
  if (summary.week) rows.push([t('common.period.week'), money(summary.week)])
  if (summary.month) rows.push([t('common.period.month'), money(summary.month)])
  if (summary.workspace) rows.push([t('ide.status.workspaceToday', { name: summary.workspace.label }), money(summary.workspace.today)])
  const out = ['**CodeBurn**', '', '| | |', '|:--|--:|', ...rows.map(([label, value]) => `| ${cell(label)} | ${value} |`), '']
  const top = summary.topModels[0]
  if (top) out.push(`${t('ide.status.topModel')}: ${cell(top.name)} · ${money(top)}`, '')
  if (summary.quota.length > 0) {
    out.push(`**${t('shell.nav.plans')}**`, '')
    for (const line of summary.quota) out.push(`- ${quotaText(line)}`)
    out.push('')
  }
  const estimated = [summary.today, summary.week, summary.month, summary.workspace?.today, top].some(figure => figure?.estimated)
  if (estimated) out.push(`_${t('shared.usd.estimated')}_`, '')
  out.push(`[${t('ide.status.open')}](command:codeburn.openDashboard)`)
  return out.join('\n')
}

/** Copy summary: plain text a person pastes into a chat or a standup note. */
export function summaryText(summary: Summary): string {
  setActiveCurrency(summary.currency)
  const lines = [`CodeBurn · ${new Date(summary.at).toLocaleDateString()}`]
  lines.push(`${t('common.period.today')}: ${money(summary.today)}`)
  if (summary.week) lines.push(`${t('common.period.week')}: ${money(summary.week)}`)
  if (summary.month) lines.push(`${t('common.period.month')}: ${money(summary.month)}`)
  if (summary.workspace) {
    lines.push(`${summary.workspace.label}: ${money(summary.workspace.today)}${summary.workspace.week ? ` · ${t('common.period.week')} ${money(summary.workspace.week)}` : ''}`)
  }
  if (summary.topModels.length > 0) {
    lines.push(`${t('ide.sidebar.topModels')}: ${summary.topModels.slice(0, 3).map(row => `${row.name} ${money(row)}`).join(', ')}`)
  }
  for (const line of summary.quota) lines.push(quotaText(line))
  if (summary.optimize && summary.optimize.findingCount > 0) {
    lines.push(`${t('shell.nav.optimize')}: ${formatCount(summary.optimize.findingCount, 'finding')} · ${t('ide.sidebar.savings', { amount: formatUsd(summary.optimize.savingsUSD) })}`)
  }
  return lines.join('\n')
}

/** What the activity bar view renders. */
export type SidebarState = {
  status: 'loading' | 'ok' | 'error'
  error: { kind: string; message: string } | null
  summary: Summary | null
  /** The workspace's name, or null with no folder open. */
  workspaceLabel: string | null
  /** Set when the CLI runs on the editor's own, too-old Node. */
  runtimeNote: string | null
  /** The star line at the bottom, once the extension has seen real use. */
  star?: boolean
}
