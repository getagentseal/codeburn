import { app, BrowserWindow, ipcMain, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'

import { CliError, resolveCodeburnPath, spawnCli, spawnCliAction, type ActionResult } from './cli'

// Result envelope: handlers never throw across IPC so the structured error
// `kind` survives contextBridge serialization. preload.ts unwraps it.
export type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; error: { kind: string; message: string } }

function providerArgs(provider: string | undefined): string[] {
  return provider && provider !== 'all' ? ['--provider', provider] : []
}

type DateRange = { from: string; to: string }

function rangeArgs(range: DateRange | undefined): string[] {
  return range ? ['--from', range.from, '--to', range.to] : []
}

function toEnvelopeError(err: unknown): { kind: string; message: string } {
  if (err instanceof CliError) return { kind: err.kind, message: err.message }
  return { kind: 'nonzero', message: err instanceof Error ? err.message : String(err) }
}

type Deps = {
  spawnCli: (args: string[], opts?: { timeoutMs?: number }) => Promise<unknown>
  spawnCliAction: (args: string[], opts?: { timeoutMs?: number }) => Promise<ActionResult>
  resolveCodeburnPath: () => string | null
}

type Handler = (...args: any[]) => Promise<Envelope>

/**
 * Maps every CodeburnBridge channel to its `codeburn` argv (plain args, no
 * shell) and returns a result envelope. Pure + injectable so the wiring is
 * unit-testable without launching Electron.
 */
export function createBridgeHandlers(deps: Deps = { spawnCli, spawnCliAction, resolveCodeburnPath }): Record<string, Handler> {
  const run = (build: (...args: any[]) => string[]): Handler => async (...args: any[]) => {
    try {
      return { ok: true, value: await deps.spawnCli(build(...args)) }
    } catch (err) {
      return { ok: false, error: toEnvelopeError(err) }
    }
  }
  const runAction = (build: (...args: any[]) => string[]): Handler => async (...args: any[]) => {
    try {
      return { ok: true, value: await deps.spawnCliAction(build(...args)) }
    } catch (err) {
      return { ok: false, error: toEnvelopeError(err) }
    }
  }

  return {
    'codeburn:getOverview': run((period: string, provider: string, range?: DateRange) => [
      'status', '--format', 'menubar-json', '--period', period, ...providerArgs(provider), ...rangeArgs(range),
    ]),
    'codeburn:getPlans': run((period: string) => ['status', '--format', 'json', '--period', period]),
    'codeburn:getActReport': run(() => ['act', 'report', '--json']),
    'codeburn:getModels': run((period: string, provider: string, byTask: boolean, range?: DateRange) => [
      'models', '--format', 'json', '--period', period, ...providerArgs(provider), ...(byTask ? ['--by-task'] : []), ...rangeArgs(range),
    ]),
    'codeburn:getSessions': run((period: string, provider: string, range?: DateRange) => [
      'sessions', '--format', 'json', '--period', period, ...providerArgs(provider), ...rangeArgs(range),
    ]),
    'codeburn:getCompareModels': run((period: string, provider: string) => [
      'compare', '--format', 'json', '--period', period, ...providerArgs(provider),
    ]),
    'codeburn:getCompare': run((period: string, provider: string, modelA: string, modelB: string) => [
      'compare', '--format', 'json', '--period', period, ...providerArgs(provider), '--model-a', modelA, '--model-b', modelB,
    ]),
    'codeburn:getYield': run((period: string, range?: DateRange) => [
      'yield', '--format', 'json', '--period', period, ...rangeArgs(range),
    ]),
    'codeburn:getSpendFlow': run((period: string, provider: string, range?: DateRange) => [
      'spend', '--format', 'flow-json', '--period', period, ...providerArgs(provider), ...rangeArgs(range),
    ]),
    'codeburn:getDevices': run((period: string) => ['devices', '--format', 'json', '--period', period]),
    'codeburn:getDevicesScan': run(() => ['devices', 'scan', '--format', 'json']),
    'codeburn:getShareStatus': run(() => ['share', 'status', '--format', 'json']),
    'codeburn:getIdentity': run(() => ['identity', '--format', 'json']),
    'codeburn:getAliases': run(() => ['model-alias', '--list', '--format', 'json']),
    'codeburn:getProxyPaths': run(() => ['proxy-path', '--list', '--format', 'json']),
    'codeburn:setCurrency': runAction((code: string) => ['currency', code]),
    'codeburn:resetCurrency': runAction(() => ['currency', '--reset']),
    'codeburn:addAlias': runAction((from: string, to: string) => ['model-alias', from, to]),
    'codeburn:removeAlias': runAction((from: string) => ['model-alias', '--remove', from]),
    'codeburn:cliStatus': async () => {
      const p = deps.resolveCodeburnPath()
      return { ok: true, value: { found: p !== null, path: p } }
    },
  }
}

function registerHandlers(): void {
  const handlers = createBridgeHandlers()
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => handler(...args))
  }
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
    },
  })

  win.once('ready-to-show', () => win.show())

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  }

  return win
}

function bootstrap(): void {
  void app.whenReady().then(() => {
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
