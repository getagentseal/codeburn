// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveCurrency } from '../lib/format'
import { __resetPolledMemo } from '../hooks/usePolled'
import type { JsonPlanSummary, QuotaProvider, StatusJson } from '../lib/types'
import { Plans } from './Plans'

const { getPlans, getQuota } = vi.hoisted(() => ({
  getPlans: vi.fn<(period: string) => Promise<StatusJson>>(),
  getQuota: vi.fn<(force?: boolean) => Promise<QuotaProvider[]>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: { getPlans, getQuota } }
})

const periodStart = new Date(2026, 5, 15).toISOString()
const periodEnd = new Date(2026, 6, 15).toISOString()

const claudePlan: JsonPlanSummary = {
  id: 'claude-max',
  provider: 'claude',
  budget: 200,
  spent: 230,
  percentUsed: 115,
  status: 'over',
  projectedMonthEnd: 254,
  daysUntilReset: 4,
  periodStart,
  periodEnd,
}

const cursorPlan: JsonPlanSummary = {
  id: 'cursor-pro',
  provider: 'cursor',
  budget: 20,
  spent: 8.2,
  percentUsed: 41,
  status: 'under',
  projectedMonthEnd: 12.4,
  daysUntilReset: 4,
  periodStart,
  periodEnd,
}

const codexPlan: JsonPlanSummary = {
  id: 'none',
  provider: 'codex',
  budget: 0,
  spent: 31.02,
  percentUsed: 15,
  status: 'under',
  projectedMonthEnd: 31.02,
  daysUntilReset: 4,
  periodStart,
  periodEnd,
}

const baseStatus = {
  currency: 'USD',
  today: { cost: 22.5, savings: 4.2, calls: 19 },
  month: { cost: 269.02, savings: 52, calls: 181 },
} satisfies Omit<StatusJson, 'plan' | 'plans'>

const statusWithPlans: StatusJson = {
  ...baseStatus,
  plans: {
    claude: claudePlan,
    cursor: cursorPlan,
    codex: codexPlan,
  },
}

function quotaProviders(): QuotaProvider[] {
  const now = Date.now()
  return [
    {
      provider: 'claude',
      connection: 'connected',
      primary: { label: 'Weekly', percent: 0.92, resetsAt: new Date(now + (3 * 24 + 14) * 60 * 60_000 + 30 * 60_000).toISOString() },
      details: [
        { label: '5-hour', percent: 0.25, resetsAt: new Date(now + 2 * 60 * 60_000 + 30 * 60_000).toISOString() },
        { label: 'Weekly', percent: 0.92, resetsAt: new Date(now + (3 * 24 + 14) * 60 * 60_000 + 30 * 60_000).toISOString() },
      ],
      planLabel: 'Max 20x',
      footerLines: [],
    },
    {
      provider: 'codex',
      connection: 'disconnected',
      primary: null,
      details: [],
      planLabel: null,
      footerLines: [],
    },
  ]
}

