// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AboutModal } from './AboutModal'
import type { UpdateStatus } from '../lib/types'

const mocks = vi.hoisted(() => ({
  getUpdateStatus: vi.fn<() => Promise<UpdateStatus>>(),
  onUpdateStatus: vi.fn<(cb: (s: UpdateStatus) => void) => () => void>(() => () => {}),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const NEWER: UpdateStatus = { currentVersion: '0.9.16', latestVersion: '0.9.17', updateAvailable: true, tag: 'desktop-v0.9.17' }
const SAME: UpdateStatus = { currentVersion: '0.9.17', latestVersion: '0.9.17', updateAvailable: false, tag: null }
const UNKNOWN: UpdateStatus = { currentVersion: '0.9.17', latestVersion: null, updateAvailable: false, tag: null }

function renderAbout() {
  return render(<AboutModal socials={[]} onClose={() => {}} />)
}

describe('AboutModal update check', () => {
  beforeEach(() => {
    mocks.getUpdateStatus.mockReset()
    mocks.openExternal.mockReset().mockResolvedValue(undefined)
    mocks.onUpdateStatus.mockReset().mockReturnValue(() => {})
  })
  afterEach(cleanup)

  it('shows no note until the button is clicked', async () => {
    mocks.getUpdateStatus.mockResolvedValue(SAME)
    renderAbout()
    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalled())
    expect(screen.queryByText(/latest version/i)).toBeNull()
  })

  it('reports up to date on the current version', async () => {
    mocks.getUpdateStatus.mockResolvedValue(SAME)
    renderAbout()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText("You're on the latest version")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('reports an available update with a Download link that opens the release page', async () => {
    mocks.getUpdateStatus.mockResolvedValue(NEWER)
    renderAbout()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))

    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent('Update available: 0.9.17')

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn/releases/tag/desktop-v0.9.17')
  })

  it('degrades gracefully when the status is unknown (offline)', async () => {
    mocks.getUpdateStatus.mockResolvedValue(UNKNOWN)
    renderAbout()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('Unable to check right now')).toBeInTheDocument()
  })
})
