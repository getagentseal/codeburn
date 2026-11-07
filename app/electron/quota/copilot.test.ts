import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { copilotConfigDirs, decodeCopilotUsage, fetchCopilotQuota } from './copilot'

const hosts = JSON.stringify({ 'github.com': { user: 'octocat', oauth_token: 'gho_test-secret' } })
const usageBody = {
  copilot_plan: 'individual',
  quota_snapshots: {
    premium_interactions: { percent_remaining: 70 },
    chat: { percent_remaining: 100 },
  },
}

const okJson = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

afterEach(() => vi.restoreAllMocks())

describe('Copilot usage decode', () => {
  it('decodes remaining-percent snapshots into used windows with the plan label', () => {
    const quota = decodeCopilotUsage(usageBody)
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Individual')
    expect(quota.primary).toEqual({ label: 'Premium requests', percent: 0.3, resetsAt: null })
    expect(quota.details.map(row => row.label)).toEqual(['Premium requests', 'Chat'])
    expect(quota.details.map(row => row.percent)).toEqual([0.3, 0])
  })

  it('accepts camelCase spellings and promotes chat when premium is absent', () => {
    const quota = decodeCopilotUsage({
      copilotPlan: 'business',
      quotaSnapshots: { chat: { percentRemaining: 55 } },
    })
    expect(quota.planLabel).toBe('Business')
    expect(quota.primary?.label).toBe('Chat')
    expect(quota.primary?.percent).toBeCloseTo(0.45)
  })

  it('skips zero-entitlement and unlimited windows instead of showing 100% used', () => {
    const quota = decodeCopilotUsage({
      copilot_plan: 'individual',
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false },
        chat: { entitlement: 200, remaining: 190, percent_remaining: 95, unlimited: false },
        completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100, unlimited: true },
      },
    })
    expect(quota.details.map(row => row.label)).toEqual(['Chat'])
    expect(quota.primary?.label).toBe('Chat')
    expect(quota.primary?.percent).toBeCloseTo(0.05, 6)
  })

  it('survives a malformed payload without usable snapshots', () => {
    const quota = decodeCopilotUsage({ quota_snapshots: { chat: 'garbage' }, extra: true })
    expect(quota.connection).toBe('connected')
    expect(quota.primary).toBeNull()
    expect(quota.details).toEqual([])
  })

  it('title-cases unknown plan tiers', () => {
    expect(decodeCopilotUsage({ copilot_plan: 'for_educators' }).planLabel).toBe('Educators')
    expect(decodeCopilotUsage({ copilot_plan: 'some_future_tier' }).planLabel).toBe('Some Future Tier')
    expect(decodeCopilotUsage({}).planLabel).toBeNull()
  })
})

describe('Copilot quota fetch', () => {
  it('returns disconnected without credentials and never fetches', async () => {
    const fetchMock = vi.fn()
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async () => null) })
    expect(result.quota.connection).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads hosts.json first and uses exact plugin headers', async () => {
    const fetchMock = vi.fn(async () => okJson(usageBody))
    const result = await fetchCopilotQuota({
      fetch: fetchMock,
      readFile: vi.fn(async (path: string) => path.endsWith('hosts.json') ? hosts : JSON.stringify({ 'Some App': { oauth_token: 'gho_wrong' } })),
    })
    expect(result.quota.connection).toBe('connected')
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/copilot_internal/user')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      Authorization: 'token gho_test-secret',
      Accept: 'application/json',
      'Editor-Version': 'vscode/1.96.2',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'X-Github-Api-Version': '2025-04-01',
    })
  })

  it('falls back to apps.json when hosts.json has no token', async () => {
    const fetchMock = vi.fn(async () => okJson(usageBody))
    const result = await fetchCopilotQuota({
      fetch: fetchMock,
      readFile: vi.fn(async (path: string) => path.endsWith('apps.json') ? JSON.stringify({ 'Visual Studio Code': { oauth_token: 'ghu_apps-token' } }) : '{}'),
    })
    expect(result.quota.connection).toBe('connected')
    const init = (fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({ Authorization: 'token ghu_apps-token' })
  })

  it('re-reads once on a 401 and adopts a rotated token', async () => {
    let reads = 0
    const readFile = vi.fn(async () => {
      reads += 1
      return JSON.stringify({ 'github.com': { oauth_token: reads === 1 ? 'gho_stale' : 'gho_rotated' } })
    })
    const fetchMock = vi.fn(async (_url: string | URL | RequestInfo, init?: RequestInit) => (init?.headers as Record<string, string>).Authorization === 'token gho_rotated'
      ? okJson(usageBody)
      : new Response('', { status: 401 }))
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile })
    expect(result.quota.connection).toBe('connected')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stays transientFailure when a 401 leaves the stored token unchanged', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async () => hosts) })
    expect(result.quota.connection).toBe('transientFailure')
    // One probe only: re-reading found the same token, so a retry is pointless.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the Retry-After header for 429 backoff', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '75' } }))
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async () => hosts) })
    expect(result.retryAfterSeconds).toBe(75)
    expect(result.quota.connection).toBe('transientFailure')
  })

  it('maps 5xx to transientFailure and other 4xx to terminalFailure', async () => {
    const serverError = vi.fn(async () => new Response('', { status: 503 }))
    const bad = await fetchCopilotQuota({ fetch: serverError, readFile: vi.fn(async () => hosts) })
    expect(bad.quota.connection).toBe('transientFailure')
    const clientError = vi.fn(async () => new Response('', { status: 404 }))
    const worse = await fetchCopilotQuota({ fetch: clientError, readFile: vi.fn(async () => hosts) })
    expect(worse.quota.connection).toBe('terminalFailure')
  })

  it('degrades a malformed success body instead of crashing the panel', async () => {
    const fetchMock = vi.fn(async () => new Response('not json {', { status: 200 }))
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async () => hosts) })
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.primary).toBeNull()
  })

  it('sends a GitHub Enterprise Cloud token only to its own API host, never api.github.com', async () => {
    const fetchMock = vi.fn(async () => okJson(usageBody))
    const tenant = JSON.stringify({ 'acme.ghe.com': { oauth_token: 'gho_tenant' } })
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async (path: string) => path.endsWith('hosts.json') ? tenant : null) })
    expect(result.quota.connection).toBe('connected')
    expect(fetchMock.mock.calls.map(call => String((call as unknown[])[0]))).toEqual(['https://api.acme.ghe.com/copilot_internal/user'])
    expect(result.quota.footerLines).toEqual(['Source: api.acme.ghe.com'])
  })

  it('reads the host of an apps.json "<host>:<app id>" key', async () => {
    const fetchMock = vi.fn(async () => okJson(usageBody))
    const apps = JSON.stringify({ 'acme.ghe.com:Iv1.b507a08c87ecfe98': { oauth_token: 'gho_apps' } })
    await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async (path: string) => path.endsWith('apps.json') ? apps : null) })
    expect(fetchMock.mock.calls.map(call => String((call as unknown[])[0]))).toEqual(['https://api.acme.ghe.com/copilot_internal/user'])
  })

  it('fails naming an unsupported host and sends its token nowhere', async () => {
    const fetchMock = vi.fn(async () => okJson(usageBody))
    const server = JSON.stringify({ 'github.acme-corp.net': { oauth_token: 'gho_server' } })
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async (path: string) => path.endsWith('hosts.json') ? server : null) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines[0]).toContain('github.acme-corp.net')
  })

  it('redacts tokens and NUL from diagnostics without surfacing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => { throw new Error('token gho_leak-secret eyJabc.def.ghi\0tail') })
    const result = await fetchCopilotQuota({ fetch: fetchMock, readFile: vi.fn(async () => hosts) })
    const logged = warn.mock.calls.flat().join(' ')
    expect(result.quota).not.toHaveProperty('error')
    expect(logged).not.toMatch(/gho_leak|eyJabc|\0/)
    expect(logged).toContain('[REDACTED]')
  })
})

