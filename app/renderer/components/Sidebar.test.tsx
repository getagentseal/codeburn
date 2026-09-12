// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { Sidebar } from './Sidebar'

// The preload bridge is read once at module load, so the switches need it mocked rather than
// assigned onto `window` after the fact.
const bridge = vi.hoisted(() => ({
  companionStatus: vi.fn(),
  setMenuBarEnabled: vi.fn(),
  setSidebarEnabled: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ codeburn: bridge, normalizeCliError: (err: unknown) => err }))

function setPlatform(platform: string): void {
  ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform }
}

describe('Sidebar', () => {
  beforeEach(() => {
    bridge.companionStatus.mockResolvedValue({ supported: false, menuBar: false, sidebar: false, store: false })
  })

  afterEach(() => {
    delete (window as unknown as { codeburn?: { platform?: string } }).codeburn
    vi.clearAllMocks()
  })

  it.each([
    ['darwin', '⌘'],
    ['win32', 'Ctrl+'],
  ] as const)('renders all nav items in the desktop order with %s keycaps', (platform, mod) => {
    setPlatform(platform)
    render(<Sidebar active="overview" onNavigate={() => {}} />)
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const labels = screen.getAllByRole('button').map(item => item.textContent?.replace(/(⌘|Ctrl\+)[\d,.]/, ''))
    expect(labels).toEqual(['Overview', 'Sessions', 'Pull requests', 'Spend', 'Optimize', 'Models', 'Compare', 'Compare periods', 'Plans', 'Settings', 'Plugins'])
    expect(screen.getByRole('button', { name: new RegExp(`Sessions.*${esc(mod)}2`) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(`Pull requests.*${esc(mod)}3`) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(`Compare.*${esc(mod)}7`) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(`Plans.*${esc(mod)}8`) })).toBeInTheDocument()
  })

  it('calls onNavigate with the section id when a nav item is clicked', () => {
    const onNavigate = vi.fn()
    render(<Sidebar active="overview" onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: /Spend/ }))
    expect(onNavigate).toHaveBeenCalledWith('spend')
  })

  it('marks the active item with the "on" class', () => {
    render(<Sidebar active="models" onNavigate={() => {}} />)
    expect(screen.getByRole('button', { name: /Models/ })).toHaveClass('on')
    expect(screen.getByRole('button', { name: /Overview/ })).not.toHaveClass('on')
  })

  it('renders the brand flame mark, static under the closed motion gate', () => {
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)
    const flame = container.querySelector('.app .flamemark')
    expect(flame?.tagName.toLowerCase()).toBe('img')
    // motionEnabled() is off under vitest, so the idle flicker never attaches.
    expect(container.querySelector('.fm-flicker')).toBeNull()
  })

  it('keeps About and the social glyphs in the corner off Windows', () => {
    setPlatform('darwin')
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)

    expect(screen.getByRole('link', { name: 'About' })).toBeInTheDocument()
    expect([...container.querySelectorAll('.foot .social a')].map(a => a.getAttribute('aria-label')))
      .toEqual(['GitHub', 'Discord', 'X', 'YouTube', 'LinkedIn'])
  })

  it('opens a glyph through the shell rather than navigating the window', () => {
    setPlatform('linux')
    render(<Sidebar active="overview" onNavigate={() => {}} />)

    fireEvent.click(screen.getByRole('link', { name: 'GitHub' }))

    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn')
  })

  // Windows is the one platform that gives that corner to something else: the two companion
  // switches sit above About, and a 186px sidebar has no room for both.
  it('gives the corner to the companion switches on Windows', async () => {
    setPlatform('win32')
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)

    expect(container.querySelector('.foot .social')).toBeNull()
    // About still lists every one of them under Links, on every platform.
    fireEvent.click(screen.getByRole('link', { name: 'About' }))
    expect(await screen.findByRole('link', { name: /GitHub/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /LinkedIn/ })).toBeInTheDocument()
  })
})

