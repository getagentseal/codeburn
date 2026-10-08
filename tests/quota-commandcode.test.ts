// Fixture-driven coverage for the Command Code quota adapter. The key is
// synthetic and every request goes through the injected fetch.
import { describe, expect, it } from 'vitest'

import { commandCodePlanLabel, decodeCommandCodeCredits, fetchCommandCodeQuota } from '../src/quota/commandcode.js'

const neverFetch = (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch
const AUTH = JSON.stringify({ apiKey: 'synthetic-commandcode-key', userName: 'someone' })
const RESET_MS = 1_791_653_049_551

const creditsBody = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 3.9706645399, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: 'weekly',
    fiveHour: { used: 0.75, cap: 3, exceeded: false, resetAt: 0 },
    weekly: { used: 6.0293354601, cap: 6, exceeded: true, resetAt: RESET_MS },
  },
}
const subscriptionBody = { success: true, data: { status: 'active', planId: 'individual-go-v1', currentPeriodEnd: '2026-11-01T10:38:29.000Z' } }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Command Code quota decoding', () => {
  it('maps the 5-hour and weekly windows as used of cap, clamped', () => {
    const quota = decodeCommandCodeCredits(creditsBody, 'individual-go-v1')
    expect(quota?.connection).toBe('connected')
    expect(quota?.details).toEqual([
      { label: '5-hour', percent: 0.25, resetsAt: null },
      { label: 'Weekly', percent: 1, resetsAt: new Date(RESET_MS).toISOString() },
    ])
    expect(quota?.primary?.label).toBe('Weekly')
    expect(quota?.planLabel).toBe('Go')
    expect(quota?.notes).toEqual(['Credits left: $3.97 monthly'])
  })

  it('skips an unreadable window and rejects a body with none', () => {
    const quota = decodeCommandCodeCredits({ windowLimits: { fiveHour: { used: 1, cap: 0 }, weekly: { used: 3, cap: 6, resetAt: 0 } } })
    expect(quota?.details).toEqual([{ label: 'Weekly', percent: 0.5, resetsAt: null }])
    expect(quota?.notes).toBeUndefined()
    expect(decodeCommandCodeCredits({ windowLimits: {} })).toBeNull()
    expect(decodeCommandCodeCredits({ credits: {} })).toBeNull()
    expect(decodeCommandCodeCredits(null)).toBeNull()
  })

  it('labels plans from their id', () => {
    expect(commandCodePlanLabel('individual-pro-v1')).toBe('Pro')
    expect(commandCodePlanLabel('team-max')).toBe('Team-max')
    expect(commandCodePlanLabel('')).toBeNull()
    expect(commandCodePlanLabel(undefined)).toBeNull()
  })
})

describe('Command Code quota fetch', () => {
  it('is disconnected without an auth file and never fetches', async () => {
    const result = await fetchCommandCodeQuota({ authPath: '/nope', readFile: async () => null, fetch: neverFetch })
    expect(result.quota.connection).toBe('disconnected')
  })

  it('sends the key as a bearer with a User-Agent to both billing endpoints', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const result = await fetchCommandCodeQuota({
      authPath: '/auth.json', readFile: async () => AUTH,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> })
        return jsonResponse(url.endsWith('/credits') ? creditsBody : subscriptionBody)
      }) as unknown as typeof fetch,
    })
    expect(result.quota.connection).toBe('connected')
    expect(result.quota.planLabel).toBe('Go')
    expect(seen.map(row => row.url).sort()).toEqual([
      'https://api.commandcode.ai/alpha/billing/credits',
      'https://api.commandcode.ai/alpha/billing/subscriptions',
    ])
    for (const row of seen) {
      expect(row.headers['Authorization']).toBe('Bearer synthetic-commandcode-key')
      expect(row.headers['User-Agent']).toBe('CodeBurn')
    }
  })

  it('keeps the windows when only the subscription call fails', async () => {
    const result = await fetchCommandCodeQuota({
      authPath: '/auth.json', readFile: async () => AUTH,
      fetch: (async (url: string) => url.endsWith('/credits') ? jsonResponse(creditsBody) : jsonResponse({}, 500)) as unknown as typeof fetch,
    })
    expect(result.quota.connection).toBe('connected')
    expect(result.quota.planLabel).toBeNull()
  })

  it('maps HTTP failures', async () => {
    const respond = (status: number) => fetchCommandCodeQuota({
      authPath: '/auth.json', readFile: async () => AUTH,
      fetch: (async () => jsonResponse({}, status)) as unknown as typeof fetch,
    })
    const expired = await respond(401)
    expect(expired.quota.connection).toBe('terminalFailure')
    expect(expired.quota.footerLines).toEqual(['Command Code session expired. Sign in with the Command Code CLI again.'])
    expect((await respond(429)).quota.rateLimited).toBe(true)
    expect((await respond(503)).quota.connection).toBe('transientFailure')
    expect((await respond(200)).quota.footerLines).toEqual(['Command Code quota response was malformed.'])
  })

  it('treats a network error as transient', async () => {
    const result = await fetchCommandCodeQuota({
      authPath: '/auth.json', readFile: async () => AUTH,
      fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    expect(result.quota.connection).toBe('transientFailure')
  })
})
