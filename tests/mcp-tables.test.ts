import { describe, expect, it } from 'vitest'
import { renderSummaryTable, renderBreakdownTable, renderSavingsTable } from '../src/mcp/tables.js'
import type { MenubarPayload } from '../src/menubar-json.js'

function payload(): MenubarPayload {
  return {
    generated: '', optimize: { findingCount: 1, savingsUSD: 2.5, topFindings: [{ title: 'Trim system prompt', impact: 'high', savingsUSD: 2.5 }] }, history: { daily: [] },
    current: {
      label: 'Last 7 Days', cost: 12.5, calls: 100, sessions: 4, oneShotRate: 0.5, inputTokens: 1000, outputTokens: 500,
      cacheHitPercent: 80, topActivities: [{ name: 'feature', cost: 8, turns: 30, oneShotRate: 0.6 }],
      topModels: [{ name: 'Opus 4.8', cost: 10, calls: 60 }], providers: { 'claude code': 12.5 },
      topProjects: [{ name: 'project-abc123', cost: 12.5, sessions: 4, avgCostPerSession: 3.125, sessionDetails: [] }],
      modelEfficiency: [], topSessions: [],
      retryTax: { totalUSD: 1.2, retries: 4, editTurns: 20, byModel: [{ name: 'Opus 4.8', taxUSD: 1.2, retries: 4, retriesPerEdit: 0.2 }] },
      routingWaste: { totalSavingsUSD: 3, baselineModel: 'Haiku 4.5', baselineCostPerEdit: 0.01, byModel: [{ name: 'Opus 4.8', costPerEdit: 0.05, editTurns: 20, actualUSD: 1, counterfactualUSD: 0.2, savingsUSD: 0.8 }] },
      tools: [], skills: [], subagents: [], mcpServers: [],
    },
  } as MenubarPayload
}

describe('tables', () => {
  it('summary shows headline cost and top models', () => {
    const t = renderSummaryTable(payload())
    expect(t).toContain('Last 7 Days')
    expect(t).toContain('Opus 4.8')
    expect(t).toContain('| Model | Cost | Calls |')
  })
  it('breakdown by provider lists providers', () => {
    expect(renderBreakdownTable(payload(), 'provider', 20)).toContain('claude code')
  })
  it('breakdown handles empty dimension gracefully', () => {
    const p = payload(); p.current.topActivities = []
    expect(renderBreakdownTable(p, 'task', 20)).toContain('no data')
  })
  it('savings shows retry tax and routing waste', () => {
    const t = renderSavingsTable(payload())
    expect(t).toContain('Retry tax')
    expect(t).toContain('Routing waste')
    expect(t).toContain('Trim system prompt')
  })
})
