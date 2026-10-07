/// The one update source the page has. The header badge, the CLI banner and the About pane
/// all read this store, so one answer feeds them all rather than each asking Rust its own
/// question.
///
/// Port of the observable half of mac/.../Data/UpdateChecker.swift. The check itself lives
/// in Rust (`src-tauri/src/update.rs`): it talks to GitHub, keeps the answer on disk and
/// only spends a request once the two-day interval is up, so asking on every mount is free.
///
/// A signed Windows build installs in one click: Update downloads and verifies the signed MSI,
/// Restart to Update runs it. Without the updater key the reader gets a release page and a
/// command instead. The reasoning is in the Rust module's doc comment.

import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

/// UpdateFailureStage: the check, or a one-click download that failed and fell back to manual.
export type UpdateStage = 'check' | 'install'

/// Where an update comes from on this install. Inside the Store package the Store installs
/// it; a signed Windows build installs in one click; everywhere else the reader installs it.
export type InstallRoute = 'store' | 'manual' | 'oneClick'

/// The releases index, for a status that has not arrived yet.
const RELEASES_URL = 'https://github.com/getagentseal/codeburn/releases'

export type UpdateStatus = {
  currentVersion: string
  latestVersion: string | null
  latestCliVersion: string | null
  installedCliVersion: string | null
  updateAvailable: boolean
  cliUpdateAvailable: boolean
  /// Too old to install the app, whether or not it is also behind the latest release.
  cliTooOld: boolean
  cliUpdateCommand: string
  /// What the reader runs to install the newer tray app.
  appUpdateCommand: string
  installRoute: InstallRoute
  /// The windows-v* release page for the version on offer, or the releases index.
  releaseUrl: string
  checkedAt: number | null
  failureStage: UpdateStage | null
  error: string | null
  /// Running from an installed MSIX/AppX package, where the Store updates the app and this
  /// check never ran. Every update surface goes quiet on it.
  storeManaged: boolean
  /// A verified update is downloaded and waits for Restart to Update.
  readyToInstall: boolean
}

export type UpdateState = {
  status: UpdateStatus | null
  checking: boolean
  downloading: boolean
}

export const EMPTY_UPDATE: UpdateState = {
  status: null,
  checking: false,
  downloading: false,
}

/// Rust decides whether a check costs a request; this only decides how often it is offered
/// the chance. Well inside the two-day interval, so an app left running for a week still
/// learns about a release, and far enough apart that the `codeburn --version` each ask
/// spawns is nothing beside the usage refresh.
const ASK_INTERVAL_MS = 12 * 60 * 60_000

type Listener = (state: UpdateState) => void

let state: UpdateState = EMPTY_UPDATE
let listeners: Listener[] = []
let timer: number | undefined
let inFlight: Promise<void> | null = null
let inFlightForced = false

function publish(next: Partial<UpdateState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener(state)
}

