import os from 'node:os'
import path from 'node:path'

import { atomicWriteSecureFileSync, fraction, quotaRequestSignal, readKeychainPassword, readSecureFile, readSecureFileSync, sanitizeError, trackCredentialWrite } from './security.js'
import type { KeychainOutcome } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const EIGHT_DAYS = 8 * 24 * 60 * 60_000
// The CodeBurn menubar caches its ChatGPT-mode Codex OAuth here as a
// `CredentialRecord` JSON blob (accessToken/refreshToken/idToken/accountId/…),
// account "default". Same brand, same machine, already consented - preferred
// over any OpenAI-owned storage.
const MENUBAR_KEYCHAIN_SERVICE = 'org.agentseal.codeburn.menubar.codex.oauth.v1'

type AuthDoc = Record<string, any> & {
  auth_mode?: string
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string; [key: string]: unknown }
  last_refresh?: string
}

export type CodexDeps = {
  fetch: typeof fetch
  authPath: string
  openaiAuthPath: string
  readFile: typeof readSecureFile
  // Synchronous by contract, not by convenience: see `persistRotated`.
  readFileSync: typeof readSecureFileSync
  writeFileSync: typeof atomicWriteSecureFileSync
  keychain: (service: string) => Promise<KeychainOutcome>
  now: () => number
}

const defaults: CodexDeps = {
  fetch: globalThis.fetch,
  authPath: path.join(os.homedir(), '.codex', 'auth.json'),
  openaiAuthPath: path.join(os.homedir(), 'Library', 'Application Support', 'com.openai.codex', 'auth.json'),
  readFile: readSecureFile,
  readFileSync: readSecureFileSync,
  writeFileSync: atomicWriteSecureFileSync,
  keychain: service => readKeychainPassword(service, ['default', null]),
  now: Date.now,
}

/** A resolved Codex credential plus how much of its lifecycle we own. Only the
 * Codex CLI's own auth.json is `writable` (we may rotate + write it back); the
 * menubar keychain and OpenAI app-support copies are read-only. */
type CodexSource = {
  name: 'menubarKeychain' | 'authFile' | 'openaiAppSupport'
  auth: AuthDoc
  writable: boolean
  reread: () => Promise<AuthDoc | null>
}

function empty(connection: QuotaProvider['connection']): QuotaProvider {
  return { provider: 'codex', connection, primary: null, details: [], planLabel: null, footerLines: [] }
}

async function readAuth(deps: CodexDeps, filePath: string = deps.authPath): Promise<AuthDoc | null> {
  const raw = await deps.readFile(filePath, 64 * 1024)
  return raw ? JSON.parse(raw) as AuthDoc : null
}

// The menubar stores a Swift `CredentialRecord` (camelCase, Date fields as
// numbers) rather than the CLI's snake_case auth.json. Normalize to AuthDoc and
// mark it chatgpt-mode (the menubar only ever caches ChatGPT subscriptions).
function authFromMenubarRecord(raw: string): AuthDoc | null {
  let record: Record<string, unknown>
  try { record = JSON.parse(raw) as Record<string, unknown> } catch { return null }
  const access = typeof record.accessToken === 'string' ? record.accessToken : ''
  if (!access) return null
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: access,
      refresh_token: typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
      id_token: typeof record.idToken === 'string' ? record.idToken : undefined,
      account_id: typeof record.accountId === 'string' ? record.accountId : undefined,
    },
  }
}

