import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { decodeCodexUsage, fetchCodexQuota } from './codex'

const now = Date.parse('2026-07-12T00:00:00Z')
const auth = {
  auth_mode: 'chatgpt', OPENAI_API_KEY: 'preserve-me', last_refresh: '2026-07-11T00:00:00Z',
  tokens: { access_token: 'eyJaccess.token.sig', refresh_token: 'refresh-secret', id_token: 'old-id', account_id: 'acct_1' },
}

afterEach(() => vi.restoreAllMocks())

describe('Codex quota', () => {
  it('decodes primary/secondary/additional windows, plan and numeric-string credits', () => {
    const quota = decodeCodexUsage({
      plan_type: 'pLuS',
      rate_limit: {
        primary_window: { used_percent: 20, reset_at: 1_800_000_000, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 80, reset_at: 1_800_100_000, limit_window_seconds: 604_800 },
      },
      additional_rate_limits: [{
        limit_name: 'GPT-5', rate_limit: {
          primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 3600 },
          secondary_window: { used_percent: 0, reset_at: 1_800_000_000, limit_window_seconds: 86_400 },
        },
      }],
      credits: { balance: '3.5' },
    })
    expect(quota.planLabel).toBe('Plus')
    expect(quota.primary?.label).toBe('5-hour')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly', 'GPT-5 · Hour'])
    expect(quota.footerLines).toEqual(['Credits remaining · $3.50'])
  })

  it('promotes secondary when primary is absent', () => {
    const quota = decodeCodexUsage({ rate_limit: { secondary_window: { used_percent: 9, reset_at: 1_800_000_000, limit_window_seconds: 604_800 } } })
    expect(quota.primary?.label).toBe('Weekly')
    expect(quota.details).toHaveLength(1)
  })

  it('returns disconnected without credentials', async () => {
    const fetchMock = vi.fn()
    const result = await fetchCodexQuota({ fetch: fetchMock, readFile: vi.fn(async () => null) })
    expect(result.quota.connection).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends account id and uses Retry-After header for 429', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
    const result = await fetchCodexQuota({ fetch: fetchMock, readFile: vi.fn(async () => JSON.stringify(auth)), now: () => now })
    expect(result.retryAfterSeconds).toBe(120)
    const usageInit = (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1]
    expect(usageInit.headers).toMatchObject({ 'ChatGPT-Account-Id': 'acct_1', 'User-Agent': 'CodeBurn' })
  })

  it('refreshes after eight days and preserves unrelated auth keys on write-back', async () => {
    const stale = { ...auth, last_refresh: '2026-07-01T00:00:00Z' }
    const fetchMock = vi.fn(async (url: string) => url.includes('/oauth/token')
      ? new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id' }), { status: 200 })
      : new Response(JSON.stringify({ plan_type: 'pro', rate_limit: {} }), { status: 200 }))
    const writeFile = vi.fn(async () => undefined)
    await fetchCodexQuota({ fetch: fetchMock as typeof fetch, readFile: vi.fn(async () => JSON.stringify(stale)), writeFile, now: () => now })
    const saved = JSON.parse((writeFile.mock.calls[0]! as unknown as [string, string])[1])
    expect(saved.OPENAI_API_KEY).toBe('preserve-me')
    expect(saved.tokens).toMatchObject({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id', account_id: 'acct_1' })
    expect((fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1].method).toBe('POST')
  })
})

// The CodeBurn menubar caches its Codex OAuth as a Swift CredentialRecord blob.
const menubarRecord = JSON.stringify({
  accessToken: 'eyJmenubar.token.sig', refreshToken: 'mb-refresh', idToken: 'mb-id', accountId: 'acct_mb', lastRefresh: 1_234_567,
})

describe('Codex menubar keychain source', () => {
  const originalPlatform = process.platform
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
  afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))

  it('resolves quota from the menubar keychain when auth.json is absent, read-only', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 10, reset_at: 1_800_000_000, limit_window_seconds: 18_000 } } }), { status: 200 }))
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: menubarRecord }))
    const writeFile = vi.fn(async () => undefined)
    const result = await fetchCodexQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: vi.fn(async () => null), writeFile, keychain, allowKeychain: true })
    expect(result.quota.connection).toBe('connected')
    expect(result.quota.planLabel).toBe('Pro')
    const init = (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer eyJmenubar.token.sig', 'ChatGPT-Account-Id': 'acct_mb' })
    expect(writeFile).not.toHaveBeenCalled()
    expect(keychain).toHaveBeenCalledWith('org.agentseal.codeburn.menubar.codex.oauth.v1')
  })

  it('re-reads the keychain once on a 401 and adopts a rotated token, never a refresh POST', async () => {
    const rotated = JSON.stringify({ accessToken: 'eyJrotated.token.sig', refreshToken: 'mb-refresh2', idToken: 'mb-id', accountId: 'acct_mb' })
    let reads = 0
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: reads++ === 0 ? menubarRecord : rotated }))
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.headers as Record<string, string>).Authorization === 'Bearer eyJrotated.token.sig'
      ? new Response(JSON.stringify({ plan_type: 'pro', rate_limit: {} }), { status: 200 })
      : new Response('', { status: 401 }))
    const writeFile = vi.fn(async () => undefined)
    const result = await fetchCodexQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: vi.fn(async () => null), writeFile, keychain, allowKeychain: true })
    expect(result.quota.connection).toBe('connected')
    expect(fetchMock.mock.calls.every(call => String(call[0]).includes('/wham/usage'))).toBe(true)
    expect(keychain).toHaveBeenCalledTimes(2)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('returns transientFailure on a keychain 401 with no rotation, never writing back', async () => {
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: menubarRecord }))
    const fetchMock = vi.fn(async (_url: string) => new Response('', { status: 401 }))
    const writeFile = vi.fn(async () => undefined)
    const result = await fetchCodexQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: vi.fn(async () => null), writeFile, keychain, allowKeychain: true })
    expect(result.quota.connection).toBe('transientFailure')
    expect(fetchMock.mock.calls.every(call => String(call[0]).includes('/wham/usage'))).toBe(true)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('surfaces accessDenied when the menubar keychain is blocked and no file exists', async () => {
    const keychain = vi.fn(async () => ({ status: 'accessDenied' as const }))
    const fetchMock = vi.fn()
    const result = await fetchCodexQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: vi.fn(async () => null), keychain, allowKeychain: true })
    expect(result.quota.connection).toBe('accessDenied')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prefers the menubar keychain over ~/.codex/auth.json and keeps it read-only', async () => {
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: menubarRecord }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plan_type: 'plus', rate_limit: {} }), { status: 200 }))
    const writeFile = vi.fn(async () => undefined)
    const result = await fetchCodexQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: vi.fn(async () => JSON.stringify(auth)), writeFile, keychain, allowKeychain: true, now: () => now })
    expect(result.quota.connection).toBe('connected')
    const init = (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer eyJmenubar.token.sig' })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('falls through to ~/.codex/auth.json when the keychain has no menubar item', async () => {
    const keychain = vi.fn(async () => ({ status: 'notFound' as const }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plan_type: 'plus', rate_limit: {} }), { status: 200 }))
    const result = await fetchCodexQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: vi.fn(async () => JSON.stringify(auth)), keychain, allowKeychain: true, now: () => now })
    expect(result.quota.connection).toBe('connected')
    const init = (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer eyJaccess.token.sig' })
  })
})