/// `force` skips the two-day gate, which is what the buttons that say Check for Updates do.
export async function checkUpdates(force: boolean): Promise<void> {
  if (inFlight) {
    // Coalescing is right for two mounts asking the same question, and wrong for a reader
    // who pressed the button: a forced check must not be answered by the cached one that
    // was already on its way, so it waits for it and then asks properly.
    if (!force || inFlightForced) return inFlight
    return inFlight.then(() => checkUpdates(true))
  }
  inFlightForced = force
  publish({ checking: true })
  inFlight = (async () => {
    try {
      const status = await invoke<UpdateStatus>('check_updates', { force })
      publish({ status, checking: false })
    } catch (err) {
      // A command that refuses to run at all is still a failed check, and the badge says so
      // rather than staying silent about a question nobody answered.
      publish({
        checking: false,
        status: {
          ...(state.status ?? blankStatus()),
          failureStage: 'check',
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  })().finally(() => { inFlight = null })
  return inFlight
}

/// Update: fetch the signed MSI quietly. A failure drops this copy to the manual route, so the
/// next click opens the release page rather than retrying something that just failed.
export async function downloadUpdate(): Promise<void> {
  if (state.downloading || !state.status) return
  publish({ downloading: true })
  try {
    await invoke('download_update')
    publish({ downloading: false, status: { ...(state.status ?? blankStatus()), readyToInstall: true } })
  } catch (err) {
    publish({
      downloading: false,
      status: {
        ...(state.status ?? blankStatus()),
        installRoute: 'manual',
        failureStage: 'install',
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

/// Restart to Update: runs the verified installer, which relaunches the app.
export async function installUpdate(): Promise<void> {
  await invoke('install_update')
}

/// What a click on an available update does: opens the release page in the browser, where
/// the reader downloads the installer and Windows gets its say before anything runs.
export async function openReleasePage(status: UpdateStatus | null): Promise<void> {
  await openUrl(status?.releaseUrl ?? RELEASES_URL)
}

function blankStatus(): UpdateStatus {
  return {
    currentVersion: '',
    latestVersion: null,
    latestCliVersion: null,
    installedCliVersion: null,
    updateAvailable: false,
    cliUpdateAvailable: false,
    cliTooOld: false,
    cliUpdateCommand: 'npm update -g codeburn',
    appUpdateCommand: 'codeburn menubar --force',
    installRoute: 'manual',
    releaseUrl: RELEASES_URL,
    checkedAt: null,
    failureStage: null,
    error: null,
    storeManaged: false,
    readyToInstall: false,
  }
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.push(listener)
  listener(state)
  if (listeners.length === 1) {
    if (state.status === null) void checkUpdates(false)
    timer = window.setInterval(() => { void checkUpdates(false) }, ASK_INTERVAL_MS)
  }
  return () => {
    listeners = listeners.filter(l => l !== listener)
    if (listeners.length === 0) window.clearInterval(timer)
  }
}

/// UpdateChecker.updateBadgeLabel, saying what the click will do rather than promising an
/// install the app no longer performs.
export function badgeLabel(state: UpdateState): string {
  const status = state.status
  if (status?.failureStage === 'check') return 'Update Check Failed'
  if (status?.updateAvailable && status.installRoute === 'oneClick') {
    if (status.readyToInstall) return 'Restart to Update'
    return state.downloading ? 'Downloading...' : 'Update Available'
  }
  if (status?.updateAvailable) return 'Download from GitHub'
  if (status?.cliUpdateAvailable) return 'CLI Update Available'
  return 'Update'
}

/// UpdateChecker.updateHelpText: the whole story in the tooltip, since the pill has room for
/// three words.
export function helpText(state: UpdateState): string {
  const status = state.status
  if (status?.failureStage === 'check' && status.error) {
    return [
      'CodeBurn could not check GitHub for updates.',
      status.error,
      'Click to retry the update check.',
    ].join('\n\n')
  }
  if (status?.updateAvailable && status.installRoute === 'oneClick') {
    const version = status.latestVersion ? `Version ${status.latestVersion}` : 'A newer version'
    return status.readyToInstall
      ? `${version} is downloaded. Click to restart into it.`
      : `${version} is available. Click to download it.`
  }
  if (status?.updateAvailable) {
    const version = status.latestVersion ? `Version ${status.latestVersion}` : 'A newer version'
    return [
      `${version} is on GitHub. Click to open the release page.`,
      `These builds do not update themselves. Download the installer there, or run ${status.appUpdateCommand} in a terminal.`,
    ].join('\n\n')
  }
  if (status?.cliUpdateAvailable) {
    const version = status.latestCliVersion ?? 'A newer CLI'
    return `CLI ${version} is available. Run ${status.cliUpdateCommand} in a terminal.`
  }
  return 'Check GitHub for a newer release'
}

/// What a click on the badge does: a one-click update downloads, then restarts; a manual one
/// opens its release page; anything else asks GitHub again.
export function badgeAction(state: UpdateState): 'check' | 'download' | 'update' | 'restart' {
  const status = state.status
  if (!status?.updateAvailable) return 'check'
  if (status.installRoute !== 'oneClick') return 'download'
  return status.readyToInstall ? 'restart' : 'update'
}

/// The one handler every update button shares.
export function runUpdateAction(action: ReturnType<typeof badgeAction>, status: UpdateStatus | null): void {
  if (action === 'update') void downloadUpdate()
  else if (action === 'restart') void installUpdate()
  else if (action === 'download') void openReleasePage(status)
  else void checkUpdates(true)
}

export function badgeVisible(state: UpdateState): boolean {
  const status = state.status
  if (!status) return false
  if (status.storeManaged) return false
  return status.updateAvailable || status.cliUpdateAvailable || status.error !== null
}
