import type { CodeburnBridge, IdeCommand, ScanProgressEvent, UpdateStatus } from '../lib/types'
import { FORWARDED_METHODS, type HostMessage, type WebviewMessage } from './channels'

export type VsCodeApi = { postMessage(message: WebviewMessage): void }

/** What the extension host writes into the page before any script runs. */
export type Boot = {
  view: 'dashboard' | 'sidebar'
  /** The extension's own version, not the bundled CLI's. */
  version: string
  platform: string
  arch: string
  locale: string
  scope: { workspace: boolean; label: string | null; id: string }
  /** Renderer localStorage keys the editor's settings own, rewritten every boot. */
  seed: Record<string, string>
  command?: IdeCommand
}

export function readBoot(doc: Document = document): Boot {
  const node = doc.getElementById('codeburn-boot')
  return JSON.parse(node?.textContent ?? '{}') as Boot
}

/**
 * localStorage keyed per scope. Every window of every workspace shares the one
 * webview origin, and the renderer persists whole reports there: without a
 * prefix, one workspace's cached views would paint in another's dashboard.
 */
export function scopedStorage(base: Storage, prefix: string): Storage {
  const own = (): string[] => {
    const keys: string[] = []
    for (let index = 0; index < base.length; index++) {
      const key = base.key(index)
      if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length))
    }
    return keys
  }
  return {
    get length() { return own().length },
    key: (index: number) => own()[index] ?? null,
    getItem: (key: string) => base.getItem(prefix + key),
    setItem: (key: string, value: string) => base.setItem(prefix + key, value),
    removeItem: (key: string) => base.removeItem(prefix + key),
    clear: () => { for (const key of own()) base.removeItem(prefix + key) },
  }
}

export function installScopedStorage(win: Window, prefix: string): Storage | null {
  let base: Storage
  try { base = win.localStorage } catch { return null }
  const storage = scopedStorage(base, prefix)
  try {
    Object.defineProperty(win, 'localStorage', { configurable: true, get: () => storage })
  } catch { return null }
  return storage
}

/** VS Code marks the body with its theme kind; the renderer reads `data-theme`. */
export function themeFromBody(body: HTMLElement): { theme: 'light' | 'dark'; highContrast: boolean } {
  const list = body.classList
  const highContrast = list.contains('vscode-high-contrast') || list.contains('vscode-high-contrast-light')
  const light = list.contains('vscode-light') || list.contains('vscode-high-contrast-light')
  return { theme: light ? 'light' : 'dark', highContrast }
}

export function followEditorTheme(doc: Document, storage: Storage | null): void {
  const apply = () => {
    const { theme, highContrast } = themeFromBody(doc.body)
    doc.documentElement.setAttribute('data-theme', theme)
    if (highContrast) doc.documentElement.setAttribute('data-contrast', 'high')
    else doc.documentElement.removeAttribute('data-contrast')
    try { storage?.setItem('codeburn.theme', theme) } catch { /* storage can be unavailable */ }
  }
  apply()
  new MutationObserver(apply).observe(doc.body, { attributes: true, attributeFilter: ['class'] })
}

const NO_UPDATE: UpdateStatus = { currentVersion: '', latestVersion: null, updateAvailable: false, tag: null }

/** `window.codeburn` over postMessage. Same shape the Electron preload exposes. */
export function createBridge(api: VsCodeApi, boot: Boot, win: Window): CodeburnBridge {
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  const progress = new Set<(event: ScanProgressEvent) => void>()
  const commands = new Set<(command: IdeCommand) => void>()
  const queued: IdeCommand[] = boot.command ? [boot.command] : []

  win.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as HostMessage
    if (!message || typeof message !== 'object') return
    if (message.type === 'result') {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.envelope.ok) waiter.resolve(message.envelope.value)
      else waiter.reject(message.envelope.error)
    } else if (message.type === 'progress') {
      for (const cb of progress) cb(message.event as ScanProgressEvent)
    } else if (message.type === 'command') {
      if (commands.size === 0) queued.push(message.command)
      for (const cb of commands) cb(message.command)
    }
  })

  const invoke = (channel: string, args: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    api.postMessage({ type: 'invoke', id, channel, args })
  })

  const forwarded = Object.fromEntries(FORWARDED_METHODS.map(name => [name, (...args: unknown[]) => invoke(`codeburn:${name}`, args)]))

  return {
    ...forwarded,
    host: 'vscode',
    hostVersion: boot.version,
    platform: boot.platform,
    arch: boot.arch,
    appLocale: boot.locale,
    ideScope: { workspace: boot.scope.workspace, label: boot.scope.label },
    onProgress: (cb: (event: ScanProgressEvent) => void) => { progress.add(cb); return () => { progress.delete(cb) } },
    onIdeCommand: (cb: (command: IdeCommand) => void) => {
      commands.add(cb)
      for (const command of queued.splice(0)) cb(command)
      return () => { commands.delete(cb) }
    },
    getUpdateStatus: async () => NO_UPDATE,
    onUpdateStatus: () => () => {},
    powerStatus: async () => false,
    onPowerStatus: () => () => {},
    telemetryStatus: async () => null,
    setTelemetryEnabled: async () => null,
    completeOnboarding: async () => null,
    telemetryTrack: async () => true,
  } as unknown as CodeburnBridge
}

/** Wire everything up before the renderer's modules read `window.codeburn`. */
export function installBridge(win: Window & { acquireVsCodeApi?: () => VsCodeApi }): { boot: Boot; api: VsCodeApi } {
  const boot = readBoot(win.document)
  const api = win.acquireVsCodeApi!()
  const storage = installScopedStorage(win, `${boot.scope.workspace ? boot.scope.id : 'all'}|`)
  if (storage) {
    for (const [key, value] of Object.entries(boot.seed ?? {})) {
      try { storage.setItem(key, value) } catch { /* storage can be unavailable */ }
    }
  }
  win.document.documentElement.setAttribute('data-host', 'vscode')
  followEditorTheme(win.document, storage)
  ;(win as unknown as { codeburn: CodeburnBridge }).codeburn = createBridge(api, boot, win)
  return { boot, api }
}
