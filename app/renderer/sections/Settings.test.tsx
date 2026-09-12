// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActionResult, AliasRow, CombinedUsage, DeviceScanResult, Identity, MenubarPayload, PriceOverrideList, PriceRates, ProjectFilter, ProjectsReport, QuotaProvider, ShareStatus, StatusJson, TelemetryStatus } from '../lib/types'
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
  getProjectFilter: vi.fn<() => Promise<ProjectFilter>>(),
  setProjectFilter: vi.fn<(filter: ProjectFilter) => Promise<ProjectFilter>>(),
  getUnfilteredProjects: vi.fn<() => Promise<ProjectsReport>>(),
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
  companionStatus: vi.fn(),
  trayPrefs: vi.fn(),
  setTrayAppPref: vi.fn(),
  setTrayDockPref: vi.fn(),
  setLaunchAtLogin: vi.fn(),
  telemetryTrack: vi.fn<(name: string, props?: Record<string, unknown>) => Promise<boolean>>(),
  telemetryStatus: vi.fn<() => Promise<TelemetryStatus | null>>(),
  setTelemetryEnabled: vi.fn<(enabled: boolean) => Promise<TelemetryStatus | null>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const identity: Identity = { name: 'Studio MacBook Pro', fingerprint: 'AA:11:22:33:44:55:66:77' }
const actionOk: ActionResult = { ok: true, stdout: 'updated', stderr: '', code: 0 }
const devices: CombinedUsage = {
  perDevice: [
    { id: 'local', name: 'Studio MacBook Pro', local: true, cost: 120.1, calls: 100, sessions: 10, inputTokens: 1, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4, totalTokens: 10 },
    { id: 'mini', name: 'studio-mini', local: false, cost: 41.2, calls: 680, sessions: 34, inputTokens: 11, outputTokens: 12, cacheCreateTokens: 13, cacheReadTokens: 14, totalTokens: 50 },
  ],
  combined: { cost: 161.3, calls: 780, sessions: 44, inputTokens: 12, outputTokens: 14, cacheCreateTokens: 16, cacheReadTokens: 18, totalTokens: 60, deviceCount: 2, reachableCount: 2 },
}
const scan: DeviceScanResult = { found: [{ name: 'Mac Studio', host: 'mac-studio.local', port: 9732, fingerprint: '7F:2A:19:88:55:44:33:C4', code: 'pair-1', paired: false }] }
const overview = { current: { providers: { claude: 12.34, codex: 4.5 } } } as unknown as MenubarPayload
const quotaProviders: QuotaProvider[] = [
  { provider: 'claude', connection: 'connected', primary: null, details: [], planLabel: 'Max 20x', footerLines: [] },
  { provider: 'codex', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [] },
]
const trayPrefs = {
  app: { metric: 'cost', menubarPeriod: 'today', accent: 'ember', trayBadge: false, usageRefreshSeconds: -1, quotaCadenceSeconds: 120, terminal: 'windowsTerminal' },
  dock: { enabled: true, preferred: 'claude', scale: 0.6, theme: 'graphite', gaugeShape: 'circle', providers: ['claude'], manualSelection: true },
  launchAtLogin: false,
}
const telemetryOff: TelemetryStatus = {
  installId: '8f1c2b4d', country: 'DE', enabled: false, defaultEnabled: false, onboarded: true,
}
const noProjectFilter: ProjectFilter = { project: [], exclude: [] }
const projectsReport: ProjectsReport = {
  projects: [
    { name: 'my-company', path: '/Users/x/Web/work/my-company', cost: 28.09, sessions: 16 },
    { name: 'shop-ops', path: '/Users/x/ecommerce/shop-ops', cost: 4.2, sessions: 3 },
  ],
}
const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() { return stored.size },
  clear: () => stored.clear(),
})

