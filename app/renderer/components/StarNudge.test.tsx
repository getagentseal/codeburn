// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { countLaunch, StarNudge } from './StarNudge'

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
})

function launch(times: number) {
  for (let i = 0; i < times; i++) countLaunch()
}

describe('StarNudge', () => {
  beforeEach(() => {
    stored.clear()
    mocks.openExternal.mockReset().mockResolvedValue(undefined)
  })

  it('stays hidden before the third launch', () => {
    launch(2)
    render(<StarNudge />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows from the third launch on, with the heading and one line above the buttons', () => {
    launch(3)
    render(<StarNudge />)
    const dialog = screen.getByRole('dialog', { name: 'Enjoying CodeBurn?' })
    expect(dialog).toHaveTextContent(/^Enjoying CodeBurn\?If it has been helping you, a star on GitHub would mean a lot\. It keeps the project free and open\.Not nowStar on GitHub$/)
  })

  it('Star on GitHub opens the repo and never shows again', () => {
    launch(3)
    const { unmount } = render(<StarNudge />)
    fireEvent.click(screen.getByRole('button', { name: 'Star on GitHub' }))
    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(stored.get('codeburn.starNudgeDone')).toBe('1')
    unmount()
    launch(1)
    render(<StarNudge />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Not now hides it for good without opening anything', () => {
    launch(3)
    const { unmount } = render(<StarNudge />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(stored.get('codeburn.starNudgeDone')).toBe('1')
    unmount()
    launch(1)
    render(<StarNudge />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['a backdrop click', () => fireEvent.click(screen.getByRole('dialog').parentElement!)],
  ])('%s closes it for this start only', (_label, act) => {
    launch(3)
    const { unmount } = render(<StarNudge />)
    act()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(stored.get('codeburn.starNudgeDone')).toBeUndefined()
    unmount()
    launch(1)
    render(<StarNudge />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('a click inside the dialog does not close it', () => {
    launch(3)
    render(<StarNudge />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(stored.get('codeburn.starNudgeDone')).toBeUndefined()
  })

  it('shows again on the next launch when ignored', () => {
    launch(3)
    const { unmount } = render(<StarNudge />)
    unmount()
    launch(1)
    render(<StarNudge />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
