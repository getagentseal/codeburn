import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { homedir, userInfo } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Reads Claude Code's OAuth credentials from local sources and refreshes them
 * when needed. Mirrors the behaviour of `mac/Sources/CodeBurnMenubar/Data/ClaudeCredentialStore.swift`
 * but stays cross-platform: the Swift version reads the macOS Keychain via
 * the Security framework; this TypeScript port reads either the standard
 * `~/.claude/.credentials.json` file (Linux / Windows / newer Claude Code
 * installs) or shells out to `/usr/bin/security` on macOS.
 *
 * Refreshed tokens are persisted to our own cache file
 * (`~/.cache/codeburn/claude-credentials.v1.json`) so that we do not rotate
 * the Claude CLI's credentials. The cache file is written with mode 0600.
 */

const OAUTH_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_CREDENTIALS_RELATIVE_PATH = '.claude/.credentials.json'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const MAX_CREDENTIAL_BYTES = 64 * 1024
const PROACTIVE_REFRESH_MARGIN_MS = 5 * 60 * 1000
const CACHE_FILENAME = 'claude-credentials.v1.json'

export type CredentialRecord = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  rateLimitTier: string | null
}

export type ClaudeCredentialErrorCode =
  | 'no_source'
  | 'decode_failed'
  | 'no_refresh_token'
  | 'refresh_http'
  | 'refresh_network'
  | 'refresh_decode'
  | 'read_failed'

export class ClaudeCredentialError extends Error {
  readonly code: ClaudeCredentialErrorCode
  readonly httpStatus?: number
  readonly httpBody?: string

  constructor(code: ClaudeCredentialErrorCode, message: string, opts?: { httpStatus?: number; httpBody?: string }) {
    super(message)
    this.name = 'ClaudeCredentialError'
    this.code = code
    this.httpStatus = opts?.httpStatus
    this.httpBody = opts?.httpBody
  }

  /**
   * True when the user must reconnect (re-run `claude /login` or otherwise
   * refresh the source credentials). Used by the CLI to decide between
   * "transient, retry later" and "you must act".
   *
   * 4xx responses from the OAuth server are normally terminal — they mean
   * the refresh token is no longer accepted. Two exceptions are kept
   * transient so callers do not spam the user with reconnect prompts:
   *
   *   - 429 (Too Many Requests) — Anthropic asks us to back off.
   *   - 408 (Request Timeout) — best-effort retry territory.
   *
   * We also keep the OAuth-spec `invalid_grant` / `invalid_client` /
   * `invalid_token` strings as positive evidence of a terminal error so a
   * future server change that swaps response codes does not silently
   * downgrade the classification.
   */
  get isTerminal(): boolean {
    if (this.code === 'no_refresh_token') return true
    if (this.code === 'no_source') return true
    if (this.code === 'refresh_http' && this.httpStatus !== undefined && this.httpStatus >= 400 && this.httpStatus < 500) {
      if (this.httpStatus === 429 || this.httpStatus === 408) return false
      const lower = (this.httpBody ?? '').toLowerCase()
      if (lower.includes('invalid_grant') || lower.includes('invalid_client') || lower.includes('invalid_token')) {
        return true
      }
      return true
    }
    return false
  }
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCacheFilePath(): string {
  return join(getCacheDir(), CACHE_FILENAME)
}

// Allow tests to stub out network + keychain interactions.
type Hooks = {
  readClaudeFile?: () => Promise<string | null>
  readMacKeychain?: () => Promise<string | null>
  refreshTokenHTTP?: (refreshToken: string) => Promise<{ status: number; body: string }>
  now?: () => Date
}

let hooks: Hooks = {}

/** Internal: used by tests to inject stubs. Reset with `resetClaudeCredentialHooks()`. */
export function setClaudeCredentialHooks(next: Hooks): void {
  hooks = { ...next }
}

export function resetClaudeCredentialHooks(): void {
  hooks = {}
}

function now(): Date {
  return hooks.now ? hooks.now() : new Date()
}

/**
 * Claude Code's keychain writer line-wraps long values mid-token, producing
 * JSON with literal control chars inside string values. Strip those plus
 * pretty-print indentation between fields so the JSON parser succeeds.
 */
export function sanitizeClaudeBlob(raw: string): string {
  let s = raw.replace(/\r/g, '')
  s = s.replace(/\n[ \t]*/g, '')
  return s.trim()
}

export function parseCredentialsBlob(blob: string): CredentialRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(sanitizeClaudeBlob(blob))
  } catch {
    throw new ClaudeCredentialError('decode_failed', 'Claude credentials are malformed.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ClaudeCredentialError('decode_failed', 'Claude credentials are malformed.')
  }
  const root = parsed as { claudeAiOauth?: unknown }
  const oauth = root.claudeAiOauth
  if (!oauth || typeof oauth !== 'object') {
    throw new ClaudeCredentialError('decode_failed', 'Claude credentials are malformed.')
  }
  const o = oauth as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
    rateLimitTier?: unknown
  }
  const access = typeof o.accessToken === 'string' ? o.accessToken.trim() : ''
  if (!access) {
    throw new ClaudeCredentialError('decode_failed', 'Claude credentials are malformed.')
  }
  const refresh = typeof o.refreshToken === 'string' && o.refreshToken.length > 0 ? o.refreshToken : null
  const expiresAtMs = typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : null
  const tier = typeof o.rateLimitTier === 'string' && o.rateLimitTier.length > 0 ? o.rateLimitTier : null
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: expiresAtMs !== null ? new Date(expiresAtMs) : null,
    rateLimitTier: tier,
  }
}

