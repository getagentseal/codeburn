import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, shell, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'

import { createBridgeHandlers as createHandlers, NO_UPDATE_STATUS, type Deps, type Handler } from './bridge-handlers'
import { reapOrphanServe, resolveCodeburnPath, serveUsage, shutdownAll, spawnCli, spawnCliAction, startServe } from './cli'
import { MenubarCompanion, readDockEnabled, STARTUP_APPS_SETTINGS_URL } from './menubar'
import { MacMenubar, type InstallPhase } from './mac-menubar'
import { getQuota } from './quota'
import { Telemetry } from './telemetry'
import { autoUpdateSupported, createAutoUpdateChecker, type AutoUpdateChecker } from './auto-update'
import { createUpdateChecker, type UpdateChecker, type UpdateStatus } from './updates'

// Initialized in bootstrap() once Electron paths exist; stays null under tests.
let telemetryInstance: Telemetry | null = null
// The once-per-launch + 24h update-availability checker. Null under tests.
let updateChecker: UpdateChecker | null = null
// Set instead of a link-only checker where the install can replace itself.
let autoUpdate: AutoUpdateChecker | null = null
// The bundled tray app and its Capacity Dock (Windows only). Null under tests.
let companion: MenubarCompanion | null = null
let macMenubar: MacMenubar | null = null

export {
  appleLanguageFor, exportedPath, makeProgressReader, NO_COMPANION, NO_COMPANION_ACTION,
  readConfigCursorSync, readConfigLanguage, readProjectFilter, writeConfigCursorSync, writeConfigLanguage, writeProjectFilter,
} from './bridge-handlers'
export type { Envelope, ProjectFilter, TelemetryBridge } from './bridge-handlers'

type QuitTelemetry = Pick<Telemetry, 'trackClose' | 'flush'>
type BeforeQuitEvent = { preventDefault: () => void }
type BeforeQuitDeps = {
  getTelemetry: () => QuitTelemetry | null
  killAll: () => void | Promise<void>
  quit: () => void
  timeoutMs?: number
}

const QUIT_FLUSH_TIMEOUT_MS = 1500

/** Intercept one quit pass, then allow the re-entrant pass after a bounded flush. */
export function createBeforeQuitHandler(deps: BeforeQuitDeps): (event: BeforeQuitEvent) => void {
  let flushStarted = false
  let allowQuit = false
  let closeTracked = false

  return event => {
    if (allowQuit) return
    try { event.preventDefault() } catch { /* keep the quit path moving */ }
    if (flushStarted) return
    flushStarted = true

    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        let childCleanup: Promise<unknown> = Promise.resolve()
        try { childCleanup = Promise.resolve(deps.killAll()).catch(() => undefined) } catch { /* child cleanup must not wedge quit */ }

        let telemetry: QuitTelemetry | null = null
        try { telemetry = deps.getTelemetry() } catch { /* telemetry lookup is best-effort */ }

        let flush: Promise<unknown> = Promise.resolve(false)
        if (telemetry) {
          if (!closeTracked) {
            closeTracked = true
            try { telemetry.trackClose() } catch { /* flush the existing queue anyway */ }
          }
          try { flush = Promise.resolve(telemetry.flush()) } catch { /* use the resolved fallback */ }
        }

        const timeout = new Promise<void>(resolve => {
          timer = setTimeout(resolve, deps.timeoutMs ?? QUIT_FLUSH_TIMEOUT_MS)
        })
        await Promise.race([
          Promise.all([flush.catch(() => false), childCleanup]),
          timeout,
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        allowQuit = true
        try { deps.quit() } catch { /* a throwing quit call must not reset the guard */ }
      }
    })()
  }
}

// IPC channel carrying cold-start scan-progress events to the splash.
export const PROGRESS_CHANNEL = 'codeburn:progress'
/** Named steps of a running menubar install, pushed while the card waits on one. */
export const MAC_MENUBAR_PROGRESS_CHANNEL = 'codeburn:macMenubarProgress'
// IPC channel pushing update-availability status to open windows (launch + 24h).
export const UPDATE_CHANNEL = 'codeburn:update'


function broadcastProgress(event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(PROGRESS_CHANNEL, event)
  }
}

function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_CHANNEL, status)
  }
}



