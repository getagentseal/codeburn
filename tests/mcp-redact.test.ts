import { describe, expect, it } from 'vitest'
import { pseudonym, redactProjectNames } from '../src/mcp/redact.js'
import type { MenubarPayload } from '../src/menubar-json.js'

function payload(): MenubarPayload {
  const base = {
    name: 'secret-client-repo', cost: 5, sessions: 2, avgCostPerSession: 2.5,
    sessionDetails: [{ cost: 3, calls: 5, inputTokens: 100, outputTokens: 50, date: '2026-06-01', models: [{ name: 'Opus', cost: 3 }] }],
  }
  return {
    generated: '', optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: {
      daily: [],
      timeline: {
        bucketMinutes: 15,
        modelSeries: [{ id: 'model_0', label: 'Opus' }],
        sessionSeries: [{ id: 'session_0', label: 'secret-client-repo · abc123 (claude)' }],
        points: [{
          timestamp: '2026-06-01T10:00:00.000Z', cost: 5, tokens: 150,
          models: [{ seriesId: 'model_0', cost: 5, tokens: 150 }],
          sessions: [{ seriesId: 'session_0', cost: 5, tokens: 150 }],
        }],
      },
    },
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
  it('removes session timeline detail by default but keeps model aggregates', () => {
    const out = redactProjectNames(payload(), false)
    expect(out.history.timeline?.sessionSeries).toEqual([])
    expect(out.history.timeline?.points[0]!.sessions).toEqual([])
    expect(out.history.timeline?.modelSeries).toHaveLength(1)
    expect(out.history.timeline?.points[0]!.models).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain('secret-client-repo ·')
  })
  it('keeps real names and session details when include=true', () => {
    const out = redactProjectNames(payload(), true)
    expect(out.current.topProjects[0]!.name).toBe('secret-client-repo')
    expect(out.current.topProjects[0]!.sessionDetails![0]!.date).toBe('2026-06-01')
    expect(out.history.timeline?.sessionSeries[0]!.label).toContain('secret-client-repo')
  })
})
