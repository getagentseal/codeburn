import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { cursorDatabasePath, decodeGrokbotUsage, fetchGrokbotQuota, grokbotInstalled } from './grokbot'

// The live response shape, captured from the account the app itself reads.
const liveBody = {
  currentPeriodStart: '2026-09-13T14:56:21.487Z',
  nextResetTimestampUtc: '2026-09-20T14:56:21.487Z',
  usagePercent: 98.542043,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
  grokPlanLabel: 'Grok Bot Plan',
}

const okJson = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
const deps = (fetchImpl: typeof fetch, token: string | null = 'synthetic-cursor-token') => ({
  fetch: fetchImpl,
  databasePath: '/mock/state.vscdb',
  loadAccessToken: vi.fn(async () => token),
})

describe('Grok Bot usage decode', () => {
  it('decodes the weekly window, plan label and reset stamp', () => {
    const quota = decodeGrokbotUsage(liveBody)
    expect(quota).not.toBe(null)
    if (quota === null || typeof quota === 'string') throw new Error('expected a quota')
    expect(quota.connection).toBe('connected')
    expect(quota.primary?.label).toBe('Weekly usage')
    expect(quota.primary?.percent).toBeCloseTo(0.98542043, 8)
    expect(quota.primary?.resetsAt).toBe('2026-09-20T14:56:21.487Z')
    expect(quota.planLabel).toBe('Grok Bot Plan')
    expect(quota.footerLines).toEqual(['Source: Cursor dashboard (the account the Cursor app is signed into)'])
  })

  it('reports no reading rather than a zero it cannot stand behind', () => {
    expect(decodeGrokbotUsage({ ...liveBody, usagePercent: undefined })).toBe(null)
    expect(decodeGrokbotUsage({ ...liveBody, hasNonZeroIncludedLimit: false })).toBe('noAllowance')
    expect(decodeGrokbotUsage({ ...liveBody, usesPooledEnterpriseAllowance: true })).toBe('pooled')
    expect(decodeGrokbotUsage('not an object')).toBe(null)
  })
})

describe('Grok Bot quota fetch', () => {
  it('posts an empty Connect body with the Cursor bearer', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const { quota } = await fetchGrokbotQuota(deps(fetchMock))
    expect(quota.connection).toBe('connected')
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    expect(init.headers.Authorization).toBe('Bearer synthetic-cursor-token')
    expect(init.headers['connect-protocol-version']).toBe('1')
  })

  it('reports the signed-out state when Cursor holds no session', async () => {
    const fetchMock = vi.fn(async () => okJson(liveBody)) as unknown as typeof fetch
    const { quota } = await fetchGrokbotQuota(deps(fetchMock, null))
    expect(quota.connection).toBe('disconnected')
    expect(quota.footerLines[0]).toContain('Sign in to the Cursor app')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a rejected session as terminal and a malformed body as retryable', async () => {
    const rejected = await fetchGrokbotQuota(deps((async () => new Response('', { status: 401 })) as unknown as typeof fetch))
    expect(rejected.quota.connection).toBe('terminalFailure')

    const malformed = await fetchGrokbotQuota(deps((async () => new Response('not json', { status: 200 })) as unknown as typeof fetch))
    expect(malformed.quota.connection).toBe('transientFailure')
  })

  it('reports an account with no per-account reading as terminal, not signed out', async () => {
    for (const [body, expected] of [
      [{ ...liveBody, usesPooledEnterpriseAllowance: true }, 'pooled enterprise allowance'],
      [{ ...liveBody, hasNonZeroIncludedLimit: false }, 'no included Grok Bot allowance'],
    ] as const) {
      const { quota } = await fetchGrokbotQuota(deps((async () => okJson(body)) as unknown as typeof fetch))
      expect(quota.connection).toBe('terminalFailure')
      expect(quota.footerLines[0]).toContain(expected)
    }
  })

  it('backs off on a 429 with the served Retry-After', async () => {
    const response = new Response('', { status: 429, headers: { 'Retry-After': '900' } })
    const result = await fetchGrokbotQuota(deps((async () => response) as unknown as typeof fetch))
    expect(result.quota.rateLimited).toBe(true)
    expect(result.retryAfterSeconds).toBe(900)
  })
})

describe('Grok Bot install detection', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'grokbot-home-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('accepts either Applications bundle or the data root', () => {
    const applications = path.join(home, 'SystemApplications')
    const installed = (platform: string) => grokbotInstalled(platform, home, applications)
    expect(installed('darwin')).toBe(false)
    expect(installed('linux')).toBe(false)

    mkdirSync(path.join(home, 'Applications', 'Grok Bot.app'), { recursive: true })
    expect(installed('darwin')).toBe(true)
    // Only macOS ships an .app bundle, so the data root is the marker elsewhere.
    expect(installed('linux')).toBe(false)

    mkdirSync(path.join(applications, 'Grok Bot.app'), { recursive: true })
    expect(installed('darwin')).toBe(true)

    mkdirSync(path.join(home, '.grokbot'))
    expect(installed('linux')).toBe(true)
  })

  it('follows the VS Code state layout for the Cursor session', () => {
    expect(cursorDatabasePath('darwin', '/h')).toBe('/h/Library/Application Support/Cursor/User/globalStorage/state.vscdb')
    expect(cursorDatabasePath('win32', '/h')).toBe('/h/AppData/Roaming/Cursor/User/globalStorage/state.vscdb')
    expect(cursorDatabasePath('linux', '/h')).toBe('/h/.config/Cursor/User/globalStorage/state.vscdb')
  })
})
