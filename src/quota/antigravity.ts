// Live Antigravity quota from LOCAL surfaces only - the Antigravity app's own
// language server or a signed-in `agy` CLI's embedded server. The local
// Antigravity language-server protocol is undocumented and
// experimental). No Google OAuth fallback in v1: when no local server answers,
// the provider reports disconnected and the UI shows its Connect affordance.
//
// Endpoints (localhost only, Connect-RPC JSON):
// - POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
//     (preferred; falls back to)
// - POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus
//
// Discovery lists processes to find candidates (app language
// servers need their `--csrf_token`; the `agy` CLI needs none), then lists each
// pid's listening TCP ports: `ps` and `lsof` on POSIX, Win32_Process and
// `netstat` on Windows, which has neither. Local HTTPS uses a self-signed cert,
// so TLS verification is relaxed ONLY for the 127.0.0.1 loopback probes.
import { execFile } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { promisify } from 'node:util'

import { fraction, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
const LOCAL_TIMEOUT_MS = 3_000

export type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string }>
export type LocalRequestFn = (
  port: number,
  tls: boolean,
  pathName: string,
  body: string,
  csrf?: string,
) => Promise<{ status: number; text: string } | null>

export type AntigravityDeps = {
  execFile: ExecFileFn
  request: LocalRequestFn
  /// Which process listing to ask for. Injected so both branches are testable from either OS.
  platform: string
}

const execFileAsync: ExecFileFn = promisify(execFile)

function postLocal(port: number, tls: boolean, pathName: string, body: string, csrf?: string): Promise<{ status: number; text: string } | null> {
  return new Promise(resolve => {
    const request = (tls ? https : http).request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: pathName,
      ...(tls ? { rejectUnauthorized: false } : {}),
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        ...(csrf ? { 'X-Codeium-Csrf-Token': csrf } : {}),
      },
      timeout: LOCAL_TIMEOUT_MS,
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }))
    })
    request.on('timeout', () => { request.destroy(); resolve(null) })
    request.on('error', () => resolve(null))
    request.end(body)
  })
}

const defaults: AntigravityDeps = {
  execFile: execFileAsync,
  request: postLocal,
  platform: process.platform,
}

function empty(connection: QuotaProvider['connection']): QuotaProvider {
  return { provider: 'antigravity', connection, primary: null, details: [], planLabel: null, footerLines: [] }
}

// Process kinds distinguish the app language server from standalone processes.
// carries richer quota data than the IDE variant, so IDE matches are skipped;
// a CLI (`agy`) match is accepted because its tokenless server exposes the
// same summary payload.
const LANGUAGE_SERVER = /language[_-]server(_macos)?(_arm)?/
const IDE_MARKER = /antigravity[-_]ide/i
const CLI_MARKER = /antigravity[-_]cli/i
const AGY_BINARY = /(^|\/|\s)agy(\s|$)/
const APP_MARKER = /--app_data_dir[= ]"?antigravity(?![\w-])|\/antigravity\//i

type Candidate = { pid: string; cli: boolean; csrf?: string; extPort?: number }

function flagValue(line: string, flag: string): string | undefined {
  const match = line.match(new RegExp(`${flag}[= ]([^\\s]+)`))
  return match?.[1]
}

export function classifyProcessLine(line: string): Candidate | null {
  const isServer = LANGUAGE_SERVER.test(line)
  const isCli = !isServer && (CLI_MARKER.test(line) || AGY_BINARY.test(line))
  if (!isServer && !isCli) return null
  const pid = line.trim().match(/^(\d+)/)?.[1]
  if (!pid) return null
  // A tokenless desktop language-server match is skipped so a later, valid
  // server can be found; the CLI exposes no CSRF flag and needs none. IDE
  // language servers are excluded too - their payloads lack the weekly groups.
  if (!isCli && (!APP_MARKER.test(line) || IDE_MARKER.test(line))) return null
  const csrf = flagValue(line, '--csrf_token')
  if (!isCli && !csrf) return null
  const extPort = Number(flagValue(line, '--extension_server_port'))
  return { pid, cli: isCli, csrf, extPort: Number.isFinite(extPort) && extPort > 0 ? extPort : undefined }
}

/// Windows has no `ps`, and asking for one is a spawn failure rather than an empty answer:
/// every quota poll there printed `ps: unknown option -- x` and reported a transient failure.
/// Win32_Process is the same listing by another name, and it is already how
/// src/providers/antigravity.ts finds these servers. The Where-Object is only a prefilter to
/// keep the output small; `classifyProcessLine` still decides what counts.
const WINDOWS_PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process'
    + " | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*antigravity*'"
    + " -or $_.CommandLine -like '*language_server*' -or $_.CommandLine -like '*agy*') }"
    + ' | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
].join('; ')

