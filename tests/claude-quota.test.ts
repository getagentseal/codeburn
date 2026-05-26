import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  resetClaudeCredentialHooks,
  setClaudeCredentialHooks,
} from '../src/claude-credentials.js'
import {
  ClaudeQuotaError,
  classifyTier,
  fetchClaudeQuota,
  quotaToJSON,
  resetClaudeQuotaHooks,
  setClaudeQuotaHooks,
  tierDisplayName,
} from '../src/claude-quota.js'

let tmp: string
const originalCacheDir = process.env['CODEBURN_CACHE_DIR']

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'codeburn-claude-quota-'))
  process.env['CODEBURN_CACHE_DIR'] = tmp
  resetClaudeCredentialHooks()
  resetClaudeQuotaHooks()
})

afterEach(async () => {
  resetClaudeCredentialHooks()
  resetClaudeQuotaHooks()
  if (originalCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCacheDir
  await rm(tmp, { recursive: true, force: true })
})

async function seedConnectedCredentials(tier: string | null): Promise<void> {
  await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
    accessToken: 'live',
    refreshToken: 'ref',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    rateLimitTier: tier,
  }))
}

describe('classifyTier', () => {
  it('maps Anthropic raw tier identifiers to the display enum', () => {
    expect(classifyTier('max_20x')).toBe('max_20x')
    expect(classifyTier('max-5x')).toBe('max_5x')
    expect(classifyTier('claude_pro')).toBe('pro')
    expect(classifyTier('team_seat')).toBe('team')
    expect(classifyTier('enterprise_org')).toBe('enterprise')
    expect(classifyTier(null)).toBe('unknown')
    expect(classifyTier('something_else')).toBe('unknown')
  })

  it('renders human display names', () => {
    expect(tierDisplayName('max_20x')).toBe('Max 20x')
    expect(tierDisplayName('max_5x')).toBe('Max 5x')
    expect(tierDisplayName('unknown')).toBe('Subscription')
  })
})

describe('fetchClaudeQuota', () => {
  it('returns null when no credentials are present', async () => {
    setClaudeCredentialHooks({
      readClaudeFile: async () => null,
      readMacKeychain: async () => null,
    })
    const result = await fetchClaudeQuota()
    expect(result).toBeNull()
  })

  it('maps a 200 response into the SubscriptionQuota shape', async () => {
    await seedConnectedCredentials('max_20x')
    setClaudeQuotaHooks({
      fetchUsage: async (token: string) => {
        expect(token).toBe('live')
        return {
          status: 200,
          body: JSON.stringify({
            five_hour: { utilization: 2.0, resets_at: '2026-05-26T15:00:00.000Z' },
            seven_day: { utilization: 89.0, resets_at: '2026-05-30T00:00:00Z' },
            seven_day_opus: { utilization: 0.0, resets_at: null },
            seven_day_sonnet: null,
          }),
        }
      },
    })
    const quota = await fetchClaudeQuota()
    expect(quota).not.toBeNull()
    expect(quota?.tier).toBe('max_20x')
    expect(quota?.fiveHour?.utilization).toBeCloseTo(2.0)
    expect(quota?.fiveHour?.resetsAt?.toISOString()).toBe('2026-05-26T15:00:00.000Z')
    expect(quota?.sevenDay?.utilization).toBeCloseTo(89.0)
    expect(quota?.sevenDayOpus?.resetsAt).toBeNull()
    expect(quota?.sevenDaySonnet).toBeNull()
  })

  it('records the 429 backoff window so the next call short-circuits', async () => {
    await seedConnectedCredentials('pro')
    let calls = 0
    setClaudeQuotaHooks({
      fetchUsage: async () => {
        calls++
        return { status: 429, body: JSON.stringify({ retry_after: 120 }) }
      },
    })
    await expect(fetchClaudeQuota()).rejects.toBeInstanceOf(ClaudeQuotaError)
    const persisted = JSON.parse(await readFile(join(tmp, 'claude-quota-backoff.json'), 'utf-8'))
    expect(typeof persisted.until).toBe('string')
    const until = new Date(persisted.until).getTime()
    expect(until - Date.now()).toBeGreaterThan(110 * 1000)

    await expect(fetchClaudeQuota()).rejects.toMatchObject({ code: 'rate_limited' })
    expect(calls).toBe(1)
  })

  it('floors retry_after to at least 60 seconds when the server returns a tiny window', async () => {
    await seedConnectedCredentials('pro')
    setClaudeQuotaHooks({
      fetchUsage: async () => ({ status: 429, body: JSON.stringify({ retry_after: 5 }) }),
    })
    await expect(fetchClaudeQuota()).rejects.toBeInstanceOf(ClaudeQuotaError)
    const persisted = JSON.parse(await readFile(join(tmp, 'claude-quota-backoff.json'), 'utf-8'))
    const until = new Date(persisted.until).getTime()
    expect(until - Date.now()).toBeGreaterThanOrEqual(60 * 1000 - 5)
  })

  it('retries once on 401 after a credential refresh and clears the backoff on success', async () => {
    await seedConnectedCredentials('pro')
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: 'rotated', refresh_token: 'r2', expires_in: 3600 }),
      }),
    })
    await writeFile(join(tmp, 'claude-quota-backoff.json'), JSON.stringify({ until: new Date(Date.now() - 60_000).toISOString() }))
    const tokens: string[] = []
    let call = 0
    setClaudeQuotaHooks({
      fetchUsage: async (token: string) => {
        tokens.push(token)
        call++
        if (call === 1) return { status: 401, body: '{}' }
        return {
          status: 200,
          body: JSON.stringify({
            five_hour: { utilization: 10.0, resets_at: '2026-05-26T15:00:00Z' },
          }),
        }
      },
    })
    const quota = await fetchClaudeQuota()
    expect(quota?.fiveHour?.utilization).toBeCloseTo(10.0)
    expect(tokens[0]).toBe('live')
    expect(tokens[1]).toBe('rotated')
    const backoff = JSON.parse(await readFile(join(tmp, 'claude-quota-backoff.json'), 'utf-8'))
    expect(backoff.until).toBeNull()
  })

  it('throws http error code on non-200/401/429', async () => {
    await seedConnectedCredentials('pro')
    setClaudeQuotaHooks({
      fetchUsage: async () => ({ status: 503, body: 'upstream down' }),
    })
    try {
      await fetchClaudeQuota()
      expect.fail('should have thrown')
    } catch (err) {
      const e = err as ClaudeQuotaError
      expect(e.code).toBe('http')
      expect(e.httpStatus).toBe(503)
    }
  })

  it('classifies decode failures as decode errors', async () => {
    await seedConnectedCredentials('pro')
    setClaudeQuotaHooks({
      fetchUsage: async () => ({ status: 200, body: 'not json' }),
    })
    try {
      await fetchClaudeQuota()
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as ClaudeQuotaError).code).toBe('decode')
    }
  })
})

