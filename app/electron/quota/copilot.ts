// Live GitHub Copilot quota via the editor plugins' internal usage endpoint.
//
// - GET https://api.github.com/copilot_internal/user
//     Headers mirror observed GitHub Copilot client traffic (Editor-Version /
//     Editor-Plugin-Version / X-Github-Api-Version). This is an INTERNAL, UNDOCUMENTED
//     API that may drift without notice; every failure must degrade to the
//     normal connection states and never crash the panel.
//
// Credential: the GitHub OAuth token already on disk from a signed-in Copilot
// plugin — ~/.config/github-copilot/hosts.json (keyed by host) falling back to
// apps.json (keyed by app name). Read-only; no new storage.
import os from 'node:os'
import path from 'node:path'

import { fraction, quotaRequestSignal, readSecureFile, sanitizeError } from './security'
import type { QuotaProvider, QuotaWindow } from './types'

const USAGE_ENDPOINT = 'https://api.github.com/copilot_internal/user'
const HEADERS = {
  Accept: 'application/json',
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'X-Github-Api-Version': '2025-04-01',
} as const

type HostRecord = Record<string, any> & { oauth_token?: unknown }

export type CopilotDeps = {
  fetch: typeof fetch
  hostsPath: string
  appsPath: string
  readFile: typeof readSecureFile
}

const defaults: CopilotDeps = {
  fetch: globalThis.fetch,
  hostsPath: path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json'),
  appsPath: path.join(os.homedir(), '.config', 'github-copilot', 'apps.json'),
  readFile: readSecureFile,
}

function empty(connection: QuotaProvider['connection']): QuotaProvider {
  return { provider: 'copilot', connection, primary: null, details: [], planLabel: null, footerLines: [] }
}

function tokenFromMap(raw: string): string | null {
  const map = JSON.parse(raw) as Record<string, HostRecord>
  // hosts.json keys by host — prefer github.com; apps.json has no canonical
  // key, so its first entry wins. Both store the token as `oauth_token`.
  const preferred = map['github.com'] ?? Object.values(map)[0]
  const token = preferred?.oauth_token
  return typeof token === 'string' && token ? token : null
}

async function credentialFromFiles(deps: CopilotDeps): Promise<string | null> {
  for (const filePath of [deps.hostsPath, deps.appsPath]) {
    try {
      const raw = await deps.readFile(filePath, 64 * 1024)
      if (!raw) continue
      const token = tokenFromMap(raw)
      if (token) return token
    } catch {
      // A malformed or unreadable file falls through to the next candidate.
    }
  }
  return null
}

function windowOf(label: string, snapshot: unknown): QuotaWindow | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const row = snapshot as Record<string, unknown>
  // The API reports percent REMAINING (0..100); windows render percent USED.
  const rawRemaining = row.percent_remaining ?? row.percentRemaining
  const remaining = fraction(typeof rawRemaining === 'number' ? rawRemaining : NaN)
  if (remaining === null) return null
  // A plan without this quota reports entitlement 0 and 0% remaining, which
  // would render as 100% used; unlimited windows have no meaningful percent.
  if (row.entitlement === 0 || row.unlimited === true) return null
  // Round away float dust from the 1-remaining subtraction (1-0.7 !== 0.3).
  return { label, percent: Number((1 - remaining).toFixed(6)), resetsAt: null }
}

function planLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const lower = value.trim().toLowerCase()
  const known: Record<string, string> = {
    free: 'Free', individual: 'Individual', pro: 'Pro', business: 'Business',
    enterprise: 'Enterprise', for_educators: 'Educators', 'for-educators': 'Educators',
  }
  return known[lower] ?? lower.replace(/(^|[_-])\w/g, match => match.replace(/[_-]/, ' ').toUpperCase())
}

export function decodeCopilotUsage(body: unknown): QuotaProvider {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  // Field names have shipped both camelCase and snake_case; read each alias
  // rather than trusting one spelling.
  const snapshots = data.quota_snapshots ?? data.quotaSnapshots
  const premium = windowOf('Premium requests', snapshots?.premium_interactions ?? snapshots?.premiumInteractions)
  const chat = windowOf('Chat', snapshots?.chat)
  const details = [premium, chat].filter((row): row is QuotaWindow => row !== null)
  return {
    provider: 'copilot', connection: 'connected', primary: premium ?? chat,
    details,
    planLabel: planLabel(data.copilot_plan ?? data.copilotPlan),
    footerLines: [],
  }
}

async function request(token: string, deps: CopilotDeps, parent?: AbortSignal): Promise<Response> {
  return deps.fetch(USAGE_ENDPOINT, {
    method: 'GET', signal: quotaRequestSignal(parent),
    headers: { ...HEADERS, Authorization: `token ${token}` },
  })
}

export type CopilotResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchCopilotQuota(options: Partial<CopilotDeps> & { signal?: AbortSignal } = {}): Promise<CopilotResult> {
  const deps = { ...defaults, ...options }
  try {
    let token = await credentialFromFiles(deps)
    if (!token) return { quota: empty('disconnected') }

    let response = await request(token, deps, options.signal)
    if (response.status === 401) {
      // An active editor session rotates this token; re-read once before
      // giving up so we don't report a failure the disk already fixed.
      const reread = await credentialFromFiles(deps)
      if (!reread || reread === token) return { quota: empty('transientFailure') }
      token = reread
      response = await request(token, deps, options.signal)
    }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) }
    }
    if (!response.ok) return { quota: { ...empty(response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure'), ...(response.status === 401 || response.status === 403 ? { connectable: true } : {}) } }
    return { quota: decodeCopilotUsage(await response.json()) }
  } catch (error) {
    console.warn(`Copilot quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
