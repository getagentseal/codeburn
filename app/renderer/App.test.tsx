// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App, overviewMemoKey } from './App'
import { __resetPolledMemo, hasPolledMemo } from './hooks/usePolled'
import type { DateRange, MenubarPayload, OptimizeJsonReport, SpendFlow } from './lib/types'

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
})

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn<(period: string, provider: string, range?: DateRange, configSource?: string | null) => Promise<MenubarPayload>>(),
  getSpendFlow: vi.fn<(period: string, provider: string, range?: DateRange) => Promise<SpendFlow>>(),
  getOptimizeReport: vi.fn<(period: string, provider: string, range?: DateRange) => Promise<OptimizeJsonReport>>(),
  getModels: vi.fn(),
  getSessions: vi.fn(),
  getCompareModels: vi.fn(),
  getCompare: vi.fn(),
  getQuota: vi.fn(),
  getPlans: vi.fn(),
  getActReport: vi.fn(),
  getYield: vi.fn(),
  getDevices: vi.fn(),
  getDevicesScan: vi.fn(),
  getIdentity: vi.fn(),
  cliStatus: vi.fn(),
}))

vi.mock('./lib/ipc', async orig => {
  const actual = await orig<typeof import('./lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function overviewPayload(): MenubarPayload {
  const now = new Date()
  return {
    generated: now.toISOString(),
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
      modelEfficiency: [],
      topSessions: [],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [],
      skills: [],
      subagents: [],
      mcpServers: [],
    },
    optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: {
      daily: [
        {
          date: dateKey(now),
          cost: 12.34,
          savingsUSD: 0,
          calls: 12,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topModels: [],
        },
      ],
    },
  }
}

const CONFIG_A = 'claude-config:aaaa000011112222'
const CONFIG_B = 'claude-desktop:bbbb000011112222'

function withConfigs(payload: MenubarPayload): MenubarPayload {
  return {
    ...payload,
    claudeConfigs: {
      selectedId: null,
      options: [
        { id: CONFIG_A, label: 'Default Claude', path: '/Users/x/.claude' },
        { id: CONFIG_B, label: 'Claude Desktop', path: '/Users/x/Library/Application Support/Claude' },
      ],
    },
  }
}

describe('App shortcuts', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.getOverview.mockResolvedValue(overviewPayload())
    mocks.getSpendFlow.mockResolvedValue({ period: { label: 'Last 30 days', start: '', end: '' }, models: [], projects: [], links: [] })
    mocks.getOptimizeReport.mockResolvedValue({
      period: { label: 'Last 30 days', start: null, end: null },
      summary: {
        healthScore: 100, healthGrade: 'A', findingCount: 0, periodCostUSD: 0,
        sessions: 0, calls: 0, potentialSavingsTokens: 0, potentialSavingsCostUSD: 0,
        potentialSavingsPercent: 0, costRateUSD: 0,
      },
      findings: [],
    })
    mocks.getModels.mockResolvedValue([])
    mocks.getSessions.mockResolvedValue([])
    mocks.getCompareModels.mockResolvedValue([])
    mocks.getQuota.mockResolvedValue([
      { provider: 'claude', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [] },
      { provider: 'codex', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [] },
    ])
    mocks.getPlans.mockResolvedValue({})
    mocks.getActReport.mockResolvedValue({ totals: { realizedCostUSD: 0, measuredActions: 0 } })
    mocks.getYield.mockResolvedValue({
      period: { label: 'Last 30 days', start: '', end: '' },
      summary: {
        productive: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
        reverted: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
        abandoned: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
        total: { costUSD: 0, sessions: 0 },
        productiveToRevertedCostRatio: null,
      },
      details: [],
    })
    mocks.getIdentity.mockResolvedValue({ name: 'CodeBurn Mac', fingerprint: 'AA:BB:CC' })
    mocks.getDevicesScan.mockResolvedValue({ found: [] })
    mocks.getDevices.mockResolvedValue({
      perDevice: [],
      combined: {
        cost: 0,
        calls: 0,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        deviceCount: 1,
        reachableCount: 1,
      },
    })
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('applies the persisted theme on app boot before Settings mounts', async () => {
    localStorage.setItem('codeburn.theme', 'dark')
    render(<App />)
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
    expect(screen.queryByRole('heading', { name: 'General' })).not.toBeInTheDocument()
  })

  it('boots with the persisted default period from Settings', async () => {
    localStorage.setItem('codeburn.defaultPeriod', 'today')
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('today', 'all'))
  })

  it('switches sections with command-number shortcuts', async () => {
    render(<App />)

    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', metaKey: true })
    expect(await screen.findByText('No sessions in this range yet.')).toBeInTheDocument()
  })

  it('keeps command navigation, settings, and refresh shortcuts active without stale hints', async () => {
    render(<App />)

    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()
    expect(screen.getByText('⌘1-7')).toBeInTheDocument()
    expect(screen.getAllByText('⌘,').length).toBeGreaterThan(0)
    expect(screen.getByText('⌘R')).toBeInTheDocument()
    expect(screen.queryByText('Command')).not.toBeInTheDocument()
    expect(screen.queryByText('Export view')).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', metaKey: true })
    expect(await screen.findByText('No sessions in this range yet.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '3', metaKey: true })
    expect(await screen.findByText('Cost flow · model → project')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '4', metaKey: true })
    expect(await screen.findByText('No waste findings in this range yet.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '5', metaKey: true })
    expect(await screen.findByText('No model usage in this range yet.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '6', metaKey: true })
    expect(await screen.findByText('Need at least two models with usage in this range to compare.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '7', metaKey: true })
    expect(await screen.findByText('Not connected. Log in with the Claude CLI.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    expect((await screen.findAllByText('Settings')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Back')).not.toBeInTheDocument()

    const overviewCalls = mocks.getOverview.mock.calls.length
    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    await waitFor(() => expect(mocks.getOverview.mock.calls.length).toBeGreaterThan(overviewCalls))
  })

  it('re-polls visible section data when period or provider changes', async () => {
    render(<App />)

    fireEvent.keyDown(document, { key: '3', metaKey: true })
    expect(await screen.findByText('Cost flow · model → project')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Today'))

    await waitFor(() => {
      expect(mocks.getOverview).toHaveBeenCalledWith('today', 'all')
      expect(mocks.getSpendFlow).toHaveBeenCalledWith('today', 'all')
    })

    fireEvent.click(screen.getByText('All providers'))
    fireEvent.click(await screen.findByRole('option', { name: 'Claude' }))

    await waitFor(() => {
      expect(mocks.getOverview).toHaveBeenCalledWith('today', 'claude')
      expect(mocks.getSpendFlow).toHaveBeenCalledWith('today', 'claude')
    })
  })

  it('builds the provider picker from providerDetails so display-name providers round-trip their internal id', async () => {
    // grok's display name is "Grok Build"; the picker must show the label but
    // send the internal id `grok` as --provider (which assertProvider accepts).
    const payload = overviewPayload()
    payload.current.providers = { 'grok build': 5, claude: 10 }
    payload.current.providerDetails = [
      { id: 'grok', label: 'Grok Build', cost: 5 },
      { id: 'claude', label: 'Claude', cost: 10 },
    ]
    mocks.getOverview.mockResolvedValue(payload)

    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.click(screen.getByText('All providers'))
    fireEvent.click(await screen.findByRole('option', { name: 'Grok Build' }))

    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'grok'))
  })

  it('lists a detected provider with no spend this period and sorts it last', async () => {
    // Hermes has usage only outside the current period: the CLI still emits it
    // as a detected provider (cost 0), so the picker must show it, at the bottom.
    const payload = overviewPayload()
    payload.current.providers = { claude: 10, hermes: 0 }
    payload.current.providerDetails = [
      { id: 'claude', label: 'Claude', cost: 10 },
      { id: 'hermes', label: 'Hermes', cost: 0 },
    ]
    mocks.getOverview.mockResolvedValue(payload)

    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.click(screen.getByText('All providers'))
    const claudeOption = await screen.findByRole('option', { name: 'Claude' })
    const hermesOption = screen.getByRole('option', { name: 'Hermes' })
    const options = screen.getAllByRole('option')
    // Zero-cost Hermes appears, and sorts after the provider that has spend.
    expect(options.indexOf(hermesOption)).toBeGreaterThan(options.indexOf(claudeOption))

    fireEvent.click(hermesOption)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'hermes'))
  })

  it('hides the Claude config picker when the payload carries no claudeConfigs', async () => {
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Claude config source' })).not.toBeInTheDocument()
  })

  it('shows the config picker, re-fetches overview with the flag, and persists the choice', async () => {
    mocks.getOverview.mockResolvedValue(withConfigs(overviewPayload()))
    render(<App />)

    const trigger = await screen.findByRole('button', { name: 'Claude config source' })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: 'Default Claude' }))

    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all', undefined, CONFIG_A))
    expect(localStorage.getItem('codeburn.claudeConfigSource')).toBe(CONFIG_A)
  })

  it('resets a non-Claude provider filter to all when a config is selected', async () => {
    const payload = withConfigs(overviewPayload())
    payload.current.providers = { claude: 10, codex: 2 }
    mocks.getOverview.mockResolvedValue(payload)
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Providers' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Codex' }))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'codex'))

    fireEvent.click(screen.getByRole('button', { name: 'Claude config source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Default Claude' }))

    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all', undefined, CONFIG_A))
    // The Claude-incompatible provider filter must never reach the CLI with the flag.
    expect(mocks.getOverview.mock.calls).not.toContainEqual(['30days', 'codex', undefined, CONFIG_A])
  })

  it('clears the config scope when a non-Claude provider is picked afterwards', async () => {
    const payload = withConfigs(overviewPayload())
    payload.current.providers = { claude: 10, codex: 2 }
    mocks.getOverview.mockResolvedValue(payload)
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Claude config source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Default Claude' }))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all', undefined, CONFIG_A))

    fireEvent.click(screen.getByRole('button', { name: 'Providers' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Codex' }))

    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'codex'))
    // The incompatible combination must never reach the CLI.
    expect(mocks.getOverview.mock.calls).not.toContainEqual(['30days', 'codex', undefined, CONFIG_A])
    expect(localStorage.getItem('codeburn.claudeConfigSource')).toBeNull()
  })

  it('boots with the persisted config source and clears it via All Claude configs', async () => {
    localStorage.setItem('codeburn.claudeConfigSource', CONFIG_A)
    mocks.getOverview.mockResolvedValue(withConfigs(overviewPayload()))
    render(<App />)

    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all', undefined, CONFIG_A))

    fireEvent.click(await screen.findByRole('button', { name: 'Claude config source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'All Claude configs' }))

    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all'))
    expect(localStorage.getItem('codeburn.claudeConfigSource')).toBeNull()
  })

  it('applies a calendar range to overview and visible section polls', async () => {
    render(<App />)

    fireEvent.keyDown(document, { key: '3', metaKey: true })
    expect(await screen.findByText('Cost flow · model → project')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose date range' }))

    const to = new Date()
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 2)
    const fromLabel = from.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const toLabel = to.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const range = { from: dateKey(from), to: dateKey(to) }

    fireEvent.mouseDown(screen.getByRole('button', { name: fromLabel }))
    fireEvent.mouseEnter(screen.getByRole('button', { name: toLabel }))
    fireEvent.mouseUp(screen.getByRole('button', { name: toLabel }))

    await waitFor(() => {
      expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all', range)
      expect(mocks.getSpendFlow).toHaveBeenCalledWith('30days', 'all', range)
    })
    expect(screen.getByRole('button', { name: /–/ })).toBeInTheDocument()
    expect(screen.getByText('30D')).not.toHaveClass('on')
  })

  it('shows no daily budget banner when none is configured', async () => {
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()
    expect(screen.queryByText(/daily budget/i)).not.toBeInTheDocument()
  })

  it('shows no banner when today spend is under 80% of the budget', async () => {
    localStorage.setItem('codeburn.dailyBudget', JSON.stringify({ kind: 'usd', value: 100 }))
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()
    expect(screen.queryByText(/daily budget/i)).not.toBeInTheDocument()
  })

  it('warns when today spend reaches 80% of the daily budget', async () => {
    localStorage.setItem('codeburn.dailyBudget', JSON.stringify({ kind: 'usd', value: 14 }))
    render(<App />)
    // 12.34 / 14 = 88.1% → warning band
    expect(await screen.findByText("Today's spend is at 88% of your daily budget")).toBeInTheDocument()
  })

  it('alerts and dismisses for the rest of the day when the budget is exceeded', async () => {
    localStorage.setItem('codeburn.dailyBudget', JSON.stringify({ kind: 'usd', value: 10 }))
    render(<App />)
    expect(await screen.findByText('Daily budget exceeded: $12.34 of $10.00')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText(/Daily budget exceeded/)).not.toBeInTheDocument())
    expect(localStorage.getItem('codeburn.dailyBudget.dismissed')).toBe(dateKey(new Date()))
  })

  it('evaluates a token budget only on the all-providers view', async () => {
    const payload = overviewPayload()
    payload.history.daily[0]!.inputTokens = 60_000
    payload.history.daily[0]!.outputTokens = 40_000
    mocks.getOverview.mockResolvedValue(payload)
    localStorage.setItem('codeburn.dailyBudget', JSON.stringify({ kind: 'tokens', value: 90_000 }))
    render(<App />)
    expect(await screen.findByText('Daily budget exceeded: 100K of 90K')).toBeInTheDocument()

    // A specific-provider filter zeroes history.daily token fields, so the token
    // cap can no longer be evaluated: the banner must disappear.
    fireEvent.click(screen.getByText('All providers'))
    fireEvent.click(await screen.findByRole('option', { name: 'Claude' }))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'claude'))
    await waitFor(() => expect(screen.queryByText(/Daily budget exceeded/)).not.toBeInTheDocument())
  })
})

