import crypto from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getCodeburnCacheDir } from '../cache-dir.js'
import {
  claudeKeychainService,
  claudeOrgProfilesCachePath,
  getClaudeConfigDirs,
  getDesktopSessionsDirs,
  readClaudeOrgProfilesCache,
  type CachedClaudeOrgProfile,
} from '../providers/claude.js'
import { wslHomes } from '../wsl.js'
import { fraction, quotaRequestSignal, readKeychainPassword, readSecureFile, sanitizeError } from './security.js'
import type { KeychainOutcome } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile'
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const DEFAULT_REFRESH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const SAFE_STORAGE_SERVICE = 'Claude Safe Storage'
const EXPIRED_FOOTER = ['Claude Code login expired. Run Claude Code once, then refresh.']

export type ClaudeCredential = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  rateLimitTier?: string
  subscriptionType?: string
  scopes?: string[]
  clientId?: string
  orgUuid?: string
  accountUuid?: string
}
/** Where the credential in hand came from, so a rejected token is re-read from that same place. */
type CredentialSource = 'file' | 'keychain' | 'org'
export type ClaudeDeps = {
  fetch: typeof fetch
  credentialPath: string
  /** Credential files inside running WSL distros (#1061); empty off Windows. */
  wslCredentialPaths: () => string[]
  readFile: typeof readSecureFile
  keychain?: (service?: string) => Promise<KeychainOutcome>
  safeStorageKeychain?: () => Promise<KeychainOutcome>
  now: () => number
}

const defaults: ClaudeDeps = {
  fetch: globalThis.fetch,
  credentialPath: path.join(os.homedir(), '.claude', '.credentials.json'),
  wslCredentialPaths: () => wslHomes().map(home => `${home}\\.claude\\.credentials.json`),
  readFile: readSecureFile,
  now: Date.now,
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'claude', connection, primary: null, details: [], planLabel: null, footerLines }
}

function parseCredential(raw: string): ClaudeCredential | null {
  const clean = raw.replace(/\r/g, '').replace(/\n[ \t]*/g, '')
  const oauth = (JSON.parse(clean) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return null
  return {
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0 ? oauth.refreshToken : undefined,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s): s is string => typeof s === 'string') : undefined,
    clientId: typeof oauth.clientId === 'string' && oauth.clientId.length > 0 ? oauth.clientId : undefined,
  }
}

function claudeOrgCredentialsCachePath(): string {
  return path.join(getCodeburnCacheDir(), 'claude-org-credentials.json')
}

type StoredOrgRecord = ClaudeCredential & {
  orgUuid: string
  accountUuid?: string
  label?: string
  organizationType?: string
  isDefaultConfigOrg?: boolean
}

async function readStoredOrgCredentials(readFile: typeof readSecureFile): Promise<Map<string, StoredOrgRecord>> {
  const map = new Map<string, StoredOrgRecord>()
  try {
    const raw = await readFile(claudeOrgCredentialsCachePath(), 256 * 1024)
    if (!raw) return map
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      const row = val as Record<string, unknown>
      if (typeof row.accessToken !== 'string' || !row.accessToken) continue
      const orgUuid = (typeof row.orgUuid === 'string' ? row.orgUuid : key).trim().toLowerCase()
      if (!orgUuid) continue
      map.set(orgUuid, {
        orgUuid,
        accessToken: row.accessToken,
        ...(typeof row.refreshToken === 'string' && row.refreshToken ? { refreshToken: row.refreshToken } : {}),
        ...(typeof row.expiresAt === 'number' ? { expiresAt: row.expiresAt } : {}),
        ...(typeof row.rateLimitTier === 'string' ? { rateLimitTier: row.rateLimitTier } : {}),
        ...(typeof row.subscriptionType === 'string' ? { subscriptionType: row.subscriptionType } : {}),
        ...(Array.isArray(row.scopes) ? { scopes: row.scopes.filter((s): s is string => typeof s === 'string') } : {}),
        ...(typeof row.clientId === 'string' ? { clientId: row.clientId } : {}),
        ...(typeof row.accountUuid === 'string' ? { accountUuid: row.accountUuid.toLowerCase() } : {}),
        ...(typeof row.label === 'string' ? { label: row.label } : {}),
        ...(typeof row.organizationType === 'string' ? { organizationType: row.organizationType } : {}),
        ...(row.isDefaultConfigOrg === true ? { isDefaultConfigOrg: true } : {}),
      })
    }
  } catch {
    // Missing or malformed cache is ignored.
  }
  return map
}