async function readClaudeCredentialsFile(): Promise<string | null> {
  if (hooks.readClaudeFile) return hooks.readClaudeFile()
  const path = join(homedir(), CLAUDE_CREDENTIALS_RELATIVE_PATH)
  if (!existsSync(path)) return null
  try {
    const data = await readFile(path, { encoding: 'utf-8' })
    if (data.length > MAX_CREDENTIAL_BYTES) {
      throw new ClaudeCredentialError('decode_failed', 'Claude credentials file is unexpectedly large.')
    }
    return data
  } catch (err) {
    if (err instanceof ClaudeCredentialError) throw err
    throw new ClaudeCredentialError('read_failed', `Could not read ${path}: ${(err as Error).message}`)
  }
}

async function readMacOSKeychain(): Promise<string | null> {
  if (hooks.readMacKeychain) return hooks.readMacKeychain()
  if (process.platform !== 'darwin') return null
  // The CLI has historically written keychain entries under different account
  // names. Try the modern `$USER`-keyed entry first, then the legacy unscoped
  // entry. Mirrors the Swift implementation's `readClaudeKeychain(account:)`
  // fallback.
  const accounts: (string | null)[] = []
  try {
    accounts.push(userInfo().username)
  } catch {
    /* userInfo() can throw on some sandboxed runtimes */
  }
  accounts.push(null)
  for (const account of accounts) {
    const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']
    if (account) args.push('-a', account)
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', args, {
        encoding: 'utf-8',
        maxBuffer: MAX_CREDENTIAL_BYTES,
      })
      if (stdout && stdout.trim().length > 0) return stdout
    } catch {
      // `security` exits non-zero when the entry is missing; try the next
      // candidate account.
      continue
    }
  }
  return null
}

async function readOurCache(): Promise<CredentialRecord | null> {
  const path = getCacheFilePath()
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, { encoding: 'utf-8' })
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const r = parsed as Partial<{
      accessToken: string
      refreshToken: string | null
      expiresAt: string | number | null
      rateLimitTier: string | null
    }>
    if (typeof r.accessToken !== 'string' || r.accessToken.length === 0) return null
    let expiresAt: Date | null = null
    if (typeof r.expiresAt === 'string') {
      const d = new Date(r.expiresAt)
      if (!Number.isNaN(d.getTime())) expiresAt = d
    } else if (typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)) {
      expiresAt = new Date(r.expiresAt)
    }
    return {
      accessToken: r.accessToken,
      refreshToken: typeof r.refreshToken === 'string' && r.refreshToken.length > 0 ? r.refreshToken : null,
      expiresAt,
      rateLimitTier: typeof r.rateLimitTier === 'string' && r.rateLimitTier.length > 0 ? r.rateLimitTier : null,
    }
  } catch {
    return null
  }
}

async function writeOurCache(record: CredentialRecord): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const finalPath = getCacheFilePath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const payload = JSON.stringify({
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    rateLimitTier: record.rateLimitTier,
  })
  // Write through a temp file + rename so a crash midway through the write
  // can never leave the cache in a half-written, unparseable state — that
  // would force the user to reconnect every time.
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, finalPath)
  } catch (err) {
    try { await unlink(tempPath) } catch { /* ignore */ }
    throw err
  }
}

async function deleteOurCache(): Promise<void> {
  try {
    await unlink(getCacheFilePath())
  } catch {
    /* best-effort */
  }
}

async function readClaudeSource(): Promise<CredentialRecord> {
  const fileBlob = await readClaudeCredentialsFile()
  if (fileBlob !== null) return parseCredentialsBlob(fileBlob)
  const keychainBlob = await readMacOSKeychain()
  if (keychainBlob !== null) return parseCredentialsBlob(keychainBlob)
  throw new ClaudeCredentialError(
    'no_source',
    'No Claude credentials found. Sign in with `claude` first.',
  )
}

async function defaultRefreshTokenHTTP(refreshToken: string): Promise<{ status: number; body: string }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }).toString()
  let response: Response
  try {
    response = await fetch(OAUTH_REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
  } catch (err) {
    throw new ClaudeCredentialError('refresh_network', `Token refresh network error: ${(err as Error).message}`)
  }
  const text = await response.text()
  return { status: response.status, body: text }
}

