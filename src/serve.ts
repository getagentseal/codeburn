import { watch, type FSWatcher } from 'fs'
import { readFile, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { createInterface } from 'readline'

import type { Command } from 'commander'
import { getDateRange } from './cli-date.js'
import { getConfigFilePath } from './config.js'
import type { ParseReuseValidation } from './parser.js'
import { SERVE_HYDRATION_ENV } from './usage-aggregator.js'
import { suppressProjectFilterWarnings } from './project-filter-warnings.js'

// ---------------------------------------------------------------------------
// codeburn serve --stdio: a resident query server for the desktop app.
//
// Every CLI spawn on a large corpus pays seconds of fixed cost before any
// work: parsing a 100MB+ session-cache JSON, then re-deriving classification
// at query time. The desktop app fetches one payload per panel, so it pays
// that cost per fetch. This server is the same CLI kept warm: the app sends
// one JSON request per line ({id, args}) and gets the command's stdout back
// ({id, ok, output}); the session-cache memo in session-cache.ts makes every
// request after the first skip the JSON reload (a stat() revalidates, so a
// rewrite by another process still forces a fresh read).
//
// Correctness stance:
// - READ-ONLY allowlist. Only the hot panel queries run in-process; anything
//   else is rejected and the app falls back to a normal spawn. A rejected
//   command is a routing decision, not an error.
// - A FRESH commander program per request (buildProgram()), because commander
//   option state is sticky across parses — reusing one program would leak
//   `--period week` from one request into the defaults of the next.
// - Requests are strictly serialized. The parse/refresh pipeline is not
//   concurrent-safe within one process, and the cross-process refresh lock
//   already guards between processes.
// ---------------------------------------------------------------------------

// Past this resident-set size the serve loop drops its in-memory memos and
// re-parses on the next request. 3GB leaves generous room for the largest
// observed corpora while bounding a pathological one.
const SERVE_MAX_RSS_BYTES = 3 * 1024 * 1024 * 1024

// How long a closing serve child waits for an already-accepted request before
// giving up and exiting. CODEBURN_SERVE_DRAIN_MS overrides it so the e2e can
// prove the bound without a 45-second test.
const DEFAULT_DRAIN_MS = 45_000

// How long the background fill waits after a cold first paint before taking the
// queue. Long enough for the client's opening burst (it is serial, so its next
// request is already on the wire) to land in front of the fill, short enough
// that a client which then goes quiet still converges promptly.
// CODEBURN_SERVE_FILL_DELAY_MS overrides it for tests.
const DEFAULT_FILL_DELAY_MS = 3_000

type OutputMemoEntry = {
  createdAt: number
  validatedFrom: number
  output: string
  configFingerprint: string
}

// Kept as a small seam so the ordering contract can be tested without relying
// on filesystem watcher scheduling: an event arriving while a parse is in
// flight must be newer than the memo produced by that parse.
export function createOutputMemoEntry(
  parseStartedAt: number,
  parseCompletedAt: number,
  output: string,
  configFingerprint: string,
): OutputMemoEntry {
  return { createdAt: parseCompletedAt, validatedFrom: parseStartedAt, output, configFingerprint }
}

type ServeOptionKind = 'flag' | 'value'

// This is intentionally a positive, command-specific option schema rather
// than a shared denylist. If a command later gains a write-capable option it
// remains a normal one-shot CLI action until it is explicitly reviewed here.
// The entries mirror the Commander definitions in main.ts. In particular,
// optimize omits its apply-only surface (--apply, --yes, --dry-run, --only),
// and report omits --refresh, which only paces the interactive dashboard.
const SERVE_OPTIONS: Readonly<Record<string, Readonly<Record<string, ServeOptionKind>>>> = {
  report: {
    '-p': 'value', '--period': 'value', '--day': 'value', '--from': 'value',
    '--to': 'value', '--provider': 'value', '--format': 'value',
    '--project': 'value', '--exclude': 'value',
  },
  status: {
    '--format': 'value', '--scope': 'value', '--provider': 'value', '--project': 'value',
    '--exclude': 'value', '--period': 'value', '--day': 'value', '--from': 'value',
    '--to': 'value', '--days': 'value', '--no-optimize': 'flag', '--no-timeline': 'flag',
    '--claude-config-source': 'value',
  },
  overview: {
    '-p': 'value', '--period': 'value', '--from': 'value', '--to': 'value',
    '--provider': 'value', '--project': 'value', '--exclude': 'value', '--no-color': 'flag',
  },
  models: {
    '-p': 'value', '--period': 'value', '--from': 'value', '--to': 'value',
    '--provider': 'value', '--task': 'value', '--by-task': 'flag', '--by-agent': 'flag',
    '--top': 'value', '--min-cost': 'value', '--no-totals': 'flag', '--format': 'value',
    '--project': 'value', '--exclude': 'value',
  },
  sessions: {
    '-p': 'value', '--period': 'value', '--from': 'value', '--to': 'value',
    '--provider': 'value', '--format': 'value', '--by-pr': 'flag', '--no-pager': 'flag',
    '--project': 'value', '--exclude': 'value',
  },
  compare: {
    '-p': 'value', '--period': 'value', '--provider': 'value', '--format': 'value',
    '--model-a': 'value', '--model-b': 'value',
    '--project': 'value', '--exclude': 'value',
  },
  yield: {
    '-p': 'value', '--period': 'value', '--provider': 'value', '--format': 'value',
    '--project': 'value', '--exclude': 'value',
  },
  spend: {
    '-p': 'value', '--period': 'value', '--from': 'value', '--to': 'value',
    '--provider': 'value', '--format': 'value',
    '--project': 'value', '--exclude': 'value',
  },
  optimize: {
    '-p': 'value', '--period': 'value', '--from': 'value', '--to': 'value',
    '--provider': 'value', '--format': 'value', '--json': 'flag',
    '--project': 'value', '--exclude': 'value',
  },
  audit: {
    '-p': 'value', '--period': 'value', '--from': 'value', '--to': 'value',
    '--provider': 'value', '--format': 'value',
    '--project': 'value', '--exclude': 'value',
  },
}

type ServeRequest = { id: string | number; args: string[] }

function isServeRequest(value: unknown): value is ServeRequest {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const idOk = typeof r['id'] === 'string' || typeof r['id'] === 'number'
  return idOk && Array.isArray(r['args']) && (r['args'] as unknown[]).every(a => typeof a === 'string')
}

function allowed(args: string[]): boolean {
  const first = args[0]
  if (!first) return false
  const options = SERVE_OPTIONS[first]
  if (!options) return false

  // Served commands have no positional arguments. Long options may use the
  // standard --name=value form; otherwise every value must immediately
  // follow an option declared as value-bearing in that command's schema.
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!
    const separator = token.startsWith('--') ? token.indexOf('=') : -1
    const option = separator >= 0 ? token.slice(0, separator) : token
    const inlineValue = separator >= 0
    const kind = options[option]
    if (!kind) return false
    if (kind === 'flag') {
      if (inlineValue) return false
      continue
    }
    if (inlineValue) continue
    const value = args[++i]
    if (value === undefined || value.startsWith('-')) return false
  }

  // `report` is the interactive dashboard on every format but json, and a TUI
  // cannot run in a resident child whose stdout is the wire. Its JSON form is
  // the only servable one; the rest is refused and falls back to a one-shot.
  if (first === 'report' && readServeOption(args, '--format') !== 'json') return false
  return true
}

