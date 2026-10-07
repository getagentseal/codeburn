// Fixture-driven coverage for the ClinePass quota adapter, ported from the
// menubar's ClinePassQuotaTests. The key is synthetic and every request goes
// through the injected fetch.
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  clinePassApiKey, clineProvidersPath, decodeClinePassUsage, fetchClinePassQuota, parseClineProviders,
} from '../src/quota/clinepass.js'

const neverFetch = (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch
const SYNTHETIC_KEY = 'synthetic-clinepass-test-key'
const noFile = async () => null
const NOW = 1_800_000_000_000

function providersFile(settings: unknown): string {
  return JSON.stringify({ version: 1, providers: { cline: { settings }, anthropic: { settings: { apiKey: 'other-provider-key' } } } })
}

const successBody = {
  success: true,
  data: {
    limits: [
      { type: 'five_hour', percentUsed: 13.5, resetsAt: '2026-08-29T05:00:00Z' },
      { type: 'weekly', percentUsed: 42, resetsAt: '2026-09-05T00:00:00Z' },
      { type: 'monthly', percentUsed: 7, resetsAt: '2026-09-23T08:00:00Z' },
    ],
  },
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('ClinePass credential discovery', () => {
  it('takes the first key the environment supplies', () => {
    expect(clinePassApiKey({ CLINEPASS_API_KEY: '  first  ', CLINE_API_KEY: 'second' })).toBe('first')
    expect(clinePassApiKey({ CLINE_API_KEY: 'second' })).toBe('second')
    expect(clinePassApiKey({ CLINEPASS_API_KEY: '   ' })).toBeNull()
    expect(clinePassApiKey({})).toBeNull()
  })

  it('reports disconnected with no key and never fetches', async () => {
    const result = await fetchClinePassQuota({ env: {}, fetch: neverFetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })

  it('follows Cline\'s settings path overrides', () => {
    expect(clineProvidersPath({}, '/home/u')).toBe(join('/home/u', '.cline', 'data', 'settings', 'providers.json'))
    expect(clineProvidersPath({ CLINE_DIR: '~/c' }, '/home/u')).toBe(join('/home/u', 'c', 'data', 'settings', 'providers.json'))
    expect(clineProvidersPath({ CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' }, '/home/u')).toBe(join('/d', 'settings', 'providers.json'))
    expect(clineProvidersPath({ CLINE_DATA_DIR: '/d', CLINE_PROVIDER_SETTINGS_PATH: '/f.json' }, '/home/u')).toBe('/f.json')
  })

  it('prefers the OAuth access token, then apiKey, then auth.apiKey', () => {
    expect(parseClineProviders(providersFile({ apiKey: 'k1', auth: { accessToken: 'workos:tok', apiKey: 'k2', expiresAt: NOW } })))
      .toEqual({ token: 'workos:tok', oauth: true, expiresAt: NOW })
    expect(parseClineProviders(providersFile({ auth: { accessToken: 'bare' } }))?.token).toBe('workos:bare')
    expect(parseClineProviders(providersFile({ apiKey: 'k1', auth: { apiKey: 'k2' } }))).toEqual({ token: 'k1', oauth: false, expiresAt: null })
    expect(parseClineProviders(providersFile({ auth: { apiKey: 'k2' } }))?.token).toBe('k2')
    expect(parseClineProviders(providersFile({ provider: 'cline' }))).toBeNull()
    expect(parseClineProviders(JSON.stringify({ providers: {} }))).toBeNull()
  })

  it('sends the Cline session token when no key is set, and a key wins over it', async () => {
    const seen: string[] = []
    const file = providersFile({ auth: { accessToken: 'workos:session-token', expiresAt: NOW + 60_000 } })
    const fetchSpy = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)['Authorization']!)
      return jsonResponse(successBody)
    }) as unknown as typeof fetch
    const viaFile = await fetchClinePassQuota({ env: {}, fetch: fetchSpy, readFile: async () => file, now: () => NOW })
    expect(viaFile.quota.connection).toBe('connected')
    await fetchClinePassQuota({ env: { CLINE_API_KEY: SYNTHETIC_KEY }, fetch: fetchSpy, readFile: async () => file, now: () => NOW })
    expect(seen).toEqual(['Bearer workos:session-token', `Bearer ${SYNTHETIC_KEY}`])
  })

  it('stops at an expired Cline session without fetching, as a retryable failure', async () => {
    const file = providersFile({ auth: { accessToken: 'workos:old', expiresAt: NOW - 1 } })
    const result = await fetchClinePassQuota({ env: {}, fetch: neverFetch, readFile: async () => file, now: () => NOW })
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.footerLines).toEqual(['Cline sign-in expired. Run cline to refresh it.'])
  })

  it('reads a rejected session token as an expired sign-in', async () => {
    const file = providersFile({ auth: { accessToken: 'workos:revoked' } })
    const result = await fetchClinePassQuota({
      env: {}, readFile: async () => file, now: () => NOW,
      fetch: (async () => jsonResponse({}, 401)) as unknown as typeof fetch,
    })
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.footerLines).toEqual(['Cline sign-in expired. Run cline to refresh it.'])
  })
})

describe('ClinePass quota decoding', () => {
  it('maps the five-hour, weekly and monthly windows in that order', () => {
    const quota = decodeClinePassUsage(successBody)
    expect(quota?.connection).toBe('connected')
    expect(quota?.details.map(row => row.label)).toEqual(['5-hour', 'Weekly', 'Monthly'])
    expect(quota?.details.map(row => row.percent)).toEqual([0.135, 0.42, 0.07])
    expect(quota?.primary).toEqual({ label: 'Weekly', percent: 0.42, resetsAt: '2026-09-05T00:00:00.000Z' })
    expect(quota?.planLabel).toBeNull()
  })

  it('accepts a window with no reset stamp and skips an unknown window type', () => {
    const quota = decodeClinePassUsage({
      success: true,
      data: { limits: [{ type: 'five_hour', percentUsed: 50, resetsAt: null }, { type: 'yearly', percentUsed: 1 }] },
    })
    expect(quota?.details).toEqual([{ label: '5-hour', percent: 0.5, resetsAt: null }])
    expect(quota?.primary?.label).toBe('5-hour')
  })

  it('rejects a malformed or unsuccessful payload', () => {
    expect(decodeClinePassUsage({ data: { limits: [] } })).toBeNull()
    expect(decodeClinePassUsage({ success: false, data: { limits: [] } })).toBeNull()
    expect(decodeClinePassUsage({ success: true })).toBeNull()
    expect(decodeClinePassUsage({ success: true, data: {} })).toBeNull()
    expect(decodeClinePassUsage({ success: true, data: { limits: [] } })).toBeNull()
    expect(decodeClinePassUsage({ success: true, data: { limits: [{ type: 'weekly' }] } })).toBeNull()
    expect(decodeClinePassUsage({ success: true, data: { limits: [{ type: 'weekly', percentUsed: 5, resetsAt: 'soon' }] } })).toBeNull()
  })
})

describe('ClinePass quota fetch', () => {
  it('sends the key as a bearer to the published endpoint', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const result = await fetchClinePassQuota({
      env: { CLINEPASS_API_KEY: SYNTHETIC_KEY },
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> })
        return jsonResponse(successBody)
      }) as unknown as typeof fetch,
    })

    expect(result.quota.connection).toBe('connected')
    expect(seen[0]!.url).toBe('https://api.cline.bot/api/v1/users/me/plan/usage-limits')
    expect(seen[0]!.headers['Authorization']).toBe(`Bearer ${SYNTHETIC_KEY}`)
  })

  it('maps the HTTP failures the way the menubar classifies them', async () => {
    const respond = async (status: number, headers: Record<string, string> = {}) => fetchClinePassQuota({
      env: { CLINEPASS_API_KEY: SYNTHETIC_KEY },
      fetch: (async () => jsonResponse({}, status, headers)) as unknown as typeof fetch,
    })

    expect((await respond(401)).quota.connection).toBe('terminalFailure')
    expect((await respond(403)).quota.footerLines).toEqual(['ClinePass rejected this API key.'])
    const limited = await respond(429, { 'Retry-After': '200' })
    expect(limited.quota.rateLimited).toBe(true)
    expect(limited.retryAfterSeconds).toBe(200)
    expect((await respond(503)).quota.footerLines).toEqual(['ClinePass is temporarily unavailable.'])
    expect((await respond(404)).quota.footerLines).toEqual(['ClinePass quota response was malformed.'])
    expect((await respond(200)).quota.footerLines).toEqual(['ClinePass quota response was malformed.'])
  })
})
