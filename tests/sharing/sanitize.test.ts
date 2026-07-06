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
      topSessions: [{ project: 'secret-project', cost: 100, savingsUSD: 0, calls: 5, date: '2026-06-01' }],
    },
    history: { daily: [] },
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
  })

  it('leaks no project name anywhere in the shared payload', () => {
    const clean = sanitizeForSharing(fixture())
    expect(JSON.stringify(clean)).not.toContain('secret-project')
  })
})