async function discoverSource(deps: CodexDeps, allowKeychain: boolean): Promise<CodexSource | 'accessDenied' | null> {
  let denied = false
  // (a) CodeBurn menubar's own cached Codex OAuth. Read-only: the menubar owns
  // rotation, so we never write it back and never proactively refresh it.
  if (allowKeychain && process.platform === 'darwin') {
    const outcome = await deps.keychain(MENUBAR_KEYCHAIN_SERVICE)
    if (outcome.status === 'accessDenied') denied = true
    else if (outcome.status === 'found') {
      const auth = authFromMenubarRecord(outcome.value)
      if (auth) {
        return {
          name: 'menubarKeychain', auth, writable: false,
          reread: async () => {
            const next = await deps.keychain(MENUBAR_KEYCHAIN_SERVICE)
            return next.status === 'found' ? authFromMenubarRecord(next.value) : null
          },
        }
      }
    }
  }
  // (b) The Codex CLI's own ~/.codex/auth.json. We own rotation + write-back.
  const fileAuth = await readAuth(deps)
  if (fileAuth) return { name: 'authFile', auth: fileAuth, writable: true, reread: () => readAuth(deps) }
  // (c) com.openai.codex App Support, only if it holds a plaintext auth JSON
  // with a usable token. Tokens encrypted via "Codex Safe Storage" have no
  // plaintext access_token here, so they fall through - we never decrypt.
  const openaiAuth = await readAuth(deps, deps.openaiAuthPath).catch(() => null)
  if (openaiAuth?.tokens?.access_token) {
    return { name: 'openaiAppSupport', auth: openaiAuth, writable: false, reread: () => readAuth(deps, deps.openaiAuthPath).catch(() => null) }
  }
  return denied ? 'accessDenied' : null
}

function labelForSeconds(value: unknown): string {
  const seconds = typeof value === 'number' ? Math.max(0, Math.trunc(value)) : 0
  if (seconds < 3600) return 'Hourly'
  if (seconds < 7200) return 'Hour'
  if (seconds >= 18_000 && seconds < 19_000) return '5-hour'
  if (seconds >= 86_400 && seconds < 87_000) return 'Daily'
  if (seconds >= 604_800 && seconds < 605_000) return 'Weekly'
  const hours = Math.floor(seconds / 3600)
  return hours < 24 ? `${hours}-hour` : `${Math.floor(hours / 24)}-day`
}

function windowOf(value: unknown, override?: string): QuotaWindow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const percent = fraction(row.used_percent)
  if (percent === null) return null
  const reset = typeof row.reset_at === 'number' && Number.isFinite(row.reset_at)
    ? new Date(row.reset_at * 1000).toISOString() : null
  return { label: override ?? labelForSeconds(row.limit_window_seconds), percent, resetsAt: reset }
}

// chatgpt.com mixes encodings inside one payload. `Number('')` is 0, not NaN,
// so blank is rejected or an absent `used` decodes as a confident zero.
function num(value: unknown): number | null {
  if (typeof value === 'string' && !value.trim()) return null
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

// Credit-based-pricing tiers arrive composite (`enterprise_cbp_usage_based`).
function normalizePlanType(value: string): string {
  return value
    .replace(/[_-]usage[_-]based$/, '')
    .replace(/^self[_-]serve[_-]/, '')
    .replace(/[_-]cbp$/, '')
    .replace(/[_-]cbp[_-]/g, '_')
}

function planLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  const lower = normalizePlanType(raw.toLowerCase())
  const known: Record<string, string> = {
    guest: 'Guest', free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro',
    prolite: 'Pro Lite', pro_lite: 'Pro Lite', 'pro-lite': 'Pro Lite',
    free_workspace: 'Free Workspace', team: 'Team', business: 'Business',
    education: 'Education', quorum: 'Quorum', k12: 'K-12', enterprise: 'Enterprise', edu: 'Edu',
  }
  return known[lower] ?? lower.replace(/(^|[_-])\w/g, match => match.replace(/[_-]/, ' ').toUpperCase())
}

// The admin-set monthly allowance, the only limit a credit-metered workspace
// has. `spend_control` is the live position, the others forward-compat. `any`
// because this walks six optional-chained hops, all validated by `num()`.
function spendControlWindow(data: Record<string, any>): QuotaWindow | null {
  // `find`/`num` per alias, not `??`: a non-null garbage value would stop `??`
  // and mask a valid alias further down. Object-shaped garbage still wins the
  // position, matching Swift, which likewise commits to the first that decodes.
  const row = [
    data.spend_control?.individual_limit,
    data.spend_control?.individualLimit,
    data.individual_limit,
    data.individualLimit,
    data.rate_limit?.individual_limit,
    data.rate_limit?.individualLimit,
  ].find(candidate => candidate && typeof candidate === 'object')
  if (!row) return null
  const limit = num(row.limit)
  if (limit === null || limit <= 0) return null
  const remainingPercent = num(row.remaining_percent) ?? num(row.remainingPercent)
  const used = num(row.used)
  const rawPercent = num(row.used_percent) ?? num(row.usedPercent)
    ?? (remainingPercent === null ? null : 100 - remainingPercent)
    ?? (used === null ? null : (used / limit) * 100)
  if (rawPercent === null) return null
  const percent = Math.min(1, Math.max(0, rawPercent / 100))
  const resetRaw = num(row.reset_at) ?? num(row.resets_at) ?? num(row.resetsAt)
  // Past 8.64e15 ms `toISOString()` throws RangeError.
  const resetsAt = resetRaw !== null && resetRaw > 0 && resetRaw * 1000 <= 8.64e15
    ? new Date(resetRaw * 1000).toISOString()
    : null
  // Unclamped percent, so a 120% draw still reports 12,000 of 10,000.
  const spent = used ?? limit * Math.max(0, rawPercent) / 100
  const round = (n: number) => Math.round(n).toLocaleString('en-US')
  const reached = data.spend_control?.reached === true
  const label = `Monthly usage limit · ${round(spent)} / ${round(limit)} credits`
  return { label: reached ? `${label} · limit reached` : label, percent, resetsAt }
}