describe('Sidebar companion switches', () => {
  const SUPPORTED = { supported: true, menuBar: true, sidebar: true, store: false }

  afterEach(() => { vi.clearAllMocks() })

  async function renderSwitches(status = SUPPORTED) {
    bridge.companionStatus.mockResolvedValue(status)
    render(<Sidebar active="overview" onNavigate={() => {}} />)
    return screen.findByRole('switch', { name: 'Menu bar' })
  }

  it('shows nothing where the main process reports no bundled tray app', async () => {
    bridge.companionStatus.mockResolvedValue({ supported: false, menuBar: false, sidebar: false, store: false })
    render(<Sidebar active="overview" onNavigate={() => {}} />)

    await waitFor(() => expect(bridge.companionStatus).toHaveBeenCalled())
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('survives a preload that has never heard of them', async () => {
    bridge.companionStatus.mockRejectedValue(new Error('no such channel'))
    render(<Sidebar active="overview" onNavigate={() => {}} />)

    await waitFor(() => expect(bridge.companionStatus).toHaveBeenCalled())
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders both switches on, in the sidebar corner', async () => {
    const menuBar = await renderSwitches()

    expect(menuBar).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Sidebar' })).toHaveAttribute('aria-checked', 'true')
  })

  it('turning Menu bar off sends false and renders the status that came back', async () => {
    const menuBar = await renderSwitches()
    bridge.setMenuBarEnabled.mockResolvedValue({ ...SUPPORTED, menuBar: false })

    fireEvent.click(menuBar)

    expect(bridge.setMenuBarEnabled).toHaveBeenCalledWith(false)
    await waitFor(() => expect(menuBar).toHaveAttribute('aria-checked', 'false'))
    expect(screen.getByRole('switch', { name: 'Sidebar' })).toHaveAttribute('aria-checked', 'true')
  })

  it('turning Sidebar off leaves Menu bar alone', async () => {
    await renderSwitches()
    bridge.setSidebarEnabled.mockResolvedValue({ ...SUPPORTED, sidebar: false })

    fireEvent.click(screen.getByRole('switch', { name: 'Sidebar' }))

    expect(bridge.setSidebarEnabled).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Sidebar' })).toHaveAttribute('aria-checked', 'false'))
    expect(screen.getByRole('switch', { name: 'Menu bar' })).toHaveAttribute('aria-checked', 'true')
  })

  /// An install the person cancelled at the UAC prompt comes back unchanged, and the switch
  /// has to show that rather than the state it optimistically painted.
  it('stays where it was when the main process reports no change', async () => {
    const menuBar = await renderSwitches({ ...SUPPORTED, menuBar: false })
    bridge.setMenuBarEnabled.mockResolvedValue({ ...SUPPORTED, menuBar: false })

    fireEvent.click(menuBar)

    await waitFor(() => expect(bridge.setMenuBarEnabled).toHaveBeenCalledWith(true))
    expect(menuBar).toHaveAttribute('aria-checked', 'false')
  })

  // The rail is a window of the tray app, so it cannot be switched on without one.
  it('disables Sidebar while Menu bar is off, and says why', async () => {
    await renderSwitches({ ...SUPPORTED, menuBar: false, sidebar: false })

    const sidebar = screen.getByRole('switch', { name: 'Sidebar' })
    expect(sidebar).toBeDisabled()
    expect(sidebar).toHaveAttribute('title', 'The Capacity Dock needs the menu bar app')
    expect(screen.getByRole('switch', { name: 'Menu bar' })).toBeEnabled()

    fireEvent.click(sidebar)
    expect(bridge.setSidebarEnabled).not.toHaveBeenCalled()
  })

  it('enables Sidebar again once Menu bar comes back on', async () => {
    const menuBar = await renderSwitches({ ...SUPPORTED, menuBar: false, sidebar: false })
    expect(screen.getByRole('switch', { name: 'Sidebar' })).toBeDisabled()
    bridge.setMenuBarEnabled.mockResolvedValue({ ...SUPPORTED, menuBar: true, sidebar: false })

    fireEvent.click(menuBar)

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Sidebar' })).toBeEnabled())
  })

  it('turning Menu bar off takes Sidebar down with it', async () => {
    const menuBar = await renderSwitches()
    bridge.setMenuBarEnabled.mockResolvedValue({ ...SUPPORTED, menuBar: false, sidebar: false })

    fireEvent.click(menuBar)

    await waitFor(() => expect(menuBar).toHaveAttribute('aria-checked', 'false'))
    const sidebar = screen.getByRole('switch', { name: 'Sidebar' })
    expect(sidebar).toHaveAttribute('aria-checked', 'false')
    expect(sidebar).toBeDisabled()
  })

  it('refuses a second click while one is still in flight', async () => {
    const menuBar = await renderSwitches()
    bridge.setMenuBarEnabled.mockReturnValue(new Promise(() => {}))

    fireEvent.click(menuBar)
    fireEvent.click(screen.getByRole('switch', { name: 'Sidebar' }))

    expect(bridge.setMenuBarEnabled).toHaveBeenCalledTimes(1)
    expect(bridge.setSidebarEnabled).not.toHaveBeenCalled()
  })
})
