// Single source of truth for platform-aware shortcut behaviour. The preload
// exposes `window.codeburn.platform` (process.platform); when the bridge is
// absent (unit tests, vite in a plain browser) fall back to the user agent.
// All functions read platform state at call time, never at module load, so
// the preload bridge may appear after this module is imported.

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

/** True when the Electron preload reports darwin (or the UA matches a Mac). */
export function isMacPlatform(): boolean {
  const platform = bridgePlatform()
  if (platform) return platform === 'darwin'
  return userAgentPlatform() === 'darwin'
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
  if (event.altKey || event.shiftKey) return false
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