/// Read a served option's value. `allowed()` has already proven the argv shape
/// (no positionals, every value-bearing option followed by a value that does
/// not start with '-'), so a token equal to the option name is always the
/// option and never someone's value.
function readServeOption(args: string[], name: string): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!
    if (token === name) return args[i + 1]
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1)
  }
  return undefined
}

/// Opt-in by whichever client spawned this child. A partial answer is only
/// honest on a surface that renders the indicator, and each client holds its
/// OWN serve child: the desktop app sets this (app/electron/cli.ts) and shows
/// `indexing history · N/M files`; the Swift menubar, GNOME and Windows clients
/// do not, so their children keep the full cold parse until those UIs can label
/// a partial payload. Unset means "answer only with complete data".
export const SERVE_PROGRESSIVE_ENV = 'CODEBURN_SERVE_PROGRESSIVE'

/// The range start a cold first paint of this request may be floored to, or
/// null when the request must not be answered partially (#1110).
///
/// Only `status --format menubar-json` qualifies, because it is the ONLY served
/// output that carries the `hydration` marker. Every other served command
/// (`models`/`sessions`/`spend` --format json ...) is a one-shot shape whose
/// consumer has no in-band way to tell a partial answer from a final one, so it
/// keeps the full parse. Explicit `--day`/`--from`/`--to`/`--days` are excluded
/// for the same reason the TUI excludes them: the floor is derived from a named
/// period, and a custom range is a deliberate question that deserves a real
/// answer.
export function coldFirstPaintRangeStart(
  args: string[],
  rangeForPeriod: (period: string) => { range: { start: Date } },
): Date | null {
  if (process.env[SERVE_PROGRESSIVE_ENV] !== '1') return null
  if (args[0] !== 'status') return null
  if (readServeOption(args, '--format') !== 'menubar-json') return null
  for (const flag of ['--day', '--from', '--to', '--days']) {
    if (readServeOption(args, flag) !== undefined) return null
  }
  // Mirrors the `status` --period default in main.ts.
  const period = readServeOption(args, '--period') ?? 'today'
  try {
    return rangeForPeriod(period).range.start
  } catch {
    return null
  }
}

