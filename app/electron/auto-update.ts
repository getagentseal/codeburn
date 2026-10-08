// One-click updates through electron-updater, reading the fixed update-feeds release rather
// than GitHub's /releases/latest, which four release lines share. Nothing downloads until the
// reader clicks; the next click restarts into the new version.

import { compareSemver, type UpdateChecker, type UpdateStatus } from './updates'

// Off until the maintainer picks Authenticode signing or hash-only trust for the NSIS
// installer (RELEASING.md, "Windows NSIS auto-update"). Windows keeps the link banner.
export const WINDOWS_AUTO_UPDATE = false

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export function autoUpdateSupported(env: {
  platform: string
  isPackaged: boolean
  mas: boolean
  windowsStore: boolean
  appImage?: string
}): boolean {
  if (!env.isPackaged) return false
  if (env.platform === 'darwin') return !env.mas
  // Only the AppImage replaces itself; deb, rpm, snap and Flathub update through their package manager.
  if (env.platform === 'linux') return Boolean(env.appImage)
  if (env.platform === 'win32') return WINDOWS_AUTO_UPDATE && !env.windowsStore
  return false
}

export type Updater = {
  autoDownload: boolean
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: 'update-downloaded', listener: () => void): unknown
}

export type AutoUpdateChecker = UpdateChecker & {
  download(): Promise<UpdateStatus>
  install(): void
}

/** A failed download is a verify failure when the checksum or Squirrel's code signature check refused it. */
export function downloadFailOutcome(err: unknown): 'download_fail' | 'verify_fail' {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  return code === 'ERR_CHECKSUM_MISMATCH' || /checksum|sha512|signature|did not pass validation/i.test(message)
    ? 'verify_fail'
    : 'download_fail'
}

export function createAutoUpdateChecker(opts: {
  updater: Updater
  currentVersion: string
  onChange: (status: UpdateStatus) => void
  now?: () => number
  /** A download that failed, as an outcome enum. */
  onDownloadFail?: (outcome: 'download_fail' | 'verify_fail', from: string, to: string) => void
  /** Called when the update is downloaded and again just before quitting into it: from then
   *  on it installs, at the latest on the next quit. */
  onInstall?: (from: string, to: string) => void
}): AutoUpdateChecker {
  const { updater, currentVersion, onChange } = opts
  const now = opts.now ?? (() => Date.now())
  updater.autoDownload = false

  let status: UpdateStatus = { currentVersion, latestVersion: null, updateAvailable: false, tag: null }
  let lastCheckedAt = 0
  let inflight: Promise<UpdateStatus> | null = null

  const set = (next: UpdateStatus) => { status = next; onChange(status) }

  updater.on('update-downloaded', () => {
    if (status.install !== 'downloading') return
    opts.onInstall?.(currentVersion, status.latestVersion ?? '')
    set({ ...status, install: 'ready' })
  })

  const check = (): Promise<UpdateStatus> => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const result = await updater.checkForUpdates()
        lastCheckedAt = now()
        const latest = result?.updateInfo.version ?? null
        if (!latest) return status
        // A download already under way or finished is not reset by a later check.
        if (status.install === 'downloading' || status.install === 'ready') return status
        const updateAvailable = compareSemver(latest, currentVersion) > 0
        status = {
          currentVersion,
          latestVersion: latest,
          updateAvailable,
          tag: updateAvailable ? `desktop-v${latest}` : null,
          ...(updateAvailable ? { install: 'available' as const } : {}),
        }
      } catch {
        // Offline or no feed yet: keep what was known and retry next cycle.
      } finally {
        inflight = null
      }
      return status
    })()
    return inflight
  }

  return {
    check,
    getStatus: () => (lastCheckedAt !== 0 && now() - lastCheckedAt < CHECK_INTERVAL_MS ? Promise.resolve(status) : check()),
    async download() {
      if (status.install !== 'available') return status
      set({ ...status, install: 'downloading' })
      try {
        await updater.downloadUpdate()
      } catch (err) {
        opts.onDownloadFail?.(downloadFailOutcome(err), currentVersion, status.latestVersion ?? '')
        // Fall back to the manual download link rather than a button that keeps failing.
        const { install: _dropped, ...rest } = status
        set(rest)
      }
      return status
    },
    install() {
      if (status.install !== 'ready') return
      opts.onInstall?.(currentVersion, status.latestVersion ?? '')
      updater.quitAndInstall()
    },
  }
}
