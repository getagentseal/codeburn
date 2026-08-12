// Plan-limit calibration sampler (opt-in via `codeburn calibrate --enable`).
// Periodically records Anthropic's live plan-window utilization (the same
// oauth/usage endpoint the menubar polls) into a local JSONL so the deltas can
// later be regressed against the token record to recover per-model plan-burn
// weights. Local only: samples never leave the machine.
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const BETA_HEADER = 'oauth-2025-04-20'
const USER_AGENT = 'claude-code/2.1.0'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Minimum spacing between samples; the serve tick calls in more often and
 * relies on this throttle, keyed off the samples file's mtime. */
export const SAMPLE_MIN_INTERVAL_MS = 5 * 60 * 1000

type WindowSample = { pct: number; resetsAt?: string }

export type UsageSample = {
  ts: string
  fiveHour?: WindowSample
  sevenDay?: WindowSample
  sevenDayOpus?: WindowSample
  sevenDaySonnet?: WindowSample
  scoped?: Array<{ label: string; pct: number; resetsAt?: string }>
}

function cacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

export function usageSamplesPath(): string {
  return join(cacheDir(), 'usage-samples.jsonl')
}

type OauthRecord = { accessToken?: string; expiresAt?: number }

function parseCredentialJson(text: string): OauthRecord | undefined {
  try {
    const root = JSON.parse(text) as { claudeAiOauth?: OauthRecord }
    return root.claudeAiOauth
  } catch {
    return undefined
  }
}

/** Claude Code's OAuth access token: the credentials file where it exists
 * (Linux, some macOS setups), else the macOS keychain item Claude Code
 * writes. Returns undefined when absent or expired — never throws. */
export async function readClaudeAccessToken(): Promise<string | undefined> {
  const fromFile = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    .then(parseCredentialJson)
    .catch(() => undefined)
  const candidates: OauthRecord[] = fromFile ? [fromFile] : []

  if (candidates.length === 0 && process.platform === 'darwin') {
    const fromKeychain = await execFileAsync(
      'security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000 },
    )
      .then(r => parseCredentialJson(r.stdout))
      .catch(() => undefined)
    if (fromKeychain) candidates.push(fromKeychain)
  }

  for (const oauth of candidates) {
    const token = oauth.accessToken?.trim()
    if (!token) continue
    // expiresAt is epoch millis; skip tokens already (about to be) expired.
    if (oauth.expiresAt !== undefined && oauth.expiresAt < Date.now() + 60_000) continue
    return token
  }
  return undefined
}

type UsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number; resets_at?: string }
  seven_day_opus?: { utilization?: number; resets_at?: string }
  seven_day_sonnet?: { utilization?: number; resets_at?: string }
  limits?: Array<{
    kind?: string
    percent?: number
    resets_at?: string
    scope?: { model?: { display_name?: string } }
  }>
}

function window(w?: { utilization?: number; resets_at?: string }): WindowSample | undefined {
  if (w?.utilization === undefined || !Number.isFinite(w.utilization)) return undefined
  return { pct: w.utilization, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) }
}

export function parseUsageResponse(body: string, ts: Date): UsageSample | undefined {
  let r: UsageResponse
  try {
    r = JSON.parse(body) as UsageResponse
  } catch {
    return undefined
  }
  const scoped = (r.limits ?? []).flatMap(limit => {
    if (limit.kind !== 'weekly_scoped') return []
    const label = limit.scope?.model?.display_name
    if (!label || limit.percent === undefined || !Number.isFinite(limit.percent)) return []
    return [{ label, pct: limit.percent, ...(limit.resets_at ? { resetsAt: limit.resets_at } : {}) }]
  })
  const sample: UsageSample = {
    ts: ts.toISOString(),
    ...(window(r.five_hour) ? { fiveHour: window(r.five_hour) } : {}),
    ...(window(r.seven_day) ? { sevenDay: window(r.seven_day) } : {}),
    ...(window(r.seven_day_opus) ? { sevenDayOpus: window(r.seven_day_opus) } : {}),
    ...(window(r.seven_day_sonnet) ? { sevenDaySonnet: window(r.seven_day_sonnet) } : {}),
    ...(scoped.length > 0 ? { scoped } : {}),
  }
  // A sample with no windows at all carries no signal; don't record it.
  const { ts: _, ...windows } = sample
  return Object.keys(windows).length > 0 ? sample : undefined
}

/** True when the samples file was written recently enough that another sample
 * would add noise, not signal. Missing file means sample away. */
export async function sampledRecently(now = Date.now()): Promise<boolean> {
  const s = await stat(usageSamplesPath()).catch(() => undefined)
  return s !== undefined && now - s.mtimeMs < SAMPLE_MIN_INTERVAL_MS
}

export type SampleOutcome =
  | { ok: true; sample: UsageSample }
  | { ok: false; reason: 'throttled' | 'no-token' | 'http-error' | 'malformed' | 'network' }

/** One sample: token → endpoint → append. Every failure is a quiet, typed
 * outcome; the sampler must never break the command it rides along with. */
export async function sampleUsageNow(opts: { force?: boolean } = {}): Promise<SampleOutcome> {
  if (!opts.force && await sampledRecently()) return { ok: false, reason: 'throttled' }
  const token = await readClaudeAccessToken()
  if (!token) return { ok: false, reason: 'no-token' }

  let body: string
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': BETA_HEADER,
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, reason: 'http-error' }
    body = await res.text()
  } catch {
    return { ok: false, reason: 'network' }
  }

  const sample = parseUsageResponse(body, new Date())
  if (!sample) return { ok: false, reason: 'malformed' }

  await mkdir(cacheDir(), { recursive: true })
  await appendFile(usageSamplesPath(), JSON.stringify(sample) + '\n', 'utf8')
  return { ok: true, sample }
}

export type SamplesInfo = { count: number; firstTs?: string; lastTs?: string }

export async function readSamplesInfo(): Promise<SamplesInfo> {
  const text = await readFile(usageSamplesPath(), 'utf8').catch(() => '')
  const lines = text.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return { count: 0 }
  const first = parseTs(lines[0]!)
  const last = parseTs(lines[lines.length - 1]!)
  return {
    count: lines.length,
    ...(first ? { firstTs: first } : {}),
    ...(last ? { lastTs: last } : {}),
  }
}

function parseTs(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { ts?: string }
    return typeof parsed.ts === 'string' ? parsed.ts : undefined
  } catch {
    return undefined
  }
}