/// The request id of a protocol line, without committing to handling it. The
/// client's watchdog is a NO-OUTPUT timer, so a request waiting behind the
/// background fill has to be heartbeated by id before its turn comes.
function peekRequestId(line: string): string | number | null {
  try {
    const id = (JSON.parse(line) as { id?: unknown } | null)?.id
    return typeof id === 'string' || typeof id === 'number' ? id : null
  } catch {
    return null
  }
}

class ExitSignal extends Error {
  constructor(public readonly code: number) { super(`exit ${code}`) }
}

function chunkToString(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
  }
  return String(chunk)
}

function finishWrite(rest: unknown[]): void {
  const callback = rest[rest.length - 1]
  if (typeof callback === 'function') (callback as () => void)()
}

/// Run one argv through a fresh program, capturing command stdout for the
/// final response and forwarding command stderr as progress. process.exit
/// inside a handler is converted to a thrown ExitSignal so a failing request
/// can never take the server down.
async function runCaptured(
  buildProgram: () => Command,
  args: string[],
  onProgress: (progress: string) => void,
): Promise<{ output: string; code: number }> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  const originalErrorWrite = process.stderr.write.bind(process.stderr)
  const originalExit = process.exit.bind(process)

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(chunkToString(chunk, rest[0]))
    finishWrite(rest)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    const progress = chunkToString(chunk, rest[0])
    if (progress) onProgress(progress)
    finishWrite(rest)
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: number) => { throw new ExitSignal(code ?? 0) }) as typeof process.exit

  try {
    const program = buildProgram()
    program.exitOverride()
    await program.parseAsync(['node', 'codeburn', ...args])
    return { output: chunks.join(''), code: 0 }
  } catch (err) {
    if (err instanceof ExitSignal) return { output: chunks.join(''), code: err.code }
    throw err
  } finally {
    process.stdout.write = originalWrite
    process.stderr.write = originalErrorWrite
    process.exit = originalExit
  }
}

/// A cheap per-request fingerprint for the configuration that affects query
/// rendering and aggregation. Hashing the small config file tracks effective
/// content rather than filesystem churn: a byte-identical rewrite keeps the
/// memo hot, while any real change invalidates immediately. A missing config
/// is a stable state; every other read failure fails closed (no memo reuse).
async function getConfigFingerprint(): Promise<string | null> {
  const path = getConfigFilePath()
  try {
    const content = await readFile(path)
    const digest = createHash('sha256').update(content).digest('hex')
    return `${path}\u0000sha256:${digest}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${path}\u0000missing`
    return null
  }
}

