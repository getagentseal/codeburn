import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CliError, DESKTOP_COLD_TIMEOUT_MS, PROGRESS_LINE_PREFIX, type ActionResult, type SpawnPriority } from './cli'
import type { CompanionStatus, MenubarCompanion } from './menubar'
import { NO_MAC_MENUBAR, type MacMenubar } from './mac-menubar'
import { readOptimizeSnapshot, sameLocalDay, writeOptimizeSnapshot, type OptimizeBlock, type OptimizeSnapshot } from './optimize-store'
import { sanitizeError, type getQuota } from './quota'
import { cliErrorReason, durationBucket, type Telemetry } from './telemetry'
import type { UpdateStatus } from './updates'

// The IPC bridge's channel -> argv mapping, free of any `electron` import so a
// non-Electron host (the VS Code extension) can run the same handlers.


/** What the companion card reads on a platform that has no tray app to bundle. */
export const NO_COMPANION: CompanionStatus = {
  supported: false, menuBar: false, sidebar: false, store: false,
  canInstall: false, installed: false, running: false, version: null, outdated: false,
}
/** The discrete-action fallback (install/quit/uninstall) where there is no companion. */
export const NO_COMPANION_ACTION = { ok: false, error: null, status: NO_COMPANION }

/** The slice of Telemetry the bridge handlers use — injectable for tests. */
export type TelemetryBridge = Pick<Telemetry, 'status' | 'setEnabled' | 'completeOnboarding' | 'track'>

export const NO_UPDATE_STATUS: UpdateStatus = { currentVersion: '', latestVersion: null, updateAvailable: false, tag: null }

// Result envelope: handlers never throw across IPC so the structured error
// `kind` survives contextBridge serialization. preload.ts unwraps it.
export type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; error: { kind: string; message: string; cold?: true; stage?: string } }

// The first overview fetch after boot hydrates a cold cache from scratch (a full
// history parse). That can far exceed the 45s read timeout, and killing it means
// the cache never persists, so every later poll restarts the scan — perpetual
// slowness. Give the first (cold) overview a long window; revert to the default
// once it succeeds. Sections gate their own first poll on this one resolving so
// the cold hydration runs ONCE, not once per section in parallel.
const WARMUP_TIMEOUT_MS = DESKTOP_COLD_TIMEOUT_MS

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

function providerArgs(provider: string | undefined): string[] {
  return provider && provider !== 'all' ? ['--provider', provider] : []
}

/** Include/exclude patterns scoping every CLI fetch the app makes. */
export type ProjectFilter = { project: string[]; exclude: string[] }

const EMPTY_PROJECT_FILTER: ProjectFilter = { project: [], exclude: [] }

/**
 * The saved project filter narrowed to these paths. Its excludes still apply;
 * its includes give way, since the paths already name the projects shown.
 */
export function scopeFilter(paths: readonly string[]): (filter: ProjectFilter) => ProjectFilter {
  return filter => paths.length === 0 ? filter : { project: [...paths], exclude: filter.exclude }
}

// A file rather than a build-time constant so it toggles without rebuilding,
// and it lives here, not in renderer storage, because this is where the argv is
// assembled. Re-read whenever the file changes, so a hand edit lands.
let appFilterCache: { path: string; stamp: string; filter: ProjectFilter } | null = null

/**
 * CODEBURN_APP_FILTER overrides the location; an empty string disables the
 * filter outright, which is what the test suite sets so a filter file in the
 * developer's own home cannot reach the assertions.
 */
function appFilterPath(): string | null {
  const override = process.env.CODEBURN_APP_FILTER
  if (override !== undefined) return override.trim() === '' ? null : override
  return path.join(os.homedir(), '.config', 'codeburn', 'app-filter.json')
}

/// Drops blanks and duplicates. A leading "-" is KEPT: Claude encodes a project
/// directory as "-Users-me-Web-thing", which is most real projects.
function normalizePatterns(value: unknown): string[] {
  // A hand-edit writes one pattern as a bare string; dropping it would unhide.
  const entries = typeof value === 'string' ? [value] : value
  if (!Array.isArray(entries)) return []
  const patterns = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const pattern = expandTilde(entry.trim())
    if (pattern === '') continue
    patterns.add(pattern)
  }
  return [...patterns]
}

/// A pattern typed into the pane has no shell behind it, so "~/work/app" is
/// expanded here, on the way in and on the way out of the file. The renderer
/// has no home directory of its own, and a tilde it cannot resolve would make
/// its switches disagree with the argv this process writes.
function expandTilde(pattern: string): string {
  const raw = pattern.replace(/\\/g, '/')
  if (raw !== '~' && !raw.startsWith('~/')) return pattern
  return os.homedir().replace(/\\/g, '/') + raw.slice(1)
}

function normalizeProjectFilter(value: unknown): ProjectFilter {
  const raw = (value ?? {}) as { project?: unknown; exclude?: unknown }
  return { project: normalizePatterns(raw.project), exclude: normalizePatterns(raw.exclude) }
}

/// A read that failed is NOT an empty filter. Answering with one would run the
/// next fetch unfiltered and paint the projects the file exists to hide, which
/// is the single outcome this pane must never produce. Callers surface this as
/// a panel error instead, so the screen stays empty until the file is readable.
function unreadableFilter(error: unknown): CliError {
  const code = (error as NodeJS.ErrnoException).code
  return new CliError('nonzero', `Could not read the project filter${code ? ` (${code})` : ''}. Showing nothing rather than the projects it hides.`)
}

