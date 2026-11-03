import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { claudeConfigDir, claudeKeychainService, decodeClaudeUsage, fetchClaudeQuota, planLabel } from './claude'
import { readKeychainPassword } from './security'

// Every Keychain lookup is answered here; no test reaches /usr/bin/security.
vi.mock('./security', async importOriginal => ({
  ...await importOriginal<typeof import('./security')>(),
  readKeychainPassword: vi.fn(),
}))

const credential = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-test-secret',
    refreshToken: 'unused',
    expiresAt: Date.now() + 86_400_000,
    rateLimitTier: 'max_20x',
  },
})

afterEach(() => vi.restoreAllMocks())

describe('Claude quota', () => {
  it('decodes ordered five-hour, weekly, model, and scoped windows with credential tier', () => {
    const quota = decodeClaudeUsage({
      five_hour: { utilization: 25, resets_at: '2026-07-12T12:00:00Z' },
      seven_day: { utilization: 50, resets_at: '2026-07-19T12:00:00.123Z' },
      seven_day_opus: { utilization: 75, resets_at: '2026-07-19T12:00:00Z' },
      seven_day_sonnet: { utilization: 90, resets_at: '2026-07-19T12:00:00Z' },
      limits: [
        { kind: 'weekly_all', percent: 88, scope: { model: { display_name: 'Duplicate' } } },
        { kind: 'weekly_scoped', percent: 10, resets_at: '2026-07-20T00:00:00Z', scope: { model: { display_name: 'Haiku' } } },
      ],
    }, { accessToken: 'hidden', rateLimitTier: 'max_20x' })

    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Max 20x')
    expect(quota.primary?.label).toBe('Weekly')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly', 'Weekly · Opus', 'Weekly · Sonnet', 'Weekly · Haiku'])
    expect(quota.details.map(row => row.percent)).toEqual([0.25, 0.5, 0.75, 0.9, 0.1])
  })

  it('returns disconnected without credentials and never fetches', async () => {
    // Off darwin there is no keychain to look in, so no credential file really
    // does mean disconnected. (On darwin it means "not checked yet" — below.)
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const fetchMock = vi.fn()
      const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => null) })
      expect(result.quota.connection).toBe('disconnected')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('prefers subscriptionType over rateLimitTier for the plan label', () => {
    const cases: Array<[string | undefined, string | undefined, string]> = [
      ['max', 'default_claude_max_20x', 'Max 20x'],
      ['team', 'default_claude_max_5x', 'Team Premium'],
      ['team', undefined, 'Team'],
      ['enterprise', 'default_claude_max_5x', 'Enterprise Premium'],
      ['pro', 'default_claude_pro', 'Pro'],
      [undefined, 'max_5x', 'Max 5x'],
      [undefined, 'max_20x', 'Max 20x'],
      [undefined, 'team', 'Team'],
      [undefined, undefined, 'Subscription'],
    ]
    for (const [subscriptionType, rateLimitTier, label] of cases) {
      expect(planLabel({ subscriptionType, rateLimitTier })).toBe(label)
    }
  })

  it('sanitizes newline-corrupted credential JSON and uses exact request headers', async () => {
    const broken = credential.replace('sk-ant-test-secret', 'sk-ant-test-\n    secret')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ seven_day: { utilization: 4, resets_at: '2026-07-19T00:00:00Z' } }), { status: 200 }))
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => broken) })
    expect(result.quota.connection).toBe('connected')
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      Authorization: 'Bearer sk-ant-test-secret', Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0',
    })
    expect(init.headers).not.toHaveProperty('anthropic-version')
  })

  it('uses the body retry_after for 429 backoff', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ retry_after: '42' }), { status: 429 }))
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    expect(result).toMatchObject({ quota: { connection: 'transientFailure' }, retryAfterSeconds: 60 })
  })

  it('never calls an Anthropic refresh endpoint when the token is unchanged after 401', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    expect(result.quota.connection).toBe('transientFailure')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls as unknown as Array<[string]>).every(call => String(call[0]) === 'https://api.anthropic.com/api/oauth/usage')).toBe(true)
  })

  it('redacts tokens and NUL from diagnostics without surfacing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => { throw new Error('Bearer rawbearer sk-ant-leak sk-other eyJabc.def.ghi\0tail') })
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    const logged = warn.mock.calls.flat().join(' ')
    expect(result.quota).not.toHaveProperty('error')
    expect(logged).not.toMatch(/rawbearer|sk-ant-leak|sk-other|eyJabc|\0/)
    expect(logged).toContain('[REDACTED]')
  })
})