describe('Plans', () => {
  beforeEach(() => {
    setActiveCurrency({ code: 'USD', symbol: '$', rate: 1 })
    getPlans.mockReset()
    getQuota.mockReset()
    getQuota.mockResolvedValue(quotaProviders())
  })

  it('renders live quota windows, tier, severity, disconnected hint, and manual plans below', async () => {
    getPlans.mockResolvedValue(statusWithPlans)

    const { container } = render(<Plans period="30days" />)

    expect(await screen.findByText('Max 20x')).toBeInTheDocument()
    expect(screen.getByText('25% used · resets in 2h 29m')).toBeInTheDocument()
    expect(screen.getByText('92% used · resets in 3d 14h')).toBeInTheDocument()
    expect(container.querySelector('[data-testid="quota-track-5-hour"] i')).toHaveClass('accent')
    expect(container.querySelector('[data-testid="quota-track-Weekly"] i')).toHaveClass('bad')
    expect(screen.getByText('Not connected. Log in with the Codex CLI.')).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Budget plans' })).toBeInTheDocument()
    expect(screen.getByText('Cursor Pro')).toBeInTheDocument()
    expect(screen.getByText('$20.00 / month budget · API-equivalent, not a live provider window · cursor')).toBeInTheDocument()
    expect(screen.getByText('$8.20 · 41%')).toBeInTheDocument()
    const cursorFill = container.querySelector('[data-testid="plan-track-cursor"] i')
    expect(cursorFill).toHaveStyle({ width: '41%' })
    expect(cursorFill).not.toHaveClass('over')
    expect(screen.getByText('On track')).toHaveClass('pace', 'ok')
    expect(screen.queryByText('Claude Max')).not.toBeInTheDocument()
    expect(screen.queryByText('API usage')).not.toBeInTheDocument()
  })

  it('keeps manual budget overage and clamped-track behavior', async () => {
    getPlans.mockResolvedValue({
      ...baseStatus,
      plans: {
        grok: { ...claudePlan, id: 'supergrok', provider: 'grok' },
      },
    })

    const { container } = render(<Plans period="30days" />)

    expect(await screen.findByText('SuperGrok')).toBeInTheDocument()
    expect(screen.getByText('$230.00 · 115% · $30.00 over')).toBeInTheDocument()
    const fill = container.querySelector('[data-testid="plan-track-grok"] i')
    expect(fill).toHaveStyle({ width: '100%' })
    expect(fill).toHaveClass('over')
    expect(screen.getByText('On pace to exceed; projected $254.00 by Jul 14')).toHaveClass('pace', 'hot')
  })

  it('renders near status as an amber non-exceeding projection when below budget', async () => {
    getPlans.mockResolvedValue({
      ...baseStatus,
      plans: {
        grok: {
          id: 'supergrok-heavy',
          provider: 'grok',
          budget: 300,
          spent: 255,
          percentUsed: 85,
          status: 'near',
          projectedMonthEnd: 280,
          daysUntilReset: 4,
          periodStart,
          periodEnd,
        },
      },
    })

    render(<Plans period="30days" />)

    const pace = await screen.findByText('85% of budget used; projected $280.00 by Jul 14')
    expect(pace).toHaveClass('pace', 'hot')
    expect(screen.queryByText(/On pace to exceed/)).not.toBeInTheDocument()
  })

  it('falls back to StatusJson.plan when the CLI returns a singular plan summary', async () => {
    getPlans.mockResolvedValue({
      ...baseStatus,
      plan: cursorPlan,
    })

    render(<Plans period="month" />)

    expect(await screen.findByText('Cursor Pro')).toBeInTheDocument()
  })

  it('omits the budget section when StatusJson has no manual plan summaries', async () => {
    getPlans.mockResolvedValue({
      currency: 'USD',
      today: { cost: 0, savings: 0, calls: 0 },
      month: { cost: 0, savings: 0, calls: 0 },
    })

    render(<Plans period="month" />)

    expect(await screen.findByText('Not connected. Log in with the Codex CLI.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Budget plans' })).not.toBeInTheDocument()
  })

  it('renders the CLI locate state when getPlans reports not-found', async () => {
    getPlans.mockRejectedValue({ kind: 'not-found', message: 'codeburn not found' })

    render(<Plans period="week" />)

    expect(await screen.findByText('Locate the codeburn CLI')).toBeInTheDocument()
  })

  it('does not re-apply the FX rate to CLI-converted plan values (symbol swap only)', async () => {
    // getPlans values arrive already converted by the CLI (convertCost). With a
    // EUR rate active, the pane must only swap the symbol — a second ×0.9 here
    // would render €18.00 / €7.38 instead of the correct €20.00 / €8.20.
    setActiveCurrency({ code: 'EUR', symbol: '€', rate: 0.9 })
    getPlans.mockResolvedValue({ ...baseStatus, currency: 'EUR', plans: { cursor: cursorPlan } })

    render(<Plans period="30days" />)

    expect(await screen.findByText('€20.00 / month budget · API-equivalent, not a live provider window · cursor')).toBeInTheDocument()
    expect(screen.getByText('€8.20 · 41%')).toBeInTheDocument()
  })

  it('forces a quota refresh only when refreshToken changes, not on the steady poll', async () => {
    getPlans.mockResolvedValue(statusWithPlans)

    const { rerender } = render(<Plans period="30days" refreshToken={0} />)
    await screen.findByText('Max 20x')
    expect(getQuota).toHaveBeenCalledWith(false, []) // mount is a steady poll
    getQuota.mockClear()

    rerender(<Plans period="30days" refreshToken={1} />) // manual refresh bumps the token
    await waitFor(() => expect(getQuota).toHaveBeenCalledWith(true, []))

    getQuota.mockClear()
    rerender(<Plans period="30days" refreshToken={1} />) // unchanged token must not re-force
    for (const call of getQuota.mock.calls) expect(call[0]).toBe(false)
  })

  it('renders permission-denied CLI failures as the amber Full Disk Access state', async () => {
    getPlans.mockRejectedValue({ kind: 'nonzero', message: 'Cursor permission denied: grant Full Disk Access' })

    render(<Plans period="week" />)

    expect(await screen.findByText('Permission denied')).toBeInTheDocument()
    expect(screen.getByText('permission denied; grant Full Disk Access')).toHaveStyle({ color: 'var(--warn)' })
  })

  it('expands the Connect affordance and forces a keychain refresh from Refresh', async () => {
    getPlans.mockResolvedValue(statusWithPlans)

    render(<Plans period="30days" />)

    const connect = await screen.findByRole('button', { name: 'Connect' })
    expect(screen.getByText('Not connected. Log in with the Codex CLI.')).toBeInTheDocument()
    fireEvent.click(connect)
    expect(screen.getByText('codex login')).toBeInTheDocument()

    getQuota.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(getQuota).toHaveBeenCalledWith(true, []))
  })

  it('renders the honest rate-limited note on a 429 backoff, per provider owner', async () => {
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockResolvedValue([
      { provider: 'claude', connection: 'transientFailure', rateLimited: true, primary: null, details: [], planLabel: null, footerLines: [] },
      { provider: 'codex', connection: 'stale', rateLimited: true, primary: null, details: [], planLabel: null, footerLines: [] },
    ])

    render(<Plans period="30days" />)

    expect(await screen.findByText('Anthropic rate limited the quota endpoint, retrying in a few minutes')).toBeInTheDocument()
    expect(screen.getByText('OpenAI rate limited the quota endpoint, retrying in a few minutes')).toBeInTheDocument()
    // The rate-limited note replaces the generic waiting copy.
    expect(screen.queryByText('Waiting on the CLI…')).not.toBeInTheDocument()
  })

  it('falls back to the generic waiting note when a transient failure is not rate limited', async () => {
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockResolvedValue([
      { provider: 'claude', connection: 'transientFailure', rateLimited: false, primary: null, details: [], planLabel: null, footerLines: [] },
    ])

    const { container } = render(<Plans period="30days" />)
    const q = within(container)

    expect(await q.findByText('Waiting on the CLI…')).toBeInTheDocument()
    expect(q.queryByText(/rate limited the quota endpoint/)).not.toBeInTheDocument()
  })

  const connectedClaude: QuotaProvider = {
    provider: 'claude',
    connection: 'connected',
    primary: { label: 'Weekly', percent: 0.1, resetsAt: null },
    details: [{ label: 'Weekly', percent: 0.1, resetsAt: null }],
    planLabel: 'Max 20x',
    footerLines: [],
  }
  const disconnectedClaude: QuotaProvider = {
    provider: 'claude', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [],
  }

  it('never flips a connected provider to disconnected across connected → empty → connected polls', async () => {
    __resetPolledMemo()
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockReset()
    getQuota
      .mockResolvedValueOnce([connectedClaude]) // poll 1: connected
      .mockResolvedValueOnce([]) // poll 2: empty/slow serve — a transient miss
      .mockResolvedValue([connectedClaude]) // poll 3+: connected again

    const { rerender } = render(<Plans period="30days" refreshToken={0} />)
    await screen.findByText('Max 20x')
    expect(screen.queryByText(/Not connected/)).not.toBeInTheDocument()

    rerender(<Plans period="30days" refreshToken={1} />) // empty poll
    await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(2))
    // The row must survive an empty poll — no disconnect flicker, plan still shown.
    expect(screen.queryByText(/Not connected/)).not.toBeInTheDocument()
    expect(screen.getByText('Max 20x')).toBeInTheDocument()

    rerender(<Plans period="30days" refreshToken={2} />) // connected again
    await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(3))
    expect(screen.queryByText(/Not connected/)).not.toBeInTheDocument()
  })

  it('debounces a single disconnected poll but still surfaces a sustained disconnect', async () => {
    __resetPolledMemo()
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockReset()
    getQuota
      .mockResolvedValueOnce([connectedClaude]) // poll 1: connected
      .mockResolvedValueOnce([disconnectedClaude]) // poll 2: one anomalous disconnect
      .mockResolvedValue([disconnectedClaude]) // poll 3+: sustained disconnect

    const { rerender } = render(<Plans period="30days" refreshToken={0} />)
    await screen.findByText('Max 20x')

    rerender(<Plans period="30days" refreshToken={1} />) // single disconnect — debounced
    await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/Not connected/)).not.toBeInTheDocument()

    rerender(<Plans period="30days" refreshToken={2} />) // second consecutive disconnect — real
    await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(3))
    expect(await screen.findByText(/Not connected/)).toBeInTheDocument()
  })

  it('renders the keychain access-denied state with recovery copy and a locked indicator', async () => {
    getPlans.mockResolvedValue(statusWithPlans)
    getQuota.mockResolvedValue([
      { provider: 'claude', connection: 'accessDenied', primary: null, details: [], planLabel: null, footerLines: [] },
      { provider: 'codex', connection: 'connected', primary: { label: 'Weekly', percent: 0.1, resetsAt: null }, details: [{ label: 'Weekly', percent: 0.1, resetsAt: null }], planLabel: 'Plus', footerLines: [] },
    ])

    render(<Plans period="30days" />)

    expect(await screen.findByText('Keychain access needed: click Allow when macOS asks, then Refresh.')).toBeInTheDocument()
    expect(screen.getByText('locked')).toBeInTheDocument()
  })

  it('adds the Connect affordance to a login-expired error, keeping its message', async () => {
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockReset()
    getQuota.mockResolvedValue([
      { provider: 'kimi', connection: 'terminalFailure', connectable: true, primary: null, details: [], planLabel: null, footerLines: ['Login expired. Run the Kimi CLI once, then refresh.'] },
    ])

    const { container } = render(<Plans period="30days" />)
    const q = within(container)

    expect(await q.findByText('Login expired. Run the Kimi CLI once, then refresh.')).toBeInTheDocument()
    expect(q.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
  })

  it('leaves a genuinely terminal error (not auth) without a Connect affordance', async () => {
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockReset()
    getQuota.mockResolvedValue([
      { provider: 'gemini', connection: 'terminalFailure', primary: null, details: [], planLabel: null, footerLines: ['Your Gemini tier was retired.'] },
    ])

    const { container } = render(<Plans period="30days" />)
    const q = within(container)

    expect(await q.findByText('Your Gemini tier was retired.')).toBeInTheDocument()
    expect(q.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
  })

  it('keeps a connected provider\'s bars through a transient "waiting" poll (manual refresh race)', async () => {
    __resetPolledMemo()
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockReset()
    const connected: QuotaProvider[] = [
      { provider: 'codex', connection: 'connected', primary: { label: 'Weekly', percent: 0.17, resetsAt: null }, details: [{ label: 'Weekly', percent: 0.17, resetsAt: null }], planLabel: 'Plus', footerLines: [] },
    ]
    const waiting: QuotaProvider[] = [
      { provider: 'codex', connection: 'transientFailure', rateLimited: false, primary: null, details: [], planLabel: null, footerLines: [] },
    ]
    getQuota.mockResolvedValueOnce(connected).mockResolvedValue(waiting)

    const { rerender } = render(<Plans period="30days" refreshToken={0} />)
    expect(await screen.findByText('17% used')).toBeInTheDocument()

    rerender(<Plans period="30days" refreshToken={1} />) // refresh comes back transient for Codex
    await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(2))
    expect(screen.getByText('17% used')).toBeInTheDocument() // bars stay
    expect(screen.queryByText('Waiting on the CLI…')).not.toBeInTheDocument()
  })

  it('caps a stuck "waiting" state to an actionable Connect after the cap', async () => {
    __resetPolledMemo()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    getPlans.mockResolvedValue(baseStatus)
    getQuota.mockReset()
    const waiting = (): QuotaProvider[] => [
      { provider: 'gemini', connection: 'transientFailure', rateLimited: false, primary: null, details: [], planLabel: null, footerLines: [] },
    ]
    getQuota.mockResolvedValueOnce(waiting()).mockResolvedValue(waiting())

    const { rerender } = render(<Plans period="30days" refreshToken={0} />)
    expect(await screen.findByText('Waiting on the CLI…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()

    nowSpy.mockReturnValue(1_000_000 + 25_000) // past the 20s cap
    rerender(<Plans period="30days" refreshToken={1} />)
    await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("Couldn't reach the Gemini CLI.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    nowSpy.mockRestore()
  })
})
