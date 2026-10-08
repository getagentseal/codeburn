// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UpdateBanner } from './UpdateBanner'
import type { UpdateStatus } from '../lib/types'

const mocks = vi.hoisted(() => ({
  getUpdateStatus: vi.fn<() => Promise<UpdateStatus>>(),
  onUpdateStatus: vi.fn<(cb: (s: UpdateStatus) => void) => () => void>(() => () => {}),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  downloadUpdate: vi.fn<() => Promise<UpdateStatus>>(),
  installUpdate: vi.fn<() => Promise<void>>(),
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

const NEWER: UpdateStatus = { currentVersion: '0.9.16', latestVersion: '0.9.17', updateAvailable: true, tag: 'desktop-v0.9.17' }
const SAME: UpdateStatus = { currentVersion: '0.9.16', latestVersion: '0.9.16', updateAvailable: false, tag: null }

describe('UpdateBanner', () => {
  beforeEach(() => {
    stored.clear()
    mocks.getUpdateStatus.mockReset()
    mocks.openExternal.mockReset().mockResolvedValue(undefined)
    mocks.onUpdateStatus.mockReset().mockReturnValue(() => {})
  })

  it('renders on a newer version, and Download opens the release page', async () => {
    mocks.getUpdateStatus.mockResolvedValue(NEWER)
    render(<UpdateBanner />)

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Update available: CodeBurn 0.9.17')

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn/releases/tag/desktop-v0.9.17')
  })

  it('one-click: Update downloads, then Restart to update installs', async () => {
    let push: (s: UpdateStatus) => void = () => {}
    mocks.onUpdateStatus.mockImplementation(cb => { push = cb; return () => {} })
    mocks.getUpdateStatus.mockResolvedValue({ ...NEWER, install: 'available' })
    render(<UpdateBanner />)

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.openExternal).not.toHaveBeenCalled()

    act(() => push({ ...NEWER, install: 'downloading' }))
    expect(screen.getByRole('status')).toHaveTextContent('Downloading update…')
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()

    act(() => push({ ...NEWER, install: 'ready' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(mocks.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not render when the running version is current', async () => {
    mocks.getUpdateStatus.mockResolvedValue(SAME)
    render(<UpdateBanner />)

    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not render when the check errored (offline)', async () => {
    mocks.getUpdateStatus.mockRejectedValue(new Error('offline'))
    render(<UpdateBanner />)

    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('dismiss persists per version and does not nag again for the same tag', async () => {
    mocks.getUpdateStatus.mockResolvedValue(NEWER)
    render(<UpdateBanner />)

    await screen.findByRole('status')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(stored.get('codeburn.updateDismissed')).toBe('desktop-v0.9.17')

    // A fresh mount with the same tag stays hidden.
    cleanup()
    render(<UpdateBanner />)
    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows again for a newer release even after an older one was dismissed', async () => {
    stored.set('codeburn.updateDismissed', 'desktop-v0.9.17')
    mocks.getUpdateStatus.mockResolvedValue({ currentVersion: '0.9.16', latestVersion: '0.9.18', updateAvailable: true, tag: 'desktop-v0.9.18' })
    render(<UpdateBanner />)

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Update available: CodeBurn 0.9.18')
  })
})
