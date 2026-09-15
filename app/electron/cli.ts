import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

// Runs entirely in the Electron main process. This module must NOT import
// `electron` so it stays unit-testable in a plain node environment.

export type CliErrorKind = 'not-found' | 'nonzero' | 'bad-json' | 'timeout' | 'too-large' | 'bad-args'
export type ActionResult = { ok: boolean; stdout: string; stderr: string; code: number | null }

/**
 * Scheduling class for a CLI spawn. 'interactive' is what a user is waiting on
 * (the visible poll, a Settings mutation); 'background' is speculative work
 * (the overview prefetch). Interactive always dequeues first, so a burst of
 * background warms can never delay the fetch behind a click.
 */
export type SpawnPriority = 'interactive' | 'background'

/**
 * A resolved CLI target. `external` is a standalone `codeburn` executable (the
 * dev repo build, a persisted path, or one found on PATH) spawned directly.
 * `bundled` is the copy shipped inside the packaged app under `resources/cli`;
 * it has no Node runner of its own, so it is spawned with Electron's own binary
 * acting as Node via `ELECTRON_RUN_AS_NODE`.
 */
export type CliTarget = { kind: 'external'; bin: string } | { kind: 'bundled'; entry: string }
/**
 * `verbatim` marks a spec that goes through `cmd.exe`: its args are one already
 * escaped command line that Windows must hand over untouched, and the real CLI
 * runs a generation below, so ending it means ending the tree.
 */
type SpawnSpec = { bin: string; args: string[]; env: NodeJS.ProcessEnv; verbatim?: true }

/**
 * Which resolution/spawn stage produced a `not-found`, as a non-sensitive enum
 * for telemetry. Never contains a path — just names what was missing so a
 * not-found is self-diagnosing without a repro. See {@link notFoundStage}.
 */
export type NotFoundStage =
  | 'bin-not-absolute'
  | 'bin-not-executable'
  | 'bundled-not-absolute'
  | 'bundled-missing'
  | 'spawn-error'
  | 'no-path-match'

/** Structured failure so the renderer can pick the right empty/permission state. */
export class CliError extends Error {
  readonly kind: CliErrorKind
  /** For `not-found` only: the non-sensitive stage enum. Undefined otherwise. */
  readonly detail?: NotFoundStage
  constructor(kind: CliErrorKind, message: string, detail?: NotFoundStage) {
    super(message)
    this.name = 'CliError'
    this.kind = kind
    this.detail = detail
  }
}

// Read timeouts are a NO-OUTPUT watchdog, not a total-runtime cap: the window
// restarts every time the child emits a byte on stdout/stderr (serve: every
// frame for that request). A long-but-progressing parse on a slow machine is
// therefore never killed — only a genuinely silent child is. Read spawns all
// set CODEBURN_PROGRESS=1 so a multi-minute parse heartbeats through it.
const DEFAULT_TIMEOUT_MS = 45_000
// The first status query may hydrate a power-user cache from scratch. Every
// resident request admitted before that succeeds shares this floor so a later
// short request cannot kill the child while it waits behind the cold scan.
export const DESKTOP_COLD_TIMEOUT_MS = 10 * 60_000
// Backstop for the watchdog: a livelocked child that chatters forever without
// ever finishing still gets reaped.
const MAX_RUNTIME_MS = 15 * 60_000
// SIGTERM is catchable, so the CLI's armSignalCleanup (src/session-cache.ts)
// unlinks its own cache refresh lock before dying. Under SIGKILL the lock file
// is simply left behind and the next cold parse takes it over once it sees the
// dead pid — self-healing, but via the stale-takeover path rather than a clean
// release. Neither signal publishes a partial parse; nothing does.
const KILL_GRACE_MS = 5_000
// Quit has a stricter user-visible budget than ordinary request timeouts. Give
// the CLI enough time to catch SIGTERM and release its cache locks, then reap
// every remaining process-group member before Electron exits.
export const SHUTDOWN_TERM_GRACE_MS = 750
const SHUTDOWN_FORCE_WAIT_MS = 250
/** Wire marker for CLI scan-progress lines (src/parser.ts: PROGRESS_LINE_PREFIX). */
export const PROGRESS_LINE_PREFIX = 'CODEBURN_PROGRESS '
// A runaway CLI (or a compromised binary) must not exhaust main-process memory.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
// A cold-cache CLI spawn costs seconds at ~120% CPU; letting every poll +
// prefetch launch at once saturates the machine. Cap how many children run
// concurrently — the rest queue and drain as slots free (interactive first).
const MAX_CONCURRENT_CLI = 2

// Every live child so `before-quit` can reap them (Electron does not on macOS).
const activeChildren = new Set<ChildProcess>()
const readInflight = new Map<string, Promise<unknown>>()
// Successful mutations advance the epoch before their promise resolves. A read
// begun against older config may still settle for its original caller, but can
// never be reused by the post-mutation refetch or delete that newer flight.
let readGeneration = 0

// Concurrency scheduler. `running` counts spawned (not queued) children; waiters
// hold the slot-grant resolver for a queued spawn. Two queues so interactive
// work jumps ahead of any already-queued background warm the moment a slot frees.
type SlotWaiter = { resolve: () => void; reject: (err: unknown) => void }
let running = 0
const interactiveQueue: SlotWaiter[] = []
const backgroundQueue: SlotWaiter[] = []
let shuttingDown = false
let shutdownPromise: Promise<void> | null = null

function ownsProcessGroup(): boolean {
  return platform() !== 'win32'
}

/** Everything but the stdio shape, which stays at the call site so its literal tuple keeps
 *  telling the type system which streams the child will have. */
function spawnOptionsFor(spec: SpawnSpec) {
  return {
    shell: false as const,
    env: spec.env,
    detached: ownsProcessGroup(),
    ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}),
  }
}