/// Watch every provider's probe roots (the same paths codeburn doctor reports
/// as "where discovery looks") so the parse-reuse validator can answer "did
/// any session data change since T?" without a stat sweep. macOS fs.watch
/// rides FSEvents and supports recursive directory watches. A probe failure or
/// a watch failure for an existing root disables event-driven reuse for this
/// generation; a root absent at setup is rechecked by the parser's hard cap.
type RootWatcherState = {
  startedAt: number
  lastEventAt: () => number
  healthy: () => boolean
  close: () => void
}

export function classifyRootReuse(
  sinceTs: number,
  state: { startedAt: number; lastEventAt: number; healthy: boolean },
): ParseReuseValidation {
  // A known event is conclusive even if watcher coverage degraded afterward.
  // Unknown means only that no dirty evidence exists and cleanliness cannot be
  // established for the whole interval.
  if (state.lastEventAt >= sinceTs) return 'dirty'
  if (!state.healthy || sinceTs < state.startedAt) return 'unknown'
  return 'clean'
}

async function startRootWatchers(): Promise<RootWatcherState | null> {
  let lastEventAt = 0
  let healthy = true
  let closed = false
  const watchers: FSWatcher[] = []
  try {
    const { getAllProviders } = await import('./providers/index.js')
    const providers = await getAllProviders()
    const roots = new Set<string>()
    for (const provider of providers) {
      if (!provider.probeRoots) continue
      try {
        for (const root of await provider.probeRoots()) roots.add(root.path)
      } catch {
        // An unknown probe result could hide an existing input root, so no
        // global all-roots-quiet claim is safe for this watcher generation.
        healthy = false
      }
    }
    for (const root of roots) {
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(root)
      } catch (err) {
        // An absent discovery root contains no sessions at arm time. If it is
        // created later there is no child watcher to see that creation, so the
        // parser's hard reuse cap remains the eventual revalidation backstop.
        // Other stat failures mean an existing input could be uncovered.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') healthy = false
        continue
      }
      try {
        const watcher = watch(root, { recursive: info.isDirectory() }, () => { lastEventAt = Date.now() })
        watcher.on('error', () => { healthy = false })
        watchers.push(watcher)
      } catch {
        // stat proved this input exists, so failing to arm it invalidates the
        // global quiet predicate even when other roots remain watched.
        healthy = false
      }
    }
  } catch {
    // Discovery itself failed. Existing watchers are still closed normally,
    // but they cannot validate reuse for an incomplete root set.
    healthy = false
  }
  if (watchers.length === 0) return null

  // Coverage begins only after at least one watcher has been successfully
  // armed. A parse performed while provider probing/stat/watch setup was in
  // flight must not be blessed retroactively as watched.
  const startedAt = Date.now()
  return {
    startedAt,
    lastEventAt: () => lastEventAt,
    healthy: () => healthy && !closed,
    close: () => {
      if (closed) return
      closed = true
      for (const w of watchers) w.close()
    },
  }
}

