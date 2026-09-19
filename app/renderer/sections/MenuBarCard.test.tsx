// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MENUBAR_QUOTA_PROVIDERS } from '../lib/menubarProviders'
import type { MacMenubarStatus } from '../lib/types'

const bridge = vi.hoisted(() => ({
  macMenubarStatus: vi.fn(),
  macMenubarInstall: vi.fn(),
  macMenubarOpen: vi.fn(),
  macMenubarSetDock: vi.fn(),
  macMenubarQuit: vi.fn(),
  macMenubarSettings: vi.fn(),
  onMacMenubarProgress: vi.fn((_cb: (phase: string) => void) => () => {}),
  macMenubarUninstall: vi.fn(),
  openExternal: vi.fn(),
  pluginList: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ codeburn: bridge, normalizeCliError: (err: unknown) => err }))

const { MenuBarCard } = await import('./MenuBarCard')
const { PluginsSection } = await import('./Plugins')

function status(patch: Partial<MacMenubarStatus> = {}): MacMenubarStatus {
  return {
    supported: true, canInstall: true, installed: false,
    path: null, version: null, running: false, dock: false, outdated: false, ...patch,
  }
}

beforeEach(() => {
  vi.useRealTimers()
})

/** The destructive actions are icon buttons: the first click arms one (its label flips to
 *  "Confirm …"), a second carries it out. This does both clicks. */
async function confirmAction(label: 'Quit' | 'Uninstall'): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: label }))
  await userEvent.click(await screen.findByRole('button', { name: `Confirm ${label.toLowerCase()}` }))
}

afterEach(() => {
  delete (window as unknown as { codeburn?: unknown }).codeburn
  vi.clearAllMocks()
})

describe('MenuBarCard states', () => {
  it('not installed: offers Install and no version, dot or switch', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status())
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy())
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('shows the whole description, not a clipped line', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status())
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByText("Spend and quotas in your Mac's menu bar.")).toBeTruthy())
  })

  it('installed but not running: Open plus the version, switch disabled', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, path: '/Applications/CodeBurnMenubar.app', version: '0.9.18' }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy())
    expect(screen.getByText('v0.9.18')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  })

  it('running: the green dot, the version and a live Capacity Dock switch', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true, dock: true }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy())
    const dock = screen.getByRole('switch')
    expect(dock.getAttribute('aria-checked')).toBe('true')
    expect(dock).toHaveProperty('disabled', false)
  })

  it('App Store build: the website line instead of an Install button', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ canInstall: false }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByText('Get the menu bar from the website')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('renders nothing when the main process says the platform is not supported', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ supported: false, canInstall: false }))
    const { container } = render(<MenuBarCard />)
    await waitFor(() => expect(bridge.macMenubarStatus).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})