/** `taskkill.exe` out of System32, never by bare name: Windows searches the current
 *  directory first, so anything dropped beside the app could answer for it. Same rule as
 *  `comspecPath` below. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\taskkill.exe`
}

/** The one taskkill argv, exported so a test can pin it: end this pid and everything
 *  below it, without asking. */
export function taskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F']
}

/**
 * End a Windows child and every process below it.
 *
 * `child.kill()` reaches one process. That is never the whole CLI: a `.cmd` shim runs node
 * as its own child, and the CLI itself spawns provider subprocesses. `taskkill /T` walks
 * the tree from this pid and is the only way to reach them.
 *
 * The handle is ended only once taskkill has finished, or could not run at all. Ending it
 * first is what made the tree kill a no-op: the descendants are reparented the moment the
 * top of the tree dies, and `taskkill /pid` on a pid that has already gone reports it as
 * not found and reaps nothing.
 *
 * `/F` on every signal, including SIGTERM: Windows has no catchable termination signal, so
 * `child.kill('SIGTERM')` is already an unconditional TerminateProcess. The graceful half
 * of {@link killGracefully} exists for POSIX.
 */
function killWindowsTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid
  if (!pid) return false
  const endHandle = () => { try { child.kill(signal) } catch { /* already gone */ } }
  let killer: ChildProcess
  try {
    killer = spawn(taskkillPath(), taskkillArgs(pid), { stdio: 'ignore', windowsHide: true })
  } catch {
    endHandle()
    return true
  }
  // A non-zero exit means taskkill found nothing to end, which is the state we were after
  // anyway; the direct kill then costs nothing. So a taskkill that cannot run at all leaves
  // exactly the behaviour there was before.
  killer.on('error', endHandle)
  killer.on('exit', code => { if (code !== 0) endHandle() })
  return true
}

/** Signal the CLI and every subprocess it created. POSIX children are spawned as
 *  process-group leaders; Windows has no process group to signal, so the tree is walked
 *  by pid instead. */
function signalOwnedTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!ownsProcessGroup()) return killWindowsTree(child, signal)
  if (child.pid) {
    try { process.kill(-child.pid, signal); return true } catch { /* already gone or no group */ }
  }
  try { return child.kill(signal) } catch { return false }
}