export function readProjectFilter(): ProjectFilter {
  const filterPath = appFilterPath()
  if (filterPath === null) return EMPTY_PROJECT_FILTER
  // mtime alone misses a same-tick rewrite and a cp -p / git checkout restore.
  let stamp: string
  try {
    const stat = fs.statSync(filterPath)
    stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
  } catch (error) {
    // A missing file is the one honest way to have no filter. Every other errno
    // (EACCES on the directory, EIO) is a read that failed, and statSync rejects
    // them all the same way.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unreadableFilter(error)
    appFilterCache = null
    return EMPTY_PROJECT_FILTER
  }
  if (appFilterCache?.path === filterPath && appFilterCache.stamp === stamp) return appFilterCache.filter
  try {
    const filter = normalizeProjectFilter(JSON.parse(fs.readFileSync(filterPath, 'utf8')))
    appFilterCache = { path: filterPath, stamp, filter }
    return filter
  } catch (error) {
    // Unreadable or half-written: keep the last filter, never unhide. The cache
    // is per-process, so the first read of a launch has no last filter to keep
    // and the failure has to travel instead of being flattened to "show all".
    if (appFilterCache?.path === filterPath) return appFilterCache.filter
    throw unreadableFilter(error)
  }
}

/** Persists the filter and returns what actually landed, normalization included. */
export function writeProjectFilter(value: unknown): ProjectFilter {
  const filter = normalizeProjectFilter(value)
  const filterPath = appFilterPath()
  // CODEBURN_APP_FILTER='' disables the filter outright: there is no file to
  // write, and the empty filter is what every later read will report.
  if (filterPath === null) return EMPTY_PROJECT_FILTER
  fs.mkdirSync(path.dirname(filterPath), { recursive: true })
  // Staged and renamed, like saveConfig in src/config.ts and for the same
  // reason: a writeFileSync straight over the live path can be interrupted, and
  // this is the one file that decides what stays hidden. A truncated filter is
  // an unreadable filter, which now costs a visible error on the next read
  // instead of a silent unhide, but neither is a state a click should produce.
  // The temp name is randomized so two windows saving at once cannot collide.
  const tmpPath = `${filterPath}.${randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(filter, null, 2) + '\n')
    fs.renameSync(tmpPath, filterPath)
  } catch (error) {
    fs.rmSync(tmpPath, { force: true })
    throw error
  }
  appFilterCache = null
  return filter
}

// The shared CLI config. The desktop writes only its `language` and
// `cursorSync` keys; the CLI reads the same fields. Path is fixed
// (os.homedir), matching src/config.ts.
function configPath(): string {
  return path.join(os.homedir(), '.config', 'codeburn', 'config.json')
}

/** The desktop's six locales; absent/other = follow the system. */
const APP_LOCALES = new Set(['en', 'fr', 'ja', 'ko', 'zh-CN', 'zh-TW'])

function readConfigKey(key: string): unknown {
  try {
    return (JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

export function readConfigLanguage(): string | null {
  const language = readConfigKey('language')
  return typeof language === 'string' && APP_LOCALES.has(language) ? language : null
}

export function readConfigCursorSync(): boolean {
  return readConfigKey('cursorSync') !== false
}

/**
 * Persist config `language` (null clears it), preserving every other key.
 */
export function writeConfigLanguage(language: string | null): void {
  writeConfigKey('language', language ?? undefined)
}

/** On is the CLI's default, so it clears the key rather than storing `true`. */
export function writeConfigCursorSync(enabled: boolean): void {
  writeConfigKey('cursorSync', enabled ? undefined : false)
}

/**
 * Set one config key (undefined removes it), preserving every other key. Staged
 * and renamed like writeProjectFilter, so a torn write never corrupts the shared
 * config. A missing file starts fresh; any other read error aborts rather than
 * clobber a config that is merely unreadable this instant.
 */
function writeConfigKey(key: string, value: unknown): void {
  const target = configPath()
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config.json is not a JSON object')
  if (value === undefined) delete config[key]
  else config[key] = value
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmpPath = `${target}.${randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n')
    fs.renameSync(tmpPath, target)
  } catch (error) {
    fs.rmSync(tmpPath, { force: true })
    throw error
  }
}

/**
 * The menu bar reads AppleLanguages and falls back to English for locales it
 * lacks (it ships en + zh-Hans). Chinese maps to the script tags the .lproj
 * uses; null (System) clears the override so the OS language decides.
 */
export function appleLanguageFor(language: string | null): string | null {
  if (language === 'zh-CN') return 'zh-Hans'
  if (language === 'zh-TW') return 'zh-Hant'
  return language
}

