import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import { fetchAntigravityQuota, decodeAntigravitySummary, parseNetstatPorts } from '../src/quota/antigravity.js'
import { decodeClaudeUsage, fetchClaudeQuota, planLabel } from '../src/quota/claude.js'
import { decodeCodexUsage, fetchCodexQuota } from '../src/quota/codex.js'
import { decodeCopilotUsage, fetchCopilotQuota } from '../src/quota/copilot.js'
import { decodeGeminiUsage, fetchGeminiQuota } from '../src/quota/gemini.js'
import { collectQuota, renderQuotaTable } from '../src/quota/index.js'
import { decodeKimiUsage, fetchKimiQuota } from '../src/quota/kimi.js'
import { discoverClaudeConfigSources } from '../src/providers/claude.js'
import type { QuotaProvider } from '../src/quota/types.js'

const noFile = vi.fn(async () => null)
const neverFetch = () => { throw new Error('the test must not reach the network') }

describe('Claude quota', () => {
  it('decodes the five-hour and weekly windows with the credential tier', () => {
    const quota = decodeClaudeUsage({
      five_hour: { utilization: 25, resets_at: '2026-07-12T12:00:00Z' },
      seven_day: { utilization: 50, resets_at: '2026-07-19T12:00:00Z' },
    }, { accessToken: 'hidden', rateLimitTier: 'max_20x' })
    expect(quota.connection).toBe('connected')
    expect(quota.planLabel).toBe('Max 20x')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(quota.primary).toEqual({ label: 'Weekly', percent: 0.5, resetsAt: '2026-07-19T12:00:00.000Z' })
  })

  it('reports disconnected without a credential and never fetches', async () => {
    const result = await fetchClaudeQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })

  it('prefers subscriptionType over rateLimitTier for the plan label', () => {
    const cases: Array<[string | undefined, string | undefined, string]> = [
      ['max', 'default_claude_max_20x', 'Max 20x'],
      ['team', 'default_claude_max_5x', 'Team Premium'],
      ['team', undefined, 'Team'],
      ['enterprise', 'default_claude_max_5x', 'Enterprise Premium'],
      ['pro', 'default_claude_pro', 'Pro'],
      [undefined, 'max_5x', 'Max 5x'],
      [undefined, 'max_20x', 'Max 20x'],
      [undefined, 'team', 'Team'],
      [undefined, undefined, 'Subscription'],
    ]
    for (const [subscriptionType, rateLimitTier, label] of cases) {
      expect(planLabel({ subscriptionType, rateLimitTier })).toBe(label)
    }
  })

  // A 401 has to be answered by re-reading the store the credential actually came
  // from - on macOS that is usually the Keychain, and no credential file exists at
  // all - and a credential whose life is over has to read as terminal rather than as
  // a blip worth retrying.
  describe('after a rejected credential', () => {
    const realPlatform = process.platform
    beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
    afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }))

    const now = () => 1_760_000_000_000
    const HOUR = 3_600_000
    const usage = JSON.stringify({ seven_day: { utilization: 55, resets_at: '2026-07-19T12:00:00Z' } })
    const stored = (accessToken: string, expiresAt: number) =>
      JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, rateLimitTier: 'max_20x' } })

    it('re-reads the keychain, not the absent file, and adopts the renewed login', async () => {
      let reads = 0
      const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored(reads++ === 0 ? 'before' : 'after', now() + HOUR) }))
      let requests = 0
      const fetchMock = vi.fn(async () => new Response(usage, { status: requests++ === 0 ? 401 : 200 }))
      const readFile = vi.fn(async () => null)

      const result = await fetchClaudeQuota({ fetch: fetchMock as unknown as typeof fetch, readFile, keychain, allowKeychain: true, now })

      expect(result.quota.connection).toBe('connected')
      expect(result.quota.primary?.percent).toBe(0.55)
      expect(keychain).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('reports a terminal failure when the login behind it has expired', async () => {
      const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored('unchanged', now() - HOUR) }))
      const fetchMock = vi.fn(async () => new Response('', { status: 401 }))

      const result = await fetchClaudeQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: noFile, keychain, allowKeychain: true, now })

      expect(result.quota.connection).toBe('terminalFailure')
      expect(result.quota.footerLines[0]).toMatch(/expired/i)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('keeps a transient failure while the credential is still within its life', async () => {
      const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored('unchanged', now() + HOUR) }))
      const fetchMock = vi.fn(async () => new Response('', { status: 401 }))

      const result = await fetchClaudeQuota({ fetch: fetchMock as unknown as typeof fetch, readFile: noFile, keychain, allowKeychain: true, now })

      expect(result.quota.connection).toBe('transientFailure')
      expect(result.quota.footerLines).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('re-reads the file for a file-backed credential and never touches the keychain', async () => {
      let reads = 0
      const readFile = vi.fn(async () => stored(reads++ === 0 ? 'before' : 'after', now() + HOUR))
      let requests = 0
      const fetchMock = vi.fn(async () => new Response(usage, { status: requests++ === 0 ? 401 : 200 }))
      const keychain = vi.fn(async () => ({ status: 'found' as const, value: stored('keychain', now() + HOUR) }))

      const result = await fetchClaudeQuota({ fetch: fetchMock as unknown as typeof fetch, readFile, keychain, allowKeychain: true, now })

      expect(result.quota.connection).toBe('connected')
      expect(readFile).toHaveBeenCalledTimes(2)
      expect(keychain).not.toHaveBeenCalled()
    })
  })
})

