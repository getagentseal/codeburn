import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CliError, DESKTOP_COLD_TIMEOUT_MS, PROGRESS_LINE_PREFIX, reapOrphanServe, resolveCodeburnPath, shutdownAll, spawnCli, spawnCliAction, startServe, type ActionResult, type SpawnPriority } from './cli'
import { MenubarCompanion, STARTUP_APPS_SETTINGS_URL, type CompanionStatus } from './menubar'
import { getQuota, sanitizeError } from './quota'
import { Telemetry } from './telemetry'
import { createUpdateChecker, type UpdateChecker, type UpdateStatus } from './updates'

// Initialized in bootstrap() once Electron paths exist; stays null under tests.
let telemetryInstance: Telemetry | null = null
// The once-per-launch + 24h update-availability checker. Null under tests.
let updateChecker: UpdateChecker | null = null
// The bundled tray app and its Capacity Dock (Windows only). Null under tests.
let companion: MenubarCompanion | null = null

/** What the sidebar switches read on a platform that has no tray app to bundle. */
export const NO_COMPANION: CompanionStatus = { supported: false, menuBar: false, sidebar: false, store: false }

/** The slice of Telemetry the bridge handlers use — injectable for tests. */
export type TelemetryBridge = Pick<Telemetry, 'status' | 'setEnabled' | 'completeOnboarding' | 'track'>

type QuitTelemetry = Pick<Telemetry, 'trackClose' | 'flush'>
type BeforeQuitEvent = { preventDefault: () => void }
type BeforeQuitDeps = {
  getTelemetry: () => QuitTelemetry | null
  killAll: () => void | Promise<void>
  quit: () => void
  timeoutMs?: number
}

const QUIT_FLUSH_TIMEOUT_MS = 1500

/** Intercept one quit pass, then allow the re-entrant pass after a bounded flush. */
export function createBeforeQuitHandler(deps: BeforeQuitDeps): (event: BeforeQuitEvent) => void {
  let flushStarted = false
  let allowQuit = false
  let closeTracked = false

  return event => {
    if (allowQuit) return
    try { event.preventDefault() } catch { /* keep the quit path moving */ }
    if (flushStarted) return
    flushStarted = true

    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        let childCleanup: Promise<unknown> = Promise.resolve()
        try { childCleanup = Promise.resolve(deps.killAll()).catch(() => undefined) } catch { /* child cleanup must not wedge quit */ }

        let telemetry: QuitTelemetry | null = null
        try { telemetry = deps.getTelemetry() } catch { /* telemetry lookup is best-effort */ }

        let flush: Promise<unknown> = Promise.resolve(false)
        if (telemetry) {
          if (!closeTracked) {
            closeTracked = true
            try { telemetry.trackClose() } catch { /* flush the existing queue anyway */ }
          }
          try { flush = Promise.resolve(telemetry.flush()) } catch { /* use the resolved fallback */ }
        }

        const timeout = new Promise<void>(resolve => {
          timer = setTimeout(resolve, deps.timeoutMs ?? QUIT_FLUSH_TIMEOUT_MS)
        })
        await Promise.race([
          Promise.all([flush.catch(() => false), childCleanup]),
          timeout,
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        allowQuit = true
        try { deps.quit() } catch { /* a throwing quit call must not reset the guard */ }
      }
    })()
  }
}

// Result envelope: handlers never throw across IPC so the structured error
// `kind` survives contextBridge serialization. preload.ts unwraps it.
export type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; error: { kind: string; message: string; cold?: true } }

// The first overview fetch after boot hydrates a cold cache from scratch (a full
// history parse). That can far exceed the 45s read timeout, and killing it means
// the cache never persists, so every later poll restarts the scan — perpetual
// slowness. Give the first (cold) overview a long window; revert to the default
// once it succeeds. Sections gate their own first poll on this one resolving so
// the cold hydration runs ONCE, not once per section in parallel.
const WARMUP_TIMEOUT_MS = DESKTOP_COLD_TIMEOUT_MS
// IPC channel carrying cold-start scan-progress events to the splash.
export const PROGRESS_CHANNEL = 'codeburn:progress'
// IPC channel pushing update-availability status to open windows (launch + 24h).
export const UPDATE_CHANNEL = 'codeburn:update'

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

function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_CHANNEL, status)
  }
}

const NO_UPDATE_STATUS: UpdateStatus = { currentVersion: '', latestVersion: null, updateAvailable: false, tag: null }

function providerArgs(provider: string | undefined): string[] {
  return provider && provider !== 'all' ? ['--provider', provider] : []
}

