import { describe, expect, it, vi } from 'vitest'

import { autoUpdateSupported, createAutoUpdateChecker, WINDOWS_AUTO_UPDATE, type Updater } from './auto-update'
import type { UpdateStatus } from './updates'

function fakeUpdater(version: string | null) {
  let downloaded: () => void = () => {}
  const updater = {
    autoDownload: true,
    checkForUpdates: vi.fn(async () => (version ? { updateInfo: { version } } : null)),
    downloadUpdate: vi.fn(async () => { downloaded() }),
    quitAndInstall: vi.fn(),
    on: vi.fn((_event: 'update-downloaded', listener: () => void) => { downloaded = listener }),
  } satisfies Updater
  return updater
}

describe('autoUpdateSupported', () => {
  const base = { isPackaged: true, mas: false, windowsStore: false }

  it('runs on packaged mac builds and the AppImage only', () => {
    expect(autoUpdateSupported({ ...base, platform: 'darwin' })).toBe(true)
    expect(autoUpdateSupported({ ...base, platform: 'darwin', isPackaged: false })).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'darwin', mas: true })).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'linux', appImage: '/tmp/CodeBurn.AppImage' })).toBe(true)
    // deb, rpm, snap and Flathub: no APPIMAGE.
    expect(autoUpdateSupported({ ...base, platform: 'linux' })).toBe(false)
  })

  it('keeps Windows on the banner until the build flag is flipped, and never touches Store installs', () => {
    expect(WINDOWS_AUTO_UPDATE).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'win32' })).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'win32', windowsStore: true })).toBe(false)
  })
})

describe('createAutoUpdateChecker', () => {
  it('never downloads on its own, and walks available -> downloading -> ready on the click', async () => {
    const updater = fakeUpdater('0.9.27')
    const seen: UpdateStatus[] = []
    const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: s => seen.push(s) })

    expect(updater.autoDownload).toBe(false)
    const status = await checker.check()
    expect(status).toEqual({ currentVersion: '0.9.26', latestVersion: '0.9.27', updateAvailable: true, tag: 'desktop-v0.9.27', install: 'available' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    checker.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    await checker.download()
    expect(seen.map(s => s.install)).toEqual(['downloading', 'ready'])

    // A later check does not knock a finished download back to "available".
    expect((await checker.check()).install).toBe('ready')

    checker.install()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('offers nothing when the feed is not newer', async () => {
    const checker = createAutoUpdateChecker({ updater: fakeUpdater('0.9.26'), currentVersion: '0.9.26', onChange: () => {} })
    expect(await checker.check()).toEqual({ currentVersion: '0.9.26', latestVersion: '0.9.26', updateAvailable: false, tag: null })
  })

  it('falls back to the download link when the download fails', async () => {
    const updater = fakeUpdater('0.9.27')
    updater.downloadUpdate.mockRejectedValueOnce(new Error('sha512 mismatch'))
    const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: () => {} })
    await checker.check()

    const status = await checker.download()
    expect(status.install).toBeUndefined()
    expect(status.tag).toBe('desktop-v0.9.27')
  })

  it('keeps the last status when the check fails', async () => {
    const updater = fakeUpdater('0.9.27')
    const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: () => {} })
    await checker.check()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    expect((await checker.check()).install).toBe('available')
  })
})