describe('provider prefetch storm', () => {
  const PROVIDERS = [
    'claude', 'codex', 'gemini', 'grok', 'copilot', 'droid',
    'hermes', 'zcode', 'cursor', 'kiro', 'codewhale', 'openrouter',
  ]

  function manyProviderPayload(): MenubarPayload {
    const base = overviewPayload()
    const providers: Record<string, number> = {}
    PROVIDERS.forEach((id, i) => { providers[id] = PROVIDERS.length - i })
    return { ...base, current: { ...base.current, providers } }
  }

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.getOverview.mockResolvedValue(manyProviderPayload())
    mocks.getActReport.mockResolvedValue({ totals: { realizedCostUSD: 0, measuredActions: 0 } })
    mocks.getYield.mockResolvedValue({
      period: { label: 'Last 30 days', start: '', end: '' },
      summary: {
        productive: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
        reverted: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
        abandoned: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
        total: { costUSD: 0, sessions: 0 },
        productiveToRevertedCostRatio: null,
      },
      details: [],
    })
    localStorage.clear()
    __resetPolledMemo()
  })

  // With MEMO_MAX too small (< providers + base keys) the base overview key
  // LRU-evicts between polls, blanking the overview and re-arming the prefetch
  // every 30s cycle: 12 redundant full-history parses forever. This asserts the
  // fix — each provider is prefetched EXACTLY ONCE total across three cycles.
  it('prefetches each detected provider exactly once across 3 poll cycles', async () => {
    vi.useFakeTimers()
    try {
      render(<App />)
      // Let the mount overview resolve so `ready` flips and the prefetch arms.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      // Three full 30s poll cycles plus the prefetch start delay and staggered
      // per-provider warms (12 × 400ms). A re-arming storm would re-spawn some
      // providers on cycles 2 and 3; the once-per-key guard must prevent it.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000 * 3 + 12_000) })

      for (const id of PROVIDERS) {
        const spawns = mocks.getOverview.mock.calls.filter(
          c => c[0] === '30days' && c[1] === id && c[2] === undefined && c[3] === undefined,
        )
        expect(spawns.length, `prefetch spawns for ${id}`).toBe(1)
      }

      // Sanity: the active 'all' view was polled every cycle (not prefetch-gated).
      const allPolls = mocks.getOverview.mock.calls.filter(c => c[1] === 'all')
      expect(allPolls.length).toBeGreaterThanOrEqual(3)

      // The memo must be sized to hold every warmed provider so none LRU-evict
      // between polls — the eviction that (in the real app) blanked the base
      // overview key and re-armed the prefetch. Under the old fixed cap of 8,
      // 7 of these 12 keys would have been evicted by soak's end.
      for (const id of PROVIDERS) {
        expect(hasPolledMemo(overviewMemoKey(id, '30days', null, null)), `warm key ${id}`).toBe(true)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
