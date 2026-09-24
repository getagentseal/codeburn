// The tray app's own preferences, read and written from the desktop app.
//
// The tray app (windows/) keeps them in two files that it reads from Rust before any of its
// windows exist, so those files are the interface rather than any running process:
//
//   ~/.config/codeburn/windows-settings.json   everything only the tray app cares about
//   ~/.config/codeburn/windows-dock.json       the Capacity Dock, whose placement lives here too
//
// Both hold keys this side has no business touching (the rail's placement, the tray app's
// theme cache), so every write is a merge of the named keys into whatever is already there.
// And every value is checked against the same closed set the tray app parses it with
// (windows/src/lib/appSettings.ts, windows/src/lib/dockPrefs.ts): a value it cannot
// understand collapses to a default there, so sending one would silently lose the setting.
//
// After a write the tray app is nudged with `--reload-settings`, which makes it re-read both
// files and broadcast to its own windows. That is done by the caller, which owns the process.

import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export type TraySettingsFile = 'app' | 'dock'

function filePath(file: TraySettingsFile, home: string): string {
  return join(home, '.config', 'codeburn', file === 'app' ? 'windows-settings.json' : 'windows-dock.json')
}

/**
 * Write a file the tray app reads, without ever showing it a half-written one.
 *
 * `writeFileSync` truncates the target and then fills it, and the tray app reads these files
 * on a schedule of its own and again on every `--reload-settings`. A read landing between the
 * two sees an empty or cut-off file, parses it as no preferences at all, and every setting in
 * it collapses to a default. So the bytes go to a temp file in the same directory first, and
 * the rename over the target is the only step a reader can observe: it gets the whole old
 * file or the whole new one. The same directory matters, because a rename across volumes is
 * a copy, and a copy is not atomic.
 *
 * Nothing is left behind when the rename cannot happen, and the failure is passed on rather
 * than swallowed: a settings write that did not land must not read as one that did.
 */
export function writeFileAtomic(path: string, contents: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, contents, { mode })
    renameOnto(temp, path)
  } catch (err) {
    try { unlinkSync(temp) } catch { /* nothing to clean up */ }
    throw err
  }
}

/** How long a replace may spend waiting out a reader before the write is reported as failed:
 *  ten tries about 20ms apart, so roughly 200ms in the worst case. A read of one of these files
 *  is a few microseconds of open file, so anything near this budget is not a reader at all. */
const RENAME_ATTEMPTS = 10
const RENAME_RETRY_MS = 20

/**
 * The rename half of the write, retried briefly on a Windows sharing violation.
 *
 * Readers of these files take no lock, on this side or the tray app's, and on POSIX that costs
 * nothing: a rename over a file somebody has open always succeeds, and the reader keeps reading
 * the file it opened. Windows refuses instead, with EPERM or EACCES, whenever something else
 * holds the target open without having agreed to its deletion, and a scanner that opened the
 * file behind our back does it just as well as one of our own processes. That is transient by
 * nature, so it is waited out rather than reported as a write that did not land, which would be
 * the very lost update the lock around this exists to prevent. The lock is already held here, so
 * the wait can only ever be on a reader, never on another writer.
 *
 * Once the budget is out the original error is thrown, unchanged, and the caller cleans up.
 */
function renameOnto(temp: string, path: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const sharingViolation = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (process.platform !== 'win32' || !sharingViolation || attempt >= RENAME_ATTEMPTS) throw err
      sleepSync(RENAME_RETRY_MS)
    }
  }
}

/** Lock-free by design: the writer renames a whole file into place, so this sees the old file
 *  or the new one and never a torn one. What it costs is paid on the writer's side, where a read
 *  overlapping a replace is a failure Windows reports rather than waits out; see
 *  {@link writeFileAtomic}. */
