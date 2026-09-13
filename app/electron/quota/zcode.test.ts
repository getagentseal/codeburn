import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeZcodeUsage, fetchZcodeQuota, zcodeAccessToken } from './zcode'
import type { ZcodeDeps } from './zcode'

// Fixtures mirror the journal layout observed on ZCode 3.11.2: DOM strings sit
// in the leveldb journal as single-byte runs of `key + varint + 0x01 + value`.
const TOKEN = 'eyJhbGciOiJIUzU1MiJ9.synthetic-zcode-login-with-no-meaning.sig'
const RENEWED = 'eyJhbGciOiJIUzU1MiJ9.synthetic-zcode-renewal-with-no-meaning.sig'
const STORAGE_KEY = 'oauth:zai:access_token'

const successBody = {
  code: 200,
  data: {
    level: 'pro',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 1853, percentage: 15, nextResetTime: 1_789_312_697_938 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 1853, percentage: 3, nextResetTime: 1_789_899_227_973 },
    ],
  },
}

const okJson = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

function journalEntry(key: string, value: string): Buffer {
  return Buffer.concat([
    Buffer.from('META:https://z.ai', 'latin1'),
    Buffer.from(key, 'latin1'),
    Buffer.from([0xfb, 0x0a, 0x01]), // varint length + Chromium string marker
    Buffer.from(value, 'latin1'),
  ])
}

function deps(files: Record<string, Buffer | null>, dir = '/mock/leveldb'): ZcodeDeps {
  return {
    fetch: vi.fn(),
    storageDir: dir,
    readDir: vi.fn(async () => Object.keys(files)),
    readJournal: vi.fn(async (filePath: string) => files[filePath.slice(dir.length + 1)] ?? null),
    env: {},
  }
}

afterEach(() => vi.restoreAllMocks())

describe('ZCode journal credential', () => {
  it('reads the login token out of the Local Storage journal', async () => {
    const base = deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) })
    await expect(zcodeAccessToken(base)).resolves.toBe(TOKEN)
  })

  it('reads a UTF-16LE encoded entry as well', async () => {
    const entry = Buffer.concat([
      Buffer.from(STORAGE_KEY, 'utf16le'),
      Buffer.from([0x01, 0x00]), // Chromium string marker as UTF-16LE \u0001
      Buffer.from(TOKEN, 'utf16le'),
    ])
    await expect(zcodeAccessToken(deps({ '000003.log': entry }))).resolves.toBe(TOKEN)
  })

  it('keeps the most recent write when the key was rotated in place', async () => {
    const journal = Buffer.concat([journalEntry(STORAGE_KEY, TOKEN), journalEntry(STORAGE_KEY, RENEWED)])
    await expect(zcodeAccessToken(deps({ '000003.log': journal }))).resolves.toBe(RENEWED)
  })

  it('prefers the newest journal by name', async () => {
    const files = { '000003.log': journalEntry(STORAGE_KEY, TOKEN), '000005.log': journalEntry(STORAGE_KEY, RENEWED) }
    await expect(zcodeAccessToken(deps(files))).resolves.toBe(RENEWED)
  })

  it('ignores non-journal files and unreadable entries', async () => {
    await expect(zcodeAccessToken(deps({ 'LOCK': Buffer.alloc(8), 'MANIFEST-000003': Buffer.alloc(8), '000004.ldb': journalEntry(STORAGE_KEY, TOKEN) }))).resolves.toBeNull()
    await expect(zcodeAccessToken(deps({ '000003.log': null }))).resolves.toBeNull()
  })

  it('reports no token when the storage directory is missing', async () => {
    const base = deps({})
    base.readDir = vi.fn(async () => { throw new Error('ENOENT') })
    await expect(zcodeAccessToken(base)).resolves.toBeNull()
  })
})