describe('Retry-After handling', () => {
  it('prefers the HTTP Retry-After header over a JSON body retry_after', async () => {
    await seedConnectedCredentials('pro')
    setClaudeQuotaHooks({
      fetchUsage: async () => ({
        status: 429,
        body: JSON.stringify({ retry_after: 5 }),
        retryAfterHeader: '900',
      }),
    })
    await expect(fetchClaudeQuota()).rejects.toBeInstanceOf(ClaudeQuotaError)
    const persisted = JSON.parse(await readFile(join(tmp, 'claude-quota-backoff.json'), 'utf-8'))
    const until = new Date(persisted.until).getTime()
    expect(until - Date.now()).toBeGreaterThan(800 * 1000)
  })

  it('parses HTTP-date Retry-After values', async () => {
    await seedConnectedCredentials('pro')
    const future = new Date(Date.now() + 600 * 1000)
    setClaudeQuotaHooks({
      fetchUsage: async () => ({
        status: 429,
        body: '',
        retryAfterHeader: future.toUTCString(),
      }),
    })
    await expect(fetchClaudeQuota()).rejects.toBeInstanceOf(ClaudeQuotaError)
    const persisted = JSON.parse(await readFile(join(tmp, 'claude-quota-backoff.json'), 'utf-8'))
    const until = new Date(persisted.until).getTime()
    expect(until - Date.now()).toBeGreaterThan(500 * 1000)
  })
})

describe('401 after refresh', () => {
  it('treats a second 401 as terminal so the caller stops looping', async () => {
    await seedConnectedCredentials('pro')
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: 'still-bad', refresh_token: 'r2', expires_in: 3600 }),
      }),
    })
    let call = 0
    setClaudeQuotaHooks({
      fetchUsage: async () => {
        call++
        return { status: 401, body: '' }
      },
    })
    try {
      await fetchClaudeQuota()
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as ClaudeQuotaError).code).toBe('credential_terminal')
      expect(call).toBe(2)
    }
  })
})

describe('quotaToJSON', () => {
  it('serialises percent and ISO reset timestamps', () => {
    const json = quotaToJSON({
      tier: 'max_20x',
      rawTier: 'max_20x',
      fiveHour: { utilization: 42, resetsAt: new Date('2026-05-26T15:00:00.000Z') },
      sevenDay: { utilization: 105, resetsAt: null },
      sevenDayOpus: null,
      sevenDaySonnet: null,
      fetchedAt: new Date('2026-05-26T12:34:56.000Z'),
    })
    expect(json.tier).toBe('max_20x')
    expect(json.fiveHour?.percent).toBeCloseTo(42)
    expect(json.fiveHour?.resetsAt).toBe('2026-05-26T15:00:00.000Z')
    expect(json.sevenDay?.percent).toBeCloseTo(105)
    expect(json.sevenDay?.resetsAt).toBeNull()
    expect(json.sevenDayOpus).toBeNull()
    expect(json.fetchedAt).toBe('2026-05-26T12:34:56.000Z')
  })
})