export function readTrayFile(file: TraySettingsFile, home = homedir()): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(file, home), 'utf8').replace(/^﻿/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

// Cross-process preference lock -------------------------------------------------------------
//
// windows-settings.json and windows-dock.json are each owned by two processes at once: this
// desktop app and the Windows tray app. Both do a read / modify / write to merge their own keys
// into whatever the other last stored. The atomic rename each already does stops a torn file,
// but not a lost update: two writers read the same state, change different keys, and the later
// rename erases the earlier writer's key, so a dock placement, an enabled switch, a provider
// choice or a scale silently reverts. This lock serializes the whole cycle so that never
// happens. The tray app runs the same protocol from Rust; the single write-up lives in
// windows/src-tauri/src/settings.rs (`prefs_lock`). The essentials, so both sides stay in step:
//
//   Lock file:  sibling of the target named `.<stem>.lock` (windows-dock.json ->
//               `.windows-dock.lock`).
//   Body:       one line of JSON, `{"pid":<os pid>,"at":<unix ms>}`.
//   Acquire:    exclusive create ('wx'). On success keep the handle open for the whole cycle.
//               On collision take the lock over only if abandoned, else poll until a short wait
//               budget runs out and then throw rather than write behind the holder.
//   Abandoned:  its mtime is older than the stale window (a crashed holder never refreshes it),
//               OR its recorded pid is not ours and no longer alive. A live holder is neither.
//   Takeover:   removing an abandoned lock is itself arbitrated, by an exclusive create of
//               `<lock>.takeover`. Only its winner may unlink the lock, and only after
//               re-checking that the lock is still abandoned. See `reclaimAbandoned`.
//   Release:    close the handle and unlink, unless it now carries a different pid.

const LOCK_POLL_MS = 50
const LOCK_WAIT_MS = 2_000
const LOCK_STALE_MS = 30_000

export type TrayLockOptions = { waitMs?: number; pollMs?: number; staleMs?: number }

function lockPathFor(target: string): string {
  const stem = basename(target).replace(/\.json$/, '')
  return join(dirname(target), `.${stem}.lock`)
}

// A synchronous sleep, so the whole lock stays synchronous and callers of patchTrayFile do not
// have to become async. Atomics.wait blocks this thread without spinning the CPU.
const lockSleepBuffer = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(lockSleepBuffer, 0, 0, ms)
}

// Signal-0 style liveness. A false "alive" (a reused pid) only delays recovery to the age gate;
// a false "dead" is the dangerous direction, so our own pid and anything unprobeable read alive.
function holderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

function lockAbandoned(lockPath: string, staleMs: number): boolean {
  let mtimeMs: number
  try { mtimeMs = statSync(lockPath).mtimeMs }
  catch { return false } // vanished between the failed create and this check; just retry create
  if (Date.now() - mtimeMs > staleMs) return true
  let pid: number | undefined
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }
    if (typeof parsed?.pid === 'number') pid = parsed.pid
  } catch { /* empty or unparseable body: only the age gate can free it */ }
  return pid !== undefined && pid !== process.pid && !holderAlive(pid)
}

/**
 * Remove an abandoned lock, but only as the one process entitled to. Two contenders that both
 * find the same stale lock would otherwise both unlink it: the first has already replaced it
 * with a lock of its own, and the second's unlink deletes that fresh one, so both walk away
 * holding the file. Windows usually hides this, because a lock a live holder still has open
 * will not unlink at all, but this protocol is also run on Linux and macOS, where the unlink
 * always succeeds.
 *
 * So the removal is arbitrated by the same primitive the lock itself uses: an exclusive create
 * of `<lock>.takeover`. Its winner alone may unlink, and only after re-checking staleness under
 * that right, because a rival may have reclaimed already and now hold a lock that is not
 * abandoned and not ours to remove. The takeover file is dropped on every path out, and never
 * held across the wait; one left behind by a reclaimer that died is freed by the same staleness
 * rule as the lock.
 *
 * Returns whether the caller should retry the exclusive create at once.
 */
