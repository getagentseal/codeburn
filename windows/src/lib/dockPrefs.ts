/// The Capacity Dock's own preferences, from mac/.../Data/CapacityDockPreferences.swift.
///
/// They live in `windows-dock.json` rather than `windows-settings.json` because the rail's
/// placement is already there and the dock reads the file from Rust before the page exists.
/// `codeburn://dock-settings-changed` carries the whole object after every write.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type DockTheme = 'graphite' | 'glass'
export type DockGaugeShape = 'circle' | 'squircle'

export const DOCK_THEMES: Array<{ id: DockTheme; label: string }> = [
  { id: 'graphite', label: 'Graphite' },
  // The mac's second appearance is Liquid Glass. Windows cannot shape its acrylic material:
  // the DWM backdrop is drawn for the whole window rectangle and neither a window region nor
  // the corner preference clips it, and the dock's window is far bigger than the rail it
  // paints. So this is a translucent surface the page draws inside the rail's own outline,
  // which is what "glass" can mean for a shaped window here.
  { id: 'glass', label: 'Glass' },
]

export const DOCK_GAUGE_SHAPES: Array<{ id: DockGaugeShape; label: string }> = [
  { id: 'circle', label: 'Circle' },
  { id: 'squircle', label: 'Squircle' },
]

/// CapacityDockPreferences.scaleRange and its 0.05 step.
export const DOCK_SCALE_MIN = 0.6
export const DOCK_SCALE_MAX = 1.2
export const DOCK_SCALE_STEP = 0.05
/// CapacityDockPreferences.maxAutoProviders.
export const DOCK_MAX_AUTO_PROVIDERS = 5

export type DockPrefs = {
  enabled: boolean
  preferred: string | null
  scale: number
  theme: DockTheme
  gaugeShape: DockGaugeShape
  /// Which providers the rail shows. Empty means nothing has been chosen yet, which is what
  /// lets the dock auto-seed from whatever is connected.
  providers: string[]
  /// Latches once the user edits the provider set, so auto-seeding stops second-guessing them.
  manualSelection: boolean
  /// Keeps every selected ring out at rest instead of collapsing to the resting provider.
  keepExpanded: boolean
}

export const DEFAULT_DOCK_PREFS: DockPrefs = {
  enabled: false,
  preferred: null,
  scale: DOCK_SCALE_MIN,
  theme: 'graphite',
  gaugeShape: 'circle',
  providers: [],
  manualSelection: false,
  keepExpanded: false,
}

export function parseDockPrefs(raw: Record<string, unknown>): DockPrefs {
  const scale = typeof raw.scale === 'number' && Number.isFinite(raw.scale) ? raw.scale : DOCK_SCALE_MIN
  return {
    enabled: raw.enabled === true,
    preferred: typeof raw.preferred === 'string' ? raw.preferred : null,
    scale: Math.min(DOCK_SCALE_MAX, Math.max(DOCK_SCALE_MIN, scale)),
    theme: raw.theme === 'glass' || raw.theme === 'acrylic' ? 'glass' : 'graphite',
    gaugeShape: raw.gaugeShape === 'squircle' ? 'squircle' : 'circle',
    providers: Array.isArray(raw.providers) ? raw.providers.filter((p): p is string => typeof p === 'string') : [],
    manualSelection: raw.manualSelection === true,
    keepExpanded: raw.keepExpanded === true,
  }
}

export async function loadDockPrefs(): Promise<DockPrefs> {
  try {
    return parseDockPrefs(await invoke<Record<string, unknown>>('dock_prefs') ?? {})
  } catch {
    return DEFAULT_DOCK_PREFS
  }
}

/// One write at a time. The command is async on the Rust side, so two writes started together
/// are two tasks that can finish in either order, and a dragged size slider starts one every
/// few pixels: the last value the reader chose could be overwritten by an earlier one, leaving
/// the rail at a size the slider does not show. Writes queue behind each other, and a patch
/// that is still waiting is merged into the one ahead of it rather than costing another round
/// trip, which is also what keeps the rail moving smoothly under the slider.
let writeChain: Promise<DockPrefs> = Promise.resolve(DEFAULT_DOCK_PREFS)
let pending: Partial<DockPrefs> | null = null

export function writeDockPrefs(patch: Partial<DockPrefs>): Promise<DockPrefs> {
  if (pending) {
    Object.assign(pending, patch)
    return writeChain
  }
  const queued: Partial<DockPrefs> = { ...patch }
  pending = queued
  writeChain = writeChain.then(async () => {
    pending = null
    try {
      return parseDockPrefs(await invoke<Record<string, unknown>>('set_dock_prefs', { patch: queued }) ?? {})
    } catch {
      return loadDockPrefs()
    }
  })
  return writeChain
}

export function onDockPrefsChanged(listener: (prefs: DockPrefs) => void): () => void {
  let stop: (() => void) | null = null
  let cancelled = false
  void listen<Record<string, unknown>>('codeburn://dock-settings-changed', event => {
    listener(parseDockPrefs(event.payload ?? {}))
  }).then(fn => {
    if (cancelled) fn()
    else stop = fn
  })
  return () => {
    cancelled = true
    if (stop) stop()
  }
}

/// CapacityDockPreferences.normalizedPreferred: the rail can only rest on a provider it is
/// actually showing, so a resting provider that has left the set gives way to the first one
/// still in it.
export function normalizedPreferred(preferred: string | null, selected: string[]): string | null {
  if (preferred !== null && selected.includes(preferred)) return preferred
  return selected[0] ?? null
}

/// CapacityDockPreferences.autoSeedFromConnected: until the user edits the provider set, the
/// dock mirrors whatever is connected, capped, so a fresh install shows what is actually
/// active rather than nothing. Returns the patch to write, or null when there is nothing to do.
export function autoSeed(prefs: DockPrefs, connected: string[]): Partial<DockPrefs> | null {
  if (prefs.manualSelection) return null
  const desired = connected.slice(0, DOCK_MAX_AUTO_PROVIDERS)
  // Nothing connected yet is a reason to wait, not a reason to empty the dock.
  if (desired.length === 0) return null
  if (desired.length === prefs.providers.length && desired.every((id, i) => prefs.providers[i] === id)) {
    return null
  }
  return { providers: desired, preferred: normalizedPreferred(prefs.preferred, desired) }
}

/// CapacityDockProviderSelection.canDeselect: the rail must never end up with nothing to
/// show, so the last connected provider in the set stays switched on.
export function canDeselect(id: string, selected: string[], isConnected: (id: string) => boolean): boolean {
  if (!selected.includes(id)) return true
  if (!isConnected(id)) return true
  return selected.filter(isConnected).length > 1
}

/// CapacityDockProviderSelection.manageableProviders: everything connected, plus anything
/// already in the set, so a provider whose connection later fails can still be removed.
export function manageableProviders(all: string[], selected: string[], isConnected: (id: string) => boolean): string[] {
  return all.filter(id => selected.includes(id) || isConnected(id))
}
