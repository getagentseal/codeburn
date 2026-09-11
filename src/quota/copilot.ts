// Live GitHub Copilot quota via the editor plugins' internal usage endpoint.
//
// - GET https://api.github.com/copilot_internal/user
//     Headers mirror observed GitHub Copilot client traffic (Editor-Version /
//     Editor-Plugin-Version / X-Github-Api-Version). This is an INTERNAL, UNDOCUMENTED
//     API that may drift without notice; every failure must degrade to the
//     normal connection states and never crash the panel.
//
// The host is not fixed. GitHub Enterprise Cloud with data residency puts an
// enterprise on its own hostname (`<tenant>.ghe.com`) whose API lives at
// `api.<tenant>.ghe.com`, so the credential carries the host it was read from
// and the endpoint follows it. A host we cannot derive an endpoint for fails
// naming that host rather than sending the credential to api.github.com
// (#1286). Self-hosted GitHub Enterprise Server is out of scope.
//
// Credential: the GitHub OAuth token already on disk from a signed-in Copilot
// plugin - hosts.json (keyed by host) falling back to apps.json (keyed by app
// name). The plugins write those under ~/.config/github-copilot on macOS and
// Linux but under %LOCALAPPDATA%\github-copilot on Windows, so the directory
// is resolved per platform. Read-only; no new storage.
import os from 'node:os'
import path from 'node:path'

import { fraction, quotaRequestSignal, readSecureFile, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

export const COPILOT_DEFAULT_HOST = 'github.com'
export const COPILOT_DEFAULT_API_HOST = 'api.github.com'
const ENTERPRISE_CLOUD_SUFFIX = '.ghe.com'
const USAGE_PATH = '/copilot_internal/user'
const HEADERS = {
  Accept: 'application/json',
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'X-Github-Api-Version': '2025-04-01',
} as const

type HostRecord = Record<string, any> & { oauth_token?: unknown }

/** A discovered token together with the GitHub host it belongs to. */
type CopilotCredential = { token: string; host: string | null }

/**
 * Bare lowercased hostname: tolerates whitespace, a scheme, a path, userinfo
 * and a port, because these keys are written by several different clients.
 */
export function normalizeCopilotHost(raw: string | null | undefined): string | null {
  let host = (raw ?? '').trim().toLowerCase()
  if (!host) return null
  const scheme = host.indexOf('://')
  if (scheme !== -1) host = host.slice(scheme + 3)
  host = host.split('/')[0] ?? ''
  const at = host.lastIndexOf('@')
  if (at !== -1) host = host.slice(at + 1)
  host = host.split(':')[0] ?? ''
  return host || null
}

/**
 * API host serving Copilot quota for a credential's GitHub host, or null when
 * this build cannot address it. A null `host` means the source carried none,
 * which is dotcom.
 */
export function copilotAPIHost(host: string | null | undefined): string | null {
  const normalized = normalizeCopilotHost(host)
  if (!normalized) return COPILOT_DEFAULT_API_HOST
  if (normalized === COPILOT_DEFAULT_HOST || normalized === COPILOT_DEFAULT_API_HOST) return COPILOT_DEFAULT_API_HOST
  if (normalized.endsWith(ENTERPRISE_CLOUD_SUFFIX) && normalized.length > ENTERPRISE_CLOUD_SUFFIX.length) {
    return normalized.startsWith('api.') ? normalized : `api.${normalized}`
  }
  return null
}

export function copilotUsageEndpoint(host: string | null | undefined): string | null {
  const apiHost = copilotAPIHost(host)
  return apiHost ? `https://${apiHost}${USAGE_PATH}` : null
}

/**
 * Picks the host to query out of the hosts a credential file lists; a null
 * entry stands for a source with no host of its own, i.e. dotcom. One entry is
 * unambiguous and is used as-is even when unsupported, so the failure can name
 * the host the user signed in to. With several, dotcom wins (what every
 * non-enterprise client writes), else the first `.ghe.com` tenant in sorted
 * order, so the pick is stable from one read to the next.
 */
export function preferredCopilotHost(hosts: (string | null)[]): string | null {
  const normalized = hosts.map(host => normalizeCopilotHost(host) ?? COPILOT_DEFAULT_HOST)
  if (normalized.length === 0) return null
  if (normalized.length === 1) return normalized[0] ?? null
  if (normalized.includes(COPILOT_DEFAULT_HOST)) return COPILOT_DEFAULT_HOST
  const enterprise = normalized.filter(host => host.endsWith(ENTERPRISE_CLOUD_SUFFIX)).sort()
  return enterprise[0] ?? normalized.slice().sort()[0] ?? null
}

const CREDENTIAL_FILES = ['hosts.json', 'apps.json'] as const

/**
 * apps.json keys look like `github.com:Iv1.<app id>` on the newer plugins and
 * like a bare app name ("Visual Studio Code") on the older ones; only the
 * former carries a host.
 */
function hostFromAppsKey(key: string): string | null {
  const separator = key.indexOf(':')
  if (separator === -1) return null
  const candidate = key.slice(0, separator)
  return candidate.includes('.') ? candidate : null
}

export type CopilotDeps = {
  fetch: typeof fetch
  /** Ordered credential directories; the first file that yields a token wins. */
  configDirs: string[]
  readFile: typeof readSecureFile
}

/**
 * Where the signed-in Copilot plugins keep hosts.json / apps.json. Windows has
 * no ~/.config: the plugins follow the platform convention and write under
 * %LOCALAPPDATA%. The XDG path stays as a second candidate there, because a
 * token copied in from a POSIX-style shell (Git Bash, an MSYS home) lands in
 * it and is just as valid.
 */
export function copilotConfigDirs(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const xdg = path.join(home, '.config', 'github-copilot')
  if (platform !== 'win32') return [xdg]
  const localAppData = env['LOCALAPPDATA']?.trim() || path.join(home, 'AppData', 'Local')
  return [path.join(localAppData, 'github-copilot'), xdg]
}

// Resolved per call rather than once at import so a caller (and the tests) can
// change the platform or the environment the paths are derived from.
function defaultDeps(): CopilotDeps {
  return { fetch: globalThis.fetch, configDirs: copilotConfigDirs(), readFile: readSecureFile }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'copilot', connection, primary: null, details: [], planLabel: null, footerLines }
}