describe('MenuBarCard actions', () => {
  it('installs and shows what came back, not what it asked for', async () => {
    // The poll is the authority, so it moves with the install rather than lagging it.
    let current = status()
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarInstall.mockImplementation(async () => {
      current = status({ installed: true, version: '1.0.0', running: true })
      return { ok: true, error: null, status: current }
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy())
    expect(screen.getByText('v1.0.0')).toBeTruthy()
  })

  it('shows a failed install in plain words and keeps the Install button', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status())
    bridge.macMenubarInstall.mockResolvedValue({
      ok: false, error: 'No connection to github.com. Try again when you are back online.', status: status(),
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(screen.getByText('No connection to github.com. Try again when you are back online.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('Open asks the main process to start it, and only while it is down', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: false }))
    bridge.macMenubarOpen.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(bridge.macMenubarOpen).toHaveBeenCalledTimes(1)
  })

  it('the switch sends the opposite of what is showing and renders the answer', async () => {
    let current = status({ installed: true, running: true, dock: false })
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarSetDock.mockImplementation(async (enabled: boolean) => {
      current = status({ installed: true, running: true, dock: enabled })
      return current
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('switch'))
    expect(bridge.macMenubarSetDock).toHaveBeenCalledWith(true)
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
  })

  it('polls while mounted and stops when the card goes away', async () => {
    vi.useFakeTimers()
    bridge.macMenubarStatus.mockResolvedValue(status())
    const view = render(<MenuBarCard />)
    await vi.advanceTimersByTimeAsync(9000)
    const polled = bridge.macMenubarStatus.mock.calls.length
    expect(polled).toBeGreaterThan(1)
    view.unmount()
    await vi.advanceTimersByTimeAsync(20000)
    expect(bridge.macMenubarStatus.mock.calls.length).toBe(polled)
    vi.useRealTimers()
  })

  it('does not re-render on a poll that says the same thing', async () => {
    vi.useFakeTimers()
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0' }))
    render(<MenuBarCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const before = screen.getByText('v1.0.0')
    // Three more polls, all answering the same thing: the node is the very same node.
    await act(async () => { await vi.advanceTimersByTimeAsync(13000) })
    expect(screen.getByText('v1.0.0')).toBe(before)
    vi.useRealTimers()
  })
})

describe('MenuBarCard quit and uninstall', () => {
  it('running: Settings, Quit and Uninstall as icon buttons; not running: Open and Uninstall, no Quit', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    const view = render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quit' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    view.unmount()

    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: false }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
  })

  it('one click arms a destructive icon, a second carries it out', async () => {
    let current = status({ installed: true, version: '1.0.0', running: true })
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarQuit.mockImplementation(async () => {
      current = status({ installed: true, version: '1.0.0', running: false })
      return { ok: true, error: null, status: current }
    })
    render(<MenuBarCard />)
    // First click arms it: the label flips, the action has not fired, siblings stay.
    await userEvent.click(await screen.findByRole('button', { name: 'Quit' }))
    expect(bridge.macMenubarQuit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm quit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
    // Second click confirms.
    await userEvent.click(screen.getByRole('button', { name: 'Confirm quit' }))
    expect(bridge.macMenubarQuit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Running')).toBeNull())
  })

  it('moving focus away disarms a primed icon without acting', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    expect(screen.getByRole('button', { name: 'Confirm uninstall' })).toBeTruthy()
    // Focus the Settings icon: the primed Uninstall reverts and nothing was removed.
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Confirm uninstall' })).toBeNull()
    expect(bridge.macMenubarUninstall).not.toHaveBeenCalled()
  })

  it('Uninstall returns the card to Not installed', async () => {
    let current = status({ installed: true, version: '1.0.0', running: true })
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarUninstall.mockImplementation(async () => {
      current = status()
      return { ok: true, error: null, status: current }
    })
    render(<MenuBarCard />)
    await confirmAction('Uninstall')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy())
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('a failed uninstall says so in plain words and leaves the card as it is', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    bridge.macMenubarUninstall.mockResolvedValue({
      ok: false,
      error: 'CodeBurn could not remove the menu bar app. Check its permissions in Finder.',
      status: status({ installed: true, version: '1.0.0', running: true }),
    })
    render(<MenuBarCard />)
    await confirmAction('Uninstall')
    await waitFor(() => expect(screen.getByText('CodeBurn could not remove the menu bar app. Check its permissions in Finder.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
  })
})

describe('MenuBarCard with an outdated menubar', () => {
  const OLD = status({ installed: true, version: '0.9.18', running: true, dock: true, outdated: true })

  it('offers Update and refuses to drive what it cannot ask', async () => {
    bridge.macMenubarStatus.mockResolvedValue(OLD)
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy())
    expect(screen.getByText('Update the menu bar to use this')).toBeTruthy()
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Quit' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Uninstall' })).toHaveProperty('disabled', true)
  })

  it('Update reinstalls and the card comes back current', async () => {
    let current = OLD
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarInstall.mockImplementation(async () => {
      current = status({ installed: true, version: '0.9.24', running: true, dock: true })
      return { ok: true, error: null, status: current }
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }))
    expect(bridge.macMenubarInstall).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Update' })).toBeNull())
    expect(screen.getByRole('switch')).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Quit' })).toHaveProperty('disabled', false)
  })

  it('an App Store build has no Update button either, only the line', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ ...OLD, canInstall: false }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByText('Update the menu bar to use this')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
  })
})

