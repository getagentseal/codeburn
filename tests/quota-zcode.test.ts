// Fixture-driven coverage for the ZCode quota adapter (the z.ai coding-plan
// login the ZCode desktop app keeps in its coding-plan webview's Local Storage
// journal). Tokens are synthetic; no test reaches the network or a real login.
import { describe, expect, it, vi } from 'vitest'

import { decodeZcodeUsage, fetchZcodeQuota, zcodeAccessToken } from '../src/quota/zcode.js'
import type { ZcodeDeps } from '../src/quota/zcode.js'

const neverFetch = (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch
const TOKEN = 'eyJhbGciOiJIUzU1MiJ9.synthetic-zcode-login-with-no-meaning.sig'
const STORAGE_KEY = 'oauth:zai:access_token'

/** Shape and values mirror the recorded 200 response posted (redacted — it
 *  carries no account identity to begin with, only limits and the plan level)
 *  in the #1347 review thread. */
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

/** Byte-faithful to a recorded ZCode journal (redacted hexdump in the #1347
 *  review thread): the map key is the origin, a NUL, the 0x01 one-byte-string
 *  flag and the key name; the value frame is a varint length, the same 0x01
 *  flag, then the value's Latin-1 bytes. The gap bytes are copied from the
 *  recording — the real login is 1,403 bytes, whose length encodes as
 *  `fb 0a`, neither of which is a token character. That matters: the scanner
 *  reads the frame as key + non-token gap + token, so a length varint that
 *  collided with the token alphabet (only possible for a login under ~130
 *  bytes; the recorded HS512 JWT is ~1,400) could not be matched. */
function journalEntry(key: string, value: string): Buffer {
  return Buffer.concat([
    Buffer.from('https://zcode.z.ai', 'latin1'),
    Buffer.from([0x00, 0x01]),
    Buffer.from(key, 'latin1'),
    Buffer.from([0xfb, 0x0a]),
    Buffer.from([0x01]),
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('ZCode credential discovery', () => {
  it('reads the login out of the newest Local Storage journal', async () => {
    const base = deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) })
    await expect(zcodeAccessToken(base)).resolves.toBe(TOKEN)
  })

  it('keeps the most recent write when the key was rotated in place', async () => {
    const journal = Buffer.concat([
      journalEntry(STORAGE_KEY, TOKEN),
      journalEntry(STORAGE_KEY, 'eyJhbGciOiJIUzU1MiJ9.synthetic-zcode-renewal-with-no-meaning.sig'),
    ])
    await expect(zcodeAccessToken(deps({ '000003.log': journal }))).resolves.toBe('eyJhbGciOiJIUzU1MiJ9.synthetic-zcode-renewal-with-no-meaning.sig')
  })

  it('reports no token when the storage directory is missing', async () => {
    const base = deps({})
    base.readDir = vi.fn(async () => { throw new Error('ENOENT') })
    await expect(zcodeAccessToken(base)).resolves.toBeNull()
  })
})

describe('ZCode quota decoding', () => {
  it('maps the credit windows with the plan level', () => {
    const quota = decodeZcodeUsage(successBody)
    expect(quota).not.toBe('rejected')
    if (quota === null || quota === 'rejected') throw new Error('expected a decoded provider')
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Pro')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(quota.primary).toEqual({ label: 'Weekly', percent: 0.03, resetsAt: '2026-09-20T10:13:47.973Z' })
    expect(quota.footerLines).toEqual(['Source: Z.ai Coding Plan'])
  })

  it('still reads string-typed token windows and derives the percentage', () => {
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
  })
})

describe('ZCode HTTP failures', () => {
  it('reports disconnected with no login anywhere and never fetches', async () => {
    const result = await fetchZcodeQuota({ ...deps({}), fetch: neverFetch })
    expect(result.quota.connection).toBe('disconnected')
  })

  it('keeps the terminal and retryable classifications', async () => {
    const respond = async (status: number, headers: Record<string, string> = {}) => fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: (async () => jsonResponse({}, status, headers)) as unknown as typeof fetch,
    })

    expect((await respond(401)).quota.footerLines).toEqual(['Login expired. Open the ZCode app and sign in again, then refresh.'])
    const limited = await respond(429, { 'Retry-After': '90' })
    expect(limited.quota.rateLimited).toBe(true)
    expect(limited.retryAfterSeconds).toBe(90)
    expect((await respond(503)).quota.footerLines).toEqual(['Z.ai is temporarily unavailable.'])
    expect((await respond(404)).quota.footerLines).toEqual(['Z.ai returned an unrecognized quota response.'])
  })

  it('turns a body-level authentication failure into a terminal state', async () => {
    const result = await fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: (async () => jsonResponse({ code: 401, success: false })) as unknown as typeof fetch,
    })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines).toEqual(['Login expired. Open the ZCode app and sign in again, then refresh.'])
  })

  it('sends the journal token as a bearer to the usage endpoint', async () => {
    const seen: Record<string, string>[] = []
    const result = await fetchZcodeQuota({
      ...deps({ '000003.log': journalEntry(STORAGE_KEY, TOKEN) }),
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe('https://api.z.ai/api/monitor/usage/quota/limit')
        seen.push(init.headers as Record<string, string>)
        return jsonResponse(successBody)
      }) as unknown as typeof fetch,
    })
    expect(result.quota.connection).toBe('connected')
    expect(seen[0]!['Authorization']).toBe(`Bearer ${TOKEN}`)
  })
})
