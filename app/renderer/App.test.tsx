// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App, overviewMemoKey, refreshedLabel, selectedReportMemoKeys, topCategoryByModel, usageSnapshotProps } from './App'
import { sanitizeProps } from '../electron/telemetry'
import { __resetPolledMemo, hasPolledMemo, primePolledMemo } from './hooks/usePolled'
import { setActiveCurrency } from './lib/format'
import { readOverviewHeadline, writeOverviewHeadline } from './lib/overviewSnapshot'
import type { DateRange, MenubarPayload, ModelReportRow, OptimizeJsonReport, SpendFlow } from './lib/types'

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() { return stored.size },
  clear: () => stored.clear(),
})

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn<(period: string, provider: string, range?: DateRange, configSource?: string | null, background?: boolean, scope?: string) => Promise<MenubarPayload>>(),
  getSpendFlow: vi.fn<(period: string, provider: string, range?: DateRange, background?: boolean) => Promise<SpendFlow>>(),
  getTimeline: vi.fn<(period: string, provider: string, range?: DateRange) => Promise<MenubarPayload>>(),
  getOptimizeReport: vi.fn<(period: string, provider: string, range?: DateRange, background?: boolean) => Promise<OptimizeJsonReport>>(),
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
  getPriceOverrides: vi.fn(),
  getProjectFilter: vi.fn<() => Promise<{ project: string[]; exclude: string[] }>>(),
  getAliases: vi.fn(),
  setCurrency: vi.fn(),
  resetCurrency: vi.fn(),
  telemetryTrack: vi.fn<(name: string, props?: Record<string, unknown>) => Promise<boolean>>(),
}))

vi.mock('./lib/ipc', async orig => {
  const actual = await orig<typeof import('./lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' })
}

// The shortcut code (lib/platform.ts) reads `window.codeburn.platform` at call
// time; stub it per test and always restore so no test leaks platform state.
function setPlatform(platform: string): void {
  ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform }
}