/**
 * Reads the `oauth_token` entries out of a credential map and picks one with
 * `preferredCopilotHost`, so the token sent and the host it is sent to always
 * come from the same entry. Keys are visited in sorted order, making the pick
 * stable when several entries qualify.
 */
function credentialFromMap(raw: string, hostForKey: (key: string) => string | null): CopilotCredential | null {
  const map = JSON.parse(raw) as Record<string, HostRecord>
  const entries: CopilotCredential[] = []
  for (const key of Object.keys(map).sort()) {
    const token = map[key]?.oauth_token
    if (typeof token !== 'string' || !token) continue
    entries.push({ token, host: hostForKey(key) })
  }
  const preferred = preferredCopilotHost(entries.map(entry => entry.host))
  if (!preferred) return null
  return entries.find(entry => (normalizeCopilotHost(entry.host) ?? COPILOT_DEFAULT_HOST) === preferred) ?? null
}

async function credentialFromFiles(deps: CopilotDeps): Promise<CopilotCredential | null> {
  for (const dir of deps.configDirs) {
    for (const name of CREDENTIAL_FILES) {
      try {
        const raw = await deps.readFile(path.join(dir, name), 64 * 1024)
        if (!raw) continue
        // hosts.json is keyed by GitHub host, apps.json by "<host>:<app id>".
        const credential = credentialFromMap(raw, name === 'hosts.json' ? key => key : hostFromAppsKey)
        if (credential) return credential
      } catch {
        // A malformed or unreadable file falls through to the next candidate.
      }
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

export function decodeCopilotUsage(body: unknown, apiHost: string = COPILOT_DEFAULT_API_HOST): QuotaProvider {
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
    // Name the endpoint when it is not dotcom, so an enterprise tenant can see
    // which host answered.
    footerLines: apiHost === COPILOT_DEFAULT_API_HOST ? [] : [`Source: ${apiHost}`],
  }
}

function unsupportedHostFooter(host: string): string {
  return `Copilot quota is not available for the GitHub host ${host}. `
    + 'CodeBurn can read github.com and GitHub Enterprise Cloud (*.ghe.com) hosts.'
}

async function request(credential: CopilotCredential, endpoint: string, deps: CopilotDeps, parent?: AbortSignal): Promise<Response> {
  return deps.fetch(endpoint, {
    method: 'GET', signal: quotaRequestSignal(parent),
    headers: { ...HEADERS, Authorization: `token ${credential.token}` },
  })
}

export type CopilotResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchCopilotQuota(options: Partial<CopilotDeps> & { signal?: AbortSignal } = {}): Promise<CopilotResult> {
  const deps = { ...defaultDeps(), ...options }
  // Named in the failure footers so an unreachable enterprise tenant says which
  // host was tried instead of a bare "Temporarily unavailable".
  let apiHost = COPILOT_DEFAULT_API_HOST
  try {
    let credential = await credentialFromFiles(deps)
    if (!credential) return { quota: empty('disconnected') }
    const endpointFor = (value: CopilotCredential): string | null => copilotUsageEndpoint(value.host)
    let endpoint = endpointFor(credential)
    if (!endpoint) {
      // Never retried against api.github.com: that endpoint does not honour an
      // enterprise credential and must not receive it.
      return { quota: empty('terminalFailure', [unsupportedHostFooter(normalizeCopilotHost(credential.host) ?? COPILOT_DEFAULT_HOST)]) }
    }
    apiHost = copilotAPIHost(credential.host) ?? apiHost

    let response = await request(credential, endpoint, deps, options.signal)
    if (response.status === 401) {
      // An active editor session rotates this token; re-read once before
      // giving up so we don't report a failure the disk already fixed.
      const reread = await credentialFromFiles(deps)
      if (!reread || reread.token === credential.token) return { quota: empty('transientFailure') }
      credential = reread
      const rereadEndpoint = endpointFor(credential)
      if (!rereadEndpoint) {
        return { quota: empty('terminalFailure', [unsupportedHostFooter(normalizeCopilotHost(credential.host) ?? COPILOT_DEFAULT_HOST)]) }
      }
      endpoint = rereadEndpoint
      apiHost = copilotAPIHost(credential.host) ?? apiHost
      response = await request(credential, endpoint, deps, options.signal)
    }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) }
    }
    if (!response.ok) {
      return {
        quota: empty(
          response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure',
          [`Copilot quota fetch failed (HTTP ${response.status}) at ${apiHost}.`],
        ),
      }
    }
    return { quota: decodeCopilotUsage(await response.json(), apiHost) }
  } catch (error) {
    console.warn(`Copilot quota unavailable from ${apiHost}: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure', [`Could not reach ${apiHost}: ${sanitizeError(error)}`]) }
  }
}
