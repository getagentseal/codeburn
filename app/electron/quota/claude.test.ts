import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { decodeClaudeUsage, fetchClaudeQuota } from './claude'

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
    const fetchMock = vi.fn()
    const result = await fetchClaudeQuota({ fetch: fetchMock, readFile: vi.fn(async () => null) })
    expect(result.quota.connection).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('never reads the keychain unless allowKeychain is set', async () => {
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: credential }))
    const result = await fetchClaudeQuota({ fetch: vi.fn(), readFile: vi.fn(async () => null), keychain })
    expect(result.quota.connection).toBe('disconnected')
    expect(keychain).not.toHaveBeenCalled()
  })
})