// `--opt=value`, never `--opt value`: a pattern routinely starts with "-", and
// as a separate argv entry that parses as another flag.
function filterArgs({ project, exclude }: ProjectFilter): string[] {
  const args: string[] = []
  for (const name of project) args.push(`--project=${name}`)
  for (const name of exclude) args.push(`--exclude=${name}`)
  return args
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
const PERIODS = new Set(['today', 'week', '30days', 'month', 'all', 'lifetime'])
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
/**
 * Drill-down contribution key (canonical project path or model id). Unlike
 * vToken, a leading '-' is legal here: Claude sanitizes project paths by
 * replacing separators with '-' (e.g. `/work/pricing` → `-work-pricing`), and
 * the key is only ever emitted in the VALUE position of `--key`/`--dimension`
 * pairs, where Commander binds the next token as the value — a dash-leading
 * value cannot inject a flag through the argv array (no shell involved).
 * Empty and NUL are still rejected.
 */
function vContributionKey(value: string): string {
  if (!value || value.includes('\0')) throw new CliError('bad-args', 'invalid contribution key')
  return value
}
/** vRange for channels where the range is REQUIRED (compare periods). */
function vRequiredRange(range: DateRange | undefined, name: string): DateRange {
  const v = vRange(range)
  if (!v) throw new CliError('bad-args', `missing ${name} date range`)
  return v
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
// Exact identities from the cohort facet report, not loose CLI patterns.
// Keep the value attached to its flag so label-only ids starting with "-"
// remain data; NUL is invalid in process argv.
function vProjectIds(projects: string[] | undefined): string[] {
  if (!projects || projects.length === 0) return []
  for (const pattern of projects) {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.includes('\0')) {
      throw new CliError('bad-args', 'invalid project identity')
    }
  }
  return projects.map(id => `--project-id=${id}`)
}
// Activity categories for the cohort selection: the ids behind the CLI's
// --category (src/types.ts CATEGORY_LABELS keys). Duplicated here because the
// main process deliberately does not import core src/ modules.
const COHORT_CATEGORIES = new Set([
  'coding', 'debugging', 'feature', 'refactoring', 'testing', 'exploration',
  'planning', 'delegation', 'git', 'build/deploy', 'conversation', 'brainstorming', 'general',
])
function vCategory(category: string): string {
  if (!COHORT_CATEGORIES.has(category)) throw new CliError('bad-args', 'invalid category')
  return category
}
// Claude config source ids are `<kind>:<hex>` (src/providers/claude.ts) — the
// colon is part of the real value, so the token class allows it while anchoring
// the first char to alphanumeric so a leading "-" can never smuggle a flag.
function vConfigSource(source: string | null | undefined): string | null {
  if (source == null) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(source)) throw new CliError('bad-args', 'invalid claude config source')
  return source
}
function vScope(scope: string | undefined): 'local' | 'combined' {
  if (scope === 'combined') return 'combined'
  if (scope === undefined || scope === 'local') return 'local'
  throw new CliError('bad-args', 'invalid scope')
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

function toEnvelopeError(err: unknown): { kind: string; message: string; stage?: string } {
  if (err instanceof CliError) return { kind: err.kind, message: sanitizeError(err.message), ...(err.kind === 'not-found' && err.detail ? { stage: err.detail } : {}) }
  return { kind: 'nonzero', message: sanitizeError(err instanceof Error ? err.message : String(err)) }
}

const PROVIDER_ISSUE_KINDS = new Set(['eacces', 'busy', 'enoent', 'malformed', 'error'])

/**
 * Props for a `cli_error` telemetry event. Deliberately carries only
 * non-sensitive enums so the event is diagnosable without a repro yet leaks
 * nothing: `cmd` is the CLI subcommand (argv[0], a fixed literal like 'status'/
 * 'sessions' — never the full args, which can hold paths), and `detail` is the
 * not-found resolution/spawn stage. The error's `message` (which may contain a
 * path or stderr) only ever reaches cliErrorReason, which reduces it to a fixed
 * label. `ms` is a duration bucket, `exit` a one-shot child's exit code or
 * signal name, and `provider` appears only when the read was scoped to one.
 */
function cliErrorProps(err: unknown, argv: readonly string[] | undefined, startedAt: number): Record<string, unknown> {
  const props: Record<string, unknown> = { ms: durationBucket(Date.now() - startedAt) }
  const cmd = argv?.[0]
  if (cmd) props.cmd = cmd
  const providerAt = argv ? argv.indexOf('--provider') : -1
  if (providerAt >= 0 && argv![providerAt + 1]) props.provider = argv![providerAt + 1]
  if (err instanceof CliError) {
    props.kind = err.kind
    if (err.kind === 'not-found' && err.detail) props.detail = err.detail
    if (err.exit !== undefined) props.exit = err.exit
    if (err.kind === 'nonzero') props.reason = cliErrorReason(err.message)
  } else {
    props.kind = 'nonzero'
  }
  return props
}

export type Deps = {
  spawnCli: (args: string[], opts?: { timeoutMs?: number; onStderr?: (chunk: string) => void; extraEnv?: NodeJS.ProcessEnv; priority?: SpawnPriority }) => Promise<unknown>
  spawnCliAction: (args: string[], opts?: { timeoutMs?: number }) => Promise<ActionResult>
  resolveCodeburnPath: () => string | null
  getQuota: typeof getQuota
  /** Forward cold-start scan-progress events to the renderer splash. */
  emitProgress?: (event: unknown) => void
  /** Consent-gated anonymous telemetry; absent under tests unless injected. */
  telemetry?: TelemetryBridge | null
  /** Cached update-availability status; absent under tests unless injected. */
  getUpdateStatus?: () => Promise<UpdateStatus>
  /** One-click update download and restart; absent where updates are a download link. */
  downloadUpdate?: () => Promise<UpdateStatus>
  installUpdate?: () => void
  /** The bundled tray app and Capacity Dock; absent off Windows and under tests. */
  companion?: Pick<
    MenubarCompanion,
    'status' | 'trayPrefs' | 'setTrayAppPref' | 'setTrayDockPref' | 'setLaunchAtLogin'
    | 'install' | 'open' | 'quit' | 'uninstall' | 'setDockEnabled'
  > | null
  /** The macOS menubar app, as the Plugins page sees it; absent off darwin and under tests. */
  macMenubar?: Pick<MacMenubar, 'status' | 'install' | 'open' | 'setDockEnabled' | 'setLanguage' | 'quit' | 'uninstall' | 'settings'> | null
  /** Where the daily optimize scan is cached (app userData). Absent = no cache. */
  stateDir?: string
  /** Stamped into a cached scan so a build whose finding shapes changed never
   *  reads the previous build's cache. */
  appVersion?: string
  /** Electron's powerMonitor, for the on-battery live cadence. */
  isOnBatteryPower?: () => boolean
  /** Narrows the saved filter before it becomes argv (the IDE's workspace scope). */
  scopeProjectFilter?: (filter: ProjectFilter) => ProjectFilter
}

export type Handler = (...args: any[]) => Promise<Envelope>

/**
 * Maps every CodeburnBridge channel to its `codeburn` argv (plain args, no
 * shell) and returns a result envelope. Pure + injectable so the wiring is
 * unit-testable without launching Electron.
 */
/**
 * The line `codeburn export` prints only after a file or folder is written
 * (src/main.ts, the `Exported (<label>) to: <path>` log). An empty export
 * prints `No usage data found.` and still exits 0, so the exit code alone
 * cannot tell the two apart.
 */
const EXPORT_SAVED_MARKER = 'Exported ('
const EXPORT_PATH_SEPARATOR = ') to: '
const EXPORT_NOTHING_WRITTEN = 'Nothing to export: no usage in the export window, or the project filter hides all of it.'

/** The path the CLI actually wrote, which is not the destination the user picked: inside
 *  the chosen folder an export is a dated folder (CSV) or a dated file (JSON). */
export function exportedPath(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const marker = line.indexOf(EXPORT_SAVED_MARKER)
    if (marker < 0) continue
    const sep = line.indexOf(EXPORT_PATH_SEPARATOR, marker)
    if (sep < 0) continue
    const saved = line.slice(sep + EXPORT_PATH_SEPARATOR.length).trim()
    if (saved) return saved
  }
  return null
}

