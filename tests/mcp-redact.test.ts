import { describe, expect, it } from 'vitest'
import { pseudonym, redactProjectNames } from '../src/mcp/redact.js'
import type { MenubarPayload } from '../src/menubar-json.js'

function payload(): MenubarPayload {
  const base = {
    name: 'secret-client-repo', cost: 5, sessions: 2, avgCostPerSession: 2.5,
    sessionDetails: [{ cost: 3, calls: 5, inputTokens: 100, outputTokens: 50, date: '2026-06-01', models: [{ name: 'Opus', cost: 3 }] }],
  }
  return {
    generated: '', optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] }, history: { daily: [] },
    current: {
      label: 'Today', cost: 5, calls: 10, sessions: 2, oneShotRate: null, inputTokens: 0, outputTokens: 0,
      cacheHitPercent: 0, topActivities: [], topModels: [], providers: {},
      topProjects: [base], modelEfficiency: [],
      topSessions: [{ project: 'secret-client-repo', cost: 5, calls: 10, date: '2026-06-01' }],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [], skills: [], subagents: [], mcpServers: [],
    },
  } as MenubarPayload
}

describe('redact', () => {
  it('pseudonym is stable and path-free', () => {
    expect(pseudonym('a')).toBe(pseudonym('a'))
    expect(pseudonym('secret-client-repo')).toMatch(/^project-[0-9a-f]{6}$/)
    expect(pseudonym('a/b/c')).not.toContain('/')
  })
  it('hashes project names by default, preserves numbers', () => {
    const out = redactProjectNames(payload(), false)
    expect(out.current.topProjects[0]!.name).toMatch(/^project-[0-9a-f]{6}$/)
    expect(out.current.topSessions[0]!.project).toMatch(/^project-[0-9a-f]{6}$/)
    expect(out.current.topProjects[0]!.cost).toBe(5)
  })
  it('redacts session details when hashing', () => {
    const out = redactProjectNames(payload(), false)
    const details = out.current.topProjects[0]!.sessionDetails!
    expect(details).toHaveLength(1)
    expect(details[0]!.date).toBe('')
    expect(details[0]!.models).toEqual([])
    expect(details[0]!.cost).toBe(3)
  })
  it('same project name gets same pseudonym in topProjects and topSessions', () => {
    const out = redactProjectNames(payload(), false)
    expect(out.current.topProjects[0]!.name).toBe(out.current.topSessions[0]!.project)
  })
  it('keeps real names and session details when include=true', () => {
    const out = redactProjectNames(payload(), true)
    expect(out.current.topProjects[0]!.name).toBe('secret-client-repo')
    expect(out.current.topProjects[0]!.sessionDetails![0]!.date).toBe('2026-06-01')
  })
})