/// Windows searches the current directory before PATH, so a system tool by bare name lets
/// anything dropped beside the caller answer for it.
function system32(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\${exe}`
}

/// One line per process, `<pid> <command line>`, on every platform.
async function listProcesses(deps: AntigravityDeps): Promise<string> {
  if (deps.platform === 'win32') {
    const { stdout } = await deps.execFile(system32('WindowsPowerShell\\v1.0\\powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROCESS_SCRIPT,
    ])
    return stdout
  }
  const { stdout } = await deps.execFile('ps', ['-ax', '-o', 'pid=,command='])
  return stdout
}

/// `netstat -ano` rows are `Proto  Local  Foreign  State  PID`. The state word is localized,
/// so it is not matched on: a row for this pid that is not listening only gives a port the
/// probe then fails to reach, which costs one refused connection and no wrong answer.
export function parseNetstatPorts(stdout: string, pid: string): number[] {
  const ports = new Set<number>()
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || !/^TCP$/i.test(parts[0]!) || parts[parts.length - 1] !== pid) continue
    const port = Number(parts[1]!.split(':').pop())
    if (Number.isFinite(port) && port > 0) ports.add(port)
  }
  return [...ports]
}

async function discoverCandidates(deps: AntigravityDeps): Promise<Candidate[]> {
  const stdout = await listProcesses(deps)
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const line of stdout.split('\n')) {
    const candidate = classifyProcessLine(line)
    if (!candidate || seen.has(candidate.pid)) continue
    seen.add(candidate.pid)
    candidates.push(candidate)
  }
  // The app source ranks above the CLI: richer quota data beats availability.
  return candidates.sort((a, b) => Number(a.cli) - Number(b.cli))
}

async function listeningPorts(deps: AntigravityDeps, pid: string): Promise<number[]> {
  try {
    // No lsof on Windows either; netstat is the listing that ships with it.
    if (deps.platform === 'win32') {
      const { stdout } = await deps.execFile(system32('netstat.exe'), ['-ano', '-p', 'TCP'])
      return parseNetstatPorts(stdout, pid)
    }
    const { stdout } = await deps.execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid])
    const ports = [...stdout.matchAll(/:(\d+)\s/g)].map(match => Number(match[1]))
    return [...new Set(ports)].filter(port => Number.isFinite(port) && port > 0)
  } catch {
    return []
  }
}

function resetTimeOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 1e12 ? value : value * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
  return null
}

function windowOf(label: string, remainingFraction: unknown, resetTime?: unknown): QuotaWindow | null {
  const remaining = fraction(typeof remainingFraction === 'number' ? (1 - remainingFraction) * 100 : NaN)
  if (remaining === null) return null
  return { label, percent: remaining, resetsAt: resetTimeOf(resetTime ?? null) }
}

/** Preferred payload: two named quota groups of model buckets. */
export function decodeAntigravitySummary(body: unknown): QuotaWindow[] {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  // 2.16+ wraps the groups in `response`; older local servers return them directly.
  const groups = Array.isArray(data.response?.groups) ? data.response.groups : data.groups
  const windows: QuotaWindow[] = []
  for (const group of Array.isArray(groups) ? groups : []) {
    const groupName = typeof group?.displayName === 'string' ? group.displayName : ''
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const name = [groupName, typeof bucket?.displayName === 'string' ? bucket.displayName : bucket?.bucketId]
        .filter(Boolean).join(' · ')
      if (!name) continue
      const window = windowOf(
        name,
        bucket?.remainingFraction ?? bucket?.remaining?.remainingFraction,
        bucket?.resetTime ?? bucket?.remaining?.resetTime,
      )
      if (window) windows.push(window)
    }
  }
  return windows
}

/** Legacy payload: flat per-model quota rows under GetUserStatus. */
export function decodeAntigravityStatus(body: unknown): QuotaWindow[] {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  const configs = data.userStatus?.cascadeModelConfigData?.clientModelConfigs
  const windows: QuotaWindow[] = []
  for (const config of Array.isArray(configs) ? configs : []) {
    // Current servers expose the display name as `label`, not `modelName`.
    const name = typeof config?.label === 'string' && config.label.trim() ? config.label
      : typeof config?.modelName === 'string' ? config.modelName : ''
    if (!name) continue
    const window = windowOf(name, config?.quotaInfo?.remainingFraction, config?.quotaInfo?.resetTime)
    if (window) windows.push(window)
  }
  return windows
}

function planFromStatus(body: unknown): string | null {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  const plan = data.planName ?? data.userStatus?.planName ?? data.account_plan
  return typeof plan === 'string' && plan.trim() ? plan.trim() : null
}

async function probePort(deps: AntigravityDeps, port: number, csrf?: string): Promise<{ windows: QuotaWindow[]; planLabel: string | null } | null> {
  const body = JSON.stringify({})
  for (const tls of [true, false]) {
    const summary = await deps.request(port, tls, SUMMARY_PATH, body, csrf)
    if (summary?.status === 200) {
      const windows = decodeAntigravitySummary(parseJson(summary.text))
      if (windows.length > 0) return { windows, planLabel: null }
    }
    const status = await deps.request(port, tls, STATUS_PATH, body, csrf)
    if (status?.status === 200) {
      const parsed = parseJson(status.text)
      const windows = decodeAntigravityStatus(parsed)
      if (windows.length > 0) return { windows, planLabel: planFromStatus(parsed) }
    }
  }
  return null
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export async function fetchAntigravityQuota(deps: Partial<AntigravityDeps> = {}): Promise<QuotaProvider> {
  const resolved = { ...defaults, ...deps }
  try {
    const candidates = await discoverCandidates(resolved)
    if (candidates.length === 0) return empty('disconnected')
    for (const candidate of candidates) {
      const ports = await listeningPorts(resolved, candidate.pid)
      if (candidate.extPort !== undefined && !ports.includes(candidate.extPort)) ports.push(candidate.extPort)
      for (const port of ports) {
        const found = await probePort(resolved, port, candidate.csrf)
        if (found) {
          const windows = [...found.windows].sort((a, b) => b.percent - a.percent)
          return {
            provider: 'antigravity', connection: 'connected',
            primary: windows[0] ?? null,
            details: windows,
            planLabel: found.planLabel,
            footerLines: [],
          }
        }
      }
    }
    return empty('disconnected')
  } catch (error) {
    console.warn(`Antigravity quota unavailable: ${sanitizeError(error)}`)
    return empty('transientFailure')
  }
}
