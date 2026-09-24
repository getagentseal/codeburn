// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __overviewSnapshotStorageKey, clearHeadlinesOnUpgrade, clearOverviewHeadlines, readOverviewHeadline, writeOverviewHeadline } from './overviewSnapshot'
import type { MenubarPayload } from './types'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')

function payload(): MenubarPayload {
  return {
    generated: '2026-08-27T11:59:58.000Z',
    current: {
      label: 'Last 7 days', cost: 123.45, calls: 678, sessions: 99,
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
      oneShotRate: 0.5, cacheHitPercent: 50, codexCredits: 0,
      topActivities: [], topModels: [], providers: { claude: 123.45 },
      topProjects: [{ name: 'secret-project', cost: 1, savingsUSD: 0, sessions: 1, avgCostPerSession: 1, sessionDetails: [] }],
      modelEfficiency: [], topSessions: [], tools: [], skills: [], subagents: [], mcpServers: [],
      localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
    },
    optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: { daily: [] },
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('persisted Overview headline', () => {
  it('round-trips only parity-proven headline fields', () => {
    const result = writeOverviewHeadline('overview|all|week', payload(), NOW)
    expect(readOverviewHeadline('overview|all|week', NOW)).toEqual(result)

    const raw = localStorage.getItem(__overviewSnapshotStorageKey) ?? ''
    expect(raw).toContain('123.45')
    expect(raw).not.toContain('sessions')
    expect(raw).not.toContain('secret-project')
    expect(raw).not.toContain('topModels')
  })

  it('rejects expired, future, and corrupt snapshots', () => {
    writeOverviewHeadline('old', payload(), NOW - 8 * 24 * 60 * 60 * 1000)
    writeOverviewHeadline('future', payload(), NOW + 61_000)
    expect(readOverviewHeadline('old', NOW)).toBeNull()
    expect(readOverviewHeadline('future', NOW)).toBeNull()

    localStorage.setItem(__overviewSnapshotStorageKey, '{not-json')
    expect(readOverviewHeadline('anything', NOW)).toBeNull()
  })

  it('never persists a partial resident-hydration total as exact', () => {
    const partial = { ...payload(), hydration: { complete: false, indexedFiles: 4, totalFiles: 10 } }

    expect(writeOverviewHeadline('partial', partial, NOW)).toBeNull()
    expect(readOverviewHeadline('partial', NOW)).toBeNull()
  })

  it('rejects a snapshot whose embedded identity does not match the requested period key', () => {
    const requestedKey = 'overview|all|week'
    writeOverviewHeadline(requestedKey, payload(), NOW)
    const parsed = JSON.parse(localStorage.getItem(__overviewSnapshotStorageKey) ?? '{}')
    parsed[requestedKey].key = 'overview|all|30days'
    localStorage.setItem(__overviewSnapshotStorageKey, JSON.stringify(parsed))

    expect(readOverviewHeadline(requestedKey, NOW)).toBeNull()
  })

  it('ignores legacy v1 headlines that may already contain a cross-period write', () => {
    localStorage.setItem('codeburn.overview-headlines.v1', JSON.stringify({
      'overview|all|week': {
        version: 1,
        capturedAt: NOW,
        generated: payload().generated,
        label: 'Last 30 Days',
        cost: 999,
        calls: 999,
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
      },
    }))

    expect(readOverviewHeadline('overview|all|week', NOW)).toBeNull()
  })

  it('clears every persisted headline after a pricing or currency mutation', () => {
    writeOverviewHeadline('one', payload(), NOW)
    localStorage.setItem('codeburn.overview-headlines.v1', '{"legacy":true}')
    clearOverviewHeadlines()
    expect(localStorage.getItem(__overviewSnapshotStorageKey)).toBeNull()
    expect(localStorage.getItem('codeburn.overview-headlines.v1')).toBeNull()
  })

  it('clears cached headlines once on a version change, then leaves them on a matching version', () => {
    writeOverviewHeadline('one', payload(), NOW)
    clearHeadlinesOnUpgrade('0.9.25')
    expect(localStorage.getItem(__overviewSnapshotStorageKey)).toBeNull()

    // Same version on the next launch: a freshly written headline survives.
    writeOverviewHeadline('two', payload(), NOW)
    clearHeadlinesOnUpgrade('0.9.25')
    expect(readOverviewHeadline('two', NOW)).not.toBeNull()

    // A later upgrade wipes again.
    clearHeadlinesOnUpgrade('0.9.26')
    expect(localStorage.getItem(__overviewSnapshotStorageKey)).toBeNull()
  })
})