function reclaimAbandoned(lockPath: string, staleMs: number): boolean {
  const takeoverPath = `${lockPath}.takeover`
  let fd: number
  try {
    fd = openSync(takeoverPath, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Somebody else is reclaiming, or a dead reclaimer left this behind. The lock itself is
    // never touched from here; the most this does is free the takeover file for a later try.
    if (lockAbandoned(takeoverPath, staleMs)) {
      try { unlinkSync(takeoverPath) } catch { /* already gone */ }
    }
    return false
  }
  try {
    try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })) } catch { /* advisory */ }
    if (!lockAbandoned(lockPath, staleMs)) return false
    try { unlinkSync(lockPath) } catch { return false }
    return true
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(takeoverPath) } catch { /* already gone */ }
  }
}

/**
 * Take the cross-process lock for `target`, returning the open descriptor to release. Throws if
 * the lock stays held past the wait budget rather than writing behind the holder, so a contended
 * write is reported to the caller instead of being silently lost.
 */
export function acquireTrayFileLock(target: string, options: TrayLockOptions = {}): number {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  mkdirSync(dirname(target), { recursive: true })
  const lockPath = lockPathFor(target)
  const body = JSON.stringify({ pid: process.pid, at: Date.now() })
  const deadline = Date.now() + waitMs
  for (;;) {
    let fd: number
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // A successful reclaim means the holder was genuinely abandoned and this process won the
      // right to remove its lock; retry the create at once. Anything else (a live holder, a
      // contender already reclaiming, an unlink that failed) falls through to the wait.
      if (lockAbandoned(lockPath, staleMs) && reclaimAbandoned(lockPath, staleMs)) continue
      if (Date.now() >= deadline) {
        throw new Error(
          `could not lock ${basename(lockPath)} within ${waitMs}ms; another process is writing ` +
          `${basename(target)}, so nothing was changed`,
        )
      }
      sleepSync(pollMs)
      continue
    }
    // The body is advisory; even if this write fails we still hold the lock the create just won.
    try { writeSync(fd, body) } catch { /* body is advisory */ }
    return fd
  }
}

/** Close the descriptor and remove the lock, unless it now carries a successor's pid. */
export function releaseTrayFileLock(target: string, fd: number): void {
  const lockPath = lockPathFor(target)
  try { closeSync(fd) } catch { /* already closed */ }
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }
    // A different pid means we were taken over (only possible past the stale window); leave it.
    if (typeof parsed?.pid === 'number' && parsed.pid !== process.pid) return
  } catch { /* empty or unparseable: it is the one we just made, so remove it */ }
  try { unlinkSync(lockPath) } catch { /* already gone */ }
}

/** Merge the given keys into the file, leaving every other key the tray app owns alone. */
export function patchTrayFile(
  file: TraySettingsFile,
  patch: Record<string, unknown>,
  home = homedir(),
): Record<string, unknown> {
  const target = filePath(file, home)
  // The whole read/modify/write is serialized against the tray app. See the protocol above.
  const fd = acquireTrayFileLock(target)
  try {
    const merged = { ...readTrayFile(file, home), ...patch }
    writeFileAtomic(target, `${JSON.stringify(merged, null, 2)}\n`)
    return merged
  } finally {
    releaseTrayFileLock(target, fd)
  }
}

// What each setting may be -----------------------------------------------------------------

