// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActionResult, AliasRow, CombinedUsage, DeviceScanResult, Identity, MenubarPayload, PriceOverrideList, PriceRates, QuotaProvider, ShareStatus, StatusJson } from '../lib/types'
import { Settings } from './Settings'

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn<() => Promise<Identity>>(),
  getDevices: vi.fn<(period: string) => Promise<CombinedUsage>>(),
  getDevicesScan: vi.fn<() => Promise<DeviceScanResult>>(),
  getShareStatus: vi.fn<() => Promise<ShareStatus>>(),
  getQuota: vi.fn<(force?: boolean) => Promise<QuotaProvider[]>>(),
  getPlans: vi.fn<(period: string) => Promise<StatusJson>>(),
  getOverview: vi.fn<(period: string, provider: string) => Promise<MenubarPayload>>(),
  getAliases: vi.fn<() => Promise<AliasRow[]>>(),
  getPriceOverrides: vi.fn<() => Promise<PriceOverrideList>>(),
  setPriceOverride: vi.fn<(model: string, rates: PriceRates) => Promise<ActionResult>>(),
  removePriceOverride: vi.fn<(model: string) => Promise<ActionResult>>(),
  setCurrency: vi.fn<(code: string) => Promise<ActionResult>>(),
  resetCurrency: vi.fn<() => Promise<ActionResult>>(),
  addAlias: vi.fn<(from: string, to: string) => Promise<ActionResult>>(),
  removeAlias: vi.fn<(from: string) => Promise<ActionResult>>(),
  removeDevice: vi.fn<(name: string) => Promise<ActionResult>>(),
  setPlan: vi.fn<(id: string, provider: string) => Promise<ActionResult>>(),
  resetPlan: vi.fn<(provider: string) => Promise<ActionResult>>(),
  chooseDirectory: vi.fn<() => Promise<string | null>>(),
  exportData: vi.fn<(format: string, provider: string, path: string) => Promise<ActionResult>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const identity: Identity = { name: 'Toruk MacBook Pro', fingerprint: 'AA:11:22:33:44:55:66:77' }
const actionOk: ActionResult = { ok: true, stdout: 'updated', stderr: '', code: 0 }
const devices: CombinedUsage = {
  perDevice: [
    { id: 'local', name: 'Toruk MacBook Pro', local: true, cost: 120.1, calls: 100, sessions: 10, inputTokens: 1, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4, totalTokens: 10 },
    { id: 'mini', name: 'toruk-mini', local: false, cost: 41.2, calls: 680, sessions: 34, inputTokens: 11, outputTokens: 12, cacheCreateTokens: 13, cacheReadTokens: 14, totalTokens: 50 },
  ],
  combined: { cost: 161.3, calls: 780, sessions: 44, inputTokens: 12, outputTokens: 14, cacheCreateTokens: 16, cacheReadTokens: 18, totalTokens: 60, deviceCount: 2, reachableCount: 2 },
}
const scan: DeviceScanResult = { found: [{ name: 'Mac Studio', host: 'mac-studio.local', port: 9732, fingerprint: '7F:2A:19:88:55:44:33:C4', code: 'pair-1', paired: false }] }
const overview = { current: { providers: { claude: 12.34, codex: 4.5 } } } as unknown as MenubarPayload
const quotaProviders: QuotaProvider[] = [
  { provider: 'claude', connection: 'connected', primary: null, details: [], planLabel: 'Max 20x', footerLines: [] },
  { provider: 'codex', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [] },
]
const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  clear: () => stored.clear(),
})