describe('ZCode usage decode', () => {
  it('maps the metered credit windows with the plan level', () => {
    const quota = decodeZcodeUsage(successBody)
    expect(quota).not.toBe('rejected')
    if (quota === null || quota === 'rejected') throw new Error('expected a decoded provider')
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Pro')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(quota.details.map(row => row.percent)).toEqual([0.15, 0.03])
    expect(quota.primary).toEqual({ label: 'Weekly', percent: 0.03, resetsAt: '2026-09-20T10:13:47.973Z' })
    expect(quota.footerLines).toEqual(['Source: Z.ai Coding Plan'])
  })

  it('derives the percentage from currentValue/usage when absent, with string-typed fields', () => {
    const quota = decodeZcodeUsage({
      data: { limits: [{ type: 'TOKENS_LIMIT', unit: '3', number: '5', usage: '2000', currentValue: '500', nextResetTime: '1800000000' }] },
    })
    if (quota === null || quota === 'rejected') throw new Error('expected a decoded provider')
    expect(quota.details).toEqual([{ label: '5-hour', percent: 0.25, resetsAt: '2027-01-15T08:00:00.000Z' }])
  })

  it('reads an authentication code in the body as a rejection', () => {
    for (const code of [401, 403]) {
      expect(decodeZcodeUsage({ code, msg: 'token expired or incorrect', success: false })).toBe('rejected')
    }
  })

  it('rejects a payload with no usable window', () => {
    expect(decodeZcodeUsage({ code: 500, success: false })).toBeNull()
    expect(decodeZcodeUsage({ data: {} })).toBeNull()
    expect(decodeZcodeUsage({ data: { limits: [] } })).toBeNull()
    expect(decodeZcodeUsage({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5 }] } })).toBeNull()
    expect(decodeZcodeUsage({ data: { limits: [{ type: 'CREDIT_LIMIT', unit: 9, number: 2, percentage: 5 }] } })).toBeNull()
    expect(decodeZcodeUsage('garbage')).toBeNull()
  })
})

describe('ZCode quota fetch', () => {
  it('returns disconnected without a login and never fetches', async () => {
    const fetchMock = vi.fn()
    const result = await fetchZcodeQuota({ ...deps({}), fetch: fetchMock })
    expect(result.quota.connection).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the journal token as a bearer to the usage endpoint', async () => {
    const fetchMock = vi.fn(async () => okJson(successBody))
    const result = await fetchZcodeQuota({ ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }), fetch: fetchMock })
    expect(result.quota.connection).toBe('connected')
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Accept-Language': 'en-US,en',
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': 'CodeBurn',
    })
  })

  it('treats a rejected login as terminal with reopen guidance', async () => {
    for (const status of [401, 403]) {
      const result = await fetchZcodeQuota({
        ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
        fetch: vi.fn(async () => new Response('', { status })),
      })
      expect(result.quota.connection).toBe('terminalFailure')
      expect(result.quota.footerLines[0]).toMatch(/open the ZCode app/i)
    }
  })

  it('turns a body-level authentication failure into the same terminal state', async () => {
    const result = await fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: vi.fn(async () => okJson({ code: 401, success: false })),
    })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines).toEqual(['Login expired. Open the ZCode app and sign in again, then refresh.'])
  })

  it('uses the Retry-After header for 429 backoff', async () => {
    const result = await fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '75' } })),
    })
    expect(result.retryAfterSeconds).toBe(75)
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.rateLimited).toBe(true)
  })

  it('maps 5xx and other 4xx to transient failures with honest footers', async () => {
    const withStatus = async (status: number) => fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: vi.fn(async () => new Response('', { status })),
    })
    expect((await withStatus(503)).quota.footerLines).toEqual(['Z.ai is temporarily unavailable.'])
    expect((await withStatus(404)).quota.footerLines).toEqual(['Z.ai returned an unrecognized quota response.'])
    expect((await withStatus(503)).quota.connection).toBe('transientFailure')
  })

  it('degrades a malformed success body instead of crashing the panel', async () => {
    const result = await fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: vi.fn(async () => new Response('not json {', { status: 200 })),
    })
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.primary).toBeNull()
  })

  it('redacts tokens from diagnostics without surfacing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: vi.fn(async () => { throw new Error(`Bearer ${TOKEN}\0tail`) }),
    })
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toMatch(/synthetic-zcode/)
    expect(logged).toContain('[REDACTED]')
  })
})