describe('Settings', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.getIdentity.mockResolvedValue(identity)
    mocks.getDevices.mockResolvedValue(devices)
    mocks.getDevicesScan.mockResolvedValue(scan)
    mocks.getShareStatus.mockResolvedValue({ sharing: true, name: 'Studio MacBook Pro', port: 9732, always: false, peers: 1, pending: [] })
    mocks.getQuota.mockResolvedValue(quotaProviders)
    mocks.getPlans.mockResolvedValue({ currency: 'EUR', today: { cost: 0, savings: 0, calls: 0 }, month: { cost: 0, savings: 0, calls: 0 }, plans: { claude: { id: 'claude-max', provider: 'claude', budget: 200, spent: 48, percentUsed: 24, status: 'under', projectedMonthEnd: 120, daysUntilReset: 19, periodStart: '2026-07-01', periodEnd: '2026-08-01' } } })
    mocks.getOverview.mockResolvedValue(overview)
    mocks.getAliases.mockResolvedValue([{ from: 'proxy-opus', to: 'claude-opus-4-6' }])
    mocks.getPriceOverrides.mockResolvedValue({ overrides: [{ model: 'local/llama', inputPerM: 0.2, outputPerM: 0.6, cacheReadPerM: 0.05 }], configPath: '/home/user/.config/codeburn/config.json' })
    mocks.setPriceOverride.mockResolvedValue(actionOk)
    mocks.getProjectFilter.mockResolvedValue(noProjectFilter)
    mocks.setProjectFilter.mockImplementation(async filter => filter)
    mocks.getUnfilteredProjects.mockResolvedValue(projectsReport)
    mocks.removePriceOverride.mockResolvedValue(actionOk)
    mocks.setCurrency.mockResolvedValue(actionOk)
    mocks.resetCurrency.mockResolvedValue(actionOk)
    mocks.addAlias.mockResolvedValue(actionOk)
    mocks.removeAlias.mockResolvedValue(actionOk)
    mocks.removeDevice.mockResolvedValue(actionOk)
    mocks.setPlan.mockResolvedValue(actionOk)
    mocks.resetPlan.mockResolvedValue(actionOk)
    mocks.chooseDirectory.mockResolvedValue('/Users/x/Exports')
    mocks.exportData.mockResolvedValue(actionOk)
    mocks.telemetryTrack.mockResolvedValue(true)
    mocks.telemetryStatus.mockResolvedValue(telemetryOff)
    mocks.setTelemetryEnabled.mockImplementation(async enabled => ({ ...telemetryOff, enabled }))
    // No bundled tray app unless a test says otherwise, which is every platform but Windows.
    mocks.companionStatus.mockResolvedValue({ supported: false, menuBar: false, sidebar: false, store: false })
    mocks.trayPrefs.mockResolvedValue(trayPrefs)
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('hides a project by saving it as an exclude pattern', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    const toggle = await screen.findByRole('switch', { name: 'Show /Users/x/Web/work/my-company' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(mocks.setProjectFilter).toHaveBeenCalledWith({ project: [], exclude: ['/Users/x/Web/work/my-company'] })
  })

  it('shows a project as hidden when an include list leaves it out, and clears that list on Show all', async () => {
    mocks.getProjectFilter.mockResolvedValue({ project: ['my-company'], exclude: [] })
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    expect(await screen.findByRole('switch', { name: 'Show /Users/x/ecommerce/shop-ops' })).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    expect(mocks.setProjectFilter).toHaveBeenCalledWith({ project: [], exclude: [] })
  })

  it('lists the projects unfiltered so a hidden one can be switched back on', async () => {
    mocks.getProjectFilter.mockResolvedValue({ project: [], exclude: ['my-company'] })
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    const toggle = await screen.findByRole('switch', { name: 'Show /Users/x/Web/work/my-company' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(mocks.setProjectFilter).toHaveBeenCalledWith({ project: [], exclude: [] })
  })

  it('hides a project whose name starts with a dash, by its path', async () => {
    mocks.getUnfilteredProjects.mockResolvedValue({ projects: [{ name: '-Users-x-Web-Github-notes-app', path: '/Users/x/Web/Github/notes-app', cost: 219.35, sessions: 19 }] })
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    // The row reads as the directory, not as the encoded transcript folder name,
    // and keeps its parent so two projects of the same name stay distinguishable.
    expect(await screen.findByText('Github/notes-app')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Show /Users/x/Web/Github/notes-app' }))
    expect(mocks.setProjectFilter).toHaveBeenCalledWith({ project: [], exclude: ['/Users/x/Web/Github/notes-app'] })
  })

  it('keeps an exclude pattern that matches nothing removable', async () => {
    mocks.getProjectFilter.mockResolvedValue({ project: [], exclude: ['gone-repo'] })
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    expect(await screen.findByText('matches nothing detected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mocks.setProjectFilter).toHaveBeenCalledWith({ project: [], exclude: [] })
  })

  // A filter has no period, so neither can the list it is checked against. The
  // period on screen used to key this fetch, which made a pattern excluding a
  // dormant project read as an orphan next to a Remove button.
  it('asks for one project list for the whole history, not one per period on screen', async () => {
    const user = userEvent.setup()
    render(<Settings period="today" />)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    await screen.findByRole('switch', { name: 'Show /Users/x/Web/work/my-company' })
    expect(mocks.getUnfilteredProjects).toHaveBeenCalledWith()
  })

  it('keeps the project list across a period change instead of refetching it', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Settings period="today" />)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    await screen.findByRole('switch', { name: 'Show /Users/x/Web/work/my-company' })
    expect(mocks.getUnfilteredProjects).toHaveBeenCalledTimes(1)
    rerender(<Settings period="month" />)
    expect(await screen.findByRole('switch', { name: 'Show /Users/x/Web/work/my-company' })).toBeInTheDocument()
    expect(mocks.getUnfilteredProjects).toHaveBeenCalledTimes(1)
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

  it('reports settings, plan and export interactions as name-only events', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)

    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(mocks.telemetryTrack).toHaveBeenCalledWith('settings_change', { setting: 'theme', value: 'dark' })

    await user.click(await screen.findByLabelText('Currency'))
    await user.click(screen.getByRole('option', { name: 'CNY' }))
    expect(mocks.telemetryTrack).toHaveBeenCalledWith('settings_change', { setting: 'currency', value: 'CNY' })

    await user.click(screen.getByRole('button', { name: 'Plans' }))
    await user.click(await screen.findByLabelText('Add a plan'))
    await user.click(screen.getByRole('option', { name: 'Cursor Pro' }))
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(mocks.telemetryTrack).toHaveBeenCalledWith('plan_set', { provider: 'cursor', plan: 'cursor-pro' })

    await user.click(screen.getAllByRole('button', { name: 'Export' }).at(-1)!)
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await screen.findByText('/Users/x/Exports')
    await user.click(screen.getByRole('button', { name: 'JSON' }))
    await user.click(screen.getAllByRole('button', { name: 'Export' }).at(-1)!)
    expect(mocks.telemetryTrack).toHaveBeenCalledWith('export', { format: 'json', provider: 'all' })

    // The chosen folder is a real path on this machine and never travels.
    const sent = JSON.stringify(mocks.telemetryTrack.mock.calls)
    expect(sent).not.toContain('/Users/x')
  })

  // The main process drops any event raised while telemetry is off, so an opt-in tracked
  // before the write lands is one that can never be sent. It goes out after the toggle takes.
  it('reports the telemetry opt-in only once the toggle has taken', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }))

    await user.click(await screen.findByRole('switch', { name: 'Anonymous telemetry' }))

    expect(mocks.setTelemetryEnabled).toHaveBeenCalledWith(true)
    await waitFor(() => {
      expect(mocks.telemetryTrack).toHaveBeenCalledWith('settings_change', { setting: 'telemetry', value: true })
    })
    const tracked = mocks.telemetryTrack.mock.invocationCallOrder.at(-1)!
    expect(tracked).toBeGreaterThan(mocks.setTelemetryEnabled.mock.invocationCallOrder[0]!)
  })

  it('sends nothing when the write does not take, and nothing on the way out', async () => {
    const user = userEvent.setup()
    // A settings write that failed leaves telemetry off, so there is no opt-in to report.
    mocks.setTelemetryEnabled.mockResolvedValue(telemetryOff)
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }))
    await user.click(await screen.findByRole('switch', { name: 'Anonymous telemetry' }))
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenCalled())

    // Turning it off mints a fresh install id and drops the queue, so an opt-out event would
    // never arrive anywhere either.
    mocks.telemetryStatus.mockResolvedValue({ ...telemetryOff, enabled: true })
    mocks.setTelemetryEnabled.mockResolvedValue(telemetryOff)
    render(<Settings period="month" />)
    await user.click(screen.getAllByRole('button', { name: 'Privacy & data' }).at(-1)!)
    await user.click((await screen.findAllByRole('switch', { name: 'Anonymous telemetry' })).at(-1)!)
    await waitFor(() => expect(mocks.setTelemetryEnabled).toHaveBeenCalledWith(false))

    const telemetryEvents = mocks.telemetryTrack.mock.calls.filter(([, props]) => props?.setting === 'telemetry')
    expect(telemetryEvents).toEqual([])
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

  it('discloses and clears local report snapshots without deleting preferences', async () => {
    stored.set('codeburn.reportSnapshot.v1.sessions|today|all|-||2026-08-28', '{"at":1}')
    stored.set('codeburn.overview-headlines.v2', '{}')
    stored.set('codeburn.theme', 'dark')
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Privacy & data' }))
    expect(screen.getByText('Local report snapshots')).toBeInTheDocument()
    expect(screen.getByText(/Calculated usage and cost reports/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear snapshots' }))
    expect([...stored.keys()].some(key => key.startsWith('codeburn.reportSnapshot.v1.'))).toBe(false)
    expect(stored.has('codeburn.overview-headlines.v2')).toBe(false)
    expect(stored.get('codeburn.theme')).toBe('dark')
    expect(await screen.findByText('Cached report snapshots cleared')).toBeInTheDocument()
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

  it('reflects the current scope and reports a change through onScopeChange', async () => {
    const user = userEvent.setup()
    const onScopeChange = vi.fn()
    render(<Settings period="month" scope="local" onScopeChange={onScopeChange} />)
    const scope = screen.getByLabelText('Scope')
    expect(scope).toHaveTextContent('Local')
    await user.click(scope)
    await user.click(screen.getByRole('option', { name: 'Combined' }))
    expect(onScopeChange).toHaveBeenCalledWith('combined')
  })

  it('offers Local only while a project filter hides something, and says why', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" scope="local" onScopeChange={vi.fn()} projectFiltered />)
    const scope = screen.getByLabelText('Scope')
    expect(screen.getByText(/Local only while the Projects pane hides something/)).toBeInTheDocument()
    await user.click(scope)
    expect(screen.queryByRole('option', { name: 'Combined' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Local' })).toBeInTheDocument()
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

  it('keys provider logos on the internal id from providerDetails', async () => {
    mocks.getOverview.mockResolvedValue({
      current: {
        providers: { 'grok build': 8.1, apex: 2.2 },
        providerDetails: [
          { id: 'grok', label: 'Grok Build', cost: 8.1 },
          { id: 'apex', label: 'Apex', cost: 2.2 },
        ],
      },
    } as unknown as MenubarPayload)
    const user = userEvent.setup()
    const { container } = render(<Settings period="week" />)
    await user.click(screen.getByRole('button', { name: 'Providers' }))

    // grok has a themed mark, keyed on the internal id, so a real image renders.
    const grokRow = (await screen.findByText('Grok Build')).closest('.set-prov-head')!
    expect(grokRow.querySelector('img.provider-logo')).toBeInTheDocument()
    expect(grokRow.querySelector('.provider-mono')).toBeNull()

    // an unknown provider still renders a monogram badge, never nothing.
    const apexRow = screen.getByText('Apex').closest('.set-prov-head')!
    expect(apexRow.querySelector('span.provider-mono')).toHaveTextContent('A')
    expect(container.querySelector('.set-prov-head img[src="grok build"]')).toBeNull()
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
    expect(screen.getByText('Not connected. Log in with the Codex CLI.')).toBeInTheDocument()
    expect(mocks.getQuota).toHaveBeenCalledWith(false, [])
  })

  it('expands the DetectedRow Connect affordance and forces a keychain refresh', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Plans' }))
    await screen.findByText('Detected subscriptions')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByText('codex login')).toBeInTheDocument()
    mocks.getQuota.mockClear()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(mocks.getQuota).toHaveBeenCalledWith(true, []))
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
    expect(await screen.findByText('/Users/x/Exports')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'JSON' }))
    await user.click(screen.getByLabelText('Provider'))
    await user.click(screen.getByRole('option', { name: 'Claude' }))
    await user.click(screen.getAllByRole('button', { name: 'Export' }).at(-1)!)
    expect(mocks.exportData).toHaveBeenCalledWith('json', 'claude', '/Users/x/Exports')
    expect(await screen.findByText('Exported to /Users/x/Exports')).toBeInTheDocument()
  })

  it('renders real device status and removes paired devices without fake pairing controls', async () => {
    const user = userEvent.setup()
    render(<Settings period="month" />)
    await user.click(screen.getByRole('button', { name: 'Devices' }))
    expect(await screen.findByText('Studio MacBook Pro')).toBeInTheDocument()
    expect(screen.getByText('Local device name: Studio MacBook Pro')).toBeInTheDocument()
    expect(await screen.findByText('Mac Studio')).toBeInTheDocument()
    expect(screen.getByText('fingerprint 7F:2A:…:C4')).toBeInTheDocument()
    expect(await screen.findByText('studio-mini')).toBeInTheDocument()
    expect(screen.getByText('34 sessions · $41.20 this month')).toBeInTheDocument()
    expect(screen.getByText('Visible')).toBeInTheDocument()
    expect(screen.getByText(/Pairing is interactive/)).toBeInTheDocument()
    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
    expect(screen.queryByText('Pull now')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(mocks.removeDevice).toHaveBeenCalledWith('studio-mini')
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

  // The tray app has settings of its own, and they only exist while it does. Each pane is
  // shown only while its switch in the sidebar corner is on.
  it("offers no tray panes where there is no bundled tray app", async () => {
    render(<Settings period="month" />)
    await waitFor(() => expect(mocks.companionStatus).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: "Menu bar" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Capacity Dock" })).toBeNull()
  })

  it("offers both tray panes while both switches are on", async () => {
    mocks.companionStatus.mockResolvedValue({ supported: true, menuBar: true, sidebar: true, store: false })
    const user = userEvent.setup()
    render(<Settings period="month" />)

    await user.click(await screen.findByRole("button", { name: "Menu bar" }))
    expect(await screen.findByRole("heading", { name: "Menu bar" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Capacity Dock" }))
    expect(await screen.findByRole("heading", { name: "Capacity Dock" })).toBeInTheDocument()
  })

  it("drops the Capacity Dock pane when the Sidebar switch is off", async () => {
    mocks.companionStatus.mockResolvedValue({ supported: true, menuBar: true, sidebar: false, store: false })
    render(<Settings period="month" />)

    expect(await screen.findByRole("button", { name: "Menu bar" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Capacity Dock" })).toBeNull()
  })
})