// Banked limit-reset credits. The Swift menubar owns the same three functions
// (mac/Sources/CodeBurnMenubar/Data/CodexBankedResets.swift); they are mirrored
// line for line so both surfaces print the same sentence. The CLI reads them off
// the `rate_limit_reset_credits` block of the usage response it already fetches
// and never calls the companion endpoint, so no new request and no new cadence.

type ResetGrant = { id: string; resetType: string | null; grantedAt: number | null }

type ResetCredits = {
  availableCount: number
  /** How many can be applied right now. Null is unknown, not zero. */
  applicableAvailableCount: number | null
  grants: ResetGrant[]
  nextExpiresAt: number | null
}

function isoMillis(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** Null on any unexpected shape: the row hides, the quota read still succeeds. */
export function decodeResetCredits(value: unknown, now: number): ResetCredits | null {
  if (!value || typeof value !== 'object') return null
  const block = value as Record<string, unknown>
  const count = num(block.available_count)
  if (count === null || count < 0 || !Number.isInteger(count)) return null
  const rows = Array.isArray(block.credits) ? block.credits : []
  const available = rows.filter((row): row is Record<string, unknown> =>
    Boolean(row) && typeof row === 'object'
    && String((row as Record<string, unknown>).status ?? '').toLowerCase() === 'available')
  const expiries = available
    .map(row => isoMillis(row.expires_at))
    .filter((at): at is number => at !== null && at > now)
  // Identity first, and only then a grant: a credit we cannot name is a credit
  // we could re-announce on every refresh.
  const grants: ResetGrant[] = []
  for (const row of available) {
    const identity = [row.id, row.granted_at]
      .map(candidate => typeof candidate === 'string' ? candidate.trim() : '')
      .find(candidate => candidate !== '')
    if (!identity) continue
    grants.push({
      id: identity,
      resetType: typeof row.reset_type === 'string' && row.reset_type ? row.reset_type : null,
      grantedAt: isoMillis(row.granted_at),
    })
  }
  const applicable = num(block.applicable_available_count)
  return {
    availableCount: count,
    applicableAvailableCount: applicable !== null && applicable >= 0 && Number.isInteger(applicable) ? applicable : null,
    grants,
    nextExpiresAt: expiries.length > 0 ? Math.min(...expiries) : null,
  }
}

/** Deliberately not `Intl.RelativeTimeFormat`: this string has to come out
 *  character-identical in TypeScript and in Swift, so the rules are spelled out
 *  instead of delegated to a locale-aware formatter. */
export function compactAge(at: number, now: number): string {
  const elapsed = (now - at) / 1000
  if (elapsed >= 0) {
    if (elapsed < 60) return 'just now'
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`
    if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)}h ago`
    return `${Math.floor(elapsed / 86_400)}d ago`
  }
  const ahead = -elapsed
  if (ahead < 60) return 'in under a minute'
  if (ahead < 3600) return `in ${Math.floor(ahead / 60)}m`
  if (ahead < 86_400) return `in ${Math.floor(ahead / 3600)}h`
  return `in ${Math.floor(ahead / 86_400)}d`
}

/** "weekly" -> "weekly reset". An absent `reset_type` degrades to the bare noun
 *  rather than inventing a scope the payload did not state. */
function resetTypeLabel(resetType: string | null): string {
  const raw = (resetType ?? '').trim().replace(/[_-]/g, ' ').toLowerCase()
  return raw ? `${raw} reset` : 'limit reset'
}

function latestGrant(credits: ResetCredits): ResetGrant | null {
  let latest: ResetGrant | null = null
  for (const grant of credits.grants) {
    if (grant.grantedAt === null) continue
    if (latest === null || grant.grantedAt > (latest.grantedAt ?? -Infinity)) latest = grant
  }
  return latest
}

/** `Limit resets · 2 available · 1 usable now · latest weekly reset granted 2h ago`.
 *  Null when the account holds nothing — the line hides rather than printing a zero. */
export function resetCreditsLine(credits: ResetCredits | null, now: number): string | null {
  if (!credits || credits.availableCount <= 0) return null
  const parts = [`${credits.availableCount} available`]
  // Only worth saying when it disagrees with the headline count.
  if (credits.applicableAvailableCount !== null && credits.applicableAvailableCount !== credits.availableCount) {
    parts.push(`${credits.applicableAvailableCount} usable now`)
  }
  const grant = latestGrant(credits)
  if (grant?.grantedAt != null) {
    const type = resetTypeLabel(grant.resetType)
    parts.push(grant.grantedAt > now
      ? `next ${type} lands ${compactAge(grant.grantedAt, now)}`
      : `latest ${type} granted ${compactAge(grant.grantedAt, now)}`)
  }
  if (credits.nextExpiresAt !== null) parts.push(`next expires ${compactAge(credits.nextExpiresAt, now)}`)
  return `Limit resets · ${parts.join(' · ')}`
}

export function decodeCodexUsage(body: unknown, now: number = Date.now()): QuotaProvider {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {}
  const primaryRaw = windowOf(data.rate_limit?.primary_window)
  const secondaryRaw = windowOf(data.rate_limit?.secondary_window)
  const primary = primaryRaw ?? secondaryRaw
  const details: QuotaWindow[] = []
  if (primaryRaw) details.push(primaryRaw)
  if (secondaryRaw && secondaryRaw !== primary) details.push(secondaryRaw)
  else if (!primaryRaw && secondaryRaw) details.push(secondaryRaw)
  if (Array.isArray(data.additional_rate_limits)) {
    for (const additional of data.additional_rate_limits) {
      if (!additional || typeof additional !== 'object' || typeof additional.limit_name !== 'string') continue
      for (const key of ['primary_window', 'secondary_window'] as const) {
        const raw = additional.rate_limit?.[key]
        const base = windowOf(raw)
        if (base && base.percent > 0) details.push({ ...base, label: `${additional.limit_name} · ${base.label}` })
      }
    }
  }
  const credits = spendControlWindow(data)
  if (credits) details.push(credits)
  const balance = num(data.credits?.balance)
  // Credit-settled accounts denominate in credits, so no currency symbol.
  const hasCredits = data.credits?.has_credits === true
  const footerLines: string[] = []
  if (balance !== null && balance > 0) {
    footerLines.push(`Credits remaining · ${hasCredits ? Math.round(balance).toLocaleString('en-US') : balance.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`)
  }
  // Uncapped on purpose, so a bar-less card does not read as a failed fetch.
  if (!credits && data.credits?.unlimited === true) footerLines.push('Credits · Unlimited')
  // Limit-reset credits, banked ones included. `notes` is what `codeburn quota`
  // prints; the footer keeps the desktop surfaces in step.
  const resets = resetCreditsLine(decodeResetCredits(data.rate_limit_reset_credits, now), now)
  if (resets) footerLines.push(resets)
  return {
    provider: 'codex', connection: 'connected', primary: primary ?? credits, details,
    planLabel: planLabel(data.plan_type),
    footerLines,
    ...(resets ? { notes: [resets] } : {}),
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** The `sub` claim of a JWT id_token, or null when it is absent or does not
 * decode. Defensive at every step: a malformed id_token is evidence of nothing,
 * so it must never itself read as a login mismatch. */
function idTokenSubject(token: unknown): string | null {
  if (typeof token !== 'string') return null
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown }
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null
  } catch {
    return null
  }
}

/** Whether two documents belong to the same Codex login. A field counts as a
 * mismatch only when it is a non-empty string on both sides and the two values
 * differ: a document that merely omits account_id, refresh_token or id_token is
 * not proof of a different login, and treating it as one would drop a rotated
 * refresh token and sign the user out. Taken to its limit that means a document
 * carrying NONE of the three reads as the same login and is written over. That
 * is the deliberate side to err on: the alternative discards a live credential
 * every time the file on disk cannot identify itself. */
function sameLogin(held: AuthDoc, latest: AuthDoc): boolean {
  const differs = (a: unknown, b: unknown): boolean =>
    typeof a === 'string' && a !== '' && typeof b === 'string' && b !== '' && a !== b
  if (differs(held.tokens?.account_id, latest.tokens?.account_id)) return false
  if (differs(held.tokens?.refresh_token, latest.tokens?.refresh_token)) return false
  return !differs(idTokenSubject(held.tokens?.id_token), idTokenSubject(latest.tokens?.id_token))
}

/** The document the rotated tokens are merged into: whatever the Codex CLI has
 * on disk right now, so a login it wrote since our own read is not clobbered.
 * `null` means writing would be wrong: the login this rotation belongs to is
 * gone (file removed, or no longer ChatGPT mode), or the file now holds a
 * different login (the user ran `codex login` and switched accounts, or another
 * process rotated the credential while our grant was in flight) and merging our
 * tokens in would splice one account's account_id onto another's refresh token.
 * An unreadable or unparseable file is NOT one of those cases: it falls back to
 * the document we already hold, because a lineage check may only fire on a file
 * that reads cleanly, and dropping a rotated refresh token signs the user out. */
function mergeBase(auth: AuthDoc, deps: CodexDeps): AuthDoc | null {
  let raw: string | null
  try {
    raw = deps.readFileSync(deps.authPath)
  } catch {
    return auth
  }
  if (raw === null) return null
  let latest: unknown
  try {
    latest = JSON.parse(raw)
  } catch {
    return auth
  }
  if (!latest || typeof latest !== 'object') return auth
  const doc = latest as AuthDoc
  if (doc.auth_mode !== 'chatgpt') return null
  // Serializing refreshes across processes with a file lock would also stop the
  // wasted double grant, but the lineage check is what closes the corrupt-write
  // hole on its own, so the lock is left out as more than the minimum here.
  return sameLogin(auth, doc) ? doc : null
}

type RotatedTokens = { access: string | null; refresh: string | null; id: string | null }

/**
 * Merges the rotated tokens into auth.json and writes them, synchronously and
 * atomically. Synchronous from the moment the token response is parsed to the
 * moment the file is renamed into place: the grant has already invalidated the
 * refresh token on disk, so an abort, a per-provider timeout or the `quota`
 * command's `process.exit` landing in an await here would leave the user with
 * nothing but a dead token, which reads as being signed out of Codex.
 */
function persistRotated(auth: AuthDoc, rotated: RotatedTokens, deps: CodexDeps): AuthDoc | null {
  const base = mergeBase(auth, deps)
  if (!base) {
    console.error(`Codex refreshed its login but the credential at ${deps.authPath} no longer holds the ChatGPT login this rotation belongs to, so the new token was discarded. Run \`codex login\` if Codex signs you out.`)
    return null
  }
  const merged: AuthDoc = {
    ...base,
    tokens: {
      ...base.tokens,
      ...(rotated.access ? { access_token: rotated.access } : {}),
      ...(rotated.refresh ? { refresh_token: rotated.refresh } : {}),
      ...(rotated.id ? { id_token: rotated.id } : {}),
    },
    last_refresh: new Date(deps.now()).toISOString(),
  }
  try {
    deps.writeFileSync(deps.authPath, `${JSON.stringify(merged, null, 2)}\n`)
  } catch (error) {
    // Never silent: the token still on disk is the one the grant just killed,
    // so the user has to be told why Codex will ask them to sign in again.
    console.error(`Codex refresh token rotated but could not be saved to ${deps.authPath}: ${sanitizeError(error)}. Run \`codex login\` if Codex signs you out.`)
    return null
  }
  return merged
}

/**
 * The read-only `codeburn quota` path still refreshes, because the endpoint it
 * reads rejects an expired access token: a ChatGPT access token lasts hours,
 * the 401 branch below exists for exactly that, and a quota read that never
 * refreshed would report Codex as unavailable for anyone who had not used the
 * Codex CLI in the last few hours. What is removed instead is the way the
 * rotation could be lost: the POST ignores the caller's abort signal, the write
 * that follows it is synchronous, and the whole thing is registered with
 * {@link trackCredentialWrite} so a command that ends in `process.exit` drains
 * it first (src/main.ts, the `quota` action).
 */
async function refresh(auth: AuthDoc, deps: CodexDeps): Promise<AuthDoc | null> {
  const refreshToken = auth.tokens?.refresh_token
  if (!refreshToken) return null
  return trackCredentialWrite(rotate(auth, refreshToken, deps))
}

async function rotate(auth: AuthDoc, refreshToken: string, deps: CodexDeps): Promise<AuthDoc | null> {
  // Deliberately not the caller's abort signal, only this request's own
  // timeout: the grant retires the refresh token on disk the moment the
  // endpoint accepts it, so a per-provider timeout firing while the response
  // is still arriving would cancel a rotation we can no longer undo. A slow
  // grant costs the caller nothing, since its own race has already given up.
  const response = await deps.fetch(TOKEN_ENDPOINT, {
    method: 'POST', signal: quotaRequestSignal(),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' }),
  })
  if (!response.ok) return null
  const next = await response.json() as Record<string, unknown>
  const rotated: RotatedTokens = { access: str(next.access_token), refresh: str(next.refresh_token), id: str(next.id_token) }
  // A rotated refresh token is persisted even when the access token is missing
  // or malformed: the grant has already retired the one on disk either way.
  if (!rotated.access && !rotated.refresh) return null
  const merged = persistRotated(auth, rotated, deps)
  return merged?.tokens?.access_token ? merged : null
}

async function usage(auth: AuthDoc, deps: CodexDeps, signal?: AbortSignal): Promise<Response | null> {
  const token = auth.tokens?.access_token
  if (!token) return null
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'CodeBurn' }
  if (auth.tokens?.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id
  return deps.fetch(USAGE_ENDPOINT, { method: 'GET', headers, signal: quotaRequestSignal(signal) })
}

export type CodexResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchCodexQuota(options: Partial<CodexDeps> & { signal?: AbortSignal; allowKeychain?: boolean } = {}): Promise<CodexResult> {
  const deps = { ...defaults, ...options }
  try {
    const discovered = await discoverSource(deps, Boolean(options.allowKeychain))
    if (discovered === 'accessDenied') return { quota: empty('accessDenied') }
    if (!discovered) return { quota: empty('disconnected') }
    const source = discovered
    let auth = source.auth
    if (auth.auth_mode !== 'chatgpt') return { quota: empty('terminalFailure') }
    if (!auth.tokens?.access_token) return { quota: empty('disconnected') }

    // Proactive staleness refresh only for the source whose rotation we own.
    if (source.writable) {
      const refreshedAt = typeof auth.last_refresh === 'string' ? Date.parse(auth.last_refresh) : NaN
      if (!Number.isFinite(refreshedAt) || deps.now() - refreshedAt > EIGHT_DAYS) {
        const next = await refresh(auth, deps)
        if (next) auth = next
      }
    }
    let response = await usage(auth, deps, options.signal)
    if (!response) return { quota: empty('disconnected') }
    if (response.status === 401) {
      const reread = await source.reread()
      if (reread?.tokens?.access_token && reread.tokens.access_token !== auth.tokens?.access_token) {
        auth = reread
      } else if (source.writable) {
        const next = await refresh(reread ?? auth, deps)
        if (!next) return { quota: empty('transientFailure') }
        auth = next
      } else {
        // Read-only source: the owner (menubar) rotates tokens on its own
        // cadence, so re-read once and otherwise wait for the next poll.
        return { quota: empty('transientFailure') }
      }
      response = await usage(auth, deps, options.signal)
      if (!response) return { quota: empty('transientFailure') }
    }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      let seconds = raw === null ? NaN : Number(raw)
      if (!Number.isFinite(seconds) && raw) seconds = (Date.parse(raw) - deps.now()) / 1000
      return { quota: empty('transientFailure'), retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60) }
    }
    if (!response.ok) return { quota: empty(response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure') }
    return { quota: decodeCodexUsage(await response.json()) }
  } catch (error) {
    console.warn(`Codex quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
