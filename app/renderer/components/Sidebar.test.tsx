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

// This jsdom setup ships no Storage, and the sidebar's collapsed state is read
// from one at first render.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
  clear: () => store.clear(),
})

function setPlatform(platform: string): void {
  ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform }
}

describe('Sidebar', () => {
  beforeEach(() => {
    bridge.companionStatus.mockResolvedValue({ supported: false, menuBar: false, sidebar: false, store: false })
  })

  afterEach(() => {
    delete (window as unknown as { codeburn?: { platform?: string } }).codeburn
    store.clear()
    vi.clearAllMocks()
  })

  it.each([
    ['darwin', '⌘'],
    ['win32', 'Ctrl+'],
  ] as const)('renders every nav item in its group with %s keycaps', (platform, mod) => {
    setPlatform(platform)
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)
    const labels = [...container.querySelectorAll('.ni')].map(item => item.textContent)
    expect(labels).toEqual(['Overview', 'Sessions', 'Pull requests', 'Spend', 'Models', 'Optimize', 'Compare', 'Compare periods', 'Plans', 'Plugins', 'Settings'])
    const tip = (label: string) => [...container.querySelectorAll('.ni')].find(item => item.textContent === label)?.getAttribute('title')
    expect(tip('Sessions')).toBe(`Sessions ${mod}2`)
    expect(tip('Pull requests')).toBe(`Pull requests ${mod}3`)
    expect(tip('Compare')).toBe(`Compare ${mod}7`)
    expect(tip('Plans')).toBe(`Plans ${mod}8`)
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

  it('renders the wordmark as animated text with no flame image', () => {
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)
    const mark = container.querySelector('.app b')
    expect(mark).toHaveClass('flame-text')
    expect(mark).toHaveTextContent('CodeBurn')
    expect(container.querySelector('.app img')).toBeNull()
  })

  it('groups the nav under muted section labels', () => {
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)
    expect([...container.querySelectorAll('.grp-label')].map(el => el.textContent)).toEqual(['Usage', 'Insight', 'Account'])
  })

  it('keeps the shortcut on the row tooltip rather than a chip in the row', () => {
    setPlatform('darwin')
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)

    expect(container.querySelector('.ni .k')).toBeNull()
    const spend = [...container.querySelectorAll('.ni')].find(item => item.textContent === 'Spend')
    expect(spend).toHaveAttribute('title', 'Spend ⌘4')
    expect(spend).toHaveAttribute('data-tip', 'Spend ⌘4')
  })

  it('carries About and the version in the corner, with the links in the modal', async () => {
    setPlatform('darwin')
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)

    const about = screen.getByRole('link', { name: /About/ })
    expect(about).toHaveTextContent(/^Aboutv\d+\.\d+\.\d+$/)
    expect(container.querySelector('.foot .social')).toBeNull()

    fireEvent.click(about)
    expect(await screen.findByRole('link', { name: /GitHub/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /LinkedIn/ })).toBeInTheDocument()
  })

  it('collapses to a rail, remembers it, and still navigates by icon', () => {
    const onNavigate = vi.fn()
    const { container, unmount } = render(<Sidebar active="overview" onNavigate={onNavigate} />)
    const nav = container.querySelector('.sb')

    expect(nav).not.toHaveClass('collapsed')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(nav).toHaveClass('collapsed')
    expect(localStorage.getItem('codeburn.sidebarCollapsed')).toBe('1')

    // The label never leaves the DOM, so the row keeps its name on the rail.
    fireEvent.click(screen.getByRole('button', { name: /Spend/ }))
    expect(onNavigate).toHaveBeenCalledWith('spend')

    unmount()
    render(<Sidebar active="overview" onNavigate={() => {}} />)
    expect(document.querySelector('.sb')).toHaveClass('collapsed')
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it.each([
    ['darwin', { metaKey: true }],
    ['win32', { ctrlKey: true }],
  ] as const)('toggles the rail with the %s modifier chord and B', (platform, chord) => {
    setPlatform(platform)
    const { container } = render(<Sidebar active="overview" onNavigate={() => {}} />)
    const nav = container.querySelector('.sb')

    fireEvent.keyDown(window, { key: 'b', ...chord })
    expect(nav).toHaveClass('collapsed')
    fireEvent.keyDown(window, { key: 'b', ...chord })
    expect(nav).not.toHaveClass('collapsed')
  })

  it('keeps the companion switches above About on Windows', async () => {
    setPlatform('win32')
    bridge.companionStatus.mockResolvedValue({ supported: true, menuBar: true, sidebar: true, store: false })
    render(<Sidebar active="overview" onNavigate={() => {}} />)

    expect(await screen.findByRole('switch', { name: 'Menu bar' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /About/ })).toBeInTheDocument()
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