export const DISPLAY_METRICS = ['cost', 'tokens', 'totalTokens', 'iconOnly'] as const
export const MENUBAR_PERIODS = ['today', 'week', 'month', 'all'] as const
export const ACCENTS = ['ember', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite'] as const
export const USAGE_CADENCES = [-1, 0, 60, 300, 900] as const
export const QUOTA_CADENCES = [0, 60, 120, 300, 900] as const
export const TERMINALS = ['windowsTerminal', 'powershell', 'commandPrompt'] as const
export const DOCK_THEMES = ['graphite', 'glass'] as const
export const DOCK_GAUGE_SHAPES = ['circle', 'squircle'] as const
export const DOCK_SCALE_MIN = 0.6
export const DOCK_SCALE_MAX = 1.2
export const DOCK_SCALE_STEP = 0.05

export type TrayAppPrefs = {
  metric: string
  menubarPeriod: string
  accent: string
  trayBadge: boolean
  usageRefreshSeconds: number
  quotaCadenceSeconds: number
  terminal: string
}

export type TrayDockPrefs = {
  enabled: boolean
  preferred: string | null
  scale: number
  theme: string
  gaugeShape: string
  providers: string[]
  manualSelection: boolean
}

export const DEFAULT_TRAY_APP_PREFS: TrayAppPrefs = {
  metric: 'cost',
  menubarPeriod: 'today',
  accent: 'ember',
  trayBadge: false,
  usageRefreshSeconds: -1,
  quotaCadenceSeconds: 120,
  terminal: 'windowsTerminal',
}

export const DEFAULT_TRAY_DOCK_PREFS: TrayDockPrefs = {
  enabled: false,
  preferred: null,
  scale: DOCK_SCALE_MIN,
  theme: 'graphite',
  gaugeShape: 'circle',
  providers: [],
  manualSelection: false,
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback
}

/** The same reading the tray app does, so what the pane shows is what the tray app sees. */
export function parseTrayAppPrefs(raw: Record<string, unknown>): TrayAppPrefs {
  return {
    metric: oneOf(raw.metric, DISPLAY_METRICS, DEFAULT_TRAY_APP_PREFS.metric),
    menubarPeriod: oneOf(raw.menubarPeriod, MENUBAR_PERIODS, DEFAULT_TRAY_APP_PREFS.menubarPeriod),
    accent: oneOf(raw.accent, ACCENTS, DEFAULT_TRAY_APP_PREFS.accent),
    trayBadge: typeof raw.trayBadge === 'boolean' ? raw.trayBadge : DEFAULT_TRAY_APP_PREFS.trayBadge,
    usageRefreshSeconds: oneOf(raw.usageRefreshSeconds, USAGE_CADENCES, DEFAULT_TRAY_APP_PREFS.usageRefreshSeconds),
    quotaCadenceSeconds: oneOf(raw.quotaCadenceSeconds, QUOTA_CADENCES, DEFAULT_TRAY_APP_PREFS.quotaCadenceSeconds),
    terminal: oneOf(raw.terminal, TERMINALS, DEFAULT_TRAY_APP_PREFS.terminal),
  }
}

/** The rail's scale is a slider, so it is clamped and snapped rather than picked from a set. */
export function normalizeScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TRAY_DOCK_PREFS.scale
  const clamped = Math.min(DOCK_SCALE_MAX, Math.max(DOCK_SCALE_MIN, value))
  const steps = Math.round((clamped - DOCK_SCALE_MIN) / DOCK_SCALE_STEP)
  return Number((DOCK_SCALE_MIN + steps * DOCK_SCALE_STEP).toFixed(2))
}

export function parseTrayDockPrefs(raw: Record<string, unknown>): TrayDockPrefs {
  return {
    enabled: raw.enabled === true,
    preferred: typeof raw.preferred === 'string' ? raw.preferred : null,
    scale: normalizeScale(raw.scale),
    // `acrylic` is the spelling the setting had before the appearance was renamed Glass.
    theme: raw.theme === 'glass' || raw.theme === 'acrylic' ? 'glass' : 'graphite',
    gaugeShape: oneOf(raw.gaugeShape, DOCK_GAUGE_SHAPES, DEFAULT_TRAY_DOCK_PREFS.gaugeShape),
    providers: Array.isArray(raw.providers) ? raw.providers.filter((id): id is string => typeof id === 'string') : [],
    manualSelection: raw.manualSelection === true,
  }
}