export async function runStdioServe(buildProgram: () => Command): Promise<void> {
  // Every stderr write becomes a progress frame below, so the project-filter
  // warning has to stay quiet for the life of this process.
  suppressProjectFilterWarnings()
  // Panel bursts (the app fetching every panel for one period) reuse a parse
  // whose through-now range end differs by less than this window, instead of
  // re-running the discovery sweep per panel. Serve-only: one-shot CLI runs
  // never set this, so their results stay byte-exact.
  if (!process.env['CODEBURN_PARSE_BURST_MS']) process.env['CODEBURN_PARSE_BURST_MS'] = '10000'
  // This process is the one producer allowed to answer partially, because its
  // clients poll and therefore converge. The marker makes every menubar payload
  // it emits carry `hydration` — including the warm ones, which report
  // `complete: true` — so a consumer never has to infer completeness from a
  // missing field within a single source.
  process.env[SERVE_HYDRATION_ENV] = '1'
  // Event-driven reuse: while no watched session root has changed, a previous
  // parse stays valid past the burst window (capped in parser.ts, so a missed
  // filesystem event self-heals within minutes). This is what turns a warm
  // no-change fetch into a no-op instead of a stat sweep.
  let rootReuseValidation: ((sinceTs: number) => ParseReuseValidation) | null = null
  // Mutable object properties keep cleanup visible to TypeScript even though
  // setup assigns them from an asynchronous continuation.
  const watcherLifecycle: {
    state: RootWatcherState | null
    resetValidator: (() => void) | null
  } = { state: null, resetValidator: null }
  const watcherSetup = startRootWatchers().then(async (w) => {
    watcherLifecycle.state = w
    if (!w) return
    const { setParseReuseValidator } = await import('./parser.js')
    // Clean means: the watchers were already armed when the parse happened,
    // and no filesystem event has landed since. lastEventAt of 0 is a quiet
    // system (clean for anything parsed after arming), not an unknown.
    const validate = (sinceTs: number): ParseReuseValidation => classifyRootReuse(sinceTs, {
      startedAt: w.startedAt,
      lastEventAt: w.lastEventAt(),
      healthy: w.healthy(),
    })
    rootReuseValidation = validate
    setParseReuseValidator(validate)
    watcherLifecycle.resetValidator = () => setParseReuseValidator(null)
  }).catch(() => {
    watcherLifecycle.state?.close()
    watcherLifecycle.state = null
  })

  // Output-level memo: an identical panel query while the roots are quiet
  // returns the previous stdout verbatim - the aggregation work is skipped
  // too, not just the parse. Session data uses the same event-or-cap rule as
  // parse reuse; config.json is fingerprinted on every request because it can
  // change rendering without touching a provider root.
  const OUTPUT_MEMO_CAP_MS = 5 * 60 * 1000
  const outputMemo = new Map<string, OutputMemoEntry>()
  let observedConfigFingerprint: string | null | undefined
  if (process.stdin.isTTY) {
    process.stderr.write('codeburn serve speaks JSON over stdio and exists for the desktop app to hold warm.\nNothing interactive happens here; press Ctrl+C to exit.\n')
  }
  // Keep the protocol transport anchored to the real stdout. runCaptured()
  // temporarily replaces process.stdout.write to collect command output; a
  // dynamic lookup here would swallow progress frames into the final payload.
  const protocolWrite = process.stdout.write.bind(process.stdout)
  const write = (value: unknown): void => { protocolWrite(JSON.stringify(value) + '\n') }
  write({ ready: true, pid: process.pid })

  // Strict serialization: each request chains on the previous one.
  let queue: Promise<void> = Promise.resolve()

  // Progressive cold start (#1110). Ids of requests received but not yet
  // answered, so work that holds the queue can heartbeat them.
  const awaiting = new Set<string | number>()
  const beat = (progress: string): void => {
    for (const id of awaiting) write({ id, progress })
  }
  // Cold detection runs at most once per paintable request until it answers
  // "warm"; from then on this child is warm for good and every request takes
  // the ordinary full path.
  let firstPaintSettled = false
  let fillTimer: ReturnType<typeof setTimeout> | undefined

  // The other half of the first paint: the same request, unfloored. It is an
  // ordinary parse, so what it writes to the session and daily caches is
  // exactly what a full cold parse would have written — the paint only
  // sequenced those files behind the answer, it never dropped them. Killed
  // mid-fill, nothing is stamped complete and the next launch re-enters cold.
  const scheduleBackgroundFill = (args: string[]): void => {
    if (fillTimer) return
    const delayMs = Number(process.env['CODEBURN_SERVE_FILL_DELAY_MS']) || DEFAULT_FILL_DELAY_MS
    fillTimer = setTimeout(() => {
      queue = queue.then(async () => {
        const { isColdCacheOnDisk } = await import('./session-cache.js')
        // A request that landed in front of the fill may already have done the
        // full parse (only the menubar payload is ever floored).
        if (!await isColdCacheOnDisk()) return
        const { startProgressKeepalive, stopProgressKeepalive } = await import('./parser.js')
        startProgressKeepalive()
        const startedAt = Date.now()
        try {
          const { output, code } = await runCaptured(buildProgram, args, beat)
          const fingerprint = await getConfigFingerprint()
          // Memoized so the poll that follows the fill answers instantly with
          // the converged payload instead of re-deriving it.
          if (code === 0 && fingerprint !== null) {
            outputMemo.set(args.join('\u0000'), createOutputMemoEntry(startedAt, Date.now(), output, fingerprint))
          }
        } catch {
          // Best effort. A failed fill leaves the cache incomplete, which is
          // exactly the state the next cold start knows how to resume from.
        } finally {
          stopProgressKeepalive()
        }
      })
    }, delayMs)
    // The app owning this child is gone once stdin closes; an unstarted fill
    // must not keep the process alive past that.
    fillTimer.unref?.()
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const waitingId = peekRequestId(trimmed)
    if (waitingId !== null) awaiting.add(waitingId)
    queue = queue.then(async () => {
      let request: unknown
      try {
        request = JSON.parse(trimmed)
      } catch {
        write({ id: null, ok: false, error: 'malformed request line' })
        return
      }
      if (!isServeRequest(request)) {
        write({ id: (request as { id?: unknown })?.id ?? null, ok: false, error: 'malformed request' })
        return
      }
      if (!allowed(request.args)) {
        // Routing signal, not a failure: the client falls back to a spawn.
        write({ id: request.id, ok: false, refused: true, error: 'command not served' })
        return
      }
      const configFingerprint = await getConfigFingerprint()
      if (observedConfigFingerprint !== undefined && configFingerprint !== observedConfigFingerprint) {
        outputMemo.clear()
      }
      observedConfigFingerprint = configFingerprint
      // A permission or transient read failure must shorten reuse, never make
      // an old result look current.
      if (configFingerprint === null) outputMemo.clear()

      const memoKey = request.args.join('\u0000')
      const memoHit = outputMemo.get(memoKey)
      if (
        configFingerprint !== null
        && memoHit?.configFingerprint === configFingerprint
        && Date.now() - memoHit.createdAt < OUTPUT_MEMO_CAP_MS
        && rootReuseValidation?.(memoHit.validatedFrom) === 'clean'
      ) {
        write({ id: request.id, ok: true, output: memoHit.output })
        return
      }
      // Progressive cold start (#1110): on a cold cache the menubar payload is
      // answered from the files the requested period can actually show, and the
      // rest are indexed behind it. Same cold test as the TUI (session-cache
      // envelope missing or complete !== true), same floor, and the answer says
      // so in-band via `hydration.complete: false`.
      const paintFrom = firstPaintSettled ? null : coldFirstPaintRangeStart(request.args, getDateRange)
      let floor: Date | null = null
      if (paintFrom) {
        const { isColdCacheOnDisk } = await import('./session-cache.js')
        floor = await isColdCacheOnDisk() ? paintFrom : null
        firstPaintSettled = true
      }
      // Heartbeat the WHOLE request, not just its parse: the aggregation and
      // payload serialization after a parse measured ~8s of further silence, and
      // it lands back-to-back with the parse's own quiet stretches. Wrapping
      // here (rather than at each command's exits) covers every served command
      // at one seam, and runCaptured routes the beats out as progress frames.
      const { startProgressKeepalive, stopProgressKeepalive, withColdFirstPaintFloor } = await import('./parser.js')
      startProgressKeepalive()
      try {
        const parseStartedAt = Date.now()
        const run = () => runCaptured(
          buildProgram,
          request.args,
          progress => write({ id: request.id, progress }),
        )
        let deferredFiles = 0
        let result: Awaited<ReturnType<typeof run>>
        if (floor) {
          const painted = await withColdFirstPaintFloor(floor, run)
          deferredFiles = painted.deferredFiles
          result = painted.result
        } else {
          result = await run()
        }
        const { output, code } = result
        if (code === 0) {
          // A partial answer is never memoized. The roots stay quiet while the
          // fill converges, so a memo hit would pin the client to the first
          // paint for the whole memo cap.
          if (configFingerprint !== null && deferredFiles === 0) {
            outputMemo.set(memoKey, createOutputMemoEntry(parseStartedAt, Date.now(), output, configFingerprint))
          }
          if (outputMemo.size > 32) {
            const oldest = [...outputMemo.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
            if (oldest) outputMemo.delete(oldest[0])
          }
          write({ id: request.id, ok: true, output })
          if (deferredFiles > 0) scheduleBackgroundFill(request.args)
        }
        else write({ id: request.id, ok: false, error: `exit ${code}`, output })
      } catch (err) {
        write({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      } finally {
        stopProgressKeepalive()
      }
      // Memory guard: a resident process accumulates parse memos that a
      // one-shot CLI never lives long enough to hold (up to 10 entries of
      // full ProjectSummary trees plus the parsed cache object). Past the
      // threshold, drop the in-memory memos — the next request re-parses
      // once (seconds), which beats an ever-growing child. The child itself
      // never exits here, so the client's death counter is untouched.
      if (process.memoryUsage().rss > SERVE_MAX_RSS_BYTES) {
        const { clearSessionCache } = await import('./parser.js')
        const { clearLoadCacheMemo } = await import('./session-cache.js')
        const { clearCodexMemCaches } = await import('./codex-cache.js')
        const { clearAntigravityCacheStates } = await import('./providers/antigravity.js')
        clearSessionCache()
        clearLoadCacheMemo()
        clearCodexMemCaches()
        clearAntigravityCacheStates()
        if (typeof globalThis.gc === 'function') globalThis.gc()
      }
    }).finally(() => {
      if (waitingId !== null) awaiting.delete(waitingId)
    })
  })

  // The app owns this process: stdin closing (or failing) means the app is
  // gone. Always release FSEvents handles and the module-global validator;
  // otherwise an existing Claude root keeps a naturally closed child alive.
  const transportClosed = new Promise<void>((resolve) => {
    rl.once('close', resolve)
    process.stdin.once('end', resolve)
    process.stdin.once('error', resolve)
  })
  try {
    await transportClosed
  } finally {
    rl.close()
    // Drain the in-flight request BEFORE returning. The caller exits the process
    // once this resolves, and runCaptured() has process.exit monkeypatched into
    // a thrown ExitSignal - returning mid-request would lose that request's
    // response frame and turn a clean exit into a failure.
    //
    // Bounded, because the app is already gone and this child must not become
    // the orphan the drain was added to prevent. The bound is generous: no
    // legitimate request answered at EOF comes close to it, and an ASYNC-wedged
    // one is released cleanly here. Note the ceiling: a parse wedged in a
    // SYNCHRONOUS loop never yields to this timer, or to any other JS path -
    // only a signal can end that process.
    const drainMs = Number(process.env['CODEBURN_SERVE_DRAIN_MS']) || DEFAULT_DRAIN_MS
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([queue, new Promise<void>(resolve => { drainTimer = setTimeout(resolve, drainMs) })])
    clearTimeout(drainTimer)
    // Bounded and non-fatal for the same reason the drain is: the app is gone,
    // and cleanup that hangs (watcher discovery on a stalled mount) or throws
    // must not stop this child from reaching its exit.
    let watcherTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      watcherSetup.catch(() => undefined),
      new Promise<void>(resolve => { watcherTimer = setTimeout(resolve, drainMs) }),
    ])
    clearTimeout(watcherTimer)
    rootReuseValidation = null
    try {
      watcherLifecycle.resetValidator?.()
    } finally {
      watcherLifecycle.state?.close()
    }
  }
}
