import { describe, expect, it } from 'vitest'
import { pseudonym, redactProjectNames } from '../src/mcp/redact.js'
import type { MenubarPayload } from '../src/menubar-json.js'

const RAW_SESSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const RAW_PROJECT_KEY = '-Users-me-Projects-secret-client-repo'

function payload(): MenubarPayload {
  const base = {
    name: 'secret-client-repo', cost: 5, sessions: 2, avgCostPerSession: 2.5,
    sessionDetails: [{ cost: 3, calls: 5, inputTokens: 100, outputTokens: 50, date: '2026-06-01', models: [{ name: 'Opus', cost: 3 }], sessionId: RAW_SESSION_ID, provider: 'claude' }],
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
      topSessions: [{ project: 'secret-client-repo', cost: 5, calls: 10, date: '2026-06-01', sessionId: RAW_SESSION_ID, provider: 'claude', projectKey: RAW_PROJECT_KEY }],
      byBranch: [
        { branch: 'exp/extraction-arms', cost: 4, calls: 8, sessions: 1 },
        { branch: null, cost: 1, calls: 2, sessions: 1 },
      ],
      pullRequests: {
        rows: [{
          url: 'https://github.com/secret-client/repo/pull/42', label: 'secret-client/repo#42',
          cost: 4, savingsUSD: 0, sessions: 1, calls: 8,
          firstStarted: '2026-06-01T10:00:00.000Z', lastEnded: '2026-06-01T12:00:00.000Z',
          approx: false, models: ['Opus'],
        }],
        distinctCost: 4, distinctSessions: 1, attributedCost: 4, unattributedCost: 0,
      },
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
  it('hashes topProjects id when present so cwd is not leaked', () => {
    const withId = payload()
    withId.current.topProjects[0]!.id = '/tmp/secret-client-repo'
    const out = redactProjectNames(withId, false)
    expect(out.current.topProjects[0]!.id).toMatch(/^project-[0-9a-f]{6}$/)
    expect(JSON.stringify(out)).not.toContain('/tmp/secret-client-repo')
  })
  it('redacts session details when hashing', () => {
    const out = redactProjectNames(payload(), false)
    const details = out.current.topProjects[0]!.sessionDetails!
    expect(details).toHaveLength(1)
    expect(details[0]!.date).toBe('')
    expect(details[0]!.models).toEqual([])
    expect(details[0]!.cost).toBe(3)
  })
  it('hashes the topSessions project key, which is a dash-encoded working directory', () => {
    const out = redactProjectNames(payload(), false)
    expect(out.current.topSessions[0]!.projectKey).toMatch(/^project-[0-9a-f]{6}$/)
    expect(JSON.stringify(out)).not.toContain(RAW_PROJECT_KEY)
  })
  it('hashes session ids on topSessions and sessionDetails but keeps the provider', () => {
    const out = redactProjectNames(payload(), false)
    expect(out.current.topSessions[0]!.sessionId).toMatch(/^session-[0-9a-f]{6}$/)
    expect(out.current.topSessions[0]!.provider).toBe('claude')
    const detail = out.current.topProjects[0]!.sessionDetails![0]!
    expect(detail.sessionId).toMatch(/^session-[0-9a-f]{6}$/)
    expect(detail.provider).toBe('claude')
    expect(JSON.stringify(out)).not.toContain(RAW_SESSION_ID)
  })
  it('hashes branch names and keeps the per-branch numbers', () => {
    const out = redactProjectNames(payload(), false)
    const rows = out.current.byBranch!
    expect(rows[0]!.branch).toMatch(/^branch-[0-9a-f]{6}$/)
    expect(rows[0]!.cost).toBe(4)
    expect(rows[0]!.calls).toBe(8)
    expect(rows[0]!.sessions).toBe(1)
    expect(JSON.stringify(out)).not.toContain('exp/extraction-arms')
  })
  it('leaves an unbranched row null: it is spend, not a branch name', () => {
    const out = redactProjectNames(payload(), false)
    expect(out.current.byBranch![1]!.branch).toBeNull()
    expect(out.current.byBranch![1]!.cost).toBe(1)
  })
  it('gives the same branch the same pseudonym on every call', () => {
    const first = redactProjectNames(payload(), false).current.byBranch![0]!.branch
    const second = redactProjectNames(payload(), false).current.byBranch![0]!.branch
    expect(first).toBe(second)
  })
  it('pseudonymizes PR urls and labels but keeps the numbers', () => {
    const out = redactProjectNames(payload(), false)
    const row = out.current.pullRequests!.rows[0]!
    expect(row.url).toMatch(/^pr-[0-9a-f]{6}$/)
    expect(row.label).toBe(row.url)
    expect(row.cost).toBe(4)
    expect(row.calls).toBe(8)
    expect(JSON.stringify(out)).not.toContain('github.com/secret-client/repo')
    expect(JSON.stringify(out)).not.toContain('secret-client/repo#42')
  })
  it('gives the same PR the same pseudonym across calls, distinct from other PRs', () => {
    const first = redactProjectNames(payload(), false).current.pullRequests!.rows[0]!.url
    const second = redactProjectNames(payload(), false).current.pullRequests!.rows[0]!.url
    expect(first).toBe(second)
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
    expect(out.current.byBranch![0]!.branch).toBe('exp/extraction-arms')
    expect(out.current.topSessions[0]!.projectKey).toBe(RAW_PROJECT_KEY)
    expect(out.current.topSessions[0]!.sessionId).toBe(RAW_SESSION_ID)
    expect(out.current.topProjects[0]!.name).toBe('secret-client-repo')
    expect(out.current.topProjects[0]!.sessionDetails![0]!.date).toBe('2026-06-01')
    expect(out.current.pullRequests!.rows[0]!.url).toBe('https://github.com/secret-client/repo/pull/42')
    expect(out.current.pullRequests!.rows[0]!.label).toBe('secret-client/repo#42')
    expect(out.history.timeline?.sessionSeries[0]!.label).toContain('secret-client-repo')
  })
  it('drops the live-session block even when names are included', () => {
    const withSessions: MenubarPayload = {
      ...payload(),
      liveSessions: {
        windowSeconds: 120,
        sessions: [{
          id: 'a', provider: 'claude', project: 'secret-client-repo', branch: 'secret-branch',
          model: 'Opus 4.8', contextTokens: 1, contextWindow: 200_000,
          startedAt: '2026-09-01T10:00:00.000Z', lastActivityAt: '2026-09-01T12:00:00.000Z',
        }],
      },
    }
    expect(redactProjectNames(withSessions, false).liveSessions).toBeUndefined()
    const included = redactProjectNames(withSessions, true)
    expect(included.liveSessions).toBeUndefined()
    expect(JSON.stringify(included)).not.toContain('secret-branch')
  })
})