export function createBridgeHandlers(deps: Deps = { spawnCli, spawnCliAction, resolveCodeburnPath, getQuota, emitProgress: broadcastProgress, telemetry: telemetryInstance, getUpdateStatus: () => updateChecker ? updateChecker.getStatus() : Promise.resolve(NO_UPDATE_STATUS), downloadUpdate: () => autoUpdate ? autoUpdate.download() : Promise.resolve(NO_UPDATE_STATUS), installUpdate: () => autoUpdate?.install(), companion: companion, macMenubar: macMenubar, stateDir: app.getPath('userData'), appVersion: app.getVersion(), isOnBatteryPower: () => powerMonitor.isOnBatteryPower() }): Record<string, Handler> {
  return createHandlers(deps)
}

function registerHandlers(): void {
  const handlers = createBridgeHandlers()
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => handler(...args))
  }
  ipcMain.handle('codeburn:chooseDirectory', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return { ok: true, value: res.canceled ? null : (res.filePaths[0] ?? null) }
  })
  ipcMain.handle('open-external', (_event, url: string) => {
    const allowed = externalUrlToOpen(url)
    return allowed === null ? undefined : shell.openExternal(allowed)
  })
}

/**
 * What the renderer may hand the shell, or null for anything else. The web is http(s) only.
 * The one exception is the Windows Settings page for startup apps, allowed by exact value:
 * on the Store route launch at login is the package's own startup task, so the tray pane
 * points at that page instead of offering a switch it cannot move (app/electron/menubar.ts).
 */
export function externalUrlToOpen(url: string, platform: string = process.platform): string | null {
  if (platform === 'win32' && url === STARTUP_APPS_SETTINGS_URL) return url
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:') return url
  } catch { /* malformed URL, refuse to open */ }
  return null
}