async function refreshAndPersist(record: CredentialRecord): Promise<CredentialRecord> {
  // Re-read the cache file immediately before the HTTP call so a sibling
  // process (another `codeburn` invocation, the menubar app) that just
  // rotated the token wins the race instead of us replaying its (now
  // invalid) refresh token. Anthropic's OAuth implementation rotates the
  // refresh token on every use and treats replay as a session compromise,
  // so this matters even for the common "two CLIs at once" case.
  const latest = await readOurCache()
  const effective = latest ?? record
  if (!effective.refreshToken || effective.refreshToken.length === 0) {
    throw new ClaudeCredentialError('no_refresh_token', 'No refresh token available; reconnect required.')
  }
  if (latest && latest.accessToken !== record.accessToken) {
    // Another process already refreshed; reuse its result.
    return latest
  }
  const refresher = hooks.refreshTokenHTTP ?? defaultRefreshTokenHTTP
  const { status, body } = await refresher(effective.refreshToken)
  if (status !== 200) {
    throw new ClaudeCredentialError(
      'refresh_http',
      `Token refresh failed (HTTP ${status})${body ? `: ${body}` : ''}`,
      { httpStatus: status, httpBody: body },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ClaudeCredentialError('refresh_decode', 'Token refresh response was malformed.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ClaudeCredentialError('refresh_decode', 'Token refresh response was malformed.')
  }
  const p = parsed as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
  if (typeof p.access_token !== 'string' || p.access_token.length === 0) {
    throw new ClaudeCredentialError('refresh_decode', 'Token refresh response was malformed.')
  }
  const updated: CredentialRecord = {
    accessToken: p.access_token,
    refreshToken: typeof p.refresh_token === 'string' && p.refresh_token.length > 0 ? p.refresh_token : effective.refreshToken,
    expiresAt: typeof p.expires_in === 'number' && Number.isFinite(p.expires_in)
      ? new Date(now().getTime() + p.expires_in * 1000)
      : effective.expiresAt,
    rateLimitTier: effective.rateLimitTier,
  }
  try {
    await writeOurCache(updated)
  } catch {
    /* Best effort. Surface to logs but keep the new record so the next call
     * can still use it. */
  }
  return updated
}

async function readSourceOrNull(): Promise<CredentialRecord | null> {
  try {
    const source = await readClaudeSource()
    await writeOurCache(source).catch(() => {})
    return source
  } catch (err) {
    if (err instanceof ClaudeCredentialError && err.code === 'no_source') return null
    throw err
  }
}

/**
 * Public: returns the current credential record from our cache, falling back
 * to reading the Claude source on first use. Writes to our cache on bootstrap
 * so subsequent calls do not prompt the macOS Keychain again.
 */
export async function getCurrentClaudeRecord(): Promise<CredentialRecord | null> {
  const cached = await readOurCache()
  if (cached) return cached
  return await readSourceOrNull()
}

/**
 * Public: drop our cached record and re-read the Claude source. Used by the
 * quota layer when a refresh failure looks terminal — the user may have
 * re-logged into the `claude` CLI and we should pick up the new credentials
 * instead of staying locked to the dead cached pair.
 */
export async function rebootstrapClaudeCredentials(): Promise<CredentialRecord | null> {
  await deleteOurCache()
  return await readSourceOrNull()
}

/**
 * Public: returns an access token, refreshing proactively when within the
 * margin. If the proactive refresh fails transiently (network glitch, 5xx,
 * 429), we return the still-valid current token rather than crashing the
 * caller — the next invocation will retry. Terminal refresh failures
 * (invalid_grant, etc.) are surfaced so the caller can prompt the user to
 * reconnect. Returns null when no credentials are available locally.
 */
export async function freshClaudeAccessToken(): Promise<string | null> {
  const record = await getCurrentClaudeRecord()
  if (!record) return null
  if (record.expiresAt && record.expiresAt.getTime() - now().getTime() < PROACTIVE_REFRESH_MARGIN_MS) {
    try {
      const updated = await refreshAndPersist(record)
      return updated.accessToken
    } catch (err) {
      if (err instanceof ClaudeCredentialError && !err.isTerminal && record.expiresAt.getTime() > now().getTime()) {
        // Transient failure with a token that is still technically valid —
        // best-effort fallback to the current token so the CLI does not
        // crash on a momentary network glitch.
        return record.accessToken
      }
      throw err
    }
  }
  return record.accessToken
}

/**
 * Public: explicit refresh after a 401 from the quota endpoint. Always
 * persists the new token to our cache.
 */
export async function refreshClaudeAccessTokenAfter401(): Promise<string> {
  const record = await getCurrentClaudeRecord()
  if (!record) {
    throw new ClaudeCredentialError('no_source', 'No Claude credentials found. Sign in with `claude` first.')
  }
  const updated = await refreshAndPersist(record)
  return updated.accessToken
}

/**
 * Public: drop our local cache. The Claude source is left untouched.
 */
export async function disconnectClaude(): Promise<void> {
  await deleteOurCache()
}