describe('Codex quota', () => {
  it('decodes the primary and secondary rate-limit windows with the plan label', () => {
    const quota = decodeCodexUsage({
      plan_type: 'enterprise_cbp_usage_based',
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_760_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604_800 },
      },
    })
    expect(quota.planLabel).toBe('Enterprise')
    expect(quota.details.map(row => row.label)).toEqual(['5-hour', 'Weekly'])
    expect(quota.primary?.percent).toBe(0.12)
    expect(quota.primary?.resetsAt).toBe('2025-10-09T08:53:20.000Z')
  })

  it('reports disconnected when no auth file exists', async () => {
    const result = await fetchCodexQuota({
      fetch: neverFetch as unknown as typeof fetch,
      readFile: noFile,
      keychain: async () => ({ status: 'notFound' }),
    })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Copilot quota', () => {
  it('turns remaining-percent snapshots into used windows', () => {
    const quota = decodeCopilotUsage({
      copilot_plan: 'individual',
      quota_snapshots: { premium_interactions: { percent_remaining: 70 }, chat: { percent_remaining: 100 } },
    })
    expect(quota.planLabel).toBe('Individual')
    expect(quota.primary).toEqual({ label: 'Premium requests', percent: 0.3, resetsAt: null })
    expect(quota.details.map(row => row.label)).toEqual(['Premium requests', 'Chat'])
  })

  it('reports disconnected when no plugin token is on disk', async () => {
    const result = await fetchCopilotQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Gemini quota', () => {
  it('decodes per-model buckets into used windows ordered by pressure', () => {
    const quota = decodeGeminiUsage({
      buckets: [
        { modelId: 'gemini-2.5-flash', remainingFraction: 0.9 },
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-09-02T00:00:00Z' },
      ],
    })
    expect(quota.details.map(row => row.label)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
    expect(quota.primary?.percent).toBeCloseTo(0.75, 6)
    expect(quota.primary?.resetsAt).toBe('2026-09-02T00:00:00.000Z')
  })

  it('reports disconnected without the CLI oauth credential', async () => {
    const result = await fetchGeminiQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Kimi quota', () => {
  it('decodes the weekly envelope plus the rate-limit windows', () => {
    const quota = decodeKimiUsage({
      usage: { limit: 100, used: 30 },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 50, remaining: 10 } }],
      user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
      parallel: { limit: 3 },
    })
    expect(quota?.planLabel).toBe('Intermediate')
    expect(quota?.details.map(row => row.label)).toEqual(['Weekly', '5-hour'])
    expect(quota?.details.map(row => row.percent)).toEqual([0.3, 0.8])
    expect(quota?.footerLines).toEqual(['Parallel sessions: 3'])
  })

  it('reports disconnected without the Kimi CLI credential', async () => {
    const result = await fetchKimiQuota({ fetch: neverFetch as unknown as typeof fetch, readFile: noFile })
    expect(result.quota.connection).toBe('disconnected')
  })
})

describe('Antigravity quota', () => {
  it('decodes grouped model buckets into used windows', () => {
    const windows = decodeAntigravitySummary({
      groups: [{ displayName: 'Weekly', buckets: [{ displayName: 'Claude Sonnet 4.5', remaining: { remainingFraction: 0.4 } }] }],
    })
    expect(windows).toEqual([{ label: 'Weekly · Claude Sonnet 4.5', percent: 0.6, resetsAt: null }])
  })

  it('reports disconnected when no local language server is running', async () => {
    const quota = await fetchAntigravityQuota({
      execFile: async () => ({ stdout: '  501 /usr/bin/unrelated --flag\n' }),
      request: async () => { throw new Error('the test must not probe a port') },
      platform: 'darwin',
    })
    expect(quota.connection).toBe('disconnected')
  })

  // Windows has neither `ps` nor `lsof`. Asking for them is a spawn failure rather than an
  // empty answer, so every poll printed "ps: unknown option -- x" and reported a transient
  // failure instead of saying the provider simply is not running.
  it('never asks Windows for ps or lsof', async () => {
    const asked: string[] = []
    const quota = await fetchAntigravityQuota({
      platform: 'win32',
      execFile: async (file, args) => {
        asked.push(file)
        expect(file).not.toMatch(/(^|[\\/])(ps|lsof)(\.exe)?$/i)
        expect(args).not.toContain('-ax')
        return { stdout: '' }
      },
      request: async () => { throw new Error('the test must not probe a port') },
    })

    expect(quota.connection).toBe('disconnected')
    expect(asked[0]).toMatch(/powershell\.exe$/i)
  })

  it('finds a language server through the Windows process listing', async () => {
    const line = '4321 C:\\Users\\x\\AppData\\Local\\antigravity\\language_server_windows_x64.exe'
      + ' --app_data_dir=antigravity --csrf_token=abc --extension_server_port=51234'
    const quota = await fetchAntigravityQuota({
      platform: 'win32',
      execFile: async file => {
        if (/powershell\.exe$/i.test(file)) return { stdout: `${line}\r\n` }
        // netstat, which is how a pid's listening ports are found there.
        return { stdout: '  TCP    127.0.0.1:51234   0.0.0.0:0   LISTENING   4321\r\n' }
      },
      request: async (port, _tls, _path, _body, csrf) => {
        expect(port).toBe(51234)
        expect(csrf).toBe('abc')
        return {
          status: 200,
          text: JSON.stringify({ groups: [{ displayName: 'Weekly', buckets: [{ displayName: 'Sonnet', remaining: { remainingFraction: 0.25 } }] }] }),
        }
      },
    })

    expect(quota.connection).toBe('connected')
    expect(quota.primary?.label).toBe('Weekly · Sonnet')
  })

  it('reads only this pid out of a netstat listing', () => {
    const stdout = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:51234        0.0.0.0:0              LISTENING       4321',
      '  TCP    127.0.0.1:60000        0.0.0.0:0              LISTENING       9999',
      '  TCP    [::]:51999             [::]:0                 LISTENING       4321',
      '  UDP    127.0.0.1:5353         *:*                                    4321',
    ].join('\r\n')

    expect(parseNetstatPorts(stdout, '4321')).toEqual([51234, 51999])
    expect(parseNetstatPorts(stdout, '1')).toEqual([])
  })
})

describe('quota command envelope', () => {
  const connected: QuotaProvider = {
    provider: 'claude', connection: 'connected', planLabel: 'Max 20x', footerLines: [],
    primary: { label: 'Weekly', percent: 0.5, resetsAt: '2026-07-19T12:00:00.000Z' },
    details: [
      { label: '5-hour', percent: 0.255, resetsAt: null },
      { label: 'Weekly', percent: 0.5, resetsAt: '2026-07-19T12:00:00.000Z' },
    ],
  }
  const missing: QuotaProvider = {
    provider: 'kimi', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [],
  }

  it('renders providers, windows and the omitted-error contract', async () => {
    const report = await collectQuota({
      readers: [
        { id: 'claude', name: 'Claude', read: async () => connected },
        { id: 'kimi', name: 'Kimi', read: async () => missing },
      ],
    })
    expect(report).toEqual({
      providers: [
        {
          id: 'claude', name: 'Claude', available: true, plan: 'Max 20x',
          windows: [
            { label: '5-hour', usedPct: 25.5 },
            { label: 'Weekly', usedPct: 50, resetsAt: '2026-07-19T12:00:00.000Z' },
          ],
        },
        { id: 'kimi', name: 'Kimi', available: false, windows: [] },
      ],
    })
    expect(renderQuotaTable(report, { color: false })).toContain('Claude (Max 20x)')
  })

  it('hides a connected ZCode row while the Z.ai credential is live, and notes the duplicate', async () => {
    const zai: QuotaProvider = {
      provider: 'zai', connection: 'connected', planLabel: 'Pro', footerLines: [],
      primary: { label: 'Weekly', percent: 0.45, resetsAt: '2026-09-21T12:00:00.000Z' }, details: [],
    }
    const zcode: QuotaProvider = {
      provider: 'zcode', connection: 'connected', planLabel: 'Pro', footerLines: [],
      primary: { label: 'Weekly', percent: 0.45, resetsAt: '2026-09-21T12:00:00.000Z' }, details: [],
    }
    const report = await collectQuota({
      readers: [
        { id: 'zai', name: 'Z.ai', read: async () => zai },
        { id: 'zcode', name: 'ZCode', read: async () => zcode },
      ],
    })
    expect(report.providers.map(row => row.id)).toEqual(['zai'])
    expect(report.providers[0].notes).toEqual([
      'A ZCode app login is also connected; it reads the same z.ai plan endpoint and is hidden as a duplicate.',
    ])
  })

  it('keeps the ZCode row when Z.ai is configured but not usable', async () => {
    // A rejected or stale Z.ai state must never hide a working ZCode login.
    const zai: QuotaProvider = {
      provider: 'zai', connection: 'terminalFailure', primary: null, details: [], planLabel: null,
      footerLines: ['Z.ai rejected this API key.'],
    }
    const zcode: QuotaProvider = {
      provider: 'zcode', connection: 'connected', planLabel: 'Pro', footerLines: [],
      primary: { label: 'Weekly', percent: 0.45, resetsAt: '2026-09-21T12:00:00.000Z' }, details: [],
    }
    const report = await collectQuota({
      readers: [
        { id: 'zai', name: 'Z.ai', read: async () => zai },
        { id: 'zcode', name: 'ZCode', read: async () => zcode },
      ],
    })
    expect(report.providers.map(row => row.id)).toEqual(['zai', 'zcode'])
  })

  it('gives up on a provider that outlives its timeout', async () => {
    const report = await collectQuota({
      timeoutMs: 5,
      readers: [{ id: 'gemini', name: 'Gemini', read: () => new Promise<QuotaProvider>(() => {}) }],
    })
    expect(report.providers).toEqual([{ id: 'gemini', name: 'Gemini', available: false, windows: [], error: 'Timed out.' }])
  })
})

describe('collectQuota claudeProfiles (#1523)', () => {
  async function withTwoDirs<T>(run: (dirs: string[], sources: Awaited<ReturnType<typeof discoverClaudeConfigSources>>) => Promise<T>): Promise<T> {
    const dirs = [
      mkdtempSync(join(tmpdir(), 'codeburn-profile-a-')),
      mkdtempSync(join(tmpdir(), 'codeburn-profile-b-')),
    ]
    const previous = process.env.CLAUDE_CONFIG_DIRS
    process.env.CLAUDE_CONFIG_DIRS = dirs.join(delimiter)
    try {
      return await run(dirs, await discoverClaudeConfigSources())
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIRS
      else process.env.CLAUDE_CONFIG_DIRS = previous
    }
  }

  it('full mode answers one profile per directory, each with its own windows and today', async () => {
    await withTwoDirs(async (dirs, sources) => {
      const work: QuotaProvider = {
        provider: 'claude', connection: 'connected', planLabel: 'Max 5x', footerLines: [],
        primary: { label: 'Weekly', percent: 0.72, resetsAt: '2026-09-30T12:00:00.000Z' }, details: [],
      }
      const report = await collectQuota({
        readers: [],
        claudeProfileDetail: 'full',
        claudeProfileReader: async source =>
          resolve(source.path) === resolve(dirs[0]) ? work : {
            provider: 'claude', connection: 'disconnected', primary: null, details: [],
            planLabel: null, footerLines: [],
          },
        claudeToday: async all => new Map([
          [all[0].id, {
            cost: 1.25, calls: 3, sessions: 1,
            inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10,
          }],
        ]),
      })
      expect(report.claudeProfiles).toEqual([
        {
          id: sources[0].id, label: sources[0].label, path: sources[0].path,
          available: true, plan: 'Max 5x',
          windows: [{ label: 'Weekly', usedPct: 72, resetsAt: '2026-09-30T12:00:00.000Z' }],
          today: {
            cost: 1.25, calls: 3, sessions: 1,
            inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10,
          },
        },
        {
          id: sources[1].id, label: sources[1].label, path: sources[1].path,
          available: false, windows: [],
        },
      ])
    })
  })

  it('full mode reuses the claude row for the default directory instead of reading it twice', async () => {
    // os.homedir() answers $HOME on POSIX, so a temp home makes ~/.claude a fixture.
    const home = mkdtempSync(join(tmpdir(), 'codeburn-profile-home-'))
    const personal = join(home, '.claude')
    const work = join(home, '.claude-work')
    for (const dir of [personal, work]) mkdirSync(dir, { recursive: true })
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const previousDirs = process.env.CLAUDE_CONFIG_DIRS
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.CLAUDE_CONFIG_DIRS = [personal, work].join(delimiter)
    try {
      const claudeRow: QuotaProvider = {
        provider: 'claude', connection: 'connected', planLabel: 'Pro', footerLines: [],
        primary: { label: 'Weekly', percent: 0.4, resetsAt: null }, details: [],
      }
      const reads: string[] = []
      const report = await collectQuota({
        readers: [{ id: 'claude', name: 'Claude', read: async () => claudeRow }],
        claudeProfileDetail: 'full',
        claudeProfileReader: async source => {
          reads.push(resolve(source.path))
          return { provider: 'claude', connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [] }
        },
        claudeToday: async () => new Map(),
      })
      // Only the non-default directory is read; the default one is the claude row itself.
      expect(reads).toEqual([resolve(work)])
      const defaultProfile = report.claudeProfiles?.find(row => row.path === resolve(personal))
      expect(defaultProfile).toMatchObject({ available: true, plan: 'Pro' })
      expect(defaultProfile?.windows).toEqual([{ label: 'Weekly', usedPct: 40 }])
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      if (previousDirs === undefined) delete process.env.CLAUDE_CONFIG_DIRS
      else process.env.CLAUDE_CONFIG_DIRS = previousDirs
    }
  })

  it('list mode (the default) names the directories without reading or parsing any of them', async () => {
    await withTwoDirs(async (_dirs, sources) => {
      const report = await collectQuota({
        readers: [],
        claudeProfileReader: () => { throw new Error('list mode must not read profiles') },
        claudeToday: () => { throw new Error('list mode must not parse today') },
      })
      expect(report.claudeProfiles).toEqual(sources.map(({ id, label, path }) => ({ id, label, path })))
    })
  })

  it('omits claudeProfiles entirely for a single config directory', async () => {
    const report = await collectQuota({ readers: [] })
    expect(report).toEqual({ providers: [] })
    expect('claudeProfiles' in report).toBe(false)
  })

  it('drops missing directories before deciding there is more than one', async () => {
    const real = mkdtempSync(join(tmpdir(), 'codeburn-profile-real-'))
    const previous = process.env.CLAUDE_CONFIG_DIRS
    process.env.CLAUDE_CONFIG_DIRS = [real, join(real, 'missing-sibling')].join(delimiter)
    try {
      const report = await collectQuota({ readers: [] })
      expect('claudeProfiles' in report).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIRS
      else process.env.CLAUDE_CONFIG_DIRS = previous
    }
  })
})