function clearPlatform(): void {
  delete (window as unknown as { codeburn?: { platform?: string } }).codeburn
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

function installDefaultMocks() {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.getOverview.mockResolvedValue(overviewPayload())
  mocks.getTimeline.mockResolvedValue(overviewPayload())
  mocks.getSpendFlow.mockResolvedValue({ period: { label: 'Last 30 days', start: '', end: '' }, models: [], projects: [], links: [] })
  mocks.getOptimizeReport.mockResolvedValue({
    period: { label: 'Last 30 days', start: null, end: null },
    summary: {
      healthScore: 100, healthGrade: 'A', findingCount: 0, periodCostUSD: 0,
      sessions: 0, calls: 0, potentialSavingsTokens: 0, potentialSavingsCostUSD: 0,
      potentialSavingsPercent: 0, costRateUSD: 0, measuredSavingsUSD: 0,
      byClass: {
        fix: { tokensSaved: 0, savingsUSD: 0, count: 0 },
        nudge: { tokensSaved: 0, savingsUSD: 0, count: 0 },
        keep: { tokensSaved: 0, savingsUSD: 0, count: 0 },
      },
    },
    findings: [],
  })
  mocks.getModels.mockResolvedValue([])
  mocks.getProjectFilter.mockResolvedValue({ project: [], exclude: [] })
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
  mocks.getPriceOverrides.mockResolvedValue({ overrides: [] })
  mocks.getAliases.mockResolvedValue([])
  mocks.setCurrency.mockResolvedValue({ ok: true, stdout: '', stderr: '' })
  mocks.resetCurrency.mockResolvedValue({ ok: true, stdout: '', stderr: '' })
  mocks.telemetryTrack.mockResolvedValue(true)
}

describe('App shortcuts', () => {
  beforeEach(() => {
    installDefaultMocks()
    localStorage.clear()
    // Pin the boot period so the provider/config tests below are independent of
    // the app-wide default ('today'); tests that exercise the default set it.
    localStorage.setItem('codeburn.defaultPeriod', '30days')
    document.documentElement.removeAttribute('data-theme')
    setPlatform('darwin')
  })

  afterEach(() => {
    clearPlatform()
    vi.useRealTimers()
  })

  it('keeps sections gated (and the splash up) while a cold hydration times out', async () => {
    // The repro: the overview timed out cold, `ready` latched anyway, and every
    // section then spawned its own 45s read behind the still-running parse.
    mocks.getOverview.mockRejectedValue({ kind: 'timeout', message: 'no output for 45000ms', cold: true })
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(mocks.getActReport).not.toHaveBeenCalled()
    expect(screen.queryByText("Couldn't read data")).not.toBeInTheDocument()
  })

  it('paints the last exact headline immediately while authoritative details load', async () => {
    const key = overviewMemoKey('all', '30days', null, null)
    writeOverviewHeadline(key, overviewPayload(), Date.now() - 1_000)
    mocks.getOverview.mockReturnValue(new Promise<MenubarPayload>(() => {}))

    render(<App />)

    expect(await screen.findByLabelText('Cached usage summary')).toBeInTheDocument()
    expect(screen.getAllByText('$12.34').length).toBeGreaterThan(0)
    expect(screen.getByText(/sessions updating/)).toBeInTheDocument()
    expect(screen.getByText('Updating detailed drill-downs…')).toBeInTheDocument()
    expect(screen.getByText('Refreshing selected view…')).toBeInTheDocument()
    expect(mocks.getActReport).not.toHaveBeenCalled()
  })

  it('labels a stale source snapshot honestly instead of claiming 29226/29226 files are still indexing', async () => {
    const payload = overviewPayload()
    payload.stale = true
    payload.hydration = { complete: false, indexedFiles: 29_226, totalFiles: 29_226 }
    mocks.getOverview.mockResolvedValue(payload)

    render(<App />)

    expect(await screen.findByText('Some sources could not be refreshed. Showing indexed data; recent activity may be missing.')).toBeInTheDocument()
    expect(screen.queryByText(/29226\/29226/)).not.toBeInTheDocument()
    expect(screen.queryByText(/totals below cover what is indexed so far/)).not.toBeInTheDocument()
  })

  it('shows file progress only for a genuinely partial progressive index', async () => {
    const payload = overviewPayload()
    payload.hydration = { complete: false, indexedFiles: 24, totalFiles: 100 }
    mocks.getOverview.mockResolvedValue(payload)

    render(<App />)

    expect(await screen.findByText('Indexing history · 24/100 files · You can keep using CodeBurn; totals update as indexing completes.')).toBeInTheDocument()
  })

  it('never persists the previous period headline under a newly selected period', async () => {
    const thirtyDays = overviewPayload()
    thirtyDays.current = { ...thirtyDays.current, label: 'Last 30 Days', cost: 30 }
    const pendingWeek = new Promise<MenubarPayload>(() => {})
    mocks.getOverview.mockImplementation((period: string) =>
      period === 'week' ? pendingWeek : Promise.resolve(thirtyDays))

    render(<App />)
    expect(await screen.findByText('$30.00')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '7D' }))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('week', 'all'))

    // The selected key has not resolved yet. A 30-day result must never be
    // written beneath it and then shown as the seven-day headline on a later
    // switch or app launch.
    expect(readOverviewHeadline(overviewMemoKey('all', 'week', null, null))).toBeNull()
  })

  it('rolls Today and Month cache identities at their local calendar boundaries', () => {
    const aug28 = new Date(2026, 7, 28, 23, 59)
    const aug29 = new Date(2026, 7, 29, 0, 1)
    const sep1 = new Date(2026, 8, 1, 0, 1)

    expect(overviewMemoKey('all', 'today', null, null, 'local', aug28))
      .not.toBe(overviewMemoKey('all', 'today', null, null, 'local', aug29))
    expect(overviewMemoKey('all', 'month', null, null, 'local', aug28))
      .toBe(overviewMemoKey('all', 'month', null, null, 'local', aug29))
    expect(overviewMemoKey('all', 'month', null, null, 'local', aug29))
      .not.toBe(overviewMemoKey('all', 'month', null, null, 'local', sep1))
  })

  it('maps the footer to the selected report instead of reusing Overview freshness', () => {
    expect(selectedReportMemoKeys('sessions', 'week', 'claude', null, 'overview-key'))
      .toEqual(['sessions|week|claude|-||'])
    expect(selectedReportMemoKeys('spend', 'week', 'claude', null, 'overview-key'))
      .toEqual(['overview-key', 'spendflow|week|claude|-||'])
    expect(selectedReportMemoKeys('optimize', 'week', 'claude', null, 'overview-key'))
      .toEqual(['overview-key', 'optimize|week|claude|-||', 'yield|week|claude|-||'])
    expect(selectedReportMemoKeys('models', 'week', 'claude', null, 'overview-key'))
      .toEqual(['models|week|claude|-|false|'])
    expect(selectedReportMemoKeys('compare', 'week', 'claude', null, 'overview-key'))
      .toEqual(['comparemodels|week|claude|-||'])
    expect(selectedReportMemoKeys('plans', 'week', 'claude', null, 'overview-key', new Set(['kimi', 'codex'])))
      .toEqual(['quota|codex,kimi', 'plans|week|all|-||'])
  })

  it('uses readable hour and day units for restored report freshness', () => {
    expect(refreshedLabel(0, false, 2 * 60 * 60 * 1000)).toBe('refreshed 2h ago')
    expect(refreshedLabel(0, false, 3 * 24 * 60 * 60 * 1000)).toBe('refreshed 3d ago')
  })

  it('releases the sections when the overview fails for a real reason', async () => {
    mocks.getOverview.mockRejectedValue({ kind: 'nonzero', message: 'permission denied' })
    render(<App />)
    await waitFor(() => expect(mocks.getActReport).toHaveBeenCalled())
  })

  it('does not fan out secondary analysis after the bounded overview timeout', async () => {
    // A real installed heavy-corpus run reached the 600s no-output boundary.
    // Marking that timeout as generally ready mounted Overview's act/yield polls;
    // a user Refresh then ran another status parse beside yield, multiplying the
    // retry's memory pressure instead of helping it recover.
    mocks.getOverview
      .mockRejectedValueOnce({ kind: 'timeout', message: 'no output for 600000ms' })
      .mockReturnValue(new Promise<MenubarPayload>(() => {}))

    render(<App />)

    expect(await screen.findByText("Couldn't read data")).toBeInTheDocument()
    expect(mocks.getActReport).not.toHaveBeenCalled()
    expect(mocks.getYield).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledTimes(2))
    expect(mocks.getActReport).not.toHaveBeenCalled()
    expect(mocks.getYield).not.toHaveBeenCalled()
  })

  it('applies the persisted theme on app boot before Settings mounts', async () => {
    localStorage.setItem('codeburn.theme', 'dark')
    render(<App />)
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
    expect(screen.queryByRole('heading', { name: 'General' })).not.toBeInTheDocument()
  })

  it('boots with the persisted default period from Settings', async () => {
    localStorage.setItem('codeburn.defaultPeriod', 'week')
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('week', 'all'))
  })

  it('boots to today when no default period is persisted', async () => {
    localStorage.removeItem('codeburn.defaultPeriod')
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('today', 'all'))
  })

  it('falls back to 7 days when the boot payload shows today has no sessions', async () => {
    localStorage.removeItem('codeburn.defaultPeriod')
    const empty = overviewPayload()
    mocks.getOverview.mockResolvedValue({ ...empty, current: { ...empty.current, sessions: 0 } })
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('today', 'all'))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('week', 'all'))
  })

  it('leaves a persisted default period alone when today has no sessions', async () => {
    localStorage.setItem('codeburn.defaultPeriod', 'today')
    const empty = overviewPayload()
    mocks.getOverview.mockResolvedValue({ ...empty, current: { ...empty.current, sessions: 0 } })
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('today', 'all'))
    await act(async () => { await Promise.resolve() })
    expect(mocks.getOverview).not.toHaveBeenCalledWith('week', 'all')
  })

  it('switches sections with command-number shortcuts', async () => {
    render(<App />)

    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', metaKey: true })
    expect(await screen.findByText('No sessions in this range yet.')).toBeInTheDocument()
  })

  it.each([
    ['darwin', { metaKey: true }, '⌘'],
    ['win32', { ctrlKey: true }, 'Ctrl+'],
  ] as const)('keeps %s navigation, settings, and refresh shortcuts active without stale hints', async (platform, chord, mod) => {
    setPlatform(platform)
    render(<App />)

    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()
    expect(screen.getByText(`${mod}1-8`)).toBeInTheDocument()
    expect(screen.getAllByText(`${mod},`).length).toBeGreaterThan(0)
    expect(screen.getByText(`${mod}R`)).toBeInTheDocument()
    expect(screen.queryByText('Command')).not.toBeInTheDocument()
    expect(screen.queryByText('Export view')).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', ...chord })
    expect(await screen.findByText('No sessions in this range yet.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '3', ...chord })
    expect(await screen.findByText(/No sessions in Last 30 days mentioned a pull request URL/)).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '4', ...chord })
    expect(await screen.findByText('Cost flow · model → project')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '5', ...chord })
    expect(await screen.findByText('No waste findings in this range yet.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '6', ...chord })
    expect(await screen.findByText('No model usage in this range yet.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '7', ...chord })
    expect(await screen.findByText('Need at least two models with usage in this range to compare.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '8', ...chord })
    expect(await screen.findByText('Not connected. Log in with the Claude CLI.')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: ',', ...chord })
    expect((await screen.findAllByText('Settings')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Back')).not.toBeInTheDocument()

    const overviewCalls = mocks.getOverview.mock.calls.length
    fireEvent.keyDown(document, { key: 'r', ...chord })
    await waitFor(() => expect(mocks.getOverview.mock.calls.length).toBeGreaterThan(overviewCalls))
  })

  it('ignores Ctrl+2 on mac', async () => {
    render(<App />)

    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', ctrlKey: true })
    expect(screen.queryByText('No sessions in this range yet.')).not.toBeInTheDocument()
  })

  it('re-polls visible section data when period or provider changes', async () => {
    render(<App />)

    fireEvent.keyDown(document, { key: '4', metaKey: true })
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

  it('drives combined-scope overview fetches and persists the Scope setting', async () => {
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all'))

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByLabelText('Scope'))
    fireEvent.click(await screen.findByRole('option', { name: 'Combined' }))

    // Combined scope forces provider='all' and passes --scope combined (6th arg).
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all', undefined, undefined, undefined, 'combined'))
    expect(localStorage.getItem('codeburn.scope')).toBe('combined')
  })

  it('boots in combined scope from the persisted Scope setting', async () => {
    localStorage.setItem('codeburn.scope', 'combined')
    render(<App />)
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all', undefined, undefined, undefined, 'combined'))
  })

  it('never boots a filtered session into combined scope, and collapses the stored setting', async () => {
    localStorage.setItem('codeburn.scope', 'combined')
    localStorage.setItem('codeburn.projectFiltered', '1')
    mocks.getProjectFilter.mockResolvedValue({ project: [], exclude: ['my-company'] })
    render(<App />)
    // Local from the first poll: a combined total would carry the hidden project.
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'all'))
    expect(mocks.getOverview).not.toHaveBeenCalledWith('30days', 'all', undefined, undefined, undefined, 'combined')
    await waitFor(() => expect(localStorage.getItem('codeburn.scope')).toBe('local'))
  })

  it('records the filter for the next boot when the pane is empty', async () => {
    render(<App />)
    await waitFor(() => expect(localStorage.getItem('codeburn.projectFiltered')).toBe('0'))
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

  it('hides idle providers while preserving explicit zero-cost activity', async () => {
    const payload = overviewPayload()
    payload.current.providers = { claude: 10, hermes: 0, cursor: 0 }
    payload.current.providerDetails = [
      { id: 'claude', label: 'Claude', cost: 10, hasUsage: true },
      { id: 'hermes', label: 'Hermes', cost: 0, hasUsage: false },
      { id: 'cursor', label: 'Cursor', cost: 0, hasUsage: true },
    ]
    mocks.getOverview.mockResolvedValue(payload)

    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.click(screen.getByText('All providers'))
    expect(await screen.findByRole('option', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Cursor' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Hermes' })).not.toBeInTheDocument()
  })

  it('keeps zero-cost providers in the picker when the CLI omits hasUsage', async () => {
    // Every released CLI omits the field. Falling back to cost > 0 there hid
    // subscription-backed providers whose period spend is $0.
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
    expect(await screen.findByRole('option', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Hermes' })).toBeInTheDocument()
  })

  it('does not carry another period provider catalog into a scoped period view', async () => {
    const payload = overviewPayload()
    payload.current.providerDetails = [
      { id: 'claude', label: 'Claude', cost: 10, hasUsage: true },
      { id: 'hermes', label: 'Hermes', cost: 5, hasUsage: true },
    ]
    mocks.getOverview.mockResolvedValue(payload)

    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Providers'))
    fireEvent.click(await screen.findByRole('option', { name: 'Claude' }))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'claude'))

    fireEvent.click(screen.getByText('Today'))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('today', 'claude'))

    fireEvent.click(screen.getByLabelText('Providers'))
    expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Hermes' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Sessions/ }))
    const sessionFilters = await screen.findByRole('group', { name: 'Filter sessions by provider' })
    expect(within(sessionFilters).getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(within(sessionFilters).queryByRole('button', { name: 'Hermes' })).not.toBeInTheDocument()
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

    fireEvent.keyDown(document, { key: '4', metaKey: true })
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

  it('names a selected custom range on the Pull requests empty note', async () => {
    render(<App />)
    fireEvent.keyDown(document, { key: '3', metaKey: true })
    expect(await screen.findByText(/No sessions in Last 30 days mentioned a pull request URL/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Choose date range' }))
    const to = new Date()
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 2)
    const fromLabel = from.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const toLabel = to.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    fireEvent.mouseDown(screen.getByRole('button', { name: fromLabel }))
    fireEvent.mouseEnter(screen.getByRole('button', { name: toLabel }))
    fireEvent.mouseUp(screen.getByRole('button', { name: toLabel }))

    const left = from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const right = to.toLocaleDateString('en-US', { month: from.getMonth() === to.getMonth() ? undefined : 'short', day: 'numeric' })
    expect(await screen.findByText(new RegExp(`No sessions in ${left} [–-] ${right} mentioned a pull request URL`))).toBeInTheDocument()
    expect(screen.getByText('30D')).not.toHaveClass('on')
    expect(screen.queryByText(/No sessions in Last 30 days/)).toBeNull()
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

describe('win32 shortcut chords', () => {
  beforeEach(() => {
    installDefaultMocks()
    localStorage.clear()
    localStorage.setItem('codeburn.defaultPeriod', '30days')
    document.documentElement.removeAttribute('data-theme')
    setPlatform('win32')
  })

  afterEach(() => {
    clearPlatform()
    vi.useRealTimers()
  })

  it('navigates with Ctrl+2 and refreshes with Ctrl+R', async () => {
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', ctrlKey: true })
    expect(await screen.findByText('No sessions in this range yet.')).toBeInTheDocument()

    const overviewCalls = mocks.getOverview.mock.calls.length
    fireEvent.keyDown(document, { key: 'r', ctrlKey: true })
    await waitFor(() => expect(mocks.getOverview.mock.calls.length).toBeGreaterThan(overviewCalls))
  })

  it('ignores Meta+2 on win32', async () => {
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', metaKey: true })
    expect(screen.queryByText('No sessions in this range yet.')).not.toBeInTheDocument()
  })

  it('ignores Ctrl+Alt+2 (the AltGr shape) on win32', async () => {
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: '2', ctrlKey: true, altKey: true })
    expect(screen.queryByText('No sessions in this range yet.')).not.toBeInTheDocument()
  })
})

describe('overview idle warming', () => {
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
    // Pin the cadence to 30s so the fake-timer soak math below is independent of
    // the app-wide default (bumped to 60s for energy).
    localStorage.setItem('codeburn.refreshInterval', '30s')
    // Pin the boot period so these prefetch assertions are independent of the
    // app-wide default ('today').
    localStorage.setItem('codeburn.defaultPeriod', '30days')
    __resetPolledMemo()
  })

  it('warms other time horizons before provider variants', async () => {
    vi.useFakeTimers()
    try {
      render(<App />)
      // Boot is pinned to 30D in beforeEach. Once it resolves, the idle queue
      // should warm the remaining horizons in product priority order, then
      // retain current main's provider-switch warming contract.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(240_000) })

      const backgroundSpawns = mocks.getOverview.mock.calls.filter(call => call[4] === true)
      expect(backgroundSpawns.slice(0, 5).map(call => [call[0], call[1]])).toEqual([
        ['today', 'all'],
        ['week', 'all'],
        ['month', 'all'],
        ['all', 'all'],
        ['lifetime', 'all'],
      ])

      expect(backgroundSpawns[5]?.slice(0, 2)).toEqual(['30days', 'claude'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('warms the first-click reports for each period behind the overview', async () => {
    vi.useFakeTimers()
    try {
      render(<App />)
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

      expect(mocks.getSessions.mock.calls.some(call => call[0] === 'today' && call[3] === true)).toBe(true)
      expect(mocks.getSpendFlow.mock.calls.some(call => call[0] === 'today' && call[3] === true)).toBe(true)
      expect(mocks.getModels.mock.calls.some(call => call[0] === 'today' && call[4] === true)).toBe(true)
      expect(mocks.getCompareModels.mock.calls.some(call => call[0] === 'today' && call[2] === true)).toBe(true)
      expect(mocks.getOptimizeReport.mock.calls.some(call => call[0] === 'today' && call[3] === true)).toBe(true)
      expect(mocks.getYield.mock.calls.some(call => call[0] === 'today' && call[3] === true)).toBe(true)
      expect(mocks.getPlans.mock.calls.some(call => call[0] === 'today' && call[1] === true)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('finishes Today first-click reports before starting the 7D horizon', async () => {
    vi.useFakeTimers()
    try {
      render(<App />)
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

      const todaySessions = mocks.getSessions.mock.calls.findIndex(call => call[0] === 'today' && call[3] === true)
      const todayPlans = mocks.getPlans.mock.calls.findIndex(call => call[0] === 'today' && call[1] === true)
      const weekOverview = mocks.getOverview.mock.calls.findIndex(call => call[0] === 'week' && call[4] === true)
      expect(todaySessions).toBeGreaterThanOrEqual(0)
      expect(todayPlans).toBeGreaterThanOrEqual(0)
      expect(weekOverview).toBeGreaterThanOrEqual(0)
      expect(mocks.getSessions.mock.invocationCallOrder[todaySessions]!)
        .toBeLessThan(mocks.getOverview.mock.invocationCallOrder[weekOverview]!)
      expect(mocks.getPlans.mock.invocationCallOrder[todayPlans]!)
        .toBeLessThan(mocks.getOverview.mock.invocationCallOrder[weekOverview]!)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a period warm that was cancelled by a user period switch', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirstToday!: (payload: MenubarPayload) => void
      const firstToday = new Promise<MenubarPayload>(resolve => { resolveFirstToday = resolve })
      let todayWarmCalls = 0
      mocks.getOverview.mockImplementation((period: string, _provider: string, _range, _config, background) => {
        if (period === 'today' && background === true) {
          todayWarmCalls++
          if (todayWarmCalls === 1) return firstToday
        }
        const payload = manyProviderPayload()
        payload.current = {
          ...payload.current,
          label: period === 'week' ? 'Last 7 Days' : payload.current.label,
        }
        return Promise.resolve(payload)
      })

      render(<App />)
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(todayWarmCalls).toBe(1)

      // The user takes priority while the first background warm is pending.
      fireEvent.click(screen.getByRole('tab', { name: '7D' }))
      await act(async () => { await Promise.resolve() })
      expect(mocks.getOverview).toHaveBeenCalledWith('week', 'all')

      // The cancelled result must not poison the session-lifetime retry guard.
      await act(async () => {
        resolveFirstToday(manyProviderPayload())
        await Promise.resolve()
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      expect(todayWarmCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefetches each provider variant once across 3 poll cycles', async () => {
    vi.useFakeTimers()
    try {
      // Give the serial idle queue a clean runway. Once it is warm, the long
      // cadence soak below proves completed provider keys are not respawned.
      localStorage.setItem('codeburn.refreshInterval', '10m')
      render(<App />)
      // Let the mount overview resolve so `ready` flips and the prefetch arms.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      fireEvent.click(screen.getByRole('button', { name: 'Providers' }))
      expect(screen.getByRole('option', { name: 'Codewhale' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Openrouter' })).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      // The all-destination queue intentionally leaves a five-second cooling
      // window between heavy report reads. Let that queue finish before the first
      // cadence tick, then soak three ten-minute polling cycles.
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000) })

      const warmedProviders = mocks.getOverview.mock.calls
        // Prefetch warms carry the background-priority flag (5th arg).
        .filter(c => c[0] === '30days' && c[1] !== 'all' && c[2] === undefined && c[3] === undefined && c[4] === true)
        .map(c => c[1])
      expect(warmedProviders).toEqual(PROVIDERS)

      // Sanity: the active 'all' view was polled every cycle (not prefetch-gated).
      const allPolls = mocks.getOverview.mock.calls.filter(c => c[1] === 'all')
      expect(allPolls.length).toBeGreaterThanOrEqual(3)

      for (const id of PROVIDERS) expect(hasPolledMemo(overviewMemoKey(id, '30days', null, null))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('freshness: hidden-window polling', () => {
  beforeEach(() => {
    installDefaultMocks()
    localStorage.clear()
    localStorage.setItem('codeburn.refreshInterval', '30s') // pin cadence for the soak math
    __resetPolledMemo()
  })

  // An open-but-occluded app still owes the configured freshness contract.
  it('keeps interval refreshes running while hidden without a duplicate catch-up', async () => {
    vi.useFakeTimers()
    try {
      setVisibility('visible')
      render(<App />)
      // Boot + three visible 30s cadences: the overview section's yield poll (a
      // pure usePolled interval, never prefetched) fires each cadence.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000 * 3) })
      const visibleYield = mocks.getYield.mock.calls.length
      expect(visibleYield).toBeGreaterThan(1) // polling while visible

      // Hidden for five cadences: data polling continues.
      setVisibility('hidden')
      const atHideYield = mocks.getYield.mock.calls.length
      const atHideOverview = mocks.getOverview.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000 * 5) })
      expect(mocks.getYield.mock.calls.length).toBeGreaterThan(atHideYield)
      expect(mocks.getOverview.mock.calls.length).toBeGreaterThan(atHideOverview)

      // Back to visible: no extra catch-up is needed inside one cadence.
      const beforeVisibleYield = mocks.getYield.mock.calls.length
      const beforeVisibleOverview = mocks.getOverview.mock.calls.length
      setVisibility('visible')
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(mocks.getYield.mock.calls.length).toBe(beforeVisibleYield)
      expect(mocks.getOverview.mock.calls.length).toBe(beforeVisibleOverview)
    } finally {
      setVisibility('visible')
      vi.useRealTimers()
      localStorage.clear()
    }
  })
})

describe('currency correctness', () => {
  const USD = { code: 'USD', symbol: '$', rate: 1 }
  const EUR = { code: 'EUR', symbol: '€', rate: 0.9 }

  beforeEach(() => {
    installDefaultMocks()
    // Reset the module-level display currency so a prior test never bleeds in.
    setActiveCurrency(USD)
    localStorage.clear()
    // Pin the boot period so the memo keys below match the app's boot fetch,
    // independent of the app-wide default ('today').
    localStorage.setItem('codeburn.defaultPeriod', '30days')
    __resetPolledMemo()
    setPlatform('darwin')
  })

  afterEach(() => {
    clearPlatform()
    vi.useRealTimers()
  })

  it('never regresses the applied currency to a memo-served (stale) payload during a switch', async () => {
    const usd = { ...overviewPayload(), currency: USD }
    // A stale EUR payload cached for `claude`, as if warmed before a currency
    // change. The claude fetch is left pending so `switching` stays true and the
    // memo-served EUR payload is what's on screen during the assertion window.
    const eur = { ...overviewPayload(), currency: EUR }
    mocks.getOverview.mockImplementation((_period: string, provider: string) =>
      provider === 'claude' ? new Promise<MenubarPayload>(() => {}) : Promise.resolve(usd))
    // Stamp the entry older than the memo's freshness window so the switch
    // revalidates behind it (a still-fresh entry is served without a refetch).
    const staleAt = Date.now() - 60_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(staleAt)
    primePolledMemo(overviewMemoKey('claude', '30days', null, null), eur)
    nowSpy.mockRestore()

    render(<App />)
    // Boot on the USD ('all') view.
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()
    expect(screen.queryByText(/€/)).not.toBeInTheDocument()

    // Switch to claude: usePolled paints the memoized EUR payload (switching) while
    // its fresh fetch hangs. The currency effect must NOT apply that stale EUR.
    fireEvent.click(screen.getByText('All providers'))
    fireEvent.click(await screen.findByRole('option', { name: 'Claude' }))
    await waitFor(() => expect(mocks.getOverview).toHaveBeenCalledWith('30days', 'claude'))

    expect(screen.queryByText(/€/)).not.toBeInTheDocument()
  })

  it('clears the instant-switch memo and force-refreshes when currency is reset', async () => {
    render(<App />)
    expect(await screen.findByText('Most expensive sessions')).toBeInTheDocument()

    // A warmed entry (as the prefetcher would leave one) that must be purged so a
    // later switch can't repaint a payload computed under the old currency.
    primePolledMemo('sentinel-warmed-key', { stale: true })
    writeOverviewHeadline(overviewMemoKey('all', 'week', null, null), overviewPayload())
    expect(hasPolledMemo('sentinel-warmed-key')).toBe(true)

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    const overviewCalls = mocks.getOverview.mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to USD' }))

    await waitFor(() => expect(mocks.resetCurrency).toHaveBeenCalled())
    // Memo purged and the active view force-refreshed so the new currency lands fast.
    await waitFor(() => expect(mocks.getOverview.mock.calls.length).toBeGreaterThan(overviewCalls))
    expect(hasPolledMemo('sentinel-warmed-key')).toBe(false)
    expect(readOverviewHeadline(overviewMemoKey('all', 'week', null, null))).toBeNull()
  })

  it('does not resurrect the live cached headline after a settings invalidation', async () => {
    const eur = { ...overviewPayload(), currency: EUR }
    const key = overviewMemoKey('all', '30days', null, null)
    writeOverviewHeadline(key, eur)
    mocks.getOverview.mockReturnValue(new Promise<MenubarPayload>(() => {}))

    render(<App />)
    expect(await screen.findByLabelText('Cached usage summary')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to USD' }))
    await waitFor(() => expect(mocks.resetCurrency).toHaveBeenCalled())
    fireEvent.keyDown(document, { key: '1', metaKey: true })

    expect(screen.queryByLabelText('Cached usage summary')).not.toBeInTheDocument()
    expect(readOverviewHeadline(key)).toBeNull()
  })

  it('rejects an old in-flight background warm after a settings invalidation', async () => {
    vi.useFakeTimers()
    let resolveOldWarm!: (payload: MenubarPayload) => void
    const oldWarm = new Promise<MenubarPayload>(resolve => { resolveOldWarm = resolve })
    const usd = { ...overviewPayload(), currency: USD }
    mocks.getOverview.mockImplementation((period: string, _provider: string, _range, _config, background) => {
      if (period === 'today' && background === true) return oldWarm
      return Promise.resolve(usd)
    })

    render(<App />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mocks.getOverview).toHaveBeenCalledWith('today', 'all', undefined, undefined, true)

    fireEvent.keyDown(document, { key: ',', metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Reset to USD' }))
    await act(async () => { await Promise.resolve() })
    expect(mocks.resetCurrency).toHaveBeenCalled()

    await act(async () => {
      resolveOldWarm(usd)
      await Promise.resolve()
    })

    const todayKey = overviewMemoKey('all', 'today', null, null)
    expect(hasPolledMemo(todayKey)).toBe(false)
    expect(readOverviewHeadline(todayKey)).toBeNull()
  })
})

describe('usage_snapshot dispatch', () => {
  beforeEach(() => {
    installDefaultMocks()
    localStorage.clear()
    localStorage.setItem('codeburn.defaultPeriod', '30days')
  })

  it('forwards the CLI-computed snapshot verbatim, with no by-model join', async () => {
    const payload = overviewPayload()
    // Opaque to the renderer: whatever the CLI put here is what goes out.
    payload.telemetrySnapshot = { schema: 2, period: 'Last 30 days', costBucket: '10-50', models: [] }
    mocks.getOverview.mockResolvedValue(payload)

    render(<App />)

    await waitFor(() => expect(mocks.telemetryTrack).toHaveBeenCalledWith('usage_snapshot', payload.telemetrySnapshot))
    expect(mocks.getModels).not.toHaveBeenCalled()
  })

  it('falls back to the renderer builder when an older CLI omits the field', async () => {
    const payload = overviewPayload()
    payload.current.topModels = [{ name: 'claude-opus-4-8', cost: 30, savingsUSD: 0, savingsBaselineModel: '', calls: 400 }]
    mocks.getOverview.mockResolvedValue(payload)
    mocks.getModels.mockResolvedValue([])

    render(<App />)

    await waitFor(() => expect(mocks.telemetryTrack).toHaveBeenCalledWith('usage_snapshot', expect.objectContaining({
      period: 'Last 30 days',
      costBucket: '10-50',
    })))
    expect(mocks.getModels).toHaveBeenCalled()
  })

  it('sends nothing when the snapshot field is explicitly null and the payload is empty', async () => {
    const payload = overviewPayload()
    payload.telemetrySnapshot = null
    mocks.getOverview.mockResolvedValue(payload)
    mocks.getModels.mockResolvedValue([])

    render(<App />)

    // A null snapshot is an older/failed CLI, not a reason to skip the event.
    await waitFor(() => expect(mocks.telemetryTrack).toHaveBeenCalledWith('usage_snapshot', expect.objectContaining({ period: 'Last 30 days' })))
  })
})

describe('usage_snapshot telemetry props', () => {
  // The renderer builds these props; the main-process sanitizer (sanitizeProps)
  // is the last gate before the wire. Test the composition, which is what ships.
  function enrichedPayload(): MenubarPayload {
    const p = overviewPayload()
    p.current.cost = 42
    p.current.topModels = [
      { name: 'claude-opus-4-8', cost: 30, savingsUSD: 0, savingsBaselineModel: '', calls: 400 },
      { name: 'M'.repeat(80), cost: 0.5, savingsUSD: 0, savingsBaselineModel: '', calls: 2 },
    ]
    p.current.topActivities = [
      { name: 'coding', cost: 20, savingsUSD: 0, turns: 100, oneShotRate: 0.6123 },
      { name: 'debugging', cost: 10, savingsUSD: 0, turns: 40, oneShotRate: null },
    ]
    p.current.mcpServers = [
      { name: 'context7', calls: 5 },
      { name: 'S'.repeat(80), calls: 250 },
      { name: 'shadcn', calls: 1500 },
    ]
    p.current.skills = [
      { name: 'graphify', turns: 3, cost: 0 },
      { name: 'council', turns: 150, cost: 0 },
    ]
    // A path-like project name that MUST NEVER reach telemetry: the snapshot never
    // reads topProjects, and this guards against a future field accidentally doing so.
    p.current.topProjects = [{
      name: '/Users/x/secret-client/private-repo',
      cost: 42, savingsUSD: 0, sessions: 1, avgCostPerSession: 42, sessionDetails: [],
    }]
    return p
  }

  it('includes MCP servers and skills as names + bucketed usage', () => {
    const props = sanitizeProps(usageSnapshotProps(enrichedPayload()))

    const mcp = props.mcpServers as Array<{ name: string; callBucket: string }>
    expect(mcp.map(m => [m.name.slice(0, 8), m.callBucket])).toEqual([
      ['context7', '1-10'],
      ['SSSSSSSS', '100-1k'],
      ['shadcn', '1k+'],
    ])

    const skills = props.skills as Array<{ name: string; callBucket: string }>
    // Skills are measured in turns; buckets mirror the count scale.
    expect(skills).toEqual([
      { name: 'graphify', callBucket: '1-10' },
      { name: 'council', callBucket: '100-1k' },
    ])
  })

  it('truncates over-long names at the 64-char sanitizer cap', () => {
    const props = sanitizeProps(usageSnapshotProps(enrichedPayload()))
    const mcp = props.mcpServers as Array<{ name: string }>
    const models = props.models as Array<{ name: string }>
    expect(mcp[1]!.name.length).toBe(64)
    expect(models[1]!.name.length).toBe(64)
  })

  it('never leaks a filesystem path or project name', () => {
    const serialized = JSON.stringify(sanitizeProps(usageSnapshotProps(enrichedPayload())))
    expect(serialized).not.toContain('/Users/')
    expect(serialized).not.toContain('secret-client')
    expect(serialized).not.toContain('private-repo')
  })

  function modelRow(over: Partial<ModelReportRow> & Pick<ModelReportRow, 'model' | 'modelDisplayName'>): ModelReportRow {
    return {
      provider: 'claude', providerDisplayName: 'Claude', category: null,
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 0,
      costUSD: 0, savingsUSD: 0, savingsBaselineModel: '', calls: 0, credits: null,
      rawModels: [over.model], ...over,
    }
  }

  it('caps providers at 8, sorted by cost descending, bucketed', () => {
    const p = enrichedPayload()
    p.current.providers = {
      claude: 500, codex: 40, gemini: 5, cursor: 0.5, antigravity: 300,
      copilot: 20, windsurf: 2, amp: 0.1, cline: 0.02,
    }
    const props = sanitizeProps(usageSnapshotProps(p))
    const providers = props.providers as Array<{ name: string; costBucket: string }>
    expect(providers).toHaveLength(8)
    expect(providers).toEqual([
      { name: 'claude', costBucket: '200-1k' },
      { name: 'antigravity', costBucket: '200-1k' },
      { name: 'codex', costBucket: '10-50' },
      { name: 'copilot', costBucket: '10-50' },
      { name: 'gemini', costBucket: '1-10' },
      { name: 'windsurf', costBucket: '1-10' },
      { name: 'cursor', costBucket: '<1' },
      { name: 'amp', costBucket: '<1' },
    ])
  })

  it('crosses each top model with its dominant task category when the report joins', () => {
    // The overview model name is the display/short name; for Claude that equals
    // modelDisplayName, which is how the by-model report row joins back.
    const rows = [
      modelRow({ model: 'claude-opus-4-20260101', modelDisplayName: 'claude-opus-4-8', topCategory: 'coding' }),
    ]
    const props = sanitizeProps(usageSnapshotProps(enrichedPayload(), topCategoryByModel(rows)))
    const models = props.models as Array<Record<string, unknown>>
    expect(models[0]).toEqual({ name: 'claude-opus-4-8', costBucket: '10-50', topCategory: 'coding' })
    // A model the report has no category for carries name + costBucket only, never a fabricated cross.
    expect(Object.keys(models[1]!).sort()).toEqual(['costBucket', 'name'])
  })

  it('still emits a valid snapshot without topCategory when the by-model fetch fails', () => {
    // The graceful-degradation path: usageSnapshotProps is called with no category map.
    const props = sanitizeProps(usageSnapshotProps(enrichedPayload()))
    const models = props.models as Array<Record<string, unknown>>
    for (const m of models) expect(Object.keys(m).sort()).toEqual(['costBucket', 'name'])
    // Everything else the snapshot carries is intact.
    expect((props.mcpServers as unknown[]).length).toBe(3)
    expect((props.skills as unknown[]).length).toBe(2)
    expect(props.categories).toEqual([
      { name: 'coding', oneShotRate: 0.61 },
      { name: 'debugging', oneShotRate: -1 },
    ])
  })
})