/** Provider ids are the CLI's own, and they end up in a file the tray app parses. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Whether a patch is a shape the key checks below can be run against at all.
 *
 * These patches arrive over IPC, so what turns up is whatever the renderer sent rather than
 * what the type says. `'metric' in patch` throws a TypeError on a string, a number or null,
 * and on an array it answers about indices, so the shape is settled before any key is read
 * out of it. Nothing but a plain object can carry a setting, so everything else is dropped.
 */
export function isPatchObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep only the keys this pane is allowed to write, each checked against what the tray app
 * can read back. Anything else in the patch is dropped rather than merged, so a renderer
 * cannot reach the rail's placement or any other key the tray app owns.
 */
export function sanitizeAppPatch(patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isPatchObject(patch)) return out
  if ('metric' in patch) out.metric = oneOf(patch.metric, DISPLAY_METRICS, DEFAULT_TRAY_APP_PREFS.metric)
  if ('menubarPeriod' in patch) out.menubarPeriod = oneOf(patch.menubarPeriod, MENUBAR_PERIODS, DEFAULT_TRAY_APP_PREFS.menubarPeriod)
  if ('accent' in patch) out.accent = oneOf(patch.accent, ACCENTS, DEFAULT_TRAY_APP_PREFS.accent)
  if ('trayBadge' in patch) out.trayBadge = patch.trayBadge === true
  if ('usageRefreshSeconds' in patch) out.usageRefreshSeconds = oneOf(patch.usageRefreshSeconds, USAGE_CADENCES, DEFAULT_TRAY_APP_PREFS.usageRefreshSeconds)
  if ('quotaCadenceSeconds' in patch) out.quotaCadenceSeconds = oneOf(patch.quotaCadenceSeconds, QUOTA_CADENCES, DEFAULT_TRAY_APP_PREFS.quotaCadenceSeconds)
  if ('terminal' in patch) out.terminal = oneOf(patch.terminal, TERMINALS, DEFAULT_TRAY_APP_PREFS.terminal)
  return out
}

export function sanitizeDockPatch(patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isPatchObject(patch)) return out
  if ('enabled' in patch) out.enabled = patch.enabled === true
  if ('scale' in patch) out.scale = normalizeScale(patch.scale)
  if ('theme' in patch) out.theme = patch.theme === 'glass' ? 'glass' : 'graphite'
  if ('gaugeShape' in patch) out.gaugeShape = oneOf(patch.gaugeShape, DOCK_GAUGE_SHAPES, DEFAULT_TRAY_DOCK_PREFS.gaugeShape)
  if ('preferred' in patch) {
    out.preferred = typeof patch.preferred === 'string' && PROVIDER_ID.test(patch.preferred) ? patch.preferred : null
  }
  if ('providers' in patch) {
    const providers = Array.isArray(patch.providers)
      ? patch.providers.filter((id): id is string => typeof id === 'string' && PROVIDER_ID.test(id))
      : []
    out.providers = providers
    // Editing the set by hand is what stops the tray app auto-seeding it from whatever is
    // connected, exactly as its own settings window latches it.
    out.manualSelection = true
  }
  return out
}

/**
 * The rail can only rest on a provider it is showing, so a resting provider that has left the
 * set gives way to the first one still in it. CapacityDockPreferences.normalizedPreferred.
 */
export function normalizedPreferred(preferred: string | null, selected: string[]): string | null {
  if (preferred !== null && selected.includes(preferred)) return preferred
  return selected[0] ?? null
}

/**
 * The rail must never end up with nothing to show, so the last connected provider in the set
 * cannot be switched off. CapacityDockProviderSelection.canDeselect.
 */
export function canDeselect(id: string, selected: string[], connected: readonly string[]): boolean {
  if (!selected.includes(id)) return true
  if (!connected.includes(id)) return true
  return selected.filter(entry => connected.includes(entry)).length > 1
}
