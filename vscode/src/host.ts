import type { Envelope, Handler } from '../../app/electron/bridge-handlers'
import { FORWARDED_METHODS } from '../../app/renderer/vscode/channels'

/** What only the editor can do for the webview, beside the shared CLI handlers. */
export type EditorActions = {
  chooseDirectory: () => Promise<string | null>
  openExternal: (url: string) => Promise<void>
  openSettings: () => Promise<void>
  setScope: (workspace: boolean) => Promise<void>
}

const ALLOWED = new Set<string>(FORWARDED_METHODS.map(name => `codeburn:${name}`))

/** Only the web, as the desktop's externalUrlToOpen allows: never file:, command: or vscode:. */
export function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Answers one webview call. The webview is untrusted input: a channel outside
 * the forwarded list is refused rather than looked up, so a crafted message can
 * never reach a desktop-only handler.
 */
export function createRouter(handlers: Record<string, Handler>, editor: EditorActions): (channel: unknown, args: unknown) => Promise<Envelope> {
  const local: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    'codeburn:chooseDirectory': () => editor.chooseDirectory(),
    'codeburn:openExternal': async url => { if (isWebUrl(url)) await editor.openExternal(url) },
    'codeburn:openIdeSettings': () => editor.openSettings(),
    'codeburn:setIdeScope': workspace => editor.setScope(workspace === true),
    // The editor's display language decides; the shared config `language` is the desktop's.
    'codeburn:getLanguage': async () => null,
    'codeburn:setLanguage': async () => undefined,
  }
  return async (channel, args) => {
    if (typeof channel !== 'string' || !ALLOWED.has(channel)) {
      return { ok: false, error: { kind: 'bad-args', message: 'unknown channel' } }
    }
    const list = Array.isArray(args) ? args : []
    const own = local[channel]
    if (own) {
      try { return { ok: true, value: await own(...list) } }
      catch (error) { return { ok: false, error: { kind: 'nonzero', message: error instanceof Error ? error.message : String(error) } } }
    }
    const handler = handlers[channel]
    if (!handler) return { ok: false, error: { kind: 'bad-args', message: 'unknown channel' } }
    return handler(...list)
  }
}

/** Unwrap an envelope the way the preload does: the value, or a thrown `{ kind, message }`. */
export async function call<T>(handler: Handler | undefined, ...args: unknown[]): Promise<T> {
  if (!handler) throw { kind: 'bad-args', message: 'unknown channel' }
  const envelope = await handler(...args)
  if (envelope.ok) return envelope.value as T
  throw envelope.error
}
