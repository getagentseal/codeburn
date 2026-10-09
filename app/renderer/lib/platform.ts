// Single source of truth for platform-aware shortcut behaviour. The preload
// exposes `window.codeburn.platform` (process.platform); when the bridge is
// absent (unit tests, vite in a plain browser) fall back to the user agent.
// All functions read platform state at call time, never at module load, so
// the preload bridge may appear after this module is imported.

import { version } from '../../package.json'

function bridgePlatform(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { codeburn?: { platform?: string } }).codeburn?.platform
}

function userAgentPlatform(): string | undefined {
  if (typeof navigator === 'undefined') return undefined
  if (/mac/i.test(navigator.userAgent)) return 'darwin'
  const platform = navigator.platform
  if (typeof platform === 'string' && /mac/i.test(platform)) return 'darwin'
  return undefined
}

/** True inside the VS Code extension's webview, where the editor owns theme,
 *  language, the chord shortcuts and the refresh cadence. */
export function isIdeHost(): boolean {
  if (typeof window === 'undefined') return false
  return (window as unknown as { codeburn?: { host?: string } }).codeburn?.host === 'vscode'
}

/** The version shown to people: the extension's own inside an editor, where
 *  package.json's is the bundled CLI's, and the app's everywhere else. */
export function displayVersion(): string {
  if (typeof window === 'undefined') return version
  return (window as unknown as { codeburn?: { hostVersion?: string } }).codeburn?.hostVersion || version
}

/** True when the Electron preload reports darwin (or the UA matches a Mac). */
export function isMacPlatform(): boolean {
  const platform = bridgePlatform()
  if (platform) return platform === 'darwin'
  return userAgentPlatform() === 'darwin'
}

/** True when the Electron preload reports win32 (or the UA names Windows). */
export function isWindowsPlatform(): boolean {
  const platform = bridgePlatform()
  if (platform) return platform === 'win32'
  if (typeof navigator === 'undefined') return false
  return /windows/i.test(navigator.userAgent)
}

/** The modifier keycap label: '⌘' on mac, 'Ctrl+' elsewhere. */
export function modKeyLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl+'
}

/** A full shortcut label, e.g. '⌘R' on mac, 'Ctrl+R' on Windows. */
export function shortcutLabel(key: string): string {
  return modKeyLabel() + key
}

/**
 * True when the event is the platform's modifier chord and no other modifier
 * is held. On mac: Meta (Cmd) without Ctrl. Elsewhere: Ctrl without Meta.
 * altKey stays rejected on every platform: AltGr on European layouts arrives
 * as Ctrl+Alt, and Ctrl+Alt+<key> must not hijack a typed character.
 */
export function isModifierChord(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  // Every chord the app binds (1-9, R, B, comma) is already an editor command.
  if (isIdeHost()) return false
  if (event.altKey || event.shiftKey) return false
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