describe('Copilot credential directories', () => {
  it('prefers %LOCALAPPDATA% on Windows and keeps the XDG path as a fallback', () => {
    expect(copilotConfigDirs('win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'C:\\Users\\dev')).toEqual([
      path.join('C:\\Users\\dev\\AppData\\Local', 'github-copilot'),
      path.join('C:\\Users\\dev', '.config', 'github-copilot'),
    ])
    expect(copilotConfigDirs('win32', {}, 'C:\\Users\\dev')[0]).toBe(path.join('C:\\Users\\dev', 'AppData', 'Local', 'github-copilot'))
  })

  it('reads only the XDG path off Windows', () => {
    expect(copilotConfigDirs('darwin', { LOCALAPPDATA: 'C:\\ignored' }, '/Users/dev')).toEqual([path.join('/Users/dev', '.config', 'github-copilot')])
  })

  it('finds the plugin token under %LOCALAPPDATA% on Windows with no explicit directory', async () => {
    const realPlatform = process.platform
    const realLocal = process.env.LOCALAPPDATA
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.LOCALAPPDATA = '/win/local'
    try {
      const readFile = vi.fn(async (file: string) => file === path.join('/win/local', 'github-copilot', 'hosts.json') ? hosts : null)
      const result = await fetchCopilotQuota({ fetch: vi.fn(async () => okJson(usageBody)), readFile })
      expect(result.quota.connection).toBe('connected')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      if (realLocal === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = realLocal
    }
  })
})

describe('Copilot credential folders', () => {
  const twoFolders = (win: Record<string, unknown>, xdg: Record<string, unknown>) => {
    const files: Record<string, string> = {
      [path.join('/win', 'github-copilot', 'hosts.json')]: JSON.stringify(win),
      [path.join('/home', '.config', 'github-copilot', 'hosts.json')]: JSON.stringify(xdg),
    }
    return { configDirs: [path.join('/win', 'github-copilot'), path.join('/home', '.config', 'github-copilot')], readFile: vi.fn(async (file: string) => files[file] ?? null) }
  }
  const seen = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(call => {
    const [url, init] = call as unknown as [string, RequestInit]
    return `${url} ${(init.headers as Record<string, string>).Authorization}`
  })

  it('moves on to the next folder when the first one holds a refused token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | RequestInfo, init?: RequestInit) => (init?.headers as Record<string, string>).Authorization === 'token gho_valid'
      ? okJson(usageBody)
      : new Response('', { status: 401 }))
    const result = await fetchCopilotQuota({ fetch: fetchMock, ...twoFolders({ 'github.com': { oauth_token: 'gho_stale' } }, { 'github.com': { oauth_token: 'gho_valid' } }) })
    expect(result.quota.connection).toBe('connected')
    expect(seen(fetchMock)).toEqual([
      'https://api.github.com/copilot_internal/user token gho_stale',
      'https://api.github.com/copilot_internal/user token gho_valid',
    ])
  })

  it('moves on to the next folder when the first one holds a host it cannot address', async () => {
    const fetchMock = vi.fn(async () => okJson(usageBody))
    const result = await fetchCopilotQuota({ fetch: fetchMock, ...twoFolders({ 'github.acme-corp.net': { oauth_token: 'gho_server' } }, { 'github.com': { oauth_token: 'gho_valid' } }) })
    expect(result.quota.connection).toBe('connected')
    expect(seen(fetchMock)).toEqual(['https://api.github.com/copilot_internal/user token gho_valid'])
  })
})