describe('Claude keychain fallback', () => {
  const originalPlatform = process.platform
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
  afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))

  it('connects from the keychain when the credential file is absent', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ seven_day: { utilization: 4, resets_at: '2026-07-19T00:00:00Z' } }), { status: 200 }))
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => null), allowKeychain: true, keychain: vi.fn(async () => ({ status: 'found' as const, value: credential })) })
    expect(result.quota.connection).toBe('connected')
    expect(result.quota.planLabel).toBe('Max 20x')
  })

  it('surfaces accessDenied when macOS blocks the keychain read', async () => {
    const fetchMock = vi.fn()
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => null), allowKeychain: true, keychain: vi.fn(async () => ({ status: 'accessDenied' as const })) })
    expect(result.quota.connection).toBe('accessDenied')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays disconnected when the keychain has no matching item', async () => {
    const fetchMock = vi.fn()
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => null), allowKeychain: true, keychain: vi.fn(async () => ({ status: 'notFound' as const })) })
    expect(result.quota.connection).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never reads the keychain unless allowKeychain is set, and says so', async () => {
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: credential }))
    const result = await fetchClaudeQuota({ fetch: vi.fn(), readFile: vi.fn(async () => null), keychain })
    // The credential is right there in the keychain. Reporting "disconnected"
    // would be a lie that told the user to log in again; this says we have not
    // looked, so the card can offer the look.
    expect(result.quota.connection).toBe('keychainUnchecked')
    expect(keychain).not.toHaveBeenCalled()
  })

  it('a file credential answers on an unforced poll, with no keychain read', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ seven_day: { utilization: 4, resets_at: '2026-07-19T00:00:00Z' } }), { status: 200 }))
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: credential }))
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential), keychain })
    expect(result.quota.connection).toBe('connected')
    expect(keychain).not.toHaveBeenCalled()
  })
})

// The desktop app reads the same credential the CLI does, and on macOS that is
// normally the Keychain with no credential file at all - which is exactly the
// install the app never writes back to. The 401 re-read has to consult that store.
describe('Claude credential recovery', () => {
  const originalPlatform = process.platform
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
  afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))

  const now = () => 1_760_000_000_000
  const HOUR = 3_600_000
  const usage = JSON.stringify({ seven_day: { utilization: 55, resets_at: '2026-07-19T12:00:00Z' } })
  const stored = (accessToken: string, expiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, rateLimitTier: 'max_20x' } })
  const ok = () => new Response(usage, { status: 200 })

  it('re-reads the keychain, not the absent file, when a 401 rejects the token', async () => {
    let reads = 0
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored(reads++ === 0 ? 'before' : 'after', now() + HOUR) }))
    let requests = 0
    const fetchMock = vi.fn(async () => (requests++ === 0 ? new Response('', { status: 401 }) : ok()))
    const readFile = vi.fn(async () => null)

    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile, keychain, allowKeychain: true, now })

    expect(result.quota.connection).toBe('connected')
    expect(result.quota.primary?.percent).toBe(0.55)
    expect(keychain).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('calls an expired login terminal when a 401 rejects it and the keychain has nothing newer', async () => {
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored('unchanged', now() - HOUR) }))
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))

    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => null), keychain, allowKeychain: true, now })

    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines[0]).toMatch(/expired/i)
    expect(result.quota.connectable).toBe(true)
    expect(keychain).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a 401 transient while the credential is still within its life', async () => {
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored('unchanged', now() + HOUR) }))
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))

    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => null), keychain, allowKeychain: true, now })

    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.footerLines).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-reads the file for a file-backed credential on a background poll and never touches the keychain', async () => {
    let reads = 0
    const readFile = vi.fn(async () => stored(reads++ === 0 ? 'before' : 'after', now() + HOUR))
    let requests = 0
    const fetchMock = vi.fn(async () => (requests++ === 0 ? new Response('', { status: 401 }) : ok()))
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored('keychain', now() + HOUR) }))

    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile, keychain, now })

    expect(result.quota.connection).toBe('connected')
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(keychain).not.toHaveBeenCalled()
  })
})