export function createApplicationMenuTemplate(isDev = Boolean(process.env.VITE_DEV_SERVER_URL)): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  } else {
    template.push({
      label: 'File',
      submenu: [{ role: 'quit' }],
    })
  }

  template.push(
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : []),
      ],
    },
  )

  return template
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate()))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1013' : '#f5f6f8',
    // macOS: integrated title bar (traffic lights float over the sidebar), like
    // Linear/Hermes. Windows/Linux keep their native frame + window controls.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep Chromium's normal background throttling so minimizing/occluding the
      // window updates the Page Visibility API and pauses renderer animations.
      // Data intervals remain registered and use a visibility catch-up on return.
      backgroundThrottling: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // This window only ever renders the bundled renderer; block in-page navigation
  // and popups so a hijacked link can't turn it into a browser.
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`)
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl).catch(err => console.error('Failed to load dev server URL:', err))
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch(err => console.error('Failed to load renderer:', err))
  }

  return win
}

function bootstrap(): void {
  process.on('unhandledRejection', reason => {
    console.error('Unhandled promise rejection in main process:', reason)
  })

  // Packaged builds ship their own version-matched CLI under resources/cli (the
  // afterPack hook copies it in). Point the resolver at the launch shim before
  // any handler spawns; cli.ts runs it with Electron-as-node. The shim, not
  // cli.js, is the entry — it corrects argv for commander under Electron. Unset
  // in dev, where the repo build is used instead.
  if (app.isPackaged) {
    process.env.CODEBURN_BUNDLED_CLI = path.join(process.resourcesPath, 'cli', 'dist', 'launch.js')
  }

  // A second launch focuses the running window instead of opening a rival one.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('before-quit', createBeforeQuitHandler({
    getTelemetry: () => telemetryInstance,
    killAll: shutdownAll,
    quit: () => app.quit(),
  }))

  void app.whenReady().then(() => {
    // Start the resident child early, but issue no artificial warm-up query:
    // the first real overview request is the single cache hydration and streams
    // its progress through serve. Every later panel reuses that parsed cache.
    // A crash leaves no one to close the previous child's stdin, so reap it
    // first — orphans hold FSEvents handles and a stale cache refresh lock.
    const servePidFile = path.join(app.getPath('userData'), 'serve.pid')
    reapOrphanServe(servePidFile)
    startServe(servePidFile)
    // Consent-gated anonymous telemetry (desktop only). Nothing transmits until
    // the onboarding consent screen is completed and the toggle is on; EU/EEA/
    // UK/CH installs default the toggle off. Dev builds never send.
    try {
      telemetryInstance = new Telemetry({
        stateDir: app.getPath('userData'),
        country: app.getLocaleCountryCode() || null,
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
        getAppMetrics: () => app.getAppMetrics(),
        getServeUsage: serveUsage,
      })
      telemetryInstance.settleUpdate(app.getVersion())
      // completeOnboarding tracks the first app_open itself; only already-
      // onboarded installs record subsequent opens here. app_open carries the
      // Capacity Dock state (on/off/none) so dock adoption is measurable.
      if (telemetryInstance.status().onboarded) {
        const dockPref = readDockEnabled()
        telemetryInstance.track('app_open', { dock: dockPref === undefined ? 'none' : dockPref ? 'on' : 'off' })
      }
      setInterval(() => {
        telemetryInstance?.sampleResources()
        void telemetryInstance?.flush()
      }, 5 * 60_000)
    } catch (err) {
      console.error('telemetry init failed (continuing without):', err)
    }
    // The tray app and the Capacity Dock the desktop app carries on Windows. Constructed
    // before the handlers so the sidebar's switches have something to read, and installed in
    // the background so a `/passive` msiexec run never holds the first window back.
    companion = new MenubarCompanion({
      // Packaged: the real resources dir. Dev: null, unless CODEBURN_MENUBAR_RESOURCES points at
      // a packaged-style layout (a `menubar` dir under it, with CodeBurn.exe beside it), so the
      // tray install can be exercised without packaging. A dev convenience like CODEBURN_BIN and
      // CODEBURN_DEV_REPO_ROOT; the CLI still validates the staged path in full (menubar-installer.ts).
      resourcesPath: app.isPackaged ? process.resourcesPath : (process.env.CODEBURN_MENUBAR_RESOURCES ?? null),
      stateDir: app.getPath('userData'),
      // Electron sets this in an installed AppX package, which is the Store route.
      store: (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true,
      platform: process.platform,
      env: process.env,
    })
    void companion.bootstrap().catch(err => console.error('menubar bootstrap failed:', err))
    // No bootstrap: nothing is installed, moved or launched until the card asks.
    macMenubar = new MacMenubar({
      platform: process.platform,
      // Electron sets this only in a Mac App Store build, where downloading an executable is
      // against the rules, so the card offers the website instead of an Install button.
      mas: (process as NodeJS.Process & { mas?: boolean }).mas === true,
      runCli: spawnCliAction,
      // So the menubar this installs can find a codeburn without one on PATH: the launcher is
      // written into userData and recorded where the menubar looks first.
      execPath: process.execPath,
      bundledCli: process.env.CODEBURN_BUNDLED_CLI,
      stateDir: app.getPath('userData'),
      onPhase: (phase: InstallPhase) => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send(MAC_MENUBAR_PROGRESS_CHANNEL, phase)
      },
    })
    registerHandlers()
    // Power source, pushed to the renderer so the live cadence halves on
    // battery and restores on AC.
    const broadcastPower = () => {
      const onBattery = powerMonitor.isOnBatteryPower()
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('codeburn:power', onBattery)
      }
    }
    powerMonitor.on('on-battery', broadcastPower)
    powerMonitor.on('on-ac', broadcastPower)
    installApplicationMenu()
    // Seed the preload-readable app locale before any window loads. app.getLocale()
    // needs the ready state, so this runs inside bootstrap's whenReady.
    process.env.__CODEBURN_APP_LOCALE__ = app.getLocale()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // Update availability: check once at launch, then every 24h, pushing each
    // result to any open window. Signed mac builds and the AppImage download and
    // install on the reader's click; everything else gets a download link.
    // Errors are swallowed inside the checkers as a silent no-op.
    const windowsStore = (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true
    if (autoUpdateSupported({
      platform: process.platform,
      isPackaged: app.isPackaged,
      mas: (process as NodeJS.Process & { mas?: boolean }).mas === true,
      windowsStore,
      appImage: process.env.APPIMAGE,
    })) {
      // Loaded only here: electron-updater picks a platform updater as soon as it is touched.
      const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
      autoUpdate = createAutoUpdateChecker({
        updater: autoUpdater,
        currentVersion: app.getVersion(),
        onChange: broadcastUpdateStatus,
        onDownloadFail: (outcome, from, to) => telemetryInstance?.track('update_result', { from, to, outcome }),
        onInstall: (from, to) => telemetryInstance?.noteUpdateInstall(from, to),
      })
      updateChecker = autoUpdate
    } else {
      updateChecker = createUpdateChecker({ currentVersion: app.getVersion(), storeManaged: windowsStore })
    }
    const runUpdateCheck = () => { void updateChecker?.check().then(broadcastUpdateStatus) }
    runUpdateCheck()
    setInterval(runUpdateCheck, 24 * 60 * 60 * 1000)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (!process.env.VITEST) bootstrap()
