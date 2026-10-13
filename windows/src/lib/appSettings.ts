/// Every preference the settings window edits, and the one place any surface reads them.
///
/// The store lives in `~/.config/codeburn/windows-settings.json` through the Rust side, not
/// in localStorage, because three windows and the tray all render from it and only a file
/// plus an event can keep them in step. `codeburn://settings-changed` carries the whole
/// object after every write, so a change made in the settings window reaches the popover and
/// the dock without either of them polling.
///
/// Port of the defaults in mac/.../Data/UsageRefreshCadence.swift,
/// Data/SubscriptionRefreshCadence.swift, Security/PreferredTerminal.swift and the
/// AppStore's DisplayMetric / Period / MenubarScope.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { t } from './i18n'
import { readSetting, writeSetting } from './settings'

/// What the tray shows beside the flame. The mac's fifth choice, Credits (Codex), is not
/// here: it reads `current.codexCredits`, which the CLI payload does not carry.
export type DisplayMetric = 'cost' | 'tokens' | 'totalTokens' | 'iconOnly'

export const DISPLAY_METRICS: Array<{ id: DisplayMetric; label: string }> = [
  { id: 'cost', label: 'Cost ($)' },
  { id: 'tokens', label: 'Tokens (up/down)' },
  { id: 'totalTokens', label: 'Total Tokens' },
  { id: 'iconOnly', label: 'Icon Only' },
]

/// Period.menubarMetricCases: the four the tray figure may be measured over.
export type MenubarPeriod = 'today' | 'week' | 'month' | 'all'

export const MENUBAR_PERIODS: Array<{ id: MenubarPeriod; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: '6 Months' },
]

/// Period.menubarSuffix, the compact form the mac appends to the tray figure.
export const MENUBAR_SUFFIX: Record<MenubarPeriod, string> = {
  today: '',
  week: '/wk',
  month: '/mo',
  all: '/6mo',
}

export type MenubarScope = 'local' | 'combined'

export type ThemeChoice = 'system' | 'light' | 'dark'

/// System, then Light, then Dark, then back. The tray item and the popover's More menu both
/// step through this, and both name the state they move to rather than the one they are in.
/// Kept in step by hand with `next_theme` in src-tauri/src/lib.rs, which the tray reads
/// before any webview exists.
export function nextTheme(current: ThemeChoice): ThemeChoice {
  return current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light'
}

/// The English sentence `theme_menu_text` looks up in Rust. The footer and the tray item
/// both name the theme the control moves to, so they have to share this key.
export function themeMenuKey(current: ThemeChoice): string {
  const next = nextTheme(current)
  if (next === 'light') return 'Switch to Light Theme'
  if (next === 'dark') return 'Switch to Dark Theme'
  return 'Switch to System Theme'
}

export function themeCycleLabel(current: ThemeChoice): string {
  return t(themeMenuKey(current))
}

/// UsageRefreshCadence. Auto is the adaptive default, manual never auto-spawns.
export const USAGE_CADENCES: Array<{ id: number; label: string }> = [
  // The mac's label promises "less on battery", which is the adaptive refresh that comes
  // with the data-layer work; this one says what it actually does today.
  { id: -1, label: 'Auto (2m, less on battery)' },
  { id: 0, label: 'Manual' },
  { id: 60, label: '1 minute' },
  { id: 300, label: '5 minutes' },
  { id: 900, label: '15 minutes' },
]

/// SubscriptionRefreshCadence, which the quota store polls on.
export const QUOTA_CADENCES: Array<{ id: number; label: string }> = [
  { id: 0, label: 'Manual' },
  { id: 60, label: '1 minute' },
  { id: 120, label: '2 minutes' },
  { id: 300, label: '5 minutes' },
  { id: 900, label: '15 minutes' },
]

/// PreferredTerminal, with the Windows consoles that can hold a command open in a live
/// window. Detection of what is actually installed happens in Rust.
export type TerminalId = 'windowsTerminal' | 'powershell' | 'commandPrompt'

export const TERMINALS: Array<{ id: TerminalId; label: string }> = [
  { id: 'windowsTerminal', label: 'Windows Terminal' },
  { id: 'powershell', label: 'Windows PowerShell' },
  { id: 'commandPrompt', label: 'Command Prompt' },
]

export type AppSettings = {
  metric: DisplayMetric
  menubarPeriod: MenubarPeriod
  menubarScope: MenubarScope
  accent: string
  theme: ThemeChoice
  trayBadge: boolean
  usageRefreshSeconds: number
  quotaCadenceSeconds: number
  terminal: TerminalId
}

