import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'

import { CliError, killAll, resolveCodeburnPath, spawnCli, spawnCliAction, type ActionResult } from './cli'
import { getQuota, sanitizeError } from './quota'
import { Telemetry } from './telemetry'

// Initialized in bootstrap() once Electron paths exist; stays null under tests.
let telemetryInstance: Telemetry | null = null

/** The slice of Telemetry the bridge handlers use — injectable for tests. */
export type TelemetryBridge = Pick<Telemetry, 'status' | 'setEnabled' | 'completeOnboarding' | 'track'>

// Result envelope: handlers never throw across IPC so the structured error
// `kind` survives contextBridge serialization. preload.ts unwraps it.
export type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; error: { kind: string; message: string } }

// The first overview fetch after boot hydrates a cold cache from scratch (a full
// history parse). That can far exceed the 45s read timeout, and killing it means
// the cache never persists, so every later poll restarts the scan — perpetual
// slowness. Give the first (cold) overview a long window; revert to the default
// once it succeeds. Sections gate their own first poll on this one resolving so
// the cold hydration runs ONCE, not once per section in parallel.
const WARMUP_TIMEOUT_MS = 10 * 60_000
// Wire marker for CLI scan-progress lines (src/parser.ts: PROGRESS_LINE_PREFIX).
const PROGRESS_LINE_PREFIX = 'CODEBURN_PROGRESS '
// IPC channel carrying cold-start scan-progress events to the splash.
export const PROGRESS_CHANNEL = 'codeburn:progress'

/** Line-buffer a spawn's stderr and forward each parsed scan-progress event. */
export function makeProgressReader(emit: (event: unknown) => void): (chunk: string) => void {
  let buffer = ''
  return chunk => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.startsWith(PROGRESS_LINE_PREFIX)) {
        try { emit(JSON.parse(line.slice(PROGRESS_LINE_PREFIX.length))) } catch { /* ignore malformed line */ }
      }
      nl = buffer.indexOf('\n')
    }
  }
}

function broadcastProgress(event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(PROGRESS_CHANNEL, event)
  }
}

function providerArgs(provider: string | undefined): string[] {
  return provider && provider !== 'all' ? ['--provider', provider] : []
}

type DateRange = { from: string; to: string }

function rangeArgs(range: DateRange | undefined): string[] {
  return range ? ['--from', range.from, '--to', range.to] : []
}

function configSourceArgs(source: string | null): string[] {
  return source ? ['--claude-config-source', source] : []
}

// Renderer-supplied strings become argv, so reject anything that could smuggle a
// flag or shell metacharacter before it reaches the CLI. Thrown from the argv
// builders, these surface through the same error envelope as any CliError.
const PERIODS = new Set(['today', 'week', '30days', 'month', 'all'])
function vPeriod(period: string): string {
  if (!PERIODS.has(period)) throw new CliError('bad-args', 'invalid period')
  return period
}
function vProvider(provider: string): string {
  if (!/^[a-z0-9-]+$/.test(provider)) throw new CliError('bad-args', 'invalid provider')
  return provider
}
function vRange(range: DateRange | undefined): DateRange | undefined {
  if (range && (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to))) {
    throw new CliError('bad-args', 'invalid date range')
  }
  return range
}
function vCurrency(code: string): string {
  if (!/^[A-Z]{3}$/.test(code)) throw new CliError('bad-args', 'invalid currency code')
  return code
}
/** model/alias/device/plan tokens: must not be read as a CLI flag. */
function vToken(value: string): string {
  if (value.startsWith('-')) throw new CliError('bad-args', 'argument must not start with "-"')
  return value
}
// Claude config source ids are `<kind>:<hex>` (src/providers/claude.ts) — the
// colon is part of the real value, so the token class allows it while anchoring
// the first char to alphanumeric so a leading "-" can never smuggle a flag.
function vConfigSource(source: string | null | undefined): string | null {
  if (source == null) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(source)) throw new CliError('bad-args', 'invalid claude config source')
  return source
}
function vOutPath(outPath: string): string {
  if (outPath.startsWith('-') || !path.isAbsolute(outPath)) throw new CliError('bad-args', 'export path must be absolute')
  return outPath
}
// Price-override rates are USD per 1M tokens: every provided rate must be a
// finite, strictly positive number before it becomes a CLI value.
type PriceRates = { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }
function rateArg(flag: string, value: number | undefined): string[] {
  if (value === undefined) return []
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new CliError('bad-args', 'rate must be a positive number')
  return [flag, String(value)]
}
function priceOverrideArgs(model: string, rates: PriceRates | undefined): string[] {
  const r = rates ?? {}
  return [
    'price-override', vToken(model),
    ...rateArg('--input', r.input),
    ...rateArg('--output', r.output),
    ...rateArg('--cache-read', r.cacheRead),
    ...rateArg('--cache-creation', r.cacheCreation),
  ]
}

