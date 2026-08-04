// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { Sidebar } from './Sidebar'

function setPlatform(platform: string): void {
  ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform }
}

describe('Sidebar', () => {
  afterEach(() => {
    delete (window as unknown as { codeburn?: { platform?: string } }).codeburn
  })

  it.each([
    ['darwin', '⌘'],
    ['win32', 'Ctrl+'],
  ] as const)('renders all nine nav items in the desktop order with %s keycaps', (platform, mod) => {
    setPlatform(platform)
    render(<Sidebar active="overview" onNavigate={() => {}} />)
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const labels = screen.getAllByRole('button').map(item => item.textContent?.replace(/(⌘|Ctrl\+)[\d,]/, ''))
    expect(labels).toEqual(['Overview', 'Sessions', 'Pull requests', 'Spend', 'Optimize', 'Models', 'Compare', 'Plans', 'Settings'])
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
})