export const DEFAULT_SETTINGS: AppSettings = {
  metric: 'cost',
  menubarPeriod: 'today',
  menubarScope: 'local',
  accent: 'ember',
  theme: 'system',
  // Off by default: a second tray icon for the number reads as clutter beside the logo, so
  // the figure lives in the tooltip and the menu until someone asks for it.
  trayBadge: false,
  usageRefreshSeconds: -1,
  quotaCadenceSeconds: 120,
  terminal: 'windowsTerminal',
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function oneOfNumber(value: unknown, allowed: number[], fallback: number): number {
  return typeof value === 'number' && allowed.includes(value) ? value : fallback
}

/// A stored value the current build no longer understands (an older release, a hand-edited
/// file) collapses to the default rather than reaching a switch that cannot handle it.
export function parseSettings(raw: Record<string, unknown>): AppSettings {
  return {
    metric: oneOf(raw.metric, DISPLAY_METRICS.map(m => m.id), DEFAULT_SETTINGS.metric),
    menubarPeriod: oneOf(raw.menubarPeriod, MENUBAR_PERIODS.map(p => p.id), DEFAULT_SETTINGS.menubarPeriod),
    menubarScope: oneOf(raw.menubarScope, ['local', 'combined'] as const, DEFAULT_SETTINGS.menubarScope),
    accent: typeof raw.accent === 'string' ? raw.accent : DEFAULT_SETTINGS.accent,
    theme: oneOf(raw.theme, ['system', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    trayBadge: typeof raw.trayBadge === 'boolean' ? raw.trayBadge : DEFAULT_SETTINGS.trayBadge,
    usageRefreshSeconds: oneOfNumber(raw.usageRefreshSeconds, USAGE_CADENCES.map(c => c.id), DEFAULT_SETTINGS.usageRefreshSeconds),
    quotaCadenceSeconds: oneOfNumber(raw.quotaCadenceSeconds, QUOTA_CADENCES.map(c => c.id), DEFAULT_SETTINGS.quotaCadenceSeconds),
    terminal: oneOf(raw.terminal, TERMINALS.map(term => term.id), DEFAULT_SETTINGS.terminal),
  }
}

type Listener = (settings: AppSettings) => void

let current: AppSettings = DEFAULT_SETTINGS
let listeners: Listener[] = []
let loaded = false
let loading: Promise<AppSettings> | null = null
let unlisten: (() => void) | null = null

function publish(next: AppSettings) {
  current = next
  for (const listener of listeners) listener(current)
}

/// The theme and the accent were kept in localStorage before this window existed. Reading
/// them once, when the file has nothing to say, means an upgrade does not reset the colours
/// somebody chose.
function migrated(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw }
  if (next.accent === undefined) {
    const saved = readSetting('accent')
    if (saved) next.accent = saved
  }
  if (next.theme === undefined) {
    const saved = readSetting('theme')
    if (saved === 'dark' || saved === 'light') next.theme = saved
  }
  if (next.trayBadge === undefined) {
    // The badge used to default on; anyone who chose either way keeps their choice.
    const saved = readSetting('trayBadge')
    if (saved === 'on') next.trayBadge = true
    if (saved === 'off') next.trayBadge = false
  }
  return next
}

export async function loadSettings(): Promise<AppSettings> {
  if (loading) return loading
  loading = (async () => {
    try {
      const raw = await invoke<Record<string, unknown>>('settings_load')
      publish(parseSettings(migrated(raw ?? {})))
    } catch {
      publish(DEFAULT_SETTINGS)
    }
    loaded = true
    return current
  })()
  return loading
}

/// Writes only the keys that changed. Rust merges and broadcasts, so the local update below
/// is only there to keep the control that was clicked from lagging a round trip behind.
export async function writeSettings(patch: Partial<AppSettings>): Promise<void> {
  publish({ ...current, ...patch })
  try {
    const merged = await invoke<Record<string, unknown>>('settings_patch', { patch })
    publish(parseSettings(merged ?? {}))
  } catch {
    // A failed write leaves the optimistic value on screen; the next load corrects it.
  }
}

/// Mirrors the popover's own writes (theme, accent, tray badge) into the store so the
/// settings window shows what the popover just did.
export function subscribeSettings(listener: Listener): () => void {
  listeners.push(listener)
  listener(current)
  if (!loaded) void loadSettings()
  if (listeners.length === 1) {
    void listen<Record<string, unknown>>('codeburn://settings-changed', event => {
      publish(parseSettings(event.payload ?? {}))
    }).then(fn => { unlisten = fn })
  }
  return () => {
    listeners = listeners.filter(l => l !== listener)
    if (listeners.length === 0 && unlisten) {
      unlisten()
      unlisten = null
    }
  }
}

/// The accent and the theme are applied before the first paint, which a round trip to Rust
/// cannot be. localStorage stays as that fast cache; the file is the source of truth and
/// this keeps the two the same.
export function cacheThemeAndAccent(settings: AppSettings): void {
  writeSetting('accent', settings.accent)
  writeSetting('theme', settings.theme === 'system' ? null : settings.theme)
}