function toEnvelopeError(err: unknown): { kind: string; message: string } {
  if (err instanceof CliError) return { kind: err.kind, message: sanitizeError(err.message) }
  return { kind: 'nonzero', message: sanitizeError(err instanceof Error ? err.message : String(err)) }
}

type Deps = {
  spawnCli: (args: string[], opts?: { timeoutMs?: number; onStderr?: (chunk: string) => void; extraEnv?: NodeJS.ProcessEnv }) => Promise<unknown>
  spawnCliAction: (args: string[], opts?: { timeoutMs?: number }) => Promise<ActionResult>
  resolveCodeburnPath: () => string | null
  getQuota: typeof getQuota
  /** Forward cold-start scan-progress events to the renderer splash. */
  emitProgress?: (event: unknown) => void
  /** Consent-gated anonymous telemetry; absent under tests unless injected. */
  telemetry?: TelemetryBridge | null
}

type Handler = (...args: any[]) => Promise<Envelope>

/**
 * Maps every CodeburnBridge channel to its `codeburn` argv (plain args, no
 * shell) and returns a result envelope. Pure + injectable so the wiring is
 * unit-testable without launching Electron.
 */
export function createBridgeHandlers(deps: Deps = { spawnCli, spawnCliAction, resolveCodeburnPath, getQuota, emitProgress: broadcastProgress, telemetry: telemetryInstance }): Record<string, Handler> {
  const emitProgress = deps.emitProgress ?? (() => {})
  const telemetry = deps.telemetry ?? null
  // Flips true after the first overview fetch succeeds. Until then, every
  // overview fetch runs cold (long timeout + progress streaming); the shared
  // spawnCli coalescing means concurrent same-arg re-polls join one child.
  let overviewWarmed = false
  // cold_start is a once-per-launch metric. Because coalesced re-polls each
  // re-enter the cold branch (and overviewWarmed only flips on success, so it
  // never guards a still-failing warmup), emitting inline would record one row
  // per poll — each with a launch-relative, cumulative elapsed time. Latch the
  // emit and anchor the duration to the FIRST cold attempt instead.
  let coldStartEmitted = false
  let coldStartBegan: number | null = null
  const emitColdStart = (timedOut: boolean): void => {
    if (coldStartEmitted) return
    coldStartEmitted = true
    telemetry?.track('cold_start', { ms: Date.now() - (coldStartBegan ?? Date.now()), timedOut })
  }

  const run = (build: (...args: any[]) => string[]): Handler => async (...args: any[]) => {
    try {
      return { ok: true, value: await deps.spawnCli(build(...args)) }
    } catch (err) {
      const error = toEnvelopeError(err)
      telemetry?.track('cli_error', { kind: error.kind })
      return { ok: false, error }
    }
  }

  // The desktop never renders the granular timeline, so it always passes
  // --no-timeline (skips buildGranularHistory on every poll). The Swift menubar
  // omits the flag and keeps the timeline unchanged.
  const buildOverviewArgs = (period: string, provider: string, range?: DateRange, configSource?: string | null): string[] => [
    'status', '--format', 'menubar-json', '--period', vPeriod(period), '--no-timeline',
    ...providerArgs(vProvider(provider)), ...rangeArgs(vRange(range)), ...configSourceArgs(vConfigSource(configSource)),
  ]

  const getOverview: Handler = async (period: string, provider: string, range?: DateRange, configSource?: string | null) => {
    coldStartBegan ??= Date.now()
    try {
      const args = buildOverviewArgs(period, provider, range, configSource)
      if (overviewWarmed) return { ok: true, value: await deps.spawnCli(args) }
      const value = await deps.spawnCli(args, {
        timeoutMs: WARMUP_TIMEOUT_MS,
        extraEnv: { CODEBURN_PROGRESS: '1' },
        onStderr: makeProgressReader(emitProgress),
      })
      overviewWarmed = true
      emitProgress({ kind: 'done' })
      emitColdStart(false)
      return { ok: true, value }
    } catch (err) {
      const error = toEnvelopeError(err)
      if (!overviewWarmed) emitColdStart(error.kind === 'timeout')
      telemetry?.track('cli_error', { kind: error.kind })
      return { ok: false, error }
    }
  }
  const runAction = (build: (...args: any[]) => string[]): Handler => async (...args: any[]) => {
    try {
      const result = await deps.spawnCliAction(build(...args))
      return { ok: true, value: { ...result, stderr: sanitizeError(result.stderr) } }
    } catch (err) {
      return { ok: false, error: toEnvelopeError(err) }
    }
  }

  return {
    'codeburn:getQuota': async (force?: boolean) => {
      try { return { ok: true, value: await deps.getQuota({ force: Boolean(force) }) } }
      catch (error) { return { ok: false, error: { kind: 'nonzero', message: sanitizeError(error) } } }
    },
    'codeburn:getOverview': getOverview,
    'codeburn:getPlans': run((period: string) => ['status', '--format', 'json', '--period', vPeriod(period)]),
    'codeburn:getActReport': run(() => ['act', 'report', '--json']),
    'codeburn:getModels': run((period: string, provider: string, byTask: boolean, range?: DateRange) => [
      'models', '--format', 'json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)), ...(byTask ? ['--by-task'] : []), ...rangeArgs(vRange(range)),
    ]),
    'codeburn:getSessions': run((period: string, provider: string, range?: DateRange) => [
      'sessions', '--format', 'json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)), ...rangeArgs(vRange(range)),
    ]),
    'codeburn:getCompareModels': run((period: string, provider: string) => [
      'compare', '--format', 'json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)),
    ]),
    'codeburn:getCompare': run((period: string, provider: string, modelA: string, modelB: string) => [
      'compare', '--format', 'json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)), '--model-a', vToken(modelA), '--model-b', vToken(modelB),
    ]),
    'codeburn:getYield': run((period: string, provider: string, range?: DateRange) => [
      'yield', '--format', 'json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)), ...rangeArgs(vRange(range)),
    ]),
    'codeburn:getSpendFlow': run((period: string, provider: string, range?: DateRange) => [
      'spend', '--format', 'flow-json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)), ...rangeArgs(vRange(range)),
    ]),
    'codeburn:getOptimizeReport': run((period: string, provider: string, range?: DateRange) => [
      'optimize', '--format', 'json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)), ...rangeArgs(vRange(range)),
    ]),
    'codeburn:getDevices': run((period: string) => ['devices', '--format', 'json', '--period', vPeriod(period)]),
    'codeburn:getDevicesScan': run(() => ['devices', 'scan', '--format', 'json']),
    'codeburn:getShareStatus': run(() => ['share', 'status', '--format', 'json']),
    'codeburn:getIdentity': run(() => ['identity', '--format', 'json']),
    'codeburn:getAliases': run(() => ['model-alias', '--list', '--format', 'json']),
    'codeburn:getProxyPaths': run(() => ['proxy-path', '--list', '--format', 'json']),
    'codeburn:getAudit': run((period: string, provider: string, range?: DateRange) => [
      'audit', '--format', 'json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)), ...rangeArgs(vRange(range)),
    ]),
    'codeburn:getPriceOverrides': run(() => ['price-override', '--list', '--format', 'json']),
    'codeburn:setCurrency': runAction((code: string) => ['currency', vCurrency(code)]),
    'codeburn:resetCurrency': runAction(() => ['currency', '--reset']),
    'codeburn:addAlias': runAction((from: string, to: string) => ['model-alias', vToken(from), vToken(to)]),
    'codeburn:removeAlias': runAction((from: string) => ['model-alias', '--remove', vToken(from)]),
    'codeburn:setPriceOverride': runAction((model: string, rates: PriceRates) => priceOverrideArgs(model, rates)),
    'codeburn:removePriceOverride': runAction((model: string) => ['price-override', '--remove', vToken(model)]),
    'codeburn:removeDevice': runAction((name: string) => ['devices', 'rm', vToken(name)]),
    'codeburn:setPlan': runAction((id: string, provider: string) => ['plan', 'set', vToken(id), '--provider', vProvider(provider)]),
    'codeburn:resetPlan': runAction((provider: string) => ['plan', 'reset', '--provider', vProvider(provider)]),
    'codeburn:exportData': runAction((format: string, provider: string, outPath: string) => [
      'export', '-f', vToken(format), '-o', vOutPath(outPath), '--provider', vProvider(provider),
    ]),
    'codeburn:cliStatus': async () => {
      const p = deps.resolveCodeburnPath()
      return { ok: true, value: { found: p !== null, path: p } }
    },
    // Telemetry consent + events. Value is null when telemetry is unavailable
    // (tests, or init failure) — the renderer treats null as "no onboarding".
    'codeburn:telemetryStatus': async () => ({ ok: true, value: telemetry ? telemetry.status() : null }),
    'codeburn:telemetrySetEnabled': async (enabled?: boolean) => ({ ok: true, value: telemetry ? telemetry.setEnabled(Boolean(enabled)) : null }),
    'codeburn:telemetryOnboarded': async (enabled?: boolean) => ({ ok: true, value: telemetry ? telemetry.completeOnboarding(Boolean(enabled)) : null }),
    'codeburn:telemetryTrack': async (name?: string, props?: unknown) => {
      telemetry?.track(String(name ?? ''), props)
      return { ok: true, value: true }
    },
  }
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
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') return shell.openExternal(url)
    } catch { /* malformed URL — refuse to open */ }
    return
  })
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
      // Chromium's default (kept explicit): when the window is minimized or fully
      // occluded the renderer's document.visibilityState flips to 'hidden' and a
      // visibilitychange fires. usePolled and the flame animation gate on that to
      // stop background CLI polls and compositor wakeups while hidden. A merely
      // unfocused-but-visible window stays 'visible' and keeps polling.
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

  app.on('before-quit', () => {
    killAll()
    // Best-effort final beat: session duration + whatever is still queued.
    telemetryInstance?.trackClose()
    void telemetryInstance?.flush()
  })

  void app.whenReady().then(() => {
    // Consent-gated anonymous telemetry (desktop only). Nothing transmits until
    // the onboarding consent screen is completed and the toggle is on; EU/EEA/
    // UK/CH installs default the toggle off. Dev builds never send.
    try {
      telemetryInstance = new Telemetry({
        stateDir: app.getPath('userData'),
        country: app.getLocaleCountryCode() || null,
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
      })
      // completeOnboarding tracks the first app_open itself; only already-
      // onboarded installs record subsequent opens here.
      if (telemetryInstance.status().onboarded) telemetryInstance.track('app_open', {})
      setInterval(() => { void telemetryInstance?.flush() }, 5 * 60_000)
    } catch (err) {
      console.error('telemetry init failed (continuing without):', err)
    }
    registerHandlers()
    installApplicationMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (!process.env.VITEST) bootstrap()