function ownedTreeAlive(child: ChildProcess): boolean {
  if (ownsProcessGroup() && child.pid) {
    try { process.kill(-child.pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  return child.exitCode === null && child.signalCode === null
}

async function waitForOwnedTreesToExit(children: ChildProcess[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (children.some(ownedTreeAlive) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Grant free slots to queued waiters, interactive first, up to the cap. */
function pumpSlots(): void {
  while (running < MAX_CONCURRENT_CLI) {
    const waiter = interactiveQueue.shift() ?? backgroundQueue.shift()
    if (!waiter) return
    running += 1
    waiter.resolve()
  }
}

/** Resolve once a run slot is free. The per-call timeout starts only after this
 *  resolves (i.e. at real spawn time), never while queued. */
function acquireSlot(priority: SpawnPriority): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ;(priority === 'background' ? backgroundQueue : interactiveQueue).push({ resolve, reject })
    pumpSlots()
  })
}

function releaseSlot(): void {
  running = Math.max(0, running - 1)
  pumpSlots()
}

/** Detach every owned child and cancel anything still queued for a slot. */
function takeAllChildren(): ChildProcess[] {
  const children = new Set(activeChildren)
  const resident = serveClient?.destroy()
  if (resident) children.add(resident)
  serveClient = null
  activeChildren.clear()
  // A queued waiter has no child to reap, so releaseSlot never fires for it;
  // reject it explicitly so its caller settles instead of hanging past quit.
  const waiting = [...interactiveQueue, ...backgroundQueue]
  interactiveQueue.length = 0
  backgroundQueue.length = 0
  running = 0
  for (const waiter of waiting) waiter.reject(new CliError('nonzero', 'codeburn cancelled'))
  return [...children]
}

/** Test/dev cleanup that permits a later fresh start in this same process. */
export function killAll(): void {
  shuttingDown = false
  shutdownPromise = null
  for (const child of takeAllChildren()) signalOwnedTree(child, 'SIGKILL')
}

/** Terminal app shutdown: reap current work and reject any IPC race that arrives
 * while Electron is still flushing telemetry before the final quit pass. */
export function shutdownAll(): Promise<void> {
  shuttingDown = true
  if (shutdownPromise) return shutdownPromise
  const children = takeAllChildren()
  for (const child of children) signalOwnedTree(child, 'SIGTERM')
  shutdownPromise = (async () => {
    await waitForOwnedTreesToExit(children, SHUTDOWN_TERM_GRACE_MS)
    // Signal every still-live group, not only direct children. A cooperative
    // CLI can exit before a stubborn provider subprocess; the group remains
    // addressable by the original leader pid and must still be reaped.
    for (const child of children) {
      if (ownedTreeAlive(child)) signalOwnedTree(child, 'SIGKILL')
    }
    await waitForOwnedTreesToExit(children, SHUTDOWN_FORCE_WAIT_MS)
  })()
  return shutdownPromise
}

// Homebrew + common Node version managers, mirroring mac/CodeburnCLI.swift so a
// GUI-launched app (minimal PATH) still finds a globally-installed `codeburn`.
export function nodeManagerDirs(): string[] {
  const home = homedir()
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.volta', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.asdf', 'shims'),
  ]
  const nvmDir = process.env.NVM_DIR || join(home, '.nvm')
  const nvmVersions = join(nvmDir, 'versions', 'node')
  try {
    // Scan version dirs newest-first and take the first whose bin actually holds
    // `codeburn`. A lexicographic max ("v9" > "v22") is not a real "newest", and
    // the top dir may not even contain the CLI — so verify, matching CodeburnCLI.swift.
    const entries = readdirSync(nvmVersions).sort().reverse()
    for (const entry of entries) {
      const bin = join(nvmVersions, entry, 'bin')
      if (isExecutableFile(join(bin, 'codeburn'))) {
        dirs.push(bin)
        break
      }
    }
  } catch {
    // no nvm — ignore
  }
  return dirs
}

/** The dirs searched for a `codeburn` executable. `CODEBURN_PATH_DIRS` overrides
 *  the whole search space (delimiter-separated) — used by tests and advanced setups. */
function searchDirs(): string[] {
  const override = process.env.CODEBURN_PATH_DIRS
  if (override !== undefined) return override.split(delimiter).filter(Boolean)
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  return [...pathDirs, ...nodeManagerDirs()]
}

/**
 * Spawn env for the resolved CLI. A GUI-launched app inherits a minimal PATH
 * (/usr/bin:/bin:...) that lacks the user's node install, and the `codeburn`
 * npm shim starts with `#!/usr/bin/env node` — so spawning it fails with
 * "env: node: No such file or directory" even though the shim itself was
 * found. Prepend the shim's own directory (node sits beside it in nvm,
 * Homebrew, and npm-prefix layouts) plus the same dirs the resolver searches.
 */
export function spawnEnvFor(bin: string): NodeJS.ProcessEnv {
  const parts = [dirname(bin), ...searchDirs(), ...(process.env.PATH || '').split(delimiter)]
  const seen = new Set<string>()
  const path = parts.filter(p => p && !seen.has(p) && (seen.add(p), true)).join(delimiter)
  return { ...process.env, PATH: path }
}

/**
 * The concrete spawn (executable, argv, env) for a resolved target. An external
 * `codeburn` runs directly with the PATH augmentation above. The bundled copy
 * has no runner of its own, so it runs as `process.execPath` (Electron's binary)
 * with `ELECTRON_RUN_AS_NODE=1` turning it into plain Node and the bundle path
 * as the first argument. PATH is still augmented so anything the CLI itself
 * shells out to (pairing, sync) resolves the same way an external CLI would.
 */
/** A script run by this process's own runtime: Electron's binary acting as Node. */
function nodeSpec(entry: string, args: string[]): SpawnSpec {
  return {
    bin: process.execPath,
    args: [entry, ...args],
    env: { ...spawnEnvFor(entry), ELECTRON_RUN_AS_NODE: '1' },
  }
}

/** What a `codeburn` install looks like on Windows: an npm `.cmd` shim on PATH, or the
 *  repo's own `dist/cli.js` in dev. Neither is something `CreateProcess` can start. */
const NODE_SCRIPT = /\.[cm]?js$/i
const CMD_SCRIPT = /\.(?:cmd|bat)$/i

/** `cmd.exe` out of System32, never by bare name: Windows searches the current directory
 *  first, so anything dropped beside the app could answer for it. */
function comspecPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\cmd.exe`
}

/**
 * Quote one argument for a `cmd.exe /c` command line.
 *
 * Two parsers see this string, and each needs its own pass. The quotes and the
 * backslash doubling are for the runtime that splits a command line back into argv;
 * the `^` escapes are for cmd itself, which re-reads the line first and would
 * otherwise act on a `&` or a `|` inside the quotes rather than pass it along. A
 * `.cmd` shim re-expands its own arguments, so those meta characters are escaped
 * twice: once for cmd reading this line, once for the shim reading what it gets.
 *
 * This is the rule `cross-spawn` applies, restated rather than depended on: the app's
 * main process ships no npm dependencies (app/DISTRIBUTION.md).
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g
export function escapeForCmd(arg: string, doubleEscape: boolean): string {
  let escaped = String(arg)
    // Any run of backslashes immediately before a quote is doubled, and the quote escaped.
    .replace(/(\\*)"/g, '$1$1\\"')
    // A trailing backslash run would otherwise escape the closing quote.
    .replace(/(\\*)$/, '$1$1')
  escaped = `"${escaped}"`.replace(CMD_META, '^$1')
  return doubleEscape ? escaped.replace(CMD_META, '^$1') : escaped
}

/** The `cmd.exe /d /s /c "<line>"` argv for a `.cmd` or `.bat` CLI. Exported for tests:
 *  everything security-relevant about the shell route is in this one string. */
export function cmdShimArgs(bin: string, args: string[]): string[] {
  const line = [escapeForCmd(bin, false), ...args.map(arg => escapeForCmd(arg, true))].join(' ')
  // /d skips AutoRun commands from the registry, /s fixes how the quotes around the whole
  // line are read, /c runs it and exits.
  return ['/d', '/s', '/c', `"${line}"`]
}

export function spawnSpecFor(target: CliTarget, args: string[]): SpawnSpec {
  if (target.kind === 'bundled') return nodeSpec(target.entry, args)

  // Windows has no shebang. `CreateProcess` starts executables, so a `.js` CLI (the repo
  // build in dev) and a `.cmd` shim (what a global npm install puts on PATH) both fail
  // outright with EFTYPE, which is why nothing the desktop app spawned ever ran here. Each
  // is given a runner that can start it. A POSIX `codeburn` is a script with a shebang and
  // an exec bit and still runs directly, exactly as before.
  if (platform() === 'win32') {
    if (NODE_SCRIPT.test(target.bin)) return nodeSpec(target.bin, args)
    if (CMD_SCRIPT.test(target.bin)) {
      return {
        bin: comspecPath(),
        args: cmdShimArgs(target.bin, args),
        env: spawnEnvFor(target.bin),
        verbatim: true,
      }
    }
  }
  return { bin: target.bin, args, env: spawnEnvFor(target.bin) }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// Persisted-path file written by the (future) first-run "locate CLI" flow,
// mirroring the mac app's Application Support/CodeBurn/codeburn-cli-path.v1.
function persistedPathFile(): string {
  const override = process.env.CODEBURN_CLI_PATH_FILE
  if (override) return override
  const home = homedir()
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'CodeBurn', 'codeburn-cli-path.v1')
  }
  const base = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return join(base, 'CodeBurn', 'codeburn-cli-path.v1')
}

function readPersistedPath(): string | null {
  try {
    const file = persistedPathFile()
    if (!existsSync(file)) return null
    const value = readFileSync(file, 'utf-8').trim()
    if (value && isAbsolute(value) && isExecutableFile(value)) return value
  } catch {
    // unreadable — fall through to PATH search
  }
  return null
}

/**
 * Resolve which `codeburn` to run, or null if none is available.
 * Order: dev override (`CODEBURN_BIN`) → repo CLI in Vite development →
 * bundled CLI shipped in the packaged app (`CODEBURN_BUNDLED_CLI`) →
 * persisted-path file → PATH / brew / nvm / volta / asdf → null.
 *
 * The dev repo CLI intentionally beats both the bundled and persisted paths: in
 * `npm run dev` the developer is iterating on this repo, so its freshly-built
 * `dist/cli.js` must win over anything older (which may lack newly-added
 * commands). The bundled CLI beats the persisted/PATH ones so a packaged app is
 * version-matched to itself and never falls back to an older globally-installed
 * `codeburn`. `CODEBURN_BIN` still overrides everything. In an unpackaged
 * dev/test run `CODEBURN_BUNDLED_CLI` is unset, so resolution behaves exactly as
 * before.
 */
export function resolveTarget(): CliTarget | null {
  const override = process.env.CODEBURN_BIN
  if (override && isAbsolute(override) && isExecutableFile(override)) return { kind: 'external', bin: override }

  // Dev convenience: when launched by the Vite dev server, prefer the repo's own
  // freshly-built CLI over a stale globally-installed/persisted one, so
  // newly-added commands (sessions/compare/act JSON) work without CODEBURN_BIN.
  if (process.env.VITE_DEV_SERVER_URL) {
    const devRepoRoot = process.env.CODEBURN_DEV_REPO_ROOT
    if (devRepoRoot) {
      // Test/advanced override, matching CODEBURN_PATH_DIRS: keep dev lookup in an isolated repo root.
      const devBin = join(devRepoRoot, 'dist', 'cli.js')
      if (isExecutableFile(devBin)) return { kind: 'external', bin: devBin }
    } else {
      const devBin = join(__dirname, '..', '..', '..', 'dist', 'cli.js')
      if (isExecutableFile(devBin)) return { kind: 'external', bin: devBin }
      // Vitest loads this source module from app/electron rather than the emitted
      // app/dist/electron directory; keep the same repo CLI discoverable there.
      const sourceDevBin = join(__dirname, '..', '..', 'dist', 'cli.js')
      if (isExecutableFile(sourceDevBin)) return { kind: 'external', bin: sourceDevBin }
    }
  }

  // Packaged app: main.ts sets CODEBURN_BUNDLED_CLI to resources/cli/dist/cli.js.
  // It is passed as an argument to Electron-as-node, so it only needs to be a
  // readable file — no exec bit or working shebang required.
  const bundled = process.env.CODEBURN_BUNDLED_CLI
  if (bundled && isAbsolute(bundled) && isFile(bundled)) return { kind: 'bundled', entry: bundled }

  const persisted = readPersistedPath()
  if (persisted) return { kind: 'external', bin: persisted }

  for (const bin of searchDirs().flatMap(pathCandidates)) {
    if (isExecutableFile(bin)) return { kind: 'external', bin }
  }
  return null
}

/**
 * What a `codeburn` in one PATH directory can be called. A global npm install writes both
 * `codeburn` (a shell script, useless here) and `codeburn.cmd` (the Windows shim) into the
 * same directory, so the extensions have to come first or the lookup finds the one Windows
 * cannot start. Elsewhere there is only ever the bare name.
 */
function pathCandidates(dir: string): string[] {
  return platform() === 'win32'
    ? [join(dir, 'codeburn.cmd'), join(dir, 'codeburn.exe'), join(dir, 'codeburn.bat'), join(dir, 'codeburn')]
    : [join(dir, 'codeburn')]
}

/** The resolved CLI's path for display/status, or null. See {@link resolveTarget}. */
export function resolveCodeburnPath(): string | null {
  const target = resolveTarget()
  if (!target) return null
  return target.kind === 'bundled' ? target.entry : target.bin
}

/**
 * Why {@link resolveTarget} found nothing, recomputed from env as a
 * non-sensitive enum for telemetry. Mirrors resolveTarget's order and reports
 * the first stage that disqualified a candidate (e.g. a bundled path that isn't
 * absolute — the Windows P0 — vs. one that's absolute but missing, vs. no PATH
 * match at all). Only enum strings escape here: never a path, arg, or message.
 */
export function notFoundStage(): NotFoundStage {
  const override = process.env.CODEBURN_BIN
  if (override) {
    if (!isAbsolute(override)) return 'bin-not-absolute'
    if (!isExecutableFile(override)) return 'bin-not-executable'
  }
  const bundled = process.env.CODEBURN_BUNDLED_CLI
  if (bundled) {
    if (!isAbsolute(bundled)) return 'bundled-not-absolute'
    if (!isFile(bundled)) return 'bundled-missing'
  }
  return 'no-path-match'
}

/** Ask a child to exit, then insist. See {@link KILL_GRACE_MS}. The child is
 *  (re-)registered as active for the whole grace: a quit landing inside that
 *  window must still find it and SIGKILL it rather than orphan it. */
function killGracefully(child: ChildProcess): void {
  activeChildren.add(child)
  let grace: NodeJS.Timeout | undefined
  const settle = () => { activeChildren.delete(child); if (grace) clearTimeout(grace) }
  child.once('exit', () => { if (!ownedTreeAlive(child)) settle() })
  if (!signalOwnedTree(child, 'SIGTERM')) { settle(); return }
  grace = setTimeout(() => { signalOwnedTree(child, 'SIGKILL'); settle() }, KILL_GRACE_MS)
  grace.unref?.()
}

/** Progress heartbeats share the stderr stream with real diagnostics, and every
 *  read spawn now enables them — so they must never become the error message. */
function withoutProgressLines(stderr: string): string {
  return stderr.split('\n').filter(line => !line.startsWith(PROGRESS_LINE_PREFIX)).join('\n').trim()
}

function runCli(spec: SpawnSpec, cmdLabel: string, timeoutMs: number, onStderr?: (chunk: string) => void): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(spec.bin, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptionsFor(spec) })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let total = 0
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(ceiling)
      activeChildren.delete(child)
      fn()
    }

    const expire = (message: string) => {
      finish(() => {
        killGracefully(child)
        reject(new CliError('timeout', message))
      })
    }

    // Restarted on every byte the child produces: `timeoutMs` bounds SILENCE.
    let idleTimer: NodeJS.Timeout
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => expire(`codeburn ${cmdLabel} produced no output for ${timeoutMs}ms`), timeoutMs)
    }
    armIdle()
    const ceiling = setTimeout(() => expire(`codeburn ${cmdLabel} exceeded ${MAX_RUNTIME_MS}ms`), MAX_RUNTIME_MS)

    const bump = (n: number) => {
      // Buffered bytes can still land after the kill; re-arming then would leave
      // a timer nobody clears (finish() already ran).
      if (settled) return
      armIdle()
      total += n
      if (total > MAX_OUTPUT_BYTES) {
        finish(() => {
          signalOwnedTree(child, 'SIGKILL')
          reject(new CliError('too-large', `codeburn ${cmdLabel} produced more than ${MAX_OUTPUT_BYTES} bytes`))
        })
      }
    }

    child.stdout.on('data', chunk => { stdout += chunk; bump(chunk.length) })
    child.stderr.on('data', chunk => {
      stderr += chunk
      bump(chunk.length)
      // Live stderr for the cold-start warmup: forwards CLI scan-progress lines
      // to the splash. Never fires for ordinary reads (onStderr unset).
      if (onStderr) { try { onStderr(chunk.toString()) } catch { /* forwarder must not kill the read */ } }
    })

    child.on('error', err => {
      finish(() => reject(new CliError('not-found', err.message, 'spawn-error')))
    })

    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          reject(new CliError('nonzero', withoutProgressLines(stderr) || `codeburn exited with code ${code}`))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new CliError('bad-json', 'codeburn produced output that was not valid JSON'))
        }
      })
    })
  })
}

/** Run a one-shot read under the global child cap. A slot grant resumes on a
 * microtask, so terminal shutdown must be checked again immediately before the
 * synchronous spawn call. */
async function runScheduledCli(
  spec: SpawnSpec,
  cmdLabel: string,
  timeoutMs: number,
  priority: SpawnPriority,
  onStderr?: (chunk: string) => void,
): Promise<unknown> {
  await acquireSlot(priority)
  try {
    if (shuttingDown) throw new CliError('nonzero', 'codeburn is shutting down')
    return await runCli(spec, cmdLabel, timeoutMs, onStderr)
  } finally {
    releaseSlot()
  }
}

/**
 * Spawn `codeburn <args>` with plain argv (never a shell), collect stdout, and
 * decode it as JSON. Rejects with a structured {@link CliError}:
 *   not-found  no binary resolved
 *   nonzero    process exited with a non-zero code (stderr surfaced)
 *   bad-json   stdout was not valid JSON
 *   timeout    the process was killed after `timeoutMs`
 *   too-large  stdout+stderr exceeded {@link MAX_OUTPUT_BYTES}
 *
 * Read-only, so concurrent identical calls share one child. Settled results are
 * never cached here because config can also change outside the desktop app.
 * Never use this for config-mutating commands.
 */
// ── Resident serve child ────────────────────────────────────────────────
// The heavy read queries (one per panel) each pay seconds of CLI startup on
// a large corpus: node boot + a 100MB+ session-cache JSON.parse before any
// query work. `codeburn serve` is the same CLI kept warm: requests go over
// stdio and the cache stays parsed in the child. Routing rules keep this
// strictly an optimization:
//  - only SERVE_ROUTED commands (the app's JSON panel queries) are eligible;
//  - the first real panel request is also the cache warm-up, so startup never
//    runs an artificial warm-up query beside a duplicate one-shot child;
//  - progress frames from serve are forwarded through the same onStderr hook
//    used by a one-shot cold start;
//  - any serve failure falls back to a normal spawn for that call;
//  - three child deaths permanently disable serve for this app run.
const SERVE_ROUTED = new Set(['status', 'models', 'sessions', 'compare', 'yield', 'spend', 'optimize', 'audit', 'report'])
const SERVE_MAX_RESTARTS = 3

type PendingServeRequest = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  /** Restart the no-output watchdog — called for every frame carrying this id. */
  arm: () => void
  /** Cancel both the watchdog and the absolute ceiling. */
  clear: () => void
  warmsServe: boolean
  decodedBytes: number
  onStderr?: (chunk: string) => void
}

class ServeClient {
  private child: ReturnType<typeof spawn> | null = null
  private pending = new Map<number, PendingServeRequest>()
  private nextId = 1
  private deaths = 0
  private buffer = ''
  private bufferBytes = 0
  private warmed = false
  private destroyed = false
  private requestTail: Promise<void> = Promise.resolve()

  constructor(private readonly spec: SpawnSpec, private readonly pidFile?: string) {}

  isRunning(): boolean { return this.child !== null }
  disabled(): boolean { return this.deaths >= SERVE_MAX_RESTARTS }
  isDestroyed(): boolean { return this.destroyed }

  start(): void {
    if (this.child || this.disabled() || this.destroyed) return
    const child = spawn(this.spec.bin, [...this.spec.args], { stdio: ['pipe', 'pipe', 'ignore'], ...spawnOptionsFor(this.spec) })
    this.child = child
    if (this.pidFile && child.pid) {
      const record = JSON.stringify({ pid: child.pid, cmd: [this.spec.bin, ...this.spec.args].join(' '), processGroup: ownsProcessGroup() })
      try { writeFileSync(this.pidFile, record) } catch { /* reaping is best-effort */ }
    }
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      // A replaced child's stream can drain after its exit callback. Never let
      // those stale bytes repopulate the shared line buffer for the new child.
      if (this.child === child) this.onData(child, chunk)
    })
    const onGone = () => this.onDeath(child)
    child.on('exit', onGone)
    child.on('error', onGone)
    // A serve process can outlive its stdin (for example across an app upgrade
    // or an interrupted shutdown). Writing to that closed pipe emits `EPIPE`
    // on the stdin stream; without a listener Node promotes it to an uncaught
    // main-process exception before the write callback can reject the request.
    child.stdin!.on('error', () => {
      if (this.child !== child) return
      this.onDeath(child)
      killGracefully(child)
    })
  }

  private onData(child: ReturnType<typeof spawn>, chunk: string): void {
    this.buffer += chunk
    this.bufferBytes += Buffer.byteLength(chunk)
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      const rawLineBytes = Buffer.byteLength(rawLine)
      this.bufferBytes = Math.max(0, this.bufferBytes - rawLineBytes - 1)
      if (rawLineBytes > MAX_OUTPUT_BYTES) {
        this.terminateForOverflow(child)
        return
      }
      const line = rawLine.trim()
      if (!line) continue
      let msg: { id?: number; ready?: boolean; progress?: string; ok?: boolean; refused?: boolean; output?: string; error?: string }
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.ready) continue
      if (typeof msg.id !== 'number') continue
      const waiter = this.pending.get(msg.id)
      if (!waiter) continue
      // Any frame for this request is proof of life: restart its watchdog so a
      // long cold parse that heartbeats progress is never killed mid-flight.
      waiter.arm()
      if (typeof msg.progress === 'string') {
        if (!this.consumeDecodedOutput(child, waiter, msg.progress)) return
        if (waiter.onStderr) {
          try { waiter.onStderr(msg.progress) } catch { /* progress consumers never own the request */ }
        }
        continue
      }
      const terminalOutput = typeof msg.output === 'string' ? msg.output : typeof msg.error === 'string' ? msg.error : ''
      if (!this.consumeDecodedOutput(child, waiter, terminalOutput)) return
      this.pending.delete(msg.id)
      waiter.clear()
      if (msg.ok && typeof msg.output === 'string') {
        if (waiter.warmsServe) this.warmed = true
        try { waiter.resolve(JSON.parse(msg.output)) }
        catch { waiter.reject(new CliError('bad-json', 'codeburn produced output that was not valid JSON')) }
      } else {
        waiter.reject(new CliError('nonzero', msg.error ?? 'serve request failed'))
      }
    }
    // Complete lines are bounded above before parsing. Bound the partial frame
    // too, otherwise a child that never emits '\n' can grow this buffer forever.
    if (this.bufferBytes > MAX_OUTPUT_BYTES) this.terminateForOverflow(child)
  }

  private consumeDecodedOutput(
    child: ReturnType<typeof spawn>,
    waiter: { decodedBytes: number },
    output: string,
  ): boolean {
    waiter.decodedBytes += Buffer.byteLength(output)
    if (waiter.decodedBytes <= MAX_OUTPUT_BYTES) return true
    this.terminateForOverflow(child)
    return false
  }

  private terminateForOverflow(child: ReturnType<typeof spawn>): void {
    if (this.child !== child) return
    const error = new CliError('too-large', `codeburn serve produced more than ${MAX_OUTPUT_BYTES} bytes`)
    // Detach synchronously before SIGKILL. A new request may start the next
    // generation immediately; the old child's eventual exit must not reject it.
    this.child = null
    this.buffer = ''
    this.bufferBytes = 0
    this.warmed = false
    // Deliberate termination, not a crash: it must not spend the unexpected-death
    // budget, or three oversized payloads would disable serve for the app run.
    activeChildren.delete(child as never)
    for (const [, waiter] of this.pending) {
      waiter.clear()
      waiter.reject(error)
    }
    this.pending.clear()
    signalOwnedTree(child, 'SIGKILL')
  }

  private onDeath(child: ReturnType<typeof spawn>, countsTowardBudget = true): void {
    // Both `error` and `exit` can fire for one child, and destroy() performs the
    // same cleanup synchronously. Only the currently-owned child may transition
    // this client or reject its pending requests.
    if (this.child !== child) return
    this.child = null
    this.buffer = ''
    this.bufferBytes = 0
    this.warmed = false
    if (countsTowardBudget) this.deaths += 1
    activeChildren.delete(child as never)
    for (const [, waiter] of this.pending) {
      waiter.clear()
      waiter.reject(new CliError('nonzero', 'codeburn serve exited'))
    }
    this.pending.clear()
  }

  restartAfterMutation(): void {
    const child = this.child
    if (child) {
      // This is an intentional replacement, not a crash. Detach first so the
      // later exit event cannot consume the unexpected-death budget. The
      // outgoing child may hold the refresh lock, so it gets the same SIGTERM
      // grace a timed-out one does and can unlink that lock on its way out.
      this.onDeath(child, false)
      killGracefully(child)
    }
    this.start()
  }

  request(args: string[], timeoutMs: number, onStderr?: (chunk: string) => void): Promise<unknown> {
    // The stdio server is deliberately serial. Mirror that contract client-side
    // so queued calls do not start their timers while a cold request is still
    // hydrating the cache in front of them.
    const run = () => this.requestNow(args, timeoutMs, onStderr)
    const result = this.requestTail.then(run, run)
    this.requestTail = result.then(() => undefined, () => undefined)
    return result
  }

  private requestNow(args: string[], timeoutMs: number, onStderr?: (chunk: string) => void): Promise<unknown> {
    const child = this.child
    if (!child?.stdin) return Promise.reject(new CliError('nonzero', 'serve not running'))
    const id = this.nextId++
    const idleMs = this.warmed ? timeoutMs : Math.max(timeoutMs, DESKTOP_COLD_TIMEOUT_MS)
    return new Promise<unknown>((resolve, reject) => {
      let idleTimer: NodeJS.Timeout
      // A hung request would block the serialized queue behind it; kill the
      // child so everything falls back to spawns and a fresh serve restarts.
      const expire = (message: string) => {
        entry.clear()
        this.pending.delete(id)
        reject(new CliError('timeout', message))
        killGracefully(child)
      }
      const ceiling = setTimeout(() => expire(`codeburn serve exceeded ${MAX_RUNTIME_MS}ms`), MAX_RUNTIME_MS)
      const entry: PendingServeRequest = {
        resolve,
        reject,
        arm: () => {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => expire(`codeburn serve produced no output for ${idleMs}ms`), idleMs)
        },
        clear: () => { clearTimeout(idleTimer); clearTimeout(ceiling) },
        warmsServe: args[0] === 'status',
        decodedBytes: 0,
        ...(onStderr ? { onStderr } : {}),
      }
      entry.arm()
      this.pending.set(id, entry)
      child.stdin!.write(JSON.stringify({ id, args }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id)
          entry.clear()
          reject(new CliError('nonzero', 'serve write failed'))
        }
      })
    })
  }

  destroy(): ChildProcess | null {
    this.destroyed = true
    this.deaths = SERVE_MAX_RESTARTS
    const child = this.child
    if (!child) return null
    this.onDeath(child, false)
    return child
  }
}

let serveClient: ServeClient | null = null

/** Start the resident serve child without issuing a query. The first real panel
 *  request is accepted immediately (even before the ready frame) and performs
 *  the one cold-cache hydration while streaming progress back to the splash.
 *  `pidFile` records the child so {@link reapOrphanServe} can clean it up if the
 *  app dies without ever closing the child's stdin. */
export function startServe(pidFile?: string): void {
  if (shuttingDown) return
  const target = resolveTarget()
  if (!target) return
  if (serveClient?.disabled()) return
  if (!serveClient) {
    const spec = spawnSpecFor(target, ['serve', '--stdio'])
    // CODEBURN_SERVE_PROGRESSIVE opts this child into answering a cold menubar
    // payload from the files the requested period can show, labelled
    // `hydration.complete: false`, with the rest indexed behind it (#1110).
    // Only clients that render the indexing indicator may ask for that; this
    // renderer does. One-shot spawns (including the fallback below) never get
    // it — a one-shot cannot converge.
    spec.env = { ...spec.env, CODEBURN_PROGRESS: '1', CODEBURN_SERVE_PROGRESSIVE: '1' }
    serveClient = new ServeClient(spec, pidFile)
  }
  serveClient.start()
}

/**
 * Best-effort reap of a serve child orphaned by a previous run (an app crash
 * leaves no one to close its stdin). Reads the pid recorded by
 * {@link startServe}, and — because pids are recycled — signals it only after
 * `ps` confirms the process is still a codeburn serve. SIGTERM, never SIGKILL:
 * the orphan may be holding the cache refresh lock.
 */
/**
 * The live command line of `pid`, or null if it cannot be established.
 *
 * POSIX uses `ps -ww` (`-ww` defeats ps's width truncation). Windows has no
 * equivalent that reports argv: `tasklist` only ever reports the image name and
 * window title, and `wmic` is removed from current Windows, so this asks CIM for
 * Win32_Process.CommandLine. `pid` is a validated integer before it is
 * interpolated, and neither call goes through a shell.
 */
function processCommandLine(pid: number): string | null {
  try {
    const out = platform() === 'win32'
      ? execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: 'utf-8', timeout: 5_000, windowsHide: true },
        )
      : execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2_000 })
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * Whether a live command line is the serve child we recorded. Exact match, not
 * a keyword sniff: any looser test signals whatever unrelated process inherited
 * the pid. Quoting is normalized away because the two sides quote differently —
 * we record a plain space-joined argv, while Windows reports the real command
 * line with its quotes intact — so a path containing spaces still round-trips.
 */
export function serveCommandMatches(recorded: string, observed: string | null): boolean {
  if (!observed) return false
  const normalize = (value: string): string => value.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
  const wanted = normalize(recorded)
  return wanted.length > 0 && normalize(observed) === wanted
}

export function reapOrphanServe(pidFile: string): void {
  let record: { pid?: unknown; cmd?: unknown; processGroup?: unknown }
  try { record = JSON.parse(readFileSync(pidFile, 'utf-8')) } catch { return }
  try { unlinkSync(pidFile) } catch { /* stale file is harmless */ }
  const pid = record.pid
  const cmd = record.cmd
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  if (typeof cmd !== 'string' || !cmd) return
  if (!serveCommandMatches(cmd, processCommandLine(pid))) return
  if (record.processGroup === true && platform() !== 'win32') {
    try { process.kill(-pid, 'SIGTERM'); return } catch { /* fall back for a pre-group child */ }
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

function restartServeAfterMutation(): void {
  // CLI-only consumers never started serve, so do not create a surprise daemon
  // for them. In Electron, replace the resident child immediately so its parser
  // and output memos cannot survive a successful config mutation. Reusing the
  // client preserves its app-lifetime budget of unexpected child deaths.
  if (!serveClient) return
  serveClient.restartAfterMutation()
}

function actionInvalidatesServe(args: string[]): boolean {
  // Export only writes the caller-selected artifact. Every other current
  // Electron action changes config or device state, and future actions restart
  // by default until they are explicitly proven state-preserving.
  return args[0] !== 'export'
}

function isServeCompatibleEnv(extraEnv?: NodeJS.ProcessEnv): boolean {
  if (!extraEnv) return true
  const entries = Object.entries(extraEnv).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return true
  return entries.length === 1 && entries[0]![0] === 'CODEBURN_PROGRESS' && entries[0]![1] === '1'
}

export function spawnCli(
  args: string[],
  opts: { timeoutMs?: number; onStderr?: (chunk: string) => void; extraEnv?: NodeJS.ProcessEnv; priority?: SpawnPriority } = {},
): Promise<unknown> {
  if (shuttingDown) return Promise.reject(new CliError('nonzero', 'codeburn is shutting down'))
  const target = resolveTarget()
  if (!target) return Promise.reject(new CliError('not-found', 'codeburn CLI not found', notFoundStage()))
  const spec = spawnSpecFor(target, args)
  // Heartbeats for the no-output watchdog: a multi-minute parse writes progress
  // lines to stderr instead of going silent. Only reads get this — mutations
  // (spawnCliAction) keep their plain total-runtime cap.
  spec.env = { ...spec.env, CODEBURN_PROGRESS: '1' }
  if (opts.extraEnv) spec.env = { ...spec.env, ...opts.extraEnv }

  const generation = readGeneration
  const key = JSON.stringify([generation, spec.bin, ...spec.args])
  const existing = readInflight.get(key)
  // A same-cadence re-poll during a slow cold warmup coalesces onto the one
  // in-flight child (which already carries onStderr); no second cold parse.
  // Coalesced calls settle here, BEFORE queueing, so they never hold a slot.
  if (existing) return existing

  const priority = opts.priority ?? 'interactive'

  // Serve fast-path: the child is started once at app startup. It accepts the
  // first real query before its ready frame, making that request the single
  // cache warm-up. CODEBURN_PROGRESS is compatible because startServe sets it
  // on the resident child; any other per-call env needs an isolated one-shot.
  if (SERVE_ROUTED.has(args[0] ?? '') && isServeCompatibleEnv(opts.extraEnv)) {
    const serve = serveClient
    // Recover lazily from an unexpected child death. start() is synchronous and
    // idempotent, and the client's lifetime death budget prevents an endlessly
    // crashing binary from being respawned on every poll.
    if (serve && !serve.isRunning() && !serve.disabled()) serve.start()
    if (serve?.isRunning()) {
      const flight = serve.request(args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.onStderr)
        .catch(err => {
          // App shutdown is terminal: never turn rejected resident requests
          // into brand-new one-shot children after killAll() has reaped them.
          if (serve.isDestroyed() || (err instanceof CliError && err.kind === 'too-large')) throw err
          return runScheduledCli(
            spec,
            args[0] ?? '',
            opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            priority,
            opts.onStderr,
          )
        })
        .finally(() => { readInflight.delete(key) })
      readInflight.set(key, flight)
      return flight
    }
  }

  const flight = runScheduledCli(
    spec,
    args[0] ?? '',
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    priority,
    opts.onStderr,
  )
    .finally(() => { readInflight.delete(key) })
  readInflight.set(key, flight)
  return flight
}

/** Spawn a config-mutating CLI command and return its text output verbatim.
 *  Mutations count as interactive, so they take a run slot ahead of any queued
 *  background warm — a Settings save is never stuck behind speculative prefetch. */
export function spawnCliAction(args: string[], opts: { timeoutMs?: number; extraEnv?: NodeJS.ProcessEnv } = {}): Promise<ActionResult> {
  if (shuttingDown) return Promise.resolve({ ok: false, stdout: '', stderr: 'codeburn is shutting down', code: null })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const target = resolveTarget()
  if (!target) return Promise.resolve({ ok: false, stdout: '', stderr: 'codeburn CLI not found', code: null })
  const spec = spawnSpecFor(target, args)
  // Actions never ride the resident `serve` child, so an extra variable simply joins the
  // one-shot spawn's env. The bundled-menubar install is the only caller: it names the .msi
  // the desktop app staged rather than putting a path on a command line.
  if (opts.extraEnv) spec.env = { ...spec.env, ...opts.extraEnv }
  return (async () => {
    try {
      await acquireSlot('interactive')
    } catch {
      // Slot grant was cancelled (killAll during quit); never reached a spawn.
      return { ok: false, stdout: '', stderr: 'codeburn cancelled', code: null }
    }
    try {
      if (shuttingDown) return { ok: false, stdout: '', stderr: 'codeburn is shutting down', code: null }
      return await runAction(spec, args, timeoutMs)
    } finally {
      releaseSlot()
    }
  })()
}

// Mutations keep a plain total-runtime cap and no progress env: they are short
// by design (a config write, an export), never a full-history parse, so there is
// no long silent stretch for a watchdog to misread.
function runAction(spec: SpawnSpec, args: string[], timeoutMs: number): Promise<ActionResult> {
  return new Promise<ActionResult>(resolve => {
    const child = spawn(spec.bin, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptionsFor(spec) })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: ActionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeChildren.delete(child)
      if (result.ok && actionInvalidatesServe(args)) {
        // Fence coalescing before the action promise resolves. An immediate
        // same-argv refetch belongs to the new config generation even while an
        // older read is still running.
        readGeneration += 1
        restartServeAfterMutation()
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      signalOwnedTree(child, 'SIGKILL')
      finish({ ok: false, stdout, stderr: `codeburn ${args[0] ?? ''} timed out after ${timeoutMs}ms`, code: null })
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', err => finish({ ok: false, stdout, stderr: err.message, code: null }))
    child.on('close', code => finish({ ok: code === 0, stdout, stderr, code }))
  })
}