describe('Settings', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.getIdentity.mockResolvedValue(identity)
    mocks.getDevices.mockResolvedValue(devices)
    mocks.getDevicesScan.mockResolvedValue(scan)
    mocks.getShareStatus.mockResolvedValue({ sharing: true, name: 'Toruk MacBook Pro', port: 9732, always: false, peers: 1, pending: [] })
    mocks.getQuota.mockResolvedValue(quotaProviders)
    mocks.getPlans.mockResolvedValue({ currency: 'EUR', today: { cost: 0, savings: 0, calls: 0 }, month: { cost: 0, savings: 0, calls: 0 }, plans: { claude: { id: 'claude-max', provider: 'claude', budget: 200, spent: 48, percentUsed: 24, status: 'under', projectedMonthEnd: 120, daysUntilReset: 19, periodStart: '2026-07-01', periodEnd: '2026-08-01' } } })
    mocks.getOverview.mockResolvedValue(overview)
    mocks.getAliases.mockResolvedValue([{ from: 'proxy-opus', to: 'claude-opus-4-6' }])
    mocks.getPriceOverrides.mockResolvedValue({ overrides: [{ model: 'local/llama', inputPerM: 0.2, outputPerM: 0.6, cacheReadPerM: 0.05 }], configPath: '/home/user/.config/codeburn/config.json' })
    mocks.setPriceOverride.mockResolvedValue(actionOk)
    mocks.removePriceOverride.mockResolvedValue(actionOk)
    mocks.setCurrency.mockResolvedValue(actionOk)
    mocks.resetCurrency.mockResolvedValue(actionOk)
    mocks.addAlias.mockResolvedValue(actionOk)
    mocks.removeAlias.mockResolvedValue(actionOk)
    mocks.removeDevice.mockResolvedValue(actionOk)
    mocks.setPlan.mockResolvedValue(actionOk)
    mocks.resetPlan.mockResolvedValue(actionOk)
    mocks.chooseDirectory.mockResolvedValue('/Users/toruk/Exports')
    mocks.exportData.mockResolvedValue(actionOk)
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('switches panes from the rail and renders the completed Plans pane', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Plans' }))
    expect(screen.getByRole('heading', { name: 'Plans' })).toBeInTheDocument()
    expect((await screen.findAllByText('Claude Max 20x')).length).toBeGreaterThan(0)
  })

  it('shows current currency and sends currency changes to the CLI', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    const currency = await screen.findByLabelText('Currency')
    expect(currency).toHaveTextContent('EUR')
    await user.click(currency)
    expect(screen.getByRole('option', { name: 'CZK' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'CNY' }))
    expect(mocks.setCurrency).toHaveBeenCalledWith('CNY')
    expect(await screen.findByText('Updated')).toBeInTheDocument()
  })

  it('persists theme choices and applies forced themes to the root', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem('codeburn.theme')).toBe('dark')
    await user.click(screen.getByRole('button', { name: 'System' }))
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })

  it('shows the active Claude config as a read-only line in General when multiple configs exist', async () => {
    render(<Settings period="month" claudeConfigs={{ selectedId: null, options: [{ id: 'claude-config:aaaa', label: 'Default Claude', path: '/x' }, { id: 'claude-desktop:bbbb', label: 'Claude Desktop', path: '/y' }] }} claudeConfigSource="claude-desktop:bbbb" />)
    expect(await screen.findByText('Claude config')).toBeInTheDocument()
    expect(screen.getByText('Claude Desktop')).toBeInTheDocument()
    expect(screen.getByText('Applies to the overview data. Manage config folders with the codeburn CLI.')).toBeInTheDocument()
  })

  it('omits the Claude config line when no multi-config selector is present', async () => {
    render(<Settings period="month" />)
    expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument()
    expect(screen.queryByText('Claude config')).not.toBeInTheDocument()
  })

  it('stores a positive daily budget from General', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByLabelText('Daily budget'))
    await user.click(screen.getByRole('option', { name: 'USD amount' }))
    await user.type(screen.getByLabelText('Daily budget amount'), '25')
    expect(JSON.parse(localStorage.getItem('codeburn.dailyBudget')!)).toEqual({ kind: 'usd', value: 25 })
  })

  it('rejects a non-positive daily budget without persisting it', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByLabelText('Daily budget'))
    await user.click(screen.getByRole('option', { name: 'Tokens' }))
    await user.type(screen.getByLabelText('Daily budget amount'), '-5')
    expect(screen.getByText('Enter a positive number.')).toBeInTheDocument()
    expect(localStorage.getItem('codeburn.dailyBudget')).toBeFalsy()
  })

  it('lists providers from the real overview payload', async () => {
    const user = userEvent.setup()
    render(<Settings period="week" />)
    await user.click(screen.getByRole('button', { name: 'Providers' }))
    expect(await screen.findByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Detected · $12.34')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(mocks.getOverview).toHaveBeenCalledWith('week', 'all')
  })

  it('lists, adds, and removes model aliases through the action bridge', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Model aliases' }))
    expect(await screen.findByText('proxy-opus')).toBeInTheDocument()
    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Unrecognized model'), 'proxy-sonnet')
    await user.type(screen.getByLabelText('Priced model'), 'claude-sonnet-4-5')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(mocks.addAlias).toHaveBeenCalledWith('proxy-sonnet', 'claude-sonnet-4-5')
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mocks.removeAlias).toHaveBeenCalledWith('proxy-opus')
  })

  it('lists, adds, and removes price overrides through the action bridge', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Pricing' }))
    expect(await screen.findByText('local/llama')).toBeInTheDocument()
    expect(screen.getByText('in 0.2 · out 0.6 · read 0.05')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Override model'), 'ollama/qwen')
    await user.type(screen.getByLabelText('Input rate'), '0.1')
    await user.type(screen.getByLabelText('Output rate'), '0.4')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    // Only the two filled rates are sent; cache fields stay out of the payload.
    expect(mocks.setPriceOverride).toHaveBeenCalledWith('ollama/qwen', { input: 0.1, output: 0.4 })
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(mocks.removePriceOverride).toHaveBeenCalledWith('local/llama')
  })

  it('rejects an invalid price rate client-side without calling the bridge', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Pricing' }))
    await user.type(screen.getByLabelText('Override model'), 'ollama/qwen')
    await user.type(screen.getByLabelText('Input rate'), '0')
    await user.type(screen.getByLabelText('Output rate'), '0.4')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('Rates must be positive numbers (USD per 1M tokens).')).toBeInTheDocument()
    expect(mocks.setPriceOverride).not.toHaveBeenCalled()
  })

  it('lists, removes, and adds plans through the action bridge', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Plans' }))
    expect((await screen.findAllByText('Claude Max 20x')).length).toBeGreaterThan(0)
    expect(screen.getByText('$200.00/month · claude · 24% used')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(mocks.resetPlan).toHaveBeenCalledWith('claude')
    await user.click(screen.getByLabelText('Add a plan'))
    await user.click(screen.getByRole('option', { name: 'Cursor Pro' }))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(mocks.setPlan).toHaveBeenCalledWith('cursor-pro', 'cursor')
  })

  it('shows detected subscriptions with an auto-detected tier and a disconnected hint', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Plans' }))
    expect(await screen.findByText('Detected subscriptions')).toBeInTheDocument()
    expect(screen.getByText('Max 20x')).toBeInTheDocument()
    expect(screen.getByText('Not connected: log in with the codex CLI')).toBeInTheDocument()
    expect(mocks.getQuota).toHaveBeenCalledWith(false)
  })

  it('offers only non-OAuth budget presets; Claude and Codex are excluded', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Plans' }))
    await user.click(await screen.findByLabelText('Add a plan'))
    expect(screen.getByRole('option', { name: 'Cursor Pro' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'SuperGrok' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Claude Pro' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Claude Max 20x' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Claude Max 5x' })).not.toBeInTheDocument()
  })

  it('still lists a configured Claude manual plan with Remove and a superseded note', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Plans' }))
    expect((await screen.findAllByText('Claude Max 20x')).length).toBeGreaterThan(0)
    expect(screen.getByText('superseded by the detected subscription')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('chooses an export folder and exports the selected format and provider', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getAllByRole('button', { name: 'Export' }).at(-1)!)
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    expect(mocks.chooseDirectory).toHaveBeenCalledOnce()
    expect(await screen.findByText('/Users/toruk/Exports')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'JSON' }))
    await user.click(screen.getByLabelText('Provider'))
    await user.click(screen.getByRole('option', { name: 'Claude' }))
    await user.click(screen.getAllByRole('button', { name: 'Export' }).at(-1)!)
    expect(mocks.exportData).toHaveBeenCalledWith('json', 'claude', '/Users/toruk/Exports')
    expect(await screen.findByText('Exported to /Users/toruk/Exports')).toBeInTheDocument()
  })

  it('renders real device status and removes paired devices without fake pairing controls', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Devices' }))
    expect(await screen.findByText('Toruk MacBook Pro')).toBeInTheDocument()
    expect(screen.getByText('Local device name: Toruk MacBook Pro')).toBeInTheDocument()
    expect(await screen.findByText('Mac Studio')).toBeInTheDocument()
    expect(screen.getByText('fingerprint 7F:2A:…:C4')).toBeInTheDocument()
    expect(await screen.findByText('toruk-mini')).toBeInTheDocument()
    expect(screen.getByText('34 sessions · $41.20 this month')).toBeInTheDocument()
    expect(screen.getByText('Visible')).toBeInTheDocument()
    expect(screen.getByText(/Pairing is interactive/)).toBeInTheDocument()
    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
    expect(screen.queryByText('Pull now')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(mocks.removeDevice).toHaveBeenCalledWith('toruk-mini')
    expect(screen.getByText('Combined view active · 2 devices')).toBeInTheDocument()
  })

  it('excludes already-paired scans and renders empty device states', async () => {
    const user = userEvent.setup()
    mocks.getDevicesScan.mockResolvedValue({ found: [{ ...scan.found[0]!, paired: true }] })
    mocks.getDevices.mockResolvedValue({ perDevice: [devices.perDevice[0]!], combined: { ...devices.combined, deviceCount: 1, reachableCount: 1 } })
    render(<Settings period="week" />)
    await user.click(screen.getByRole('button', { name: 'Devices' }))
    expect(await screen.findByText('No nearby devices found.')).toBeInTheDocument()
    expect(screen.getByText('No paired devices yet.')).toBeInTheDocument()
    expect(screen.queryByText('Mac Studio')).not.toBeInTheDocument()
  })

  it('renders not-found and permission states for device reads', async () => {
    const user = userEvent.setup()
    mocks.getIdentity.mockRejectedValue({ kind: 'not-found', message: 'codeburn not found' })
    mocks.getDevicesScan.mockRejectedValue({ kind: 'nonzero', message: 'Cursor permission denied: Full Disk Access required' })
    mocks.getDevices.mockRejectedValue({ kind: 'not-found', message: 'codeburn not found' })
    render(<Settings period="week" />)
    await user.click(screen.getByRole('button', { name: 'Devices' }))
    await waitFor(() => expect(screen.getAllByText('Locate the codeburn CLI')).toHaveLength(2))
    expect(screen.getByText('permission denied; grant Full Disk Access')).toHaveStyle({ color: 'var(--warn)' })
  })
})