async function writeStoredOrgCredentials(records: Map<string, StoredOrgRecord>): Promise<void> {
  try {
    const dir = getCodeburnCacheDir()
    await mkdir(dir, { recursive: true })
    const credObj: Record<string, StoredOrgRecord> = {}
    const profObj: Record<string, CachedClaudeOrgProfile> = await readClaudeOrgProfilesCache().then(m => Object.fromEntries(m))
    for (const [orgUuid, rec] of records) {
      credObj[orgUuid] = rec
      const prev = profObj[orgUuid]
      const isDefault = rec.isDefaultConfigOrg ?? prev?.isDefaultConfigOrg
      profObj[orgUuid] = {
        orgUuid,
        ...(rec.accountUuid ?? prev?.accountUuid ? { accountUuid: rec.accountUuid ?? prev?.accountUuid } : {}),
        ...(rec.label ?? prev?.label ? { label: rec.label ?? prev?.label } : {}),
        ...(rec.organizationType ?? prev?.organizationType ? { organizationType: rec.organizationType ?? prev?.organizationType } : {}),
        ...(isDefault ? { isDefaultConfigOrg: true } : {}),
      }
    }
    await writeFile(claudeOrgCredentialsCachePath(), JSON.stringify(credObj, null, 2) + '\n', { mode: 0o600 })
    await writeFile(claudeOrgProfilesCachePath(), JSON.stringify(profObj, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // Best-effort cache write.
  }
}

export function decryptSafeStorageV10(base64Ciphertext: string, password: string): string | null {
  try {
    const buf = Buffer.from(base64Ciphertext, 'base64')
    if (buf.length <= 3 || buf.subarray(0, 3).toString('utf8') !== 'v10') return null
    const key = crypto.pbkdf2Sync(password.trim(), 'saltysalt', 1003, 16, 'sha1')
    const iv = Buffer.alloc(16, ' ')
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function parseDesktopTokenCacheV2(rawJson: string): Map<string, StoredOrgRecord> {
  const out = new Map<string, StoredOrgRecord>()
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    for (const [cacheKey, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      const entry = val as Record<string, unknown>
      const token = typeof entry.token === 'string' ? entry.token.trim() : ''
      if (!token) continue
      // Key shape: `acct:<accountUuid>|<clientId>:<orgUuid>:<apiHost>:<scopes>`
      const pipeIdx = cacheKey.indexOf('|')
      const accountUuid = cacheKey.startsWith('acct:') && pipeIdx > 5
        ? cacheKey.slice(5, pipeIdx).toLowerCase()
        : undefined
      const rest = pipeIdx >= 0 ? cacheKey.slice(pipeIdx + 1) : cacheKey
      const parts = rest.split(':')
      if (parts.length < 3) continue
      const clientId = parts[0]
      const orgUuid = parts[1]?.toLowerCase()
      if (!orgUuid || !/^[0-9a-f-]{36}$/i.test(orgUuid)) continue
      const scopePart = parts.slice(4).join(':')
      const scopes = scopePart ? scopePart.split(/\s+/).filter(Boolean) : undefined
      // Prefer tokens carrying `user:sessions:claude_code` or `user:inference` over profile-only tokens.
      const hasInference = !scopes || scopes.includes('user:inference') || scopes.includes('user:sessions:claude_code')
      const existing = out.get(orgUuid)
      const existingHasInference = !existing?.scopes || existing.scopes.includes('user:inference') || existing.scopes.includes('user:sessions:claude_code')
      if (existing && existingHasInference && !hasInference) continue
      const expiresAt = typeof entry.expiresAt === 'number' ? entry.expiresAt : undefined
      if (existing && existingHasInference === hasInference && (existing.expiresAt ?? -Infinity) > (expiresAt ?? -Infinity)) {
        continue
      }
      out.set(orgUuid, {
        orgUuid,
        ...(accountUuid ? { accountUuid } : {}),
        ...(clientId ? { clientId } : {}),
        accessToken: token,
        ...(typeof entry.refreshToken === 'string' && entry.refreshToken ? { refreshToken: entry.refreshToken } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(typeof entry.subscriptionType === 'string' ? { subscriptionType: entry.subscriptionType } : {}),
        ...(typeof entry.rateLimitTier === 'string' ? { rateLimitTier: entry.rateLimitTier } : {}),
        ...(scopes?.length ? { scopes } : {}),
      })
    }
  } catch {
    // Ignore malformed cache payload.
  }
  return out
}

async function readDesktopTokenCacheOrgs(deps: ClaudeDeps, allowKeychain: boolean): Promise<Map<string, StoredOrgRecord>> {
  const merged = await readStoredOrgCredentials(deps.readFile)
  const appRoots = [...new Set(getDesktopSessionsDirs().map(d => path.dirname(d)))]
  for (const appRoot of appRoots) {
    const cfgPath = path.join(appRoot, 'config.json')
    const rawCfg = await deps.readFile(cfgPath, 2 * 1024 * 1024).catch(() => null)
    if (!rawCfg) continue
    let tokenCacheRaw: unknown
    try {
      tokenCacheRaw = (JSON.parse(rawCfg) as Record<string, unknown>)['oauth:tokenCacheV2']
    } catch {
      continue
    }
    let decrypted: string | null = null
    if (typeof tokenCacheRaw === 'string' && tokenCacheRaw.length > 0) {
      if (tokenCacheRaw.trim().startsWith('{')) {
        decrypted = tokenCacheRaw
      } else if (allowKeychain && process.platform === 'darwin') {
        const readSafe = deps.safeStorageKeychain ?? (() => readKeychainPassword(SAFE_STORAGE_SERVICE, ['Claude Key', 'Claude', null]))
        const outcome = await readSafe().catch(() => ({ status: 'notFound' as const }))
        if (outcome.status === 'found') {
          decrypted = decryptSafeStorageV10(tokenCacheRaw, outcome.value)
        }
      }
    } else if (tokenCacheRaw && typeof tokenCacheRaw === 'object') {
      decrypted = JSON.stringify(tokenCacheRaw)
    }
    if (!decrypted) continue
    for (const [orgUuid, record] of parseDesktopTokenCacheV2(decrypted)) {
      const prev = merged.get(orgUuid)
      if (!prev || (record.expiresAt ?? -Infinity) >= (prev.expiresAt ?? -Infinity)) {
        merged.set(orgUuid, {
          ...prev,
          ...record,
          label: record.label ?? prev?.label,
          organizationType: record.organizationType ?? prev?.organizationType,
        })
      }
    }
  }
  return merged
}

async function fetchOrgProfileMetadata(
  token: string,
  deps: ClaudeDeps,
  parent?: AbortSignal,
): Promise<{ orgUuid?: string; accountUuid?: string; label?: string; organizationType?: string; rateLimitTier?: string } | null> {
  try {
    const response = await deps.fetch(PROFILE_ENDPOINT, {
      method: 'GET',
      signal: quotaRequestSignal(parent),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      account?: { uuid?: unknown }
      organization?: { uuid?: unknown; name?: unknown; organization_type?: unknown; rate_limit_tier?: unknown }
    }
    const org = body?.organization
    if (!org || typeof org !== 'object') return null
    const rawType = typeof org.organization_type === 'string' ? org.organization_type.toLowerCase() : undefined
    const organizationType =
      rawType === 'claude_team' ? 'team'
      : rawType === 'claude_enterprise' ? 'enterprise'
      : rawType === 'claude_max' ? 'max'
      : rawType === 'claude_pro' ? 'pro'
      : rawType
    const rawName = typeof org.name === 'string' ? org.name.trim() : undefined
    const label =
      organizationType === 'max' || organizationType === 'pro' || (rawName && /^.+['’]s organization$/i.test(rawName))
        ? 'Personal'
        : rawName || (organizationType === 'team' ? 'Team' : organizationType === 'enterprise' ? 'Enterprise' : undefined)
    return {
      ...(typeof org.uuid === 'string' ? { orgUuid: org.uuid.toLowerCase() } : {}),
      ...(typeof body.account?.uuid === 'string' ? { accountUuid: body.account.uuid.toLowerCase() } : {}),
      ...(label ? { label } : {}),
      ...(organizationType ? { organizationType } : {}),
      ...(typeof org.rate_limit_tier === 'string' ? { rateLimitTier: org.rate_limit_tier } : {}),
    }
  } catch {
    return null
  }
}

async function refreshOAuthCredential(
  credential: ClaudeCredential,
  deps: ClaudeDeps,
  parent?: AbortSignal,
): Promise<ClaudeCredential | null> {
  if (!credential.refreshToken) return null
  try {
    const scopes = credential.scopes?.length ? credential.scopes : DEFAULT_REFRESH_SCOPES
    const response = await deps.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      signal: quotaRequestSignal(parent),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: credential.clientId ?? OAUTH_CLIENT_ID,
        scope: scopes.join(' '),
      }),
    })
    if (!response.ok) return null
    const body = (await response.json()) as Record<string, unknown>
    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 0
    if (!accessToken || expiresIn <= 0) return null
    return {
      ...credential,
      accessToken,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : credential.refreshToken,
      expiresAt: deps.now() + expiresIn * 1000,
      ...(typeof body.scope === 'string' ? { scopes: body.scope.split(/\s+/).filter(Boolean) } : {}),
    }
  } catch {
    return null
  }
}

async function credentialAt(file: string, deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  const raw = await deps.readFile(file, 64 * 1024)
  return raw ? parseCredential(raw) : null
}

// A 9P share whose distro is going down can stall a read; the quota poll must
// never wait on it. The abandoned read settles (or not) on its own.
const WSL_READ_TIMEOUT_MS = 2000

function wslCredentialAt(file: string, deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>(resolve => { timer = setTimeout(resolve, WSL_READ_TIMEOUT_MS, null) })
  return Promise.race([credentialAt(file, deps).catch(() => null), timeout]).finally(() => clearTimeout(timer))
}

/**
 * The Windows-home credential plus one per running WSL distro home. A user can
 * be logged in on both sides; the one expiring last is the one Claude Code
 * renewed most recently. A broken WSL file is skipped; a broken Windows file
 * still surfaces its error when nothing else is usable.
 */
async function credentialFromFiles(deps: ClaudeDeps): Promise<{ credential: ClaudeCredential; path: string } | null> {
  let nativeError: unknown
  const native = credentialAt(deps.credentialPath, deps).catch(error => { nativeError = error; return null })
  const paths = [deps.credentialPath, ...deps.wslCredentialPaths()]
  const found = await Promise.all([native, ...paths.slice(1).map(file => wslCredentialAt(file, deps))])
  let best: { credential: ClaudeCredential; path: string } | null = null
  for (const [i, credential] of found.entries()) {
    if (credential && (!best || (credential.expiresAt ?? -Infinity) > (best.credential.expiresAt ?? -Infinity))) {
      best = { credential, path: paths[i]! }
    }
  }
  if (!best && nativeError !== undefined) throw nativeError
  return best
}

/**
 * Re-read whichever store the credential came from. On macOS the credential
 * usually lives in the Keychain and no file exists at all, so re-reading the
 * file after a 401 could never see the token Claude Code has since renewed.
 * A denied Keychain on a re-read needs no state of its own: the first read
 * already decided whether that store is reachable.
 */
async function credentialFrom(source: CredentialSource, file: string, keychainService: string, deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  if (source === 'file') return file === deps.credentialPath ? credentialAt(file, deps) : wslCredentialAt(file, deps)
  if (source === 'org') return null
  const outcome = await (deps.keychain ? deps.keychain(keychainService) : readClaudeKeychain(keychainService))
  return outcome.status === 'found' ? parseCredential(outcome.value) : null
}

export async function readClaudeKeychain(service: string = KEYCHAIN_SERVICE): Promise<KeychainOutcome> {
  // Claude Code has written the item under both `$USER` (2.1.x) and the older
  // hardcoded "agentseal" account; a user-scoped miss must fall through to the
  // service-only lookup rather than reporting disconnected.
  const user = process.env.USER
  return readKeychainPassword(service, user ? [user, null] : [null])
}

function windowOf(label: string, value: unknown): QuotaWindow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const percent = fraction(row.utilization)
  if (percent === null) return null
  const resetsAt = typeof row.resets_at === 'string' && !Number.isNaN(Date.parse(row.resets_at))
    ? new Date(row.resets_at).toISOString() : null
  return { label, percent, resetsAt }
}

export function planLabel(credential: Pick<ClaudeCredential, 'subscriptionType' | 'rateLimitTier'>): string {
  const subscriptionType = credential.subscriptionType?.toLowerCase() ?? ''
  const tier = credential.rateLimitTier?.toLowerCase() ?? ''
  const hasMax20 = tier.includes('max_20x') || tier.includes('max20x') || tier.includes('max-20x')
  const hasMax = tier.includes('max')
  if (subscriptionType === 'team' || (subscriptionType === '' && tier.includes('team'))) {
    return hasMax ? 'Team Premium' : 'Team'
  }
  if (subscriptionType === 'enterprise' || (subscriptionType === '' && tier.includes('enterprise'))) {
    return hasMax ? 'Enterprise Premium' : 'Enterprise'
  }
  if (subscriptionType === 'max' || hasMax) {
    return hasMax20 ? 'Max 20x' : 'Max 5x'
  }
  if (subscriptionType === 'pro' || tier.includes('pro')) {
    return 'Pro'
  }
  return 'Subscription'
}

export function decodeClaudeUsage(body: unknown, credential: ClaudeCredential): QuotaProvider {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const five = windowOf('5-hour', data.five_hour)
  const weekly = windowOf('Weekly', data.seven_day)
  const opus = windowOf('Weekly · Opus', data.seven_day_opus)
  const sonnet = windowOf('Weekly · Sonnet', data.seven_day_sonnet)
  const scoped: QuotaWindow[] = []
  if (Array.isArray(data.limits)) {
    for (const item of data.limits) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, any>
      const display = row.scope?.model?.display_name
      const percent = fraction(row.percent)
      if (row.kind !== 'weekly_scoped' || typeof display !== 'string' || percent === null) continue
      const resetsAt = typeof row.resets_at === 'string' && !Number.isNaN(Date.parse(row.resets_at))
        ? new Date(row.resets_at).toISOString() : null
      scoped.push({ label: `Weekly · ${display}`, percent, resetsAt })
    }
  }
  return {
    provider: 'claude', connection: 'connected', primary: weekly ?? five,
    details: [five, weekly, opus, sonnet].filter((row): row is QuotaWindow => row !== null).concat(scoped),
    planLabel: planLabel(credential), footerLines: [],
  }
}

async function request(token: string, deps: ClaudeDeps, parent?: AbortSignal): Promise<Response> {
  return deps.fetch(ENDPOINT, {
    method: 'GET', signal: quotaRequestSignal(parent),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
    },
  })
}

export type ClaudeResult = { quota: QuotaProvider; retryAfterSeconds?: number; label?: string }

export async function fetchClaudeQuota(
  options: Partial<ClaudeDeps> & {
    signal?: AbortSignal
    allowKeychain?: boolean
    configDir?: string
    orgUuid?: string
  } = {},
): Promise<ClaudeResult> {
  const resolvedConfigDir = options.configDir
    ?? (options.credentialPath === undefined ? (await getClaudeConfigDirs().catch(() => []))[0] : undefined)
  const keychainService = claudeKeychainService(resolvedConfigDir)
  const defaultCredentialPath = resolvedConfigDir
    ? path.join(resolvedConfigDir, '.credentials.json')
    : defaults.credentialPath
  const deps: ClaudeDeps = {
    ...defaults,
    credentialPath: defaultCredentialPath,
    ...options,
  }
  const targetOrgUuid = options.orgUuid?.trim().toLowerCase()

  try {
    let credential: ClaudeCredential | null = null
    let source: CredentialSource = 'file'
    let fromFile: { credential: ClaudeCredential; path: string } | null = null
    let orgRecords: Map<string, StoredOrgRecord> | null = null
    let discoveredLabel: string | undefined

    if (targetOrgUuid) {
      orgRecords = await readDesktopTokenCacheOrgs(deps, Boolean(options.allowKeychain))
      const orgRecord = orgRecords.get(targetOrgUuid)
      if (orgRecord) {
        credential = orgRecord
        source = 'org'
        discoveredLabel = orgRecord.label
      }
    }

    if (!credential) {
      fromFile = await credentialFromFiles(deps)
      credential = fromFile?.credential ?? null
      source = 'file'
      const fileExpired = credential?.expiresAt !== undefined && credential.expiresAt <= deps.now()
      if ((!credential || fileExpired) && options.allowKeychain && process.platform === 'darwin') {
        const outcome = await (deps.keychain ? deps.keychain(keychainService) : readClaudeKeychain(keychainService))
        if (outcome.status === 'accessDenied' && !credential) return { quota: empty('accessDenied') }
        const kcCred = outcome.status === 'found' ? parseCredential(outcome.value) : null
        if (kcCred && (!credential || (kcCred.expiresAt ?? Infinity) > (credential.expiresAt ?? -Infinity))) {
          credential = kcCred
          source = 'keychain'
        }
      }
      // Sync Claude Desktop's oauth:tokenCacheV2 when reading live quota so multi-org
      // Personal + Team profiles stay warm in the cache, and fall back to a live desktop
      // token when the CLI file/Keychain credential is absent or expired.
      if (options.allowKeychain && !options.keychain) {
        orgRecords = await readDesktopTokenCacheOrgs(deps, true)
        const credExpired = credential?.expiresAt !== undefined && credential.expiresAt <= deps.now()
        if ((!credential || (credExpired && !credential.refreshToken)) && orgRecords.size > 0) {
          const bestOrg = [...orgRecords.values()].sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0]
          if (bestOrg && (bestOrg.expiresAt ?? Infinity) > (credential?.expiresAt ?? -Infinity)) {
            credential = bestOrg
            source = 'org'
          }
        }
      }
    }

    if (!credential) return { quota: empty('disconnected') }

    // If an org-backed credential is already past its expiry and carries a refresh token,
    // renew it before hitting /api/oauth/usage so Anthropic does not 429 the stale token.
    if (source === 'org' && credential.expiresAt !== undefined && credential.expiresAt <= deps.now() && credential.refreshToken) {
      const refreshed = await refreshOAuthCredential(credential, deps, options.signal)
      if (refreshed) {
        credential = refreshed
        if (orgRecords && targetOrgUuid) {
          const prev = orgRecords.get(targetOrgUuid)
          orgRecords.set(targetOrgUuid, { ...prev, ...refreshed, orgUuid: targetOrgUuid })
          await writeStoredOrgCredentials(orgRecords)
        }
      }
    }

    let response = await request(credential.accessToken, deps, options.signal)
    const isExpired = () => credential?.expiresAt !== undefined && credential.expiresAt <= deps.now()
    if (response.status === 401 || (response.status === 429 && isExpired())) {
      let reread = await credentialFrom(source, fromFile?.path ?? deps.credentialPath, keychainService, deps)
      if ((!reread || reread.accessToken === credential.accessToken) && isExpired() && credential.refreshToken) {
        reread = await refreshOAuthCredential(credential, deps, options.signal)
      }
      if (!reread || reread.accessToken === credential.accessToken) {
        if (response.status === 401) {
          // Nothing but a fresh login can clear a 401 on a credential whose life is
          // already over, so it is reported as terminal rather than as the blip its
          // consumers are meant to retry and to keep their last numbers through. A
          // token that has not expired is a real blip and keeps that backoff.
          return { quota: isExpired() ? empty('terminalFailure', EXPIRED_FOOTER) : empty('transientFailure') }
        }
      } else {
        credential = reread
        response = await request(credential.accessToken, deps, options.signal)
      }
    }
    if (response.status === 429) {
      let hint: unknown
      try { hint = (await response.json() as Record<string, unknown>).retry_after } catch { hint = undefined }
      const parsed = typeof hint === 'number' ? hint : typeof hint === 'string' ? Number(hint) : NaN
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(parsed) ? parsed : 300, 60) }
    }
    if (!response.ok) return { quota: empty(response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure') }
    const usageJson = await response.json()
    if (orgRecords && (targetOrgUuid || orgRecords.size > 0)) {
      if (!targetOrgUuid && source !== 'org') {
        const existingDefault = [...orgRecords.values()].find(r => r.isDefaultConfigOrg && r.accessToken === credential.accessToken)
        if (existingDefault) {
          discoveredLabel = existingDefault.label
        } else {
          const prof = await fetchOrgProfileMetadata(credential.accessToken, deps, options.signal)
          if (prof?.orgUuid) {
            for (const r of orgRecords.values()) delete r.isDefaultConfigOrg
            const prev = orgRecords.get(prof.orgUuid)
            orgRecords.set(prof.orgUuid, {
              ...prev,
              ...credential,
              orgUuid: prof.orgUuid,
              accountUuid: prof.accountUuid ?? prev?.accountUuid,
              label: prof.label ?? prev?.label ?? 'Personal',
              organizationType: prof.organizationType ?? prev?.organizationType,
              rateLimitTier: prof.rateLimitTier ?? credential.rateLimitTier,
              isDefaultConfigOrg: true,
            })
            discoveredLabel = prof.label ?? 'Personal'
          }
        }
      }
      for (const [orgKey, rec] of orgRecords) {
        if (!rec.label && (orgKey === targetOrgUuid || rec.accessToken)) {
          const prof = await fetchOrgProfileMetadata(rec.accessToken, deps, options.signal)
          if (prof) {
            rec.label = prof.label ?? rec.label
            rec.organizationType = prof.organizationType ?? rec.organizationType
            rec.rateLimitTier = prof.rateLimitTier ?? rec.rateLimitTier
          }
        }
      }
      const orgKey = targetOrgUuid ?? credential.orgUuid
      if (orgKey && orgRecords.get(orgKey)?.label) {
        discoveredLabel = orgRecords.get(orgKey)?.label
      }
      await writeStoredOrgCredentials(orgRecords)
    }
    return {
      quota: decodeClaudeUsage(usageJson, credential),
      ...(discoveredLabel ? { label: discoveredLabel } : {}),
    }
  } catch (error) {
    // Deliberately sanitize before the only diagnostic sink. Tokens are never returned.
    console.warn(`Claude quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
