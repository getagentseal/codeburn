import { formatCost, formatTokens } from '../format.js'
import type { MenubarPayload } from '../menubar-json.js'

export type BreakdownBy = 'project' | 'model' | 'task' | 'provider'

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  if (rows.length === 0) return `${head}\n${sep}\n| _(no data)_ ${' | '.repeat(headers.length - 1)}|`
  return [head, sep, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
}

const pct = (n: number) => `${Math.round(n)}%`
const oneShot = (r: number | null) => (r === null ? 'n/a' : pct(r * 100))

export function renderSummaryTable(p: MenubarPayload): string {
  const c = p.current
  const unpriced = c.unpricedModels ?? []
  return [
    `**${c.label}** — ${formatCost(c.cost)} · ${c.calls} calls · ${c.sessions} sessions`,
    `cache hit ${pct(c.cacheHitPercent)} · one-shot ${oneShot(c.oneShotRate)} · in ${formatTokens(c.inputTokens)} / out ${formatTokens(c.outputTokens)}`,
    ...(unpriced.length > 0
      ? [`⚠ ${unpriced.length} model${unpriced.length === 1 ? '' : 's'} unpriced, counted at $0: ${unpriced.map(u => `${u.model} (${u.calls} calls)`).join(', ')}. Cost above understates real spend; fix with \`codeburn model-alias\` or \`codeburn price-override\`.`]
      : []),
    '',
    '_Top models_',
    mdTable(['Model', 'Cost', 'Calls'], c.topModels.slice(0, 5).map(m => [m.name, formatCost(m.cost), String(m.calls)])),
    '',
    '_Top projects_',
    mdTable(['Project', 'Cost', 'Sessions'], c.topProjects.slice(0, 5).map(x => [x.name, formatCost(x.cost), String(x.sessions)])),
  ].join('\n')
}

export function renderBreakdownTable(p: MenubarPayload, by: BreakdownBy, limit: number): string {
  const c = p.current
  if (by === 'model') return mdTable(['Model', 'Cost', 'Calls'], c.topModels.slice(0, limit).map(m => [m.name, formatCost(m.cost), String(m.calls)]))
  if (by === 'project') return mdTable(['Project', 'Cost', 'Sessions'], c.topProjects.slice(0, limit).map(x => [x.name, formatCost(x.cost), String(x.sessions)]))
  if (by === 'task') return mdTable(['Task', 'Cost', 'Turns', 'One-shot'], c.topActivities.slice(0, limit).map(a => [a.name, formatCost(a.cost), String(a.turns), oneShot(a.oneShotRate)]))
  return mdTable(['Provider', 'Cost'], Object.entries(c.providers).sort(([, a], [, b]) => b - a).slice(0, limit).map(([name, cost]) => [name, formatCost(cost)]))
}

export function renderSavingsTable(p: MenubarPayload): string {
  const c = p.current
  const findings = mdTable(['Finding', 'Impact', 'Saves'], p.optimize.topFindings.slice(0, 10).map(f => [f.title, f.impact, formatCost(f.savingsUSD)]))
  const retry = mdTable(['Model', 'Retry tax', 'Retries'], c.retryTax.byModel.map(m => [m.name, formatCost(m.taxUSD), String(m.retries)]))
  const routing = mdTable(['Model', 'Overpaid', 'vs baseline'], c.routingWaste.byModel.map(m => [m.name, formatCost(m.savingsUSD), c.routingWaste.baselineModel]))
  return [
    `**Savings — ${c.label}**`,
    `Optimize findings: ${p.optimize.findingCount} (≈ ${formatCost(p.optimize.savingsUSD)})`,
    findings, '',
    `_Retry tax_ — ${formatCost(c.retryTax.totalUSD)} on ${c.retryTax.retries} retries`,
    retry, '',
    `_Routing waste_ — ${formatCost(c.routingWaste.totalSavingsUSD)} vs ${c.routingWaste.baselineModel || 'n/a'}`,
    routing,
  ].join('\n')
}
