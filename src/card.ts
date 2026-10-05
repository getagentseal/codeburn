import { formatCost, getCurrency } from './currency.js'
import { toDateString } from './daily-cache.js'
import type { MenubarPayload } from './menubar-json.js'

export type CardTheme = 'dark' | 'light' | 'auto'

/// Everything the card shows. Aggregates only: no project, path, session or prompt field
/// exists here, so nothing of the kind can reach the SVG.
export type CardData = {
  period: string
  tools: Array<{ name: string; cost: number }>
  /// USD per day, oldest first, ending today.
  daily: number[]
  cost: number
  calls: number
  /// null when the period has no input or cache-read tokens at all.
  cacheHitPercent: number | null
}

const SPARK_DAYS = 14
const MAX_NAME = 24
const BAR_WIDTH = 26
const PAD = 8
// Wider than the 12px advance of Menlo, SF Mono and Consolas, so columns can only gain gap.
const CW = 7.4
const LH = 20
const ACCENT = '#F0793B'
const GREEN = '#6BCB77'
const GREY = '#8b8f97'
const TOOL_COLORS: Record<string, string> = { claude: ACCENT, codex: GREEN }
const LIGHT = '.m{fill:#57606a}.d{fill:#d0d7de}.v{fill:#1f2328}'
const DARK = '.m{fill:#8b8f97}.d{fill:#33373e}.v{fill:#e8e6e1}'
const SPARK = '▁▂▃▄▅▆▇█'

export function cardDataFromPayload(payload: Pick<MenubarPayload, 'current' | 'history'>, period: string, today: Date, top: number): CardData {
  const { current } = payload
  const tools = current.providerDetails
    .filter(p => p.hasUsage && !p.excludedFromTotal)
    .sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id))
    .slice(0, top)
    .map(p => ({ name: p.id, cost: p.cost }))
  const byDate = new Map(payload.history.daily.map(d => [d.date, d.cost]))
  const daily = Array.from({ length: SPARK_DAYS }, (_, i) =>
    byDate.get(toDateString(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (SPARK_DAYS - 1 - i)))) ?? 0)
  const hasCacheData = current.inputTokens + current.cacheReadTokens > 0
  return {
    period,
    tools,
    daily,
    cost: current.cost,
    calls: current.calls,
    cacheHitPercent: hasCacheData ? Math.round(current.cacheHitPercent * 10) / 10 : null,
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function grouped(formatted: string): string {
  return formatted.replace(/\d+/, n => Number(n).toLocaleString('en-US'))
}

function money(usd: number): string {
  return grouped(formatCost(usd))
}

function roundMoney(usd: number): string {
  const { rate, symbol } = getCurrency()
  return usd * rate >= 100 ? `${symbol}${Math.round(usd * rate).toLocaleString('en-US')}` : money(usd)
}

function fitName(name: string): string {
  return name.length > MAX_NAME ? name.slice(0, MAX_NAME - 1) + '…' : name
}

function x(col: number): string {
  return String(Math.round((PAD + col * CW) * 10) / 10)
}

export function renderCard(data: CardData, theme: CardTheme): string {
  const empty = data.tools.length === 0 && data.calls === 0 && data.cost === 0
  const lines: string[] = []
  let y = 20
  const header = empty ? `ai.agents@${data.period} ` : `ai.agents@${data.period} · top ${data.tools.length} `
  const rows: string[] = []
  let cols = header.length + 8

  if (empty) {
    const msg = ' no AI agent usage recorded for this period yet'
    cols = Math.max(cols, msg.length)
    y += LH
    rows.push(`<text x="${x(0)}" y="${y}" class="m">${esc(msg)}</text>`)
  } else {
    const names = data.tools.map(t => fitName(t.name))
    const labelWidth = Math.max(0, ...names.map(n => n.length))
    const max = Math.max(...data.tools.map(t => t.cost)) || 1
    const barCol = 1 + labelWidth + 2
    const costCol = barCol + BAR_WIDTH + 2
    data.tools.forEach((t, i) => {
      y += LH
      const bars = '█'.repeat(Math.max(1, Math.round(t.cost / max * BAR_WIDTH)))
      const cost = money(t.cost)
      cols = Math.max(cols, costCol + cost.length)
      rows.push(
        `<text x="${x(0)}" y="${y}" class="m"> ${esc(names[i]!)}</text>` +
        `<text x="${x(barCol)}" y="${y}" fill="${TOOL_COLORS[t.name] ?? GREY}">${bars}</text>` +
        `<text x="${x(costCol)}" y="${y}" class="v">${esc(cost)}</text>`,
      )
    })

    y += LH + 6
    const peak = Math.max(...data.daily)
    const spark = data.daily
      .map(v => v > 0 ? SPARK[Math.min(7, Math.floor(v / peak * 7.99))] : '<tspan class="d">▁</tspan>')
      .join('')
    const label = ` last ${SPARK_DAYS} days `
    const peakText = ` peak ${roundMoney(peak)}/day`
    const peakCol = label.length + SPARK_DAYS + 1
    cols = Math.max(cols, peakCol + peakText.length)
    rows.push(
      `<text x="${x(0)}" y="${y}" class="m">${label}</text>` +
      `<text x="${x(label.length)}" y="${y}" fill="${ACCENT}">${spark}</text>` +
      `<text x="${x(peakCol)}" y="${y}" class="m">${esc(peakText)}</text>`,
    )

    y += LH
    const periodLabel = ` ${data.period} `
    const totals = `${roundMoney(data.cost)} API-equiv · ${data.calls.toLocaleString('en-US')} call${data.calls === 1 ? '' : 's'}`
    const cache = data.cacheHitPercent === null ? '' : `${data.cacheHitPercent.toFixed(1)}% cache hit`
    const totalsText = cache ? `${totals} · ` : totals
    cols = Math.max(cols, periodLabel.length + totalsText.length + cache.length)
    rows.push(
      `<text x="${x(0)}" y="${y}" class="m">${esc(periodLabel)}</text>` +
      `<text x="${x(periodLabel.length)}" y="${y}" class="v">${esc(totalsText)}</text>` +
      (cache ? `<text x="${x(periodLabel.length + totalsText.length)}" y="${y}" fill="${GREEN}">${esc(cache)}</text>` : ''),
    )
  }

  y += LH
  rows.push(`<text x="${x(1)}" y="${y}" class="m" font-size="10">tracked by CodeBurn</text>`)

  const width = Math.ceil(PAD * 2 + cols * CW)
  const height = y + 12
  const colors = theme === 'dark' ? DARK : theme === 'light' ? LIGHT : `${LIGHT}\n@media (prefers-color-scheme: dark){${DARK}}`
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="AI agent usage tracked by CodeBurn">`,
    '<title>AI agent usage tracked by CodeBurn</title>',
    `<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;font-size:12px}\n.t{fill:${ACCENT};font-weight:bold}\n${colors}</style>`,
    `<text x="${x(0)}" y="20" class="t">${esc(header)}</text><text x="${x(header.length)}" y="20" class="d">${'─'.repeat(cols - header.length)}</text>`,
    ...rows,
    '</svg>',
  )
  return lines.join('\n') + '\n'
}