describe('MenuBarCard progress and timeouts', () => {
  it('names each install step as the main process reports it', async () => {
    let push: ((phase: string) => void) | null = null
    bridge.onMacMenubarProgress.mockImplementation((cb: (phase: string) => void) => { push = cb; return () => { push = null } })
    let current = status()
    bridge.macMenubarStatus.mockImplementation(async () => current)
    let settle: (() => void) | null = null
    bridge.macMenubarInstall.mockImplementation(() => new Promise(resolve => {
      settle = () => {
        current = status({ installed: true, version: '0.9.25', running: true })
        resolve({ ok: true, error: null, status: current })
      }
    }))
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    // Until the first phase arrives the button names the action itself.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Installing…' })).toBeTruthy())
    for (const phase of ['Downloading', 'Verifying', 'Installing', 'Starting']) {
      act(() => push!(phase))
      expect(screen.getByRole('button', { name: `${phase}…` })).toBeTruthy()
    }
    await act(async () => { settle!() })
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy())
  })

  it('an install that lands an older release shows the outdated state, not Running', async () => {
    let current = status()
    bridge.macMenubarStatus.mockImplementation(async () => current)
    bridge.macMenubarInstall.mockImplementation(async () => {
      current = status({ installed: true, version: '0.9.24', running: true, outdated: true })
      return { ok: true, error: null, status: current }
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy())
    expect(screen.getByText('Update the menu bar to use this')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Quit' })).toHaveProperty('disabled', true)
  })

  it('a Quit nobody answered says so and leaves the card running', async () => {
    const running = status({ installed: true, version: '0.9.24', running: true })
    bridge.macMenubarStatus.mockResolvedValue(running)
    bridge.macMenubarQuit.mockResolvedValue({
      ok: false, error: 'The menu bar app did not respond. Update it and try again.', status: running,
    })
    render(<MenuBarCard />)
    await confirmAction('Quit')
    await waitFor(() => expect(screen.getByText('The menu bar app did not respond. Update it and try again.')).toBeTruthy())
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Quit' })).toBeTruthy()
  })

  it('an Uninstall nobody answered says the same and keeps the bundle', async () => {
    const running = status({ installed: true, version: '0.9.24', running: true })
    bridge.macMenubarStatus.mockResolvedValue(running)
    bridge.macMenubarUninstall.mockResolvedValue({
      ok: false, error: 'The menu bar app did not respond. Update it and try again.', status: running,
    })
    render(<MenuBarCard />)
    await confirmAction('Uninstall')
    await waitFor(() => expect(screen.getByText('The menu bar app did not respond. Update it and try again.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy()
  })
})

describe('MenuBarCard settings and the info modal', () => {
  it('running: Settings shows and Open does not', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('not running: Open comes back', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: false }))
    render(<MenuBarCard />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy())
  })

  it('Settings asks the menubar to open its own Settings window', async () => {
    const running = status({ installed: true, version: '1.0.0', running: true })
    bridge.macMenubarStatus.mockResolvedValue(running)
    bridge.macMenubarSettings.mockResolvedValue({ ok: true, error: null, status: running })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(bridge.macMenubarSettings).toHaveBeenCalledTimes(1)
  })

  it('a Settings nobody answered says so in the card', async () => {
    const running = status({ installed: true, version: '1.0.0', running: true })
    bridge.macMenubarStatus.mockResolvedValue(running)
    bridge.macMenubarSettings.mockResolvedValue({
      ok: false, error: 'The menu bar app did not respond. Update it and try again.', status: running,
    })
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(screen.getByText('The menu bar app did not respond. Update it and try again.')).toBeTruthy())
  })

  it('the info dot opens a modal with both columns and the real provider list', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    render(<MenuBarCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'What the menu bar app does' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Menu bar' })).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: 'Capacity Dock' })).toBeTruthy()
    // The names come from the menubar's own catalog, never from copy written here.
    expect(within(dialog).getAllByText(MENUBAR_QUOTA_PROVIDERS.join(', ')).length).toBe(2)
  })

  it('the modal closes on the close button, on the backdrop and on Escape', async () => {
    bridge.macMenubarStatus.mockResolvedValue(status({ installed: true, version: '1.0.0', running: true }))
    render(<MenuBarCard />)
    const dot = await screen.findByRole('button', { name: 'What the menu bar app does' })

    await userEvent.click(dot)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(dot)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await userEvent.click(dot)
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(dialog.parentElement!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('the Plugins page', () => {
  it('renders the card on darwin', async () => {
    ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform: 'darwin' }
    bridge.pluginList.mockResolvedValue([])
    bridge.macMenubarStatus.mockResolvedValue(status())
    render(<PluginsSection />)
    await waitFor(() => expect(screen.getByText('Menu bar')).toBeTruthy())
  })

  it('renders no card on linux', async () => {
    ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform: 'linux' }
    bridge.pluginList.mockResolvedValue([])
    bridge.macMenubarStatus.mockResolvedValue(status())
    render(<PluginsSection />)
    await waitFor(() => expect(screen.getByText('Coming soon')).toBeTruthy())
    expect(screen.queryByText('Menu bar')).toBeNull()
    expect(bridge.macMenubarStatus).not.toHaveBeenCalled()
  })

  it('renders no card on win32, where the page is its own coming-soon panel', async () => {
    ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform: 'win32' }
    bridge.pluginList.mockResolvedValue([])
    render(<PluginsSection />)
    await waitFor(() => expect(screen.getByText('Plugins are coming to Windows')).toBeTruthy())
    expect(screen.queryByText('Menu bar')).toBeNull()
    expect(bridge.macMenubarStatus).not.toHaveBeenCalled()
  })
})

describe('the Teams card', () => {
  beforeEach(() => {
    ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform: 'darwin' }
    bridge.pluginList.mockResolvedValue([])
    bridge.macMenubarStatus.mockResolvedValue(status())
  })

  it('opens a Teams modal from its info button and closes it on Escape', async () => {
    render(<PluginsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'What Teams will do' }))
    const dialog = await screen.findByRole('dialog', { name: 'Teams' })
    expect(within(dialog).getByText(/shared team dashboard/i)).toBeTruthy()
    expect(within(dialog).getByText(/never your code or prompts/i)).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens the beta signup URL through the external opener', async () => {
    render(<PluginsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Register for beta testing' }))
    expect(bridge.openExternal).toHaveBeenCalledWith('https://codeburn.app/teams')
  })
})