export function createBridgeHandlers(deps: Deps): Record<string, Handler> {
  const emitProgress = deps.emitProgress ?? (() => {})
  const savedFilter = (): ProjectFilter => {
    const filter = readProjectFilter()
    return deps.scopeProjectFilter ? deps.scopeProjectFilter(filter) : filter
  }
  // The top bar's project pick. Held in memory only, so a restart is back on
  // every project and the saved filter is never touched.
  let transientProject: string | null = null
  const projectArgs = (): string[] => {
    const filter = savedFilter()
    // "=": the picked row alone, not the folders under it that are rows of their own.
    return filterArgs(transientProject ? scopeFilter([`=${transientProject}`])(filter) : filter)
  }
  const telemetry = deps.telemetry ?? null
  // The CLI lists providers it could not read on the payload; forwarded as enums only,
  // and the telemetry budget keeps it to one per provider per day.
  const trackProviderIssues = <T>(payload: T): T => {
    const issues = (payload as { providerIssues?: unknown } | null)?.providerIssues
    if (Array.isArray(issues)) {
      for (const issue of issues.slice(0, 50)) {
        const { provider, stage, kind } = (issue ?? {}) as Record<string, unknown>
        if (typeof provider !== 'string' || !/^[a-z0-9-]{1,40}$/.test(provider)) continue
        if (stage !== 'locate' && stage !== 'parse') continue
        if (typeof kind !== 'string' || !PROVIDER_ISSUE_KINDS.has(kind)) continue
        telemetry?.track('provider_read_fail', { provider, stage, kind })
      }
    }
    return payload
  }
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

  // Until the cold hydration finishes, EVERY read shares the overview's floor.
  // Sections start polling the moment `ready` flips (which an overview error
  // also does), and a 45s section spawn queued behind a still-running cold parse
  // was killed on arrival — the `act report`/`plan` red panels in the repro.
  const readOpts = (): { timeoutMs: number } | undefined =>
    overviewWarmed ? undefined : { timeoutMs: WARMUP_TIMEOUT_MS }
  // Marks a TIMEOUT that happened while the cold hydration was still running, so
  // the renderer keeps the splash instead of painting a red error panel. Only
  // timeouts: a permission or nonzero failure is real news even while cold.
  //
  // BOUNDED, deliberately. `overviewWarmed` only flips on success, so an install
  // that can never hydrate would otherwise sit behind an indexing splash forever
  // with no error and no way to reach the "Locate the CLI" recovery. Past the
  // cold window itself, a timeout stops being "still indexing" and surfaces.
  const bootedAt = Date.now()
  const stillCold = (): boolean =>
    !overviewWarmed && Date.now() - (coldStartBegan ?? bootedAt) < WARMUP_TIMEOUT_MS
  const coldError = (err: unknown): { kind: string; message: string; cold?: true; stage?: string } => {
    const error = toEnvelopeError(err)
    return stillCold() && error.kind === 'timeout' ? { ...error, cold: true } : error
  }

  const run = (build: (...args: any[]) => string[], backgroundIndex?: number): Handler => async (...args: any[]) => {
    let argv: string[] | undefined
    const startedAt = Date.now()
    try {
      const background = backgroundIndex !== undefined && args[backgroundIndex] === true
      // `background` is renderer scheduling metadata, not a CLI argument.
      argv = build(...(backgroundIndex === undefined ? args : args.slice(0, backgroundIndex)))
      const baseOpts = readOpts()
      return {
        ok: true,
        value: await deps.spawnCli(argv, background
          ? { ...(baseOpts ?? {}), priority: 'background' }
          : baseOpts),
      }
    } catch (err) {
      const error = coldError(err)
      telemetry?.track('cli_error', cliErrorProps(err, argv, startedAt))
      return { ok: false, error }
    }
  }

  // The desktop never renders the granular timeline, so it always passes
  // --no-timeline (skips buildGranularHistory on every poll). The Swift menubar
  // omits the flag and keeps the timeline unchanged.
  //
  // Combined scope aggregates paired-device usage: the CLI rejects --scope
  // combined alongside --provider/--project/--exclude (paired devices report
  // unfiltered usage), so the provider filter is dropped in that mode. The
  // caller (renderer) forces provider='all' when combined, so nothing is lost.
  // A project filter cannot be dropped the same way: the hidden projects would
  // come back inside the combined total. The renderer already picks local while
  // a filter is set; this keeps a stale caller off the rejected argv.
  //
  // The optimize scan is OFF this argv (`--no-optimize`): it is the one part of
  // the payload that reads mutable project files, so it defeats the snapshot
  // fast path (src/main.ts `useSnapshot = !queryScope.optimize`) and costs a
  // fresh ~0.2s scan on every poll. The three figures the UI takes from it come
  // from the once-a-day cache below (`codeburn:getOptimizeSnapshot`), which
  // runs this same argv WITHOUT the flag, so no displayed number changes value.
  const buildOverviewArgs = (period: string, provider: string, range?: DateRange, configSource?: string | null, scope?: string, optimize = false): string[] => {
    const vScopeValue = vScope(scope)
    const filterArgs = projectArgs()
    const combined = vScopeValue === 'combined' && filterArgs.length === 0
    return [
      'status', '--format', 'menubar-json', '--period', vPeriod(period), '--no-timeline',
      ...(optimize ? [] : ['--no-optimize']),
      ...(combined ? ['--scope', 'combined'] : providerArgs(vProvider(provider))),
      ...filterArgs,
      ...rangeArgs(vRange(range)), ...configSourceArgs(vConfigSource(configSource)),
    ]
  }

  // The optimize scan is a DAILY figure: recomputed when nothing is cached for
  // this scope, when the cache is older than `maxAgeMs` (24h by default) OR was
  // computed on an earlier local day, or when the renderer forces it (the
  // Optimize page, manual refresh). Never on a poll tick. The cache key is the
  // full argv, so a period/provider/project/config/scope change is a different
  // entry and one scope's savings can never be served for another.
  //
  // The same-day rule is what makes the key honest: the key says
  // `--period today` (or week/30days/month), which names a window anchored to
  // the LOCAL day, not a fixed date. Without it a scan taken at 23:50 would be
  // served at 00:10 as today's, and every rolling window would be a day stale.
  const OPTIMIZE_MAX_AGE_MS = 24 * 60 * 60 * 1000
  const getOptimizeSnapshot: Handler = async (period: string, provider: string, range?: DateRange, configSource?: string | null, scope?: string, maxAgeMs?: number) => {
    const argv = buildOverviewArgs(period, provider, range, configSource, scope, true)
    const key = argv.join(' ')
    const appVersion = deps.appVersion ?? '0'
    const maxAge = typeof maxAgeMs === 'number' && maxAgeMs >= 0 ? maxAgeMs : OPTIMIZE_MAX_AGE_MS
    if (deps.stateDir) {
      const cached = readOptimizeSnapshot(deps.stateDir, key, appVersion)
      // An unparseable computedAt yields NaN, which fails both tests and
      // recomputes — the safe direction.
      const computedAt = cached ? Date.parse(cached.computedAt) : NaN
      const now = Date.now()
      if (cached && now - computedAt < maxAge && sameLocalDay(computedAt, now)) return { ok: true, value: cached }
    }
    const startedAt = Date.now()
    try {
      // Background priority, which only applies to the one-shot fallback path:
      // a serve-routed command (this one is `status`) is dispatched before
      // priority is read, and the resident child answers strictly FIFO. So this
      // does NOT let a click overtake it — it only keeps it out of the way when
      // serve is unavailable.
      const payload = await deps.spawnCli(argv, { ...(readOpts() ?? {}), priority: 'background' })
      const optimize = (payload as { optimize?: OptimizeBlock } | null)?.optimize
      if (!optimize || !Array.isArray(optimize.topFindings)) {
        return { ok: false, error: { kind: 'nonzero', message: 'No optimize findings in the payload.' } }
      }
      const snapshot: OptimizeSnapshot = { scope: key, computedAt: new Date().toISOString(), appVersion, optimize }
      if (deps.stateDir) writeOptimizeSnapshot(deps.stateDir, snapshot)
      return { ok: true, value: snapshot }
    } catch (err) {
      const error = coldError(err)
      telemetry?.track('cli_error', cliErrorProps(err, argv, startedAt))
      return { ok: false, error }
    }
  }

  // `background` (renderer prefetch only) drops this fetch to background priority
  // so it yields the CLI's run slots to any interactive poll or click. Optional
  // and defaulting to interactive, so an older preload that omits it is unchanged.
  const getOverview: Handler = async (period: string, provider: string, range?: DateRange, configSource?: string | null, background?: boolean, scope?: string) => {
    coldStartBegan ??= Date.now()
    const priority: SpawnPriority | undefined = background ? 'background' : undefined
    const startedAt = Date.now()
    let args: string[] | undefined
    try {
      args = buildOverviewArgs(period, provider, range, configSource, scope)
      if (overviewWarmed) return { ok: true, value: trackProviderIssues(await deps.spawnCli(args, priority ? { priority } : undefined)) }
      const value = trackProviderIssues(await deps.spawnCli(args, {
        timeoutMs: WARMUP_TIMEOUT_MS,
        extraEnv: { CODEBURN_PROGRESS: '1' },
        onStderr: makeProgressReader(emitProgress),
        ...(priority ? { priority } : {}),
      }))
      overviewWarmed = true
      emitProgress({ kind: 'done' })
      emitColdStart(false)
      return { ok: true, value }
    } catch (err) {
      const error = coldError(err)
      if (!overviewWarmed) emitColdStart(error.kind === 'timeout')
      telemetry?.track('cli_error', cliErrorProps(err, args ?? ['status'], startedAt))
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
    'codeburn:getQuota': async (force?: boolean, disabled?: string[]) => {
      try { return { ok: true, value: await deps.getQuota({ force: Boolean(force), disabled }) } }
      catch (error) { return { ok: false, error: { kind: 'nonzero', message: sanitizeError(error) } } }
    },
    'codeburn:getOverview': getOverview,
    'codeburn:getOptimizeSnapshot': getOptimizeSnapshot,
    'codeburn:powerStatus': async () => {
      try { return { ok: true, value: deps.isOnBatteryPower ? deps.isOnBatteryPower() : false } }
      catch { return { ok: true, value: false } }
    },
    // Timeline variant for the Spend punchcard only: identical payload WITH
    // history.timeline (every other fetch keeps --no-timeline lean).
    'codeburn:getTimeline': run((period: string, provider: string, range?: DateRange) => [
      'status', '--format', 'menubar-json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ]),
    // Unfiltered like combined scope: a plan is billed on every project.
    'codeburn:getPlans': run((period: string) => ['status', '--format', 'json', '--period', vPeriod(period)], 1),
    'codeburn:getActReport': run(() => ['act', 'report', '--json']),
    'codeburn:getModels': run((period: string, provider: string, byTask: boolean, range?: DateRange) => [
      // The CLI defaults minCost to $0.01, which silently dropped every row
      // below a cent — including ALL unpriced rows, so the dimming and
      // add-alias affordances could never fire. Ask for the whole table;
      // the renderer already distinguishes unpriced rows (#1465).
      'models', '--format', 'json', '--period', vPeriod(period), '--min-cost', '0',
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...(byTask ? ['--by-task'] : []),
      ...rangeArgs(vRange(range)),
    ], 4),
    'codeburn:getSessions': run((period: string, provider: string, range?: DateRange) => [
      'sessions', '--format', 'json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ], 3),
    // Drill-through report: plain session rows plus per-turn contribution
    // segments (day/category/branch/model/PR). Same filtering semantics as
    // getSessions — one filtering mechanism, additive payload fields only.
    'codeburn:getSessionsContributions': run((period: string, provider: string, range?: DateRange) => [
      'sessions', '--format', 'json', '--contributions', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ], 3),
    // One session's cost diagnosis. Reads that transcript's content on demand;
    // never routed through serve (its output memo would hold the text).
    'codeburn:getSessionWhy': run((id: string) => ['sessions', '--id', vToken(id), '--why', '--format', 'json']),
    'codeburn:getCompareModels': run((period: string, provider: string) => [
      'compare', '--format', 'json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
    ], 2),
    'codeburn:getCompare': run((period: string, provider: string, modelA: string, modelB: string) => [
      'compare', '--format', 'json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      '--model-a', vToken(modelA), '--model-b', vToken(modelB),
    ]),
    // Compare periods (B minus A). Both ranges are REQUIRED local YYYY-MM-DD
    // key pairs; the renderer computes the 7v7 default so argv stays explicit.
    'codeburn:getPeriodCompare': run((rangeA: DateRange, rangeB: DateRange, provider: string, background?: boolean) => [
      'compare-periods', '--format', 'json',
      '--from-a', vRequiredRange(rangeA, 'A').from, '--to-a', vRequiredRange(rangeA, 'A').to,
      '--from-b', vRequiredRange(rangeB, 'B').from, '--to-b', vRequiredRange(rangeB, 'B').to,
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
    ], 3),
    'codeburn:getPeriodCompareSessions': run((rangeA: DateRange, rangeB: DateRange, provider: string, dimension: string, key: string) => {
      if (dimension !== 'project' && dimension !== 'model') throw new CliError('bad-args', 'invalid drill-down dimension')
      return [
        'compare-periods', '--format', 'sessions',
        '--from-a', vRequiredRange(rangeA, 'A').from, '--to-a', vRequiredRange(rangeA, 'A').to,
        '--from-b', vRequiredRange(rangeB, 'B').from, '--to-b', vRequiredRange(rangeB, 'B').to,
        ...providerArgs(vProvider(provider)),
        ...projectArgs(),
        '--dimension', dimension, '--key', vContributionKey(key),
      ]
    }),
    // Cohort mode: the facet query (models/projects/categories) and the report
    // for two models over an explicit selection. Same `compare` command, new
    // cohort-json format; project identities are exact, category is one id.
    'codeburn:getCompareCohortModels': run((period: string, provider: string, range?: DateRange) => [
      'compare', '--format', 'cohort-json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)),
      ...projectArgs(), ...rangeArgs(vRange(range)),
    ], 3),
    // The saved project filter still scopes the population; --project-id then
    // narrows it further to one identity the facet report offered.
    'codeburn:getCompareCohort': run((period: string, provider: string, modelA: string, modelB: string, range?: DateRange, projects?: string[], category?: string) => [
      'compare', '--format', 'cohort-json', '--period', vPeriod(period), ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      '--model-a', vToken(modelA), '--model-b', vToken(modelB), ...rangeArgs(vRange(range)),
      ...(vProjectIds(projects)), ...(category ? ['--category', vCategory(category)] : []),
    ], 7),
    'codeburn:getYield': run((period: string, provider: string, range?: DateRange) => [
      'yield', '--format', 'json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ], 3),
    'codeburn:getSpendFlow': run((period: string, provider: string, range?: DateRange) => [
      'spend', '--format', 'flow-json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ], 3),
    // Spend "By branch" lens: spend per canonical project × branch (plus
    // coverage for sources without branch metadata).
    'codeburn:getBranchSpend': run((period: string, provider: string, range?: DateRange) => [
      'spend', '--format', 'branch-json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ], 3),
    'codeburn:getOptimizeReport': run((period: string, provider: string, range?: DateRange) => [
      'optimize', '--format', 'json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ], 3),
    'codeburn:getDevices': run((period: string) => ['devices', '--format', 'json', '--period', vPeriod(period)]),
    'codeburn:getDevicesScan': run(() => ['devices', 'scan', '--format', 'json']),
    'codeburn:getShareStatus': run(() => ['share', 'status', '--format', 'json']),
    'codeburn:getIdentity': run(() => ['identity', '--format', 'json']),
    'codeburn:getAliases': run(() => ['model-alias', '--list', '--format', 'json']),
    'codeburn:getProxyPaths': run(() => ['proxy-path', '--list', '--format', 'json']),
    'codeburn:getAudit': run((period: string, provider: string, range?: DateRange) => [
      'audit', '--format', 'json', '--period', vPeriod(period),
      ...providerArgs(vProvider(provider)),
      ...projectArgs(),
      ...rangeArgs(vRange(range)),
    ]),
    'codeburn:getPriceOverrides': run(() => ['price-override', '--list', '--format', 'json']),
    'codeburn:getProjectFilter': async () => {
      try { return { ok: true, value: readProjectFilter() } }
      catch (error) { return { ok: false, error: toEnvelopeError(error) } }
    },
    // An absolute path only, or the temporary-folders row: a bare name would be
    // a substring pattern and could take in every project sharing it.
    'codeburn:setTransientProject': async (projectPath?: unknown) => {
      if (projectPath !== null && projectPath !== '@temp' && (typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || projectPath.includes('\0'))) {
        return { ok: false, error: { kind: 'bad-args', message: 'invalid project path' } }
      }
      transientProject = projectPath
      return { ok: true, value: undefined }
    },
    'codeburn:setProjectFilter': async (filter?: unknown) => {
      try { return { ok: true, value: writeProjectFilter(filter) } }
      catch (error) { return { ok: false, error: { kind: 'nonzero', message: sanitizeError(error) } } }
    },
    // Deliberately NOT scoped by projectArgs(): the Projects pane builds its
    // checklist from this, so it has to see the projects the filter is hiding.
    //
    // Lifetime, and NOT the period on screen. A filter scopes every screen and
    // every horizon at once, so a list bounded to the visible period hides the
    // projects a pattern is actually excluding: the pane would print "matches
    // nothing detected" beside a live exclude, offer to remove it, and count it
    // out of "N projects hidden". `all` is capped at six months, so `lifetime`
    // is the only horizon that can answer for the whole filter.
    'codeburn:getUnfilteredProjects': run(() => ['report', '--format', 'json', '--period', 'lifetime']),
    'codeburn:getLanguage': async () => ({ ok: true, value: readConfigLanguage() }),
    'codeburn:setLanguage': async (language?: unknown) => {
      try {
        const lang = typeof language === 'string' && APP_LOCALES.has(language) ? language : null
        writeConfigLanguage(lang)
        if (deps.macMenubar) await deps.macMenubar.setLanguage(appleLanguageFor(lang))
        return { ok: true, value: undefined }
      } catch (err) {
        return { ok: false, error: toEnvelopeError(err) }
      }
    },
    'codeburn:getCursorSync': async () => ({ ok: true, value: readConfigCursorSync() }),
    'codeburn:setCursorSync': async (enabled?: unknown) => {
      try {
        if (typeof enabled !== 'boolean') throw new CliError('bad-args', 'invalid cursorSync value')
        writeConfigCursorSync(enabled)
        return { ok: true, value: undefined }
      } catch (err) {
        return { ok: false, error: toEnvelopeError(err) }
      }
    },
    'codeburn:setCurrency': runAction((code: string) => ['currency', vCurrency(code)]),
    'codeburn:resetCurrency': runAction(() => ['currency', '--reset']),
    'codeburn:addAlias': runAction((from: string, to: string) => ['model-alias', vToken(from), vToken(to)]),
    'codeburn:removeAlias': runAction((from: string) => ['model-alias', '--remove', vToken(from)]),
    'codeburn:setPriceOverride': runAction((model: string, rates: PriceRates) => priceOverrideArgs(model, rates)),
    'codeburn:removePriceOverride': runAction((model: string) => ['price-override', '--remove', vToken(model)]),
    'codeburn:removeDevice': runAction((name: string) => ['devices', 'rm', vToken(name)]),
    'codeburn:setPlan': runAction((id: string, provider: string) => ['plan', 'set', vToken(id), '--provider', vProvider(provider)]),
    'codeburn:resetPlan': runAction((provider: string) => ['plan', 'reset', '--provider', vProvider(provider)]),
    // Not plain runAction: `export` prints prose and exits 0 when every period
    // came back empty, and a filter that hides every project now makes that
    // reachable from a click. The exit code would toast "Exported to <folder>"
    // over a folder the CLI never created, so success reads the saved-path line
    // the CLI prints only after a write.
    'codeburn:exportData': async (format: string, provider: string, outPath: string) => {
      try {
        const result = await deps.spawnCliAction([
          'export', '-f', vToken(format), '-o', vOutPath(outPath), '--provider', vProvider(provider),
          ...filterArgs(savedFilter()),
        ])
        const savedPath = exportedPath(result.stdout)
        if (result.ok && savedPath === null) {
          return { ok: true, value: { ...result, ok: false, stderr: EXPORT_NOTHING_WRITTEN } }
        }
        return { ok: true, value: { ...result, stderr: sanitizeError(result.stderr), ...(savedPath ? { savedPath } : {}) } }
      } catch (err) {
        return { ok: false, error: toEnvelopeError(err) }
      }
    },
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
    // One-shot read of the cached update-availability status. The check itself
    // runs in the background (launch + 24h); this returns whatever is known.
    'codeburn:getUpdateStatus': async () => ({ ok: true, value: deps.getUpdateStatus ? await deps.getUpdateStatus() : NO_UPDATE_STATUS }),
    'codeburn:downloadUpdate': async () => ({ ok: true, value: deps.downloadUpdate ? await deps.downloadUpdate() : NO_UPDATE_STATUS }),
    'codeburn:installUpdate': async () => {
      deps.installUpdate?.()
      return { ok: true, value: true }
    },
    // The bundled tray app and its Capacity Dock (Windows). Every setter answers with the
    // whole status, so the sidebar renders the state that actually took rather than the one
    // it asked for: an install that was cancelled leaves the switch where it was.
    'codeburn:companionStatus': async () => ({ ok: true, value: deps.companion ? await deps.companion.status() : NO_COMPANION }),
    // The Plugins card's discrete actions, mirroring the macOS card: install/reinstall, show
    // the tray UI, quit without uninstalling, and remove. Each answers with the whole status.
    'codeburn:companionInstall': async () =>
      ({ ok: true, value: deps.companion ? await deps.companion.install() : NO_COMPANION_ACTION }),
    'codeburn:companionOpen': async () =>
      ({ ok: true, value: deps.companion ? await deps.companion.open() : NO_COMPANION }),
    'codeburn:companionQuit': async () =>
      ({ ok: true, value: deps.companion ? await deps.companion.quit() : NO_COMPANION_ACTION }),
    'codeburn:companionUninstall': async () =>
      ({ ok: true, value: deps.companion ? await deps.companion.uninstall() : NO_COMPANION_ACTION }),
    'codeburn:companionSetDock': async (enabled?: boolean) =>
      ({ ok: true, value: deps.companion ? await deps.companion.setDockEnabled(Boolean(enabled)) : NO_COMPANION }),
    // The tray app's own settings, which live in the files it reads them from. Every setter
    // answers with the whole set, so the panes render what landed rather than what was sent.
    'codeburn:trayPrefs': async () => ({ ok: true, value: deps.companion ? await deps.companion.trayPrefs() : null }),
    // A patch is whatever came over the channel, so it is typed as that and checked where it
    // is read (tray-settings.ts, isPatchObject) rather than asserted into a shape here.
    'codeburn:setTrayAppPref': async (patch?: unknown) =>
      ({ ok: true, value: deps.companion ? await deps.companion.setTrayAppPref(patch) : null }),
    'codeburn:setTrayDockPref': async (patch?: unknown) =>
      ({ ok: true, value: deps.companion ? await deps.companion.setTrayDockPref(patch) : null }),
    'codeburn:setLaunchAtLogin': async (enabled?: boolean) =>
      ({ ok: true, value: deps.companion ? await deps.companion.setLaunchAtLogin(Boolean(enabled)) : null }),
    // The macOS menubar app's card on the Plugins page. Every call answers with the whole
    // status for the same reason the Windows switches do: the card renders what is on disk,
    // never what it asked for.
    'codeburn:macMenubarStatus': async () => ({ ok: true, value: deps.macMenubar ? await deps.macMenubar.status() : NO_MAC_MENUBAR }),
    'codeburn:macMenubarInstall': async () =>
      ({ ok: true, value: deps.macMenubar ? await deps.macMenubar.install() : { ok: false, error: 'The menu bar app is macOS only.', status: NO_MAC_MENUBAR } }),
    'codeburn:macMenubarOpen': async () => ({ ok: true, value: deps.macMenubar ? await deps.macMenubar.open() : NO_MAC_MENUBAR }),
    'codeburn:macMenubarSetDock': async (enabled?: boolean) =>
      ({ ok: true, value: deps.macMenubar ? await deps.macMenubar.setDockEnabled(Boolean(enabled)) : NO_MAC_MENUBAR }),
    'codeburn:macMenubarSettings': async () =>
      ({ ok: true, value: deps.macMenubar ? await deps.macMenubar.settings() : { ok: false, error: 'The menu bar app is macOS only.', status: NO_MAC_MENUBAR } }),
    'codeburn:macMenubarQuit': async () =>
      ({ ok: true, value: deps.macMenubar ? await deps.macMenubar.quit() : { ok: false, error: 'The menu bar app is macOS only.', status: NO_MAC_MENUBAR } }),
    'codeburn:macMenubarUninstall': async () =>
      ({ ok: true, value: deps.macMenubar ? await deps.macMenubar.uninstall() : { ok: false, error: 'The menu bar app is macOS only.', status: NO_MAC_MENUBAR } }),
    // Plugin management reads (all return parsed JSON)
    'codeburn:pluginList': run(() => ['plugin', 'list', '--json']),
    'codeburn:pluginInfo': run((name: string) => ['plugin', 'info', vToken(name), '--json']),
    'codeburn:syncAutoStatus': run(() => ['sync', 'auto', 'status', '--json']),
    // Plugin management mutations
    'codeburn:pluginAdd': runAction((source: string) => ['plugin', 'add', vToken(source)]),
    'codeburn:pluginRemove': runAction((name: string) => ['plugin', 'remove', vToken(name), '--confirm']),
    'codeburn:pluginVerify': runAction((name: string) => ['plugin', 'verify', vToken(name)]),
    // Sync auto enable: special case - when accept=false, capture disclosure text from stdout
    'codeburn:syncAutoEnable': async (cadence?: string, attribution?: boolean, accept?: boolean) => {
      try {
        const args = ['sync', 'auto', 'enable', '--cadence', cadence === 'hourly' ? 'hourly' : 'daily']
        if (attribution) args.push('--attribution')
        if (accept) args.push('--accept')

        const result = await deps.spawnCliAction(args)
        // When accept=false, the disclosure text is in stdout, we return it for display
        // When accept=true, it succeeds with no special output needed
        if (!accept && result.stdout) {
          return { ok: true, value: { ok: true, disclosure: result.stdout, code: result.code } }
        }
        return { ok: true, value: { ...result, stderr: sanitizeError(result.stderr) } }
      } catch (err) {
        return { ok: false, error: toEnvelopeError(err) }
      }
    },
    'codeburn:syncAutoDisable': runAction(() => ['sync', 'auto', 'disable']),
  }
}