describe('Claude login of a non-default config dir', () => {
  const keychain = vi.mocked(readKeychainPassword)
  const originalPlatform = process.platform
  const originalUser = process.env.USER
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    if (originalUser === undefined) delete process.env.USER
    else process.env.USER = originalUser
  })
  beforeEach(() => {
    keychain.mockReset()
    process.env.USER = 'alice'
  })

  const WORK = '/home/alice/.claude-work'
  const now = () => 1_760_000_000_000
  const HOUR = 3_600_000
  const stored = (accessToken: string, expiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, rateLimitTier: 'max_20x' } })

  function run(file: string | null, allowKeychain = true) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ seven_day: { utilization: 40 } }), { status: 200 }))
    const readFile = vi.fn(async (_path: string) => file)
    const done = fetchClaudeQuota({ configDir: WORK, allowKeychain, fetch: fetchMock, readFile, now })
    const bearers = () => (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)
      .map(([, init]) => (init.headers as Record<string, string>).Authorization)
    return { done, bearers, readFile }
  }

  it('names the Keychain item the way Claude Code 2.1.314 does', () => {
    expect(claudeKeychainService(path.join(os.homedir(), '.claude'))).toBe('Claude Code-credentials')
    expect(claudeKeychainService(WORK)).toBe('Claude Code-credentials-f0fc2950')
    // The NFD spelling of /Users/rené/.claude-2 hashes as its NFC form.
    expect(claudeKeychainService('/Users/rene\u0301/.claude-2')).toBe('Claude Code-credentials-45281352')
  })

  it("reads that dir's own file and Keychain item, $USER account first", async () => {
    keychain.mockResolvedValue({ status: 'found', value: stored('live', now() + HOUR) })
    const { done, readFile } = run(null)
    expect((await done).quota).toMatchObject({ connection: 'connected', planLabel: 'Max 20x' })
    expect(readFile.mock.calls.map(call => call[0])).toEqual([path.join(WORK, '.credentials.json')])
    expect(keychain.mock.calls).toEqual([['Claude Code-credentials-f0fc2950', ['alice', null]]])
  })

  it('prefers a live Keychain login over an expired credential file', async () => {
    keychain.mockResolvedValue({ status: 'found', value: stored('live', now() + HOUR) })
    const { done, bearers } = run(stored('stale', now() - 1))
    expect((await done).quota.connection).toBe('connected')
    expect(bearers()).toEqual(['Bearer live'])
  })

  it('reports the expired file when the Keychain holds no login', async () => {
    keychain.mockResolvedValue({ status: 'notFound' })
    const { done, bearers } = run(stored('stale', now() - 1))
    expect((await done).quota).toMatchObject({ connection: 'terminalFailure', footerLines: [expect.stringMatching(/expired/i)] })
    expect(bearers()).toEqual([])
  })

  it('reports a denied Keychain instead of the expired file', async () => {
    keychain.mockResolvedValue({ status: 'accessDenied' })
    const { done, bearers } = run(stored('stale', now() - 1))
    expect((await done).quota.connection).toBe('accessDenied')
    expect(bearers()).toEqual([])
  })

  it('leaves an expired file unchecked on a background poll, and never reads past a live file', async () => {
    expect((await run(stored('stale', now() - 1), false).done).quota.connection).toBe('keychainUnchecked')
    const live = run(stored('fresh', now() + HOUR))
    expect((await live.done).quota.connection).toBe('connected')
    expect(live.bearers()).toEqual(['Bearer fresh'])
    expect(keychain).not.toHaveBeenCalled()
  })
})

describe('the Claude config dir the quota reads', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'claude-config-dir-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('is the first dir in the CLI order: CLAUDE_CONFIG_DIRS, CLAUDE_CONFIG_DIR, claudeConfigDirs, ~/.claude', () => {
    expect(claudeConfigDir({}, home)).toBe(path.join(home, '.claude'))
    mkdirSync(path.join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(path.join(home, '.config', 'codeburn', 'config.json'), JSON.stringify({ claudeConfigDirs: [' ', 7, ' ~/.claude-work ', '/b'] }))
    expect(claudeConfigDir({}, home)).toBe(path.join(home, '.claude-work'))
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/single' }, home)).toBe(path.resolve('/single'))
    // A list of nothing but separators counts as unset.
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIRS: ` ${path.delimiter} `, CLAUDE_CONFIG_DIR: '/single' }, home)).toBe(path.resolve('/single'))
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIRS: ` ${path.delimiter} /first ${path.delimiter}/second`, CLAUDE_CONFIG_DIR: '/single' }, home)).toBe(path.resolve('/first'))
  })
})
