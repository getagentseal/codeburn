import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

// Runs entirely in the Electron main process. This module must NOT import
// `electron` so it stays unit-testable in a plain node environment.

export type CliErrorKind = 'not-found' | 'nonzero' | 'bad-json' | 'timeout' | 'too-large' | 'bad-args'
export type ActionResult = { ok: boolean; stdout: string; stderr: string; code: number | null }

/** Structured failure so the renderer can pick the right empty/permission state. */
export class CliError extends Error {
  readonly kind: CliErrorKind
  constructor(kind: CliErrorKind, message: string) {
    super(message)
    this.name = 'CliError'
    this.kind = kind
  }
}

const DEFAULT_TIMEOUT_MS = 45_000
// A runaway CLI (or a compromised binary) must not exhaust main-process memory.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
// Same-cadence pollers fire near-identical read spawns; share one child and hold
// its result briefly so six overview hooks don't launch six processes at once.
const COALESCE_TTL_MS = 5_000

// Every live child so `before-quit` can reap them (Electron does not on macOS).
const activeChildren = new Set<ChildProcess>()
const readInflight = new Map<string, Promise<unknown>>()
const readCache = new Map<string, { at: number; value: unknown }>()

/** SIGKILL every in-flight child. Wired to Electron's `before-quit`. */
export function killAll(): void {
  for (const child of activeChildren) child.kill('SIGKILL')
  activeChildren.clear()
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

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
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
    if (value && value.startsWith('/') && isExecutableFile(value)) return value
  } catch {
    // unreadable — fall through to PATH search
  }
  return null
}

/**
 * Resolve the absolute path to the `codeburn` binary, or null if not found.
 * Order: dev override (`CODEBURN_BIN`) → repo CLI in Vite development →
 * persisted-path file → PATH / brew / nvm / volta / asdf → null.
 *
 * The dev repo CLI intentionally beats the persisted-path file: in `npm run
 * dev` the developer is iterating on this repo, so its freshly-built
 * `dist/cli.js` must win over a stale globally-installed/persisted binary
 * (which may lack newly-added commands). Setting `CODEBURN_BIN` still overrides
 * everything. In production `VITE_DEV_SERVER_URL` is unset, so the persisted
 * path behaves exactly as before.
 */
export function resolveCodeburnPath(): string | null {
  const override = process.env.CODEBURN_BIN
  if (override && override.startsWith('/') && isExecutableFile(override)) return override

  // Dev convenience: when launched by the Vite dev server, prefer the repo's own
  // freshly-built CLI over a stale globally-installed/persisted one, so
  // newly-added commands (sessions/compare/act JSON) work without CODEBURN_BIN.
  if (process.env.VITE_DEV_SERVER_URL) {
    const devBin = join(__dirname, '..', '..', '..', 'dist', 'cli.js')
    if (isExecutableFile(devBin)) return devBin
    // Vitest loads this source module from app/electron rather than the emitted
    // app/dist/electron directory; keep the same repo CLI discoverable there.
    const sourceDevBin = join(__dirname, '..', '..', 'dist', 'cli.js')
    if (isExecutableFile(sourceDevBin)) return sourceDevBin
  }

  const persisted = readPersistedPath()
  if (persisted) return persisted

  for (const bin of searchDirs().map(dir => join(dir, 'codeburn'))) {
    if (isExecutableFile(bin)) return bin
  }
  return null
}

function runCli(bin: string, args: string[], timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnvFor(bin) })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let total = 0
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeChildren.delete(child)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL')
        reject(new CliError('timeout', `codeburn ${args[0] ?? ''} timed out after ${timeoutMs}ms`))
      })
    }, timeoutMs)

    const bump = (n: number) => {
      total += n
      if (total > MAX_OUTPUT_BYTES) {
        finish(() => {
          child.kill('SIGKILL')
          reject(new CliError('too-large', `codeburn ${args[0] ?? ''} produced more than ${MAX_OUTPUT_BYTES} bytes`))
        })
      }
    }

    child.stdout.on('data', chunk => { stdout += chunk; bump(chunk.length) })
    child.stderr.on('data', chunk => { stderr += chunk; bump(chunk.length) })

    child.on('error', err => {
      finish(() => reject(new CliError('not-found', err.message)))
    })

    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          reject(new CliError('nonzero', stderr.trim() || `codeburn exited with code ${code}`))
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

/**
 * Spawn `codeburn <args>` with plain argv (never a shell), collect stdout, and
 * decode it as JSON. Rejects with a structured {@link CliError}:
 *   not-found  no binary resolved
 *   nonzero    process exited with a non-zero code (stderr surfaced)
 *   bad-json   stdout was not valid JSON
 *   timeout    the process was killed after `timeoutMs`
 *   too-large  stdout+stderr exceeded {@link MAX_OUTPUT_BYTES}
 *
 * Read-only, so concurrent identical calls share one child and a 5s result cache
 * absorbs same-cadence pollers. Never use this for config-mutating commands.
 */
export function spawnCli(args: string[], opts: { timeoutMs?: number } = {}): Promise<unknown> {
  const bin = resolveCodeburnPath()
  if (!bin) return Promise.reject(new CliError('not-found', 'codeburn CLI not found'))

  const key = JSON.stringify([bin, ...args])
  const cached = readCache.get(key)
  if (cached && Date.now() - cached.at < COALESCE_TTL_MS) return Promise.resolve(cached.value)
  const existing = readInflight.get(key)
  if (existing) return existing

  const flight = runCli(bin, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    .then(value => { readCache.set(key, { at: Date.now(), value }); return value })
    .finally(() => { readInflight.delete(key) })
  readInflight.set(key, flight)
  return flight
}

/** Spawn a config-mutating CLI command and return its text output verbatim. */
export function spawnCliAction(args: string[], opts: { timeoutMs?: number } = {}): Promise<ActionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<ActionResult>(resolve => {
    const bin = resolveCodeburnPath()
    if (!bin) {
      resolve({ ok: false, stdout: '', stderr: 'codeburn CLI not found', code: null })
      return
    }

    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnvFor(bin) })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: ActionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeChildren.delete(child)
      // The action may have changed config the read cache still reflects; a
      // Settings refetch fires immediately after, so serve it fresh data.
      readCache.clear()
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, stdout, stderr: `codeburn ${args[0] ?? ''} timed out after ${timeoutMs}ms`, code: null })
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', err => finish({ ok: false, stdout, stderr: err.message, code: null }))
    child.on('close', code => finish({ ok: code === 0, stdout, stderr, code }))
  })
}
