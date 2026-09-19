import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeGeminiUsage, fetchGeminiQuota } from './gemini'

const credential = JSON.stringify({
  access_token: 'ya29.test-secret',
  refresh_token: '1//refresh-secret',
  expiry_date: Date.now() + 3_600_000,
})

// A Google Workspace id_token carries the hosted-domain (`hd`) JWT claim.
const workspaceCredential = JSON.stringify({
  access_token: 'ya29.workspace-secret',
  id_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ hd: 'example.com' })).toString('base64url')}.sig`,
  expiry_date: Date.now() + 3_600_000,
})

const quotaBody = {
  buckets: [
    { modelId: 'gemini-2.5-flash', remainingFraction: 0.9, resetTime: '2026-07-13T00:00:00Z' },
    { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-07-12T18:00:00Z' },
    { modelId: 'gemini-2.5-lite', remainingFraction: 'garbage' },
  ],
}

const okJson = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

afterEach(() => vi.unstubAllEnvs())

describe('Gemini usage decode', () => {
  it('decodes buckets most-constrained first and derives used percent', () => {
    const quota = decodeGeminiUsage(quotaBody)
    expect(quota.connection).toBe('connected')
    expect(quota.primary?.label).toBe('gemini-2.5-pro')
    expect(quota.primary?.percent).toBeCloseTo(0.75)
    expect(quota.details.map(row => row.label)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
    expect(quota.details[0]!.resetsAt).toBe('2026-07-12T18:00:00.000Z')
  })

  it('survives a malformed payload with no usable buckets', () => {
    const quota = decodeGeminiUsage({ buckets: [null, 'x', {}], extra: true })
    expect(quota.connection).toBe('connected')
    expect(quota.primary).toBeNull()
    expect(quota.details).toEqual([])
  })
})

describe('Gemini quota fetch', () => {
  it('returns disconnected without credentials and never fetches', async () => {
    const fetchMock = vi.fn()
    const result = await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => null) })
    expect(result.quota.connection).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls loadCodeAssist then retrieveUserQuota with the discovered project and exact headers', async () => {
    const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => String(url).includes('loadCodeAssist')
      ? okJson({ currentTier: { name: 'free-tier' }, cloudaicompanionProject: 'gen-lang-client-1' })
      : okJson(quotaBody))
    const result = await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    expect(result.quota.connection).toBe('connected')
    expect(result.quota.planLabel).toBe('Free')
    expect(fetchMock.mock.calls.every(call => String(call[0]).startsWith('https://cloudcode-pa.googleapis.com/v1internal:'))).toBe(true)
    const [, quotaInit] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit]
    expect(JSON.parse(String(quotaInit.body))).toEqual({ project: 'gen-lang-client-1' })
    expect(quotaInit.headers).toMatchObject({
      Authorization: 'Bearer ya29.test-secret',
      'Content-Type': 'application/json',
      'User-Agent': 'CodeBurn',
    })
  })

  it('sends an empty project object when discovery yields none', async () => {
    const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => String(url).includes('loadCodeAssist') ? okJson({}) : okJson(quotaBody))
    await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    const [, quotaInit] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit]
    expect(JSON.parse(String(quotaInit.body))).toEqual({})
  })

  it('refreshes a stale token through Google OAuth using the documented env overrides', async () => {
    vi.stubEnv('GEMINI_OAUTH_CLIENT_ID', 'client-id')
    vi.stubEnv('GEMINI_OAUTH_CLIENT_SECRET', 'client-secret')
    const stale = JSON.stringify({ ...JSON.parse(credential), expiry_date: Date.now() - 1000 })
    const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => String(url).includes('oauth2.googleapis.com')
      ? okJson({ access_token: 'ya29.refreshed' })
      : String(url).includes('loadCodeAssist')
        ? okJson({ paidTier: { name: 'standard-tier' } })
        : okJson(quotaBody))
    const result = await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => stale) })
    expect(result.quota.planLabel).toBe('Paid')
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token')
    expect(tokenInit.method).toBe('POST')
    expect(String(tokenInit.body)).toContain('grant_type=refresh_token')
    const init = (fetchMock.mock.calls.at(-1)! as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ya29.refreshed' })
  })

  it('uses the Retry-After header for 429 backoff', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '90' } }))
    const result = await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    expect(result.retryAfterSeconds).toBe(90)
    expect(result.quota.connection).toBe('transientFailure')
  })

  it('treats a 401 with an unchanged token as a terminal, connectable login expiry', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))
    const result = await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.connectable).toBe(true)
    expect(result.quota.footerLines[0]).toMatch(/login expired/i)
    expect((fetchMock.mock.calls as unknown as Array<[string]>).every(call => call[0].includes('loadCodeAssist'))).toBe(true)
  })

  it('maps retired consumer tiers to terminalFailure with migration guidance', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 400, status: 'UNSUPPORTED_CLIENT', message: 'IneligibleTierError: use Antigravity' } }), { status: 400 }))
    const result = await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines).toEqual(['Google retired Gemini CLI OAuth for this account tier — use Antigravity.'])
  })

  it('labels a Workspace account from the id_token hd claim, personal from the tier alone', async () => {
    const assist = { currentTier: { name: 'free-tier' } }
    const workspace = vi.fn(async (url: string | URL | RequestInfo) => String(url).includes('loadCodeAssist') ? okJson(assist) : okJson(quotaBody))
    const result = await fetchGeminiQuota({ fetch: workspace, readFile: vi.fn(async () => workspaceCredential) })
    expect(result.quota.planLabel).toBe('Workspace')

    const personal = vi.fn(async (url: string | URL | RequestInfo) => String(url).includes('loadCodeAssist') ? okJson(assist) : okJson(quotaBody))
    const free = await fetchGeminiQuota({ fetch: personal, readFile: vi.fn(async () => credential) })
    expect(free.quota.planLabel).toBe('Free')
  })

  it('maps 5xx to transientFailure and other 4xx to terminalFailure', async () => {
    const serverError = vi.fn(async () => new Response('', { status: 503 }))
    const bad = await fetchGeminiQuota({ fetch: serverError, readFile: vi.fn(async () => credential) })
    expect(bad.quota.connection).toBe('transientFailure')
    const clientError = vi.fn(async () => new Response('', { status: 404 }))
    const worse = await fetchGeminiQuota({ fetch: clientError, readFile: vi.fn(async () => credential) })
    expect(worse.quota.connection).toBe('terminalFailure')
  })

  it('redacts tokens and NUL from diagnostics without surfacing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => { throw new Error('Bearer rawtoken ya29.leak eyJabc.def.ghi\0tail') })
    const result = await fetchGeminiQuota({ fetch: fetchMock, readFile: vi.fn(async () => credential) })
    const logged = warn.mock.calls.flat().join(' ')
    expect(result.quota).not.toHaveProperty('error')
    expect(logged).not.toMatch(/rawtoken|ya29\.leak|eyJabc|\0/)
    expect(logged).toContain('[REDACTED]')
  })
})
