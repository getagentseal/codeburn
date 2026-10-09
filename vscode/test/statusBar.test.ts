import { describe, expect, it } from 'vitest'

import type { MenubarPayload, QuotaProvider } from '../../app/renderer/lib/types'
import { buildSummary, figureOf, quotaLines, statusText, summaryText, tooltipMarkdown } from '../../app/renderer/vscode/summary'

function payload(cost: number, opts: { estimated?: number; currency?: MenubarPayload['currency']; models?: Array<{ name: string; cost: number; estimatedCostUSD?: number }> } = {}): MenubarPayload {
  return {
    currency: opts.currency,
    current: {
      cost,
      providerDetails: opts.estimated === undefined ? undefined : [
        { id: 'claude', label: 'Claude', cost: cost - opts.estimated, estimatedCostUSD: 0 },
        { id: 'cursor', label: 'Cursor', cost: opts.estimated, estimatedCostUSD: opts.estimated },
        { id: 'excluded', label: 'Excluded', cost: 99, estimatedCostUSD: 99, excludedFromTotal: true },
      ],
      topModels: (opts.models ?? []).map(model => ({ ...model, savingsUSD: 0, savingsBaselineModel: '', calls: 1 })),
      topProjects: [{ name: 'codeburn', cost, savingsUSD: 0, sessions: 1, sessionDetails: [] }],
    },
  } as unknown as MenubarPayload
}

const quota: QuotaProvider[] = [
  { provider: 'claude', connection: 'connected', planLabel: 'Max', footerLines: [], primary: { label: 'Session', percent: 0.42, resetsAt: null }, details: [{ label: 'Weekly', percent: 0.61, resetsAt: null }] },
  { provider: 'codex', connection: 'disconnected', planLabel: null, footerLines: [], primary: null, details: [] },
]

describe('figureOf (the #1657 rule)', () => {
  it('marks a total whose estimated share is at least 1%', () => {
    expect(figureOf(payload(10, { estimated: 0.5 })).estimated).toBe(true)
    expect(figureOf(payload(10, { estimated: 0.05 })).estimated).toBe(false)
  })

  it('ignores providers excluded from the total', () => {
    expect(figureOf(payload(10, { estimated: 0 })).estimated).toBe(false)
  })

  it('falls back to the model split on a CLI without provider estimates', () => {
    expect(figureOf(payload(10, { models: [{ name: 'gpt', cost: 10, estimatedCostUSD: 4 }] })).estimated).toBe(true)
  })

  it('does not mark a figure that prints as zero', () => {
    expect(figureOf(payload(0.001, { estimated: 0.001 })).estimated).toBe(false)
  })
})

describe('statusText', () => {
  const summary = buildSummary({
    today: payload(12.4, { estimated: 1 }),
    week: payload(80),
    month: payload(300),
    workspace: { label: 'codeburn', today: payload(3.1), week: payload(20) },
    quota,
    optimize: { findingCount: 3, savingsUSD: 12 },
    now: Date.UTC(2026, 9, 6, 12),
  })

  it('shows today with ~ when estimated', () => {
    expect(statusText(summary, 'cost')).toBe('$(flame) ~$12.40')
  })

  it('adds the most-used quota window', () => {
    expect(statusText(summary, 'costAndQuota')).toBe('$(flame) ~$12.40 · 61%')
  })

  it('shows this workspace, then everything', () => {
    expect(statusText(summary, 'workspace')).toBe('$(flame) $3.10 / ~$12.40')
  })

  it('shows only the mark before the first read', () => {
    expect(statusText(null, 'cost')).toBe('$(flame)')
  })

  it('converts with the payload currency', () => {
    const euro = buildSummary({ today: payload(10, { currency: { code: 'EUR', symbol: '€', rate: 0.5 } }), week: null, month: null, workspace: null, quota: null, optimize: null })
    expect(statusText(euro, 'cost')).toBe('$(flame) €5.00')
  })

  it('writes a tooltip with every window, the workspace, quota and the open link', () => {
    const md = tooltipMarkdown(summary)
    expect(md).toContain('| Today | ~$12.40 |')
    expect(md).toContain('| Last 7 days | $80.00 |')
    expect(md).toContain('| This month | $300.00 |')
    expect(md).toContain('| codeburn today | $3.10 |')
    expect(md).toContain('Claude Max · Weekly · 61% used')
    expect(md).not.toContain('Codex')
    expect(md).toContain('estimated')
    expect(md).toContain('(command:codeburn.openDashboard)')
  })

  it('keeps workspace and model names literal in the tooltip', () => {
    const hostile = buildSummary({
      today: payload(1, { models: [{ name: '[x](command:evil) *m*', cost: 1 }] }), week: null, month: null,
      workspace: { label: 'repo|[a](https://e.x)`$(zap)`', today: payload(1), week: null }, quota: null, optimize: null,
    })
    const md = tooltipMarkdown(hostile)
    expect(md).toContain('repo\\|\\[a\\]\\(https://e.x\\)\\`\\$\\(zap\\)\\` today')
    expect(md).toContain('\\[x\\]\\(command:evil\\) \\*m\\*')
    expect(md.match(/\]\(command:/g)).toHaveLength(1)
  })

  it('copies a plain summary', () => {
    const text = summaryText(summary)
    expect(text).toContain('Today: ~$12.40')
    expect(text).toContain('codeburn: $3.10')
    expect(text).toContain('3 findings')
  })
})

describe('quotaLines', () => {
  it('keeps connected providers and their fullest window', () => {
    expect(quotaLines(quota)).toEqual([{ provider: 'claude', plan: 'Max', label: 'Weekly', percent: 0.61, resetsAt: null }])
  })
})
