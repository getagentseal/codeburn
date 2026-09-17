// Fixture-driven coverage for the Grok Bot quota adapter. Every test drives a
// stub token loader and a mocked fetch; none of them reads the operator's real
// Cursor session or touches the network.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { decodeGrokbotUsage, fetchGrokbotQuota, grokbotInstalled } from '../src/quota/grokbot.js'
import { availableReaders } from '../src/quota/index.js'

const neverFetch = (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch
const withToken = async () => 'cursor-access-token'

// The field names and value shapes of a real GetSandUsageStatus response.
const successBody = {
  currentPeriodStart: '2026-09-13T14:56:21.487Z',
  nextResetTimestampUtc: '2026-09-20T14:56:21.487Z',
  usagePercent: 98.294066,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('decodeGrokbotUsage', () => {
  it('reads one weekly window from the percentage and the reset stamp', () => {
    const quota = decodeGrokbotUsage(successBody)
    expect(quota).toMatchObject({ provider: 'grokbot', connection: 'connected', planLabel: null })
    expect(typeof quota === 'object' && quota?.primary).toEqual({
      label: 'Weekly usage',
      percent: 0.98294066,
      resetsAt: '2026-09-20T14:56:21.487Z',
    })
  })

  it('clamps a percentage past the limit instead of overflowing the bar', () => {
    const quota = decodeGrokbotUsage({ ...successBody, usagePercent: 140 })
    expect(typeof quota === 'object' && quota?.primary?.percent).toBe(1)
  })

  it('carries the plan label when the build sends one', () => {
    const quota = decodeGrokbotUsage({ ...successBody, grokPlanLabel: 'Pro+' })
    expect(typeof quota === 'object' && quota?.planLabel).toBe('Pro+')
  })

  it('refuses the readings the app itself refuses', () => {
    expect(decodeGrokbotUsage({ ...successBody, usesPooledEnterpriseAllowance: true })).toBe('pooled')
    expect(decodeGrokbotUsage({ ...successBody, hasNonZeroIncludedLimit: false })).toBe('noAllowance')
  })

  it('returns null for a body with no usable percentage', () => {
    expect(decodeGrokbotUsage({ ...successBody, usagePercent: 'a lot' })).toBeNull()
    expect(decodeGrokbotUsage({ ...successBody, usagePercent: -1 })).toBeNull()
    expect(decodeGrokbotUsage({})).toBeNull()
    expect(decodeGrokbotUsage(null)).toBeNull()
  })

  it('keeps the window when the reset stamp is missing or unparseable', () => {
    const quota = decodeGrokbotUsage({ usagePercent: 12, nextResetTimestampUtc: 'soon' })
    expect(typeof quota === 'object' && quota?.primary).toEqual({ label: 'Weekly usage', percent: 0.12, resetsAt: null })
  })
})

describe('fetchGrokbotQuota', () => {
  it('posts an empty Connect body with the Cursor token as a bearer', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(successBody))
    const { quota } = await fetchGrokbotQuota({
      fetch: fetchMock as unknown as typeof fetch,
      databasePath: '/nowhere/state.vscdb',
      loadAccessToken: withToken,
    })

    expect(quota.connection).toBe('connected')
    expect(quota.primary?.percent).toBeCloseTo(0.98294066, 8)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer cursor-access-token')
    expect((init.headers as Record<string, string>)['connect-protocol-version']).toBe('1')
  })

  it('reports a signed-out Cursor app without making a request', async () => {
    const { quota } = await fetchGrokbotQuota({
      fetch: neverFetch,
      databasePath: '/nowhere/state.vscdb',
      loadAccessToken: async () => null,
    })
    expect(quota.connection).toBe('disconnected')
    expect(quota.footerLines[0]).toContain('Sign in to the Cursor app')
    expect(quota.primary).toBeNull()
  })

  it('treats a rejected session as terminal', async () => {
    for (const status of [401, 403]) {
      const { quota } = await fetchGrokbotQuota({
        fetch: (async () => jsonResponse({ error: 'unauthenticated' }, status)) as unknown as typeof fetch,
        databasePath: '/nowhere/state.vscdb',
        loadAccessToken: withToken,
      })
      expect(quota.connection).toBe('terminalFailure')
      expect(quota.footerLines[0]).toContain('Sign in again')
    }
  })

  it('treats a malformed body as a transient failure, not an empty account', async () => {
    const { quota } = await fetchGrokbotQuota({
      fetch: (async () => new Response('not json at all', { status: 200 })) as unknown as typeof fetch,
      databasePath: '/nowhere/state.vscdb',
      loadAccessToken: withToken,
    })
    expect(quota.connection).toBe('transientFailure')
    expect(quota.primary).toBeNull()
  })

  it('reports a body without a percentage as unrecognized', async () => {
    const { quota } = await fetchGrokbotQuota({
      fetch: (async () => jsonResponse({ hasAvailableUsage: true })) as unknown as typeof fetch,
      databasePath: '/nowhere/state.vscdb',
      loadAccessToken: withToken,
    })
    expect(quota.connection).toBe('transientFailure')
    expect(quota.footerLines[0]).toContain('unrecognized')
  })

  it('backs off on a rate limit and honours Retry-After', async () => {
    const { quota, retryAfterSeconds } = await fetchGrokbotQuota({
      fetch: (async () => jsonResponse({}, 429, { 'Retry-After': '120' })) as unknown as typeof fetch,
      databasePath: '/nowhere/state.vscdb',
      loadAccessToken: withToken,
    })
    expect(quota.rateLimited).toBe(true)
    expect(retryAfterSeconds).toBe(120)
  })

  it('reports an account with no per-account reading as terminal, not signed out', async () => {
    for (const [body, expected] of [
      [{ ...successBody, usesPooledEnterpriseAllowance: true }, 'pooled enterprise allowance'],
      [{ ...successBody, hasNonZeroIncludedLimit: false }, 'no included Grok Bot allowance'],
    ] as const) {
      const { quota } = await fetchGrokbotQuota({
        fetch: (async () => jsonResponse(body)) as unknown as typeof fetch,
        databasePath: '/nowhere/state.vscdb',
        loadAccessToken: withToken,
      })
      expect(quota.connection).toBe('terminalFailure')
      expect(quota.footerLines[0]).toContain(expected)
      expect(quota.primary).toBeNull()
    }
  })

  it('reports a database it cannot read as transient, never as signed out', async () => {
    const { quota } = await fetchGrokbotQuota({
      fetch: neverFetch,
      databasePath: '/nowhere/state.vscdb',
      loadAccessToken: async () => { throw new Error('database is locked') },
    })
    expect(quota.connection).toBe('transientFailure')
    expect(quota.footerLines[0]).toContain('Quit and reopen Cursor')
  })
})

describe('grokbotInstalled', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'grokbot-home-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('accepts either Applications bundle or the data root', () => {
    const applications = path.join(home, 'SystemApplications')
    const installed = (platform: string) => grokbotInstalled(platform, home, applications)
    expect(installed('darwin')).toBe(false)
    expect(installed('linux')).toBe(false)

    mkdirSync(path.join(applications, 'Grok Bot.app'), { recursive: true })
    expect(installed('darwin')).toBe(true)
    // Only macOS ships an .app bundle, so the data root is the marker elsewhere.
    expect(installed('linux')).toBe(false)

    mkdirSync(path.join(home, 'Applications', 'Grok Bot.app'), { recursive: true })
    expect(installed('darwin')).toBe(true)

    mkdirSync(path.join(home, '.grokbot'))
    expect(installed('linux')).toBe(true)
  })

  it('leaves Grok Bot out of the quota run when the app is absent', () => {
    expect(availableReaders(() => false).map(entry => entry.id)).not.toContain('grokbot')
    expect(availableReaders(() => true).map(entry => entry.id)).toContain('grokbot')
  })
})