/** Include/exclude patterns scoping every CLI fetch the app makes. */
export type ProjectFilter = { project: string[]; exclude: string[] }

const EMPTY_PROJECT_FILTER: ProjectFilter = { project: [], exclude: [] }

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

// `--opt=value`, never `--opt value`: a pattern routinely starts with "-", and
// as a separate argv entry that parses as another flag.
function projectArgs(): string[] {
  const { project, exclude } = readProjectFilter()
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

function toEnvelopeError(err: unknown): { kind: string; message: string } {
  if (err instanceof CliError) return { kind: err.kind, message: sanitizeError(err.message) }
  return { kind: 'nonzero', message: sanitizeError(err instanceof Error ? err.message : String(err)) }
}

/**
 * Props for a `cli_error` telemetry event. Deliberately carries only
 * non-sensitive enums so the event is diagnosable without a repro yet leaks
 * nothing: `cmd` is the CLI subcommand (argv[0], a fixed literal like 'status'/
 * 'sessions' — never the full args, which can hold paths), and `detail` is the
 * not-found resolution/spawn stage. The error's `message` (which may contain a
 * path or stderr) is never read here — only `kind` and the stage enum are.
 */
function cliErrorProps(err: unknown, cmd: string | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  if (cmd) props.cmd = cmd
  if (err instanceof CliError) {
    props.kind = err.kind
    if (err.kind === 'not-found' && err.detail) props.detail = err.detail
  } else {
    props.kind = 'nonzero'
  }
  return props
}

type Deps = {
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
  /** The bundled tray app and Capacity Dock; absent off Windows and under tests. */
  companion?: Pick<
    MenubarCompanion,
    'status' | 'setMenuBarEnabled' | 'setSidebarEnabled' | 'trayPrefs' | 'setTrayAppPref' | 'setTrayDockPref' | 'setLaunchAtLogin'
  > | null
}

type Handler = (...args: any[]) => Promise<Envelope>

/**
 * Maps every CodeburnBridge channel to its `codeburn` argv (plain args, no
 * shell) and returns a result envelope. Pure + injectable so the wiring is
 * unit-testable without launching Electron.
 */
export function createBridgeHandlers(deps: Deps = { spawnCli, spawnCliAction, resolveCodeburnPath, getQuota, emitProgress: broadcastProgress, telemetry: telemetryInstance, getUpdateStatus: () => updateChecker ? updateChecker.getStatus() : Promise.resolve(NO_UPDATE_STATUS), companion: companion }): Record<string, Handler> {
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
  const coldError = (err: unknown): { kind: string; message: string; cold?: true } => {
    const error = toEnvelopeError(err)
    return stillCold() && error.kind === 'timeout' ? { ...error, cold: true } : error
  }

  const run = (build: (...args: any[]) => string[], backgroundIndex?: number): Handler => async (...args: any[]) => {
    let cmd: string | undefined
    try {
      const background = backgroundIndex !== undefined && args[backgroundIndex] === true
      // `background` is renderer scheduling metadata, not a CLI argument.
      const argv = build(...(backgroundIndex === undefined ? args : args.slice(0, backgroundIndex)))
      cmd = argv[0]
      const baseOpts = readOpts()
      return {
        ok: true,
        value: await deps.spawnCli(argv, background
          ? { ...(baseOpts ?? {}), priority: 'background' }
          : baseOpts),
      }
    } catch (err) {
      const error = coldError(err)
      telemetry?.track('cli_error', cliErrorProps(err, cmd))
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
  const buildOverviewArgs = (period: string, provider: string, range?: DateRange, configSource?: string | null, scope?: string): string[] => {
    const vScopeValue = vScope(scope)
    const filterArgs = projectArgs()
    const combined = vScopeValue === 'combined' && filterArgs.length === 0
    return [
      'status', '--format', 'menubar-json', '--period', vPeriod(period), '--no-timeline',
      ...(combined ? ['--scope', 'combined'] : providerArgs(vProvider(provider))),
      ...filterArgs,
      ...rangeArgs(vRange(range)), ...configSourceArgs(vConfigSource(configSource)),
    ]
  }

  // `background` (renderer prefetch only) drops this fetch to background priority
  // so it yields the CLI's run slots to any interactive poll or click. Optional
  // and defaulting to interactive, so an older preload that omits it is unchanged.
  const getOverview: Handler = async (period: string, provider: string, range?: DateRange, configSource?: string | null, background?: boolean, scope?: string) => {
    coldStartBegan ??= Date.now()
    const priority: SpawnPriority | undefined = background ? 'background' : undefined
    try {
      const args = buildOverviewArgs(period, provider, range, configSource, scope)
      if (overviewWarmed) return { ok: true, value: await deps.spawnCli(args, priority ? { priority } : undefined) }
      const value = await deps.spawnCli(args, {
        timeoutMs: WARMUP_TIMEOUT_MS,
        extraEnv: { CODEBURN_PROGRESS: '1' },
        onStderr: makeProgressReader(emitProgress),
        ...(priority ? { priority } : {}),
      })
      overviewWarmed = true
      emitProgress({ kind: 'done' })
      emitColdStart(false)
      return { ok: true, value }
    } catch (err) {
      const error = coldError(err)
      if (!overviewWarmed) emitColdStart(error.kind === 'timeout')
      telemetry?.track('cli_error', cliErrorProps(err, 'status'))
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
      'models', '--format', 'json', '--period', vPeriod(period),
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
      ...projectArgs(),
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
    // One-shot read of the cached update-availability status. The check itself
    // runs in the background (launch + 24h); this returns whatever is known.
    'codeburn:getUpdateStatus': async () => ({ ok: true, value: deps.getUpdateStatus ? await deps.getUpdateStatus() : NO_UPDATE_STATUS }),
    // The bundled tray app and its Capacity Dock (Windows). Every setter answers with the
    // whole status, so the sidebar renders the state that actually took rather than the one
    // it asked for: an install that was cancelled leaves the switch where it was.
    'codeburn:companionStatus': async () => ({ ok: true, value: deps.companion ? deps.companion.status() : NO_COMPANION }),
    'codeburn:setMenuBarEnabled': async (enabled?: boolean) =>
      ({ ok: true, value: deps.companion ? await deps.companion.setMenuBarEnabled(Boolean(enabled)) : NO_COMPANION }),
    'codeburn:setSidebarEnabled': async (enabled?: boolean) =>
      ({ ok: true, value: deps.companion ? await deps.companion.setSidebarEnabled(Boolean(enabled)) : NO_COMPANION }),
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
    const allowed = externalUrlToOpen(url)
    return allowed === null ? undefined : shell.openExternal(allowed)
  })
}

/**
 * What the renderer may hand the shell, or null for anything else. The web is http(s) only.
 * The one exception is the Windows Settings page for startup apps, allowed by exact value:
 * on the Store route launch at login is the package's own startup task, so the tray pane
 * points at that page instead of offering a switch it cannot move (app/electron/menubar.ts).
 */
export function externalUrlToOpen(url: string, platform: string = process.platform): string | null {
  if (platform === 'win32' && url === STARTUP_APPS_SETTINGS_URL) return url
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:') return url
  } catch { /* malformed URL, refuse to open */ }
  return null
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
      // Keep Chromium's normal background throttling so minimizing/occluding the
      // window updates the Page Visibility API and pauses renderer animations.
      // Data intervals remain registered and use a visibility catch-up on return.
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

  app.on('before-quit', createBeforeQuitHandler({
    getTelemetry: () => telemetryInstance,
    killAll: shutdownAll,
    quit: () => app.quit(),
  }))

  void app.whenReady().then(() => {
    // Start the resident child early, but issue no artificial warm-up query:
    // the first real overview request is the single cache hydration and streams
    // its progress through serve. Every later panel reuses that parsed cache.
    // A crash leaves no one to close the previous child's stdin, so reap it
    // first — orphans hold FSEvents handles and a stale cache refresh lock.
    const servePidFile = path.join(app.getPath('userData'), 'serve.pid')
    reapOrphanServe(servePidFile)
    startServe(servePidFile)
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
    // The tray app and the Capacity Dock the desktop app carries on Windows. Constructed
    // before the handlers so the sidebar's switches have something to read, and installed in
    // the background so a `/passive` msiexec run never holds the first window back.
    companion = new MenubarCompanion({
      resourcesPath: app.isPackaged ? process.resourcesPath : null,
      stateDir: app.getPath('userData'),
      // Electron sets this in an installed AppX package, which is the Store route.
      store: (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true,
      platform: process.platform,
      env: process.env,
    })
    void companion.bootstrap().catch(err => console.error('menubar bootstrap failed:', err))
    registerHandlers()
    installApplicationMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // Update availability: check once at launch, then every 24h, pushing each
    // result to any open window. Never downloads/installs (unsigned builds);
    // errors are swallowed inside the checker as a silent no-op.
    updateChecker = createUpdateChecker({ currentVersion: app.getVersion() })
    const runUpdateCheck = () => { void updateChecker?.check().then(broadcastUpdateStatus) }
    runUpdateCheck()
    setInterval(runUpdateCheck, 24 * 60 * 60 * 1000)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (!process.env.VITEST) bootstrap()
