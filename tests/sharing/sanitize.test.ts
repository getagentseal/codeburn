import { describe, it, expect } from 'vitest'

import { sanitizeForSharing } from '../../src/sharing/sanitize.js'
import type { MenubarPayload } from '../../src/menubar-json.js'

function fixture(): MenubarPayload {
  return {
    generated: 'now',
    current: {
      label: 'June',
      cost: 100,
      calls: 5,
      sessions: 2,
      oneShotRate: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheHitPercent: 90,
      codexCredits: 0,
      topActivities: [{ name: 'Coding', cost: 50, savingsUSD: 0, turns: 3, oneShotRate: 1 }],
      topModels: [{ name: 'Opus', cost: 80, savingsUSD: 0, savingsBaselineModel: '', calls: 4 }],
      providers: { claude: 100 },
      topProjects: [
        { name: 'secret-project', cost: 100, savingsUSD: 0, sessions: 2, avgCostPerSession: 50, sessionDetails: [] },
      ],
      tools: [{ name: 'Bash', calls: 9 }],
      topSessions: [{ project: 'secret-project', cost: 100, savingsUSD: 0, calls: 5, date: '2026-06-01', projectKey: '-Users-me-Projects-secret-project' }],
      byBranch: [
        { branch: 'exp/extraction-arms', cost: 60, calls: 3, sessions: 1 },
        { branch: null, cost: 40, calls: 2, sessions: 1 },
      ],
      pullRequests: {
        rows: [{
          url: 'https://github.com/secret-client/repo/pull/42', label: 'secret-client/repo#42',
          cost: 60, savingsUSD: 0, sessions: 1, calls: 5,
          firstStarted: '2026-06-01T10:00:00.000Z', lastEnded: '2026-06-01T12:00:00.000Z',
          approx: false, models: ['Opus'],
        }],
        distinctCost: 60, distinctSessions: 1, attributedCost: 60, unattributedCost: 0,
      },
    },
    history: {
      daily: [],
      timeline: {
        bucketMinutes: 15,
        modelSeries: [{ id: 'model_0', label: 'claude-opus-4-6' }],
        sessionSeries: [{ id: 'session_0', label: 'secret-project · abc123…cdef (claude)' }],
        points: [{
          timestamp: '2026-06-01T10:00:00.000Z',
          cost: 5,
          tokens: 150,
          models: [{ seriesId: 'model_0', cost: 5, tokens: 150 }],
          sessions: [{ seriesId: 'session_0', cost: 5, tokens: 150 }],
        }],
      },
    },
  } as unknown as MenubarPayload
}

describe('sanitizeForSharing', () => {
  it('strips project names and session detail but keeps aggregates', () => {
    const clean = sanitizeForSharing(fixture())
    expect(clean.current.topProjects).toEqual([])
    expect(clean.current.topSessions).toEqual([])
    expect(clean.current.cost).toBe(100)
    expect(clean.current.topModels[0]!.name).toBe('Opus')
    expect(clean.current.providers).toEqual({ claude: 100 })
    expect(clean.history.timeline?.sessionSeries).toEqual([])
    expect(clean.history.timeline?.points[0]!.sessions).toEqual([])
    expect(clean.history.timeline?.modelSeries).toHaveLength(1)
    expect(clean.history.timeline?.points[0]!.models).toHaveLength(1)
  })

  it('leaks no project name anywhere in the shared payload', () => {
    const clean = sanitizeForSharing(fixture())
    expect(JSON.stringify(clean)).not.toContain('secret-project')
  })

  it('drops the per-branch rows: branch names encode tickets, customers and codenames', () => {
    const clean = sanitizeForSharing(fixture())
    expect(clean.current.byBranch).toBeUndefined()
    expect(JSON.stringify(clean)).not.toContain('exp/extraction-arms')
  })

  it('leaks no working-directory key from the session rows', () => {
    const clean = sanitizeForSharing(fixture())
    expect(JSON.stringify(clean)).not.toContain('-Users-me-Projects-secret-project')
  })

  it('drops the pull-request rows: their urls and labels name the repository', () => {
    const clean = sanitizeForSharing(fixture())
    expect(clean.current.pullRequests).toBeUndefined()
    expect(JSON.stringify(clean)).not.toContain('github.com/secret-client/repo')
    expect(JSON.stringify(clean)).not.toContain('secret-client/repo#42')
  })

  it('drops the live-session block, which names the project and branch in flight', () => {
    const withSessions = {
      ...fixture(),
      liveSessions: {
        windowSeconds: 120,
        sessions: [{
          id: 'a', provider: 'claude', project: 'secret-project', branch: 'secret-branch',
          model: 'Opus 4.8', contextTokens: 1, contextWindow: 200_000,
          startedAt: '2026-09-01T10:00:00.000Z', lastActivityAt: '2026-09-01T12:00:00.000Z',
        }],
      },
    }
    const clean = sanitizeForSharing(withSessions)
    expect(clean.liveSessions).toBeUndefined()
    expect(JSON.stringify(clean)).not.toContain('secret-branch')
  })
})
