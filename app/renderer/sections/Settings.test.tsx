// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActionResult, AliasRow, CombinedUsage, DeviceScanResult, Identity, MenubarPayload, StatusJson } from '../lib/types'
import { Settings } from './Settings'

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn<() => Promise<Identity>>(),
  getDevices: vi.fn<(period: string) => Promise<CombinedUsage>>(),
  getDevicesScan: vi.fn<() => Promise<DeviceScanResult>>(),
  getPlans: vi.fn<(period: string) => Promise<StatusJson>>(),
  getOverview: vi.fn<(period: string, provider: string) => Promise<MenubarPayload>>(),
  getAliases: vi.fn<() => Promise<AliasRow[]>>(),
  setCurrency: vi.fn<(code: string) => Promise<ActionResult>>(),
  resetCurrency: vi.fn<() => Promise<ActionResult>>(),
  addAlias: vi.fn<(from: string, to: string) => Promise<ActionResult>>(),
  removeAlias: vi.fn<(from: string) => Promise<ActionResult>>(),
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
    mocks.getPlans.mockResolvedValue({ currency: 'EUR', today: { cost: 0, savings: 0, calls: 0 }, month: { cost: 0, savings: 0, calls: 0 } })
    mocks.getOverview.mockResolvedValue(overview)
    mocks.getAliases.mockResolvedValue([{ from: 'proxy-opus', to: 'claude-opus-4-6' }])
    mocks.setCurrency.mockResolvedValue(actionOk)
    mocks.resetCurrency.mockResolvedValue(actionOk)
    mocks.addAlias.mockResolvedValue(actionOk)
    mocks.removeAlias.mockResolvedValue(actionOk)
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('switches panes from the rail and keeps minimal placeholders honest', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Plans' }))
    expect(screen.getByRole('heading', { name: 'Plans' })).toBeInTheDocument()
    expect(screen.getByText('Wired up in the next pass.')).toBeInTheDocument()
  })

  it('shows current currency and sends currency changes to the CLI', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    const currency = await screen.findByLabelText('Currency')
    expect(currency).toHaveValue('EUR')
    await user.selectOptions(currency, 'GBP')
    expect(mocks.setCurrency).toHaveBeenCalledWith('GBP')
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

  it('renders device identity, scan results, paired devices, and Part 2 affordances', async () => {
    const user = userEvent.setup()
    const { container } = render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Devices' }))
    expect(await screen.findByText('Toruk MacBook Pro')).toBeInTheDocument()
    expect(screen.getByText('Visible on the local network as Toruk MacBook Pro.local')).toBeInTheDocument()
    expect(await screen.findByText('Mac Studio')).toBeInTheDocument()
    expect(screen.getByText('wants to pair · fingerprint 7F:2A:…:C4')).toBeInTheDocument()
    expect(await screen.findByText('toruk-mini')).toBeInTheDocument()
    expect(screen.getByText('34 sessions · $41.20 this month')).toBeInTheDocument()
    expect(screen.getByText('Visibility: on')).toBeInTheDocument()
    expect(screen.getByText('Approve')).toBeInTheDocument()
    expect(screen.getByText('Pull now')).toBeInTheDocument()
    expect(container.querySelector('.tglon')).toBeInTheDocument()
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
    expect(screen.getByText('permission denied — grant Full Disk Access')).toHaveStyle({ color: 'var(--amber)' })
  })
})
