// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'

// Render-churn regression: the shell must NOT re-render on a wall-clock tick.
// The footer's "refreshed Ns ago" label is the only per-second surface and it
// owns its own 1s interval (RefreshedAt); AppMain re-renders only on real state
// changes and once per local calendar day (memo-key midnight boundary).

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() { return stored.size },
  clear: () => stored.clear(),
})

const churn = vi.hoisted(() => {
  const state = { overviewRenders: 0 }
  function payload() {
    return {
      generated: new Date().toISOString(),
      current: {
        label: 'Last 30 days',
        cost: 12.34,
        calls: 12,
        sessions: 2,
        oneShotRate: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheHitPercent: 0,
        codexCredits: 0,
        topActivities: [],
        topModels: [],
        localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
        providers: { claude: 10, codex: 2 },
        topProjects: [],
        topSessions: [],
        retryTax: { totalUSD: 0 },
        routingWaste: { totalSavingsUSD: 0 },
      },
      history: { daily: [] },
      optimize: { savingsUSD: 0, topFindings: [] },
    }
  }
  const bridge = {
    getOverview: vi.fn(async () => payload()),
    getModels: vi.fn(async () => null),
    telemetryTrack: vi.fn(async () => true),
    getUpdateStatus: vi.fn(async () => null),
    onProgress: vi.fn(() => () => {}),
    onUpdateStatus: vi.fn(() => () => {}),
  }
  return { state, bridge }
})

vi.mock('./lib/ipc', () => ({ codeburn: churn.bridge }))

vi.mock('./sections/Overview', () => ({
  // Probe component: every call is one AppMain render (App renders it inline).
  OverviewContent: () => { churn.state.overviewRenders += 1; return null },
}))

function resetChurn(): void {
  churn.state.overviewRenders = 0
  churn.bridge.getOverview.mockClear()
}

beforeEach(() => {
  stored.clear()
  resetChurn()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function bootApp(): Promise<void> {
  render(<App />)
  // Flush the boot overview fetch (a resolved promise; no timer advance needed).
  await act(async () => { await Promise.resolve() })
}

describe('App render churn', () => {
  it('does not re-render the shell on the per-second footer tick', async () => {
    await bootApp()
    const baseline = churn.state.overviewRenders
    expect(baseline).toBeGreaterThan(0)
    // One advance per act so React cannot batch the whole window into a single
    // render: a wall clock in AppMain re-renders the shell once per second.
    for (let second = 0; second < 5; second++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    }
    const growth = churn.state.overviewRenders - baseline
    expect(growth).toBeLessThanOrEqual(2)
  })

  it('still ticks the "refreshed Ns ago" label once a second while the shell stays flat', async () => {
    await bootApp()
    // The footer label is RefreshedAt's whole output: starts at "just now",
    // then counts seconds. Find the node whose text carries the label.
    const labelNode = () => Array.from(document.querySelectorAll('body *'))
      .find(node => (node.textContent ?? '').trim().startsWith('refreshed'))
    const first = labelNode()?.textContent?.trim()
    expect(first).toBe('refreshed just now')
    const shellRendersBeforeTick = churn.state.overviewRenders
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(labelNode()?.textContent?.trim()).toBe('refreshed 1s ago')
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(labelNode()?.textContent?.trim()).toBe('refreshed 2s ago')
    // …while the shell did not re-render at all across those ticks.
    expect(churn.state.overviewRenders).toBe(shellRendersBeforeTick)
  })

  it('rolls the shell exactly on the local midnight boundary, not on every check', async () => {
    vi.setSystemTime(new Date(2026, 8, 12, 23, 59, 40))
    await bootApp()
    const baseline = churn.state.overviewRenders
    // First 15s day-check lands at 23:59:55 — same day, no re-render.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(churn.state.overviewRenders - baseline).toBe(0)
    // Second check lands past midnight: the memo-key boundary must roll, which
    // needs a re-render (a handful, as the overview refetch clears then lands).
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    const growth = churn.state.overviewRenders - (baseline + 0)
    expect(growth).toBeGreaterThanOrEqual(1)
    expect(growth).toBeLessThanOrEqual(5)
  })
})
