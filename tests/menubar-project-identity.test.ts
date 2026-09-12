import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { getDateRange } from '../src/cli-date.js'
import { currentTzKey, DAILY_CACHE_VERSION, toDateString, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { calculateCost, loadPricing } from '../src/models.js'
import { computeSpendFlow } from '../src/spend-flow.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'
import { buildMenubarPayloadForRange, buildPayloadProjects, getDailyCacheConfigHash } from '../src/usage-aggregator.js'

vi.setConfig({ testTimeout: 30_000 })

const emptyTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
}

function session(opts: {
  id: string
  project: string
  cost: number
  models: Record<string, number>
}): SessionSummary {
  return {
    sessionId: opts.id,
    project: opts.project,
    firstTimestamp: '2026-09-07T12:00:00.000Z',
    lastTimestamp: '2026-09-07T12:01:00.000Z',
    totalCostUSD: opts.cost,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: Object.keys(opts.models).length,
    turns: [],
    modelBreakdown: Object.fromEntries(
      Object.entries(opts.models).map(([name, costUSD]) => [
        name,
        { calls: 1, costUSD, savingsUSD: 0, tokens: emptyTokens },
      ]),
    ),
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {},
    skillBreakdown: {},
    subagentBreakdown: {},
  } as SessionSummary
}

function live(project: string, projectPath: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project,
    projectPath,
    sessions,
    totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
    totalSavingsUSD: 0,
    totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    totalProxiedCostUSD: 0,
  }
}

function cacheDay(projects: NonNullable<DailyEntry['projects']>): DailyEntry {
  return {
    date: '2026-09-07',
    cost: 0,
    savingsUSD: 0,
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: {},
    projects,
  }
}

describe('buildPayloadProjects identity', () => {
  const home = '/Users/me'

  it('coalesces provider-split cache slugs for the same cwd with cost/session conservation', () => {
    const shared = '/tmp/shared-vault'
    const other = '/tmp/other-vault'
    const rows = buildPayloadProjects(
      [
        live('shared-vault', shared, [
          session({ id: 'claude', project: 'shared-vault', cost: 0.468, models: { 'Opus 4.6': 0.45, 'Sonnet 4.5': 0.018 } }),
          session({ id: 'codex', project: '-tmp-shared-vault', cost: 0.00091, models: { 'GPT-5.3 Codex': 0.00091 } }),
        ]),
        live('other-vault', other, [
          session({ id: 'haiku', project: 'other-vault', cost: 0.015, models: { 'Haiku 4.5': 0.015 } }),
        ]),
      ],
      [cacheDay({
        'shared-vault': { cost: 0.468, calls: 3, savingsUSD: 0, sessions: 1, path: shared },
        '-tmp-shared-vault': { cost: 0.00091, calls: 2, savingsUSD: 0, sessions: 1, path: shared },
        'other-vault': { cost: 0.015, calls: 1, savingsUSD: 0, sessions: 1, path: other },
      })],
      home,
    )

    expect(rows.map(r => r.id)).toEqual([shared, other])
    expect(rows.map(r => r.name)).toEqual(['shared-vault', 'other-vault'])
    expect(rows[0]!.cost).toBeCloseTo(0.46891, 10)
    expect(rows[0]!.sessions).toBe(2)
    expect(rows[0]!.sessionDetails?.map(s => s.models[0]?.name)).toEqual(['Opus 4.6', 'GPT-5.3 Codex'])
    expect(rows[1]!.cost).toBeCloseTo(0.015, 10)
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBeCloseTo(0.48391, 10)
    expect(rows.reduce((s, r) => s + r.sessions, 0)).toBe(3)
  })

  it('keeps distinct cwd with the same basename separate and disambiguates labels', () => {
    const rows = buildPayloadProjects(
      [
        live('vault', '/a/vault', [session({ id: 'a', project: 'vault', cost: 10, models: { opus: 10 } })]),
        live('vault', '/b/vault', [session({ id: 'b', project: 'vault', cost: 1, models: { sonnet: 1 } })]),
      ],
      null,
      home,
    )
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.id).sort()).toEqual(['/a/vault', '/b/vault'])
    expect(rows.map(r => r.name).sort()).toEqual(['a/vault', 'b/vault'])
    expect(rows.map(r => r.cost).sort((a, b) => b - a)).toEqual([10, 1])
  })

  it('keeps old cache rows with no path as a slug fallback', () => {
    const rows = buildPayloadProjects(
      [],
      [cacheDay({
        'legacy-slug': { cost: 2, calls: 4, savingsUSD: 0, sessions: 1 },
      })],
      home,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('legacy-slug')
    expect(rows[0]!.name).toBe('legacy-slug')
    expect(rows[0]!.cost).toBe(2)
    expect(rows[0]!.sessionDetails).toBeUndefined()
  })

  // Root fixture root-project-adjacent-repro.ts — adapt only the import.
  it('distinct POSIX cwd must not be lowercased into one project', () => {
    const days: any = [{ projects: { first: { path: '/tmp/Case/Vault', cost: 1, savingsUSD: 0, sessions: 1 }, second: { path: '/tmp/case/vault', cost: 2, savingsUSD: 0, sessions: 1 } } }]
    const rows = buildPayloadProjects([], days, '/Users/synthetic')
    expect(rows.length).toBe(2)
    expect(rows.map(r => r.id).sort()).toEqual(['/tmp/Case/Vault', '/tmp/case/vault'])
    expect(rows.map(r => r.cost).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('joins a pathless cache slug with a unique live path without double-counting', () => {
    const rows = buildPayloadProjects(
      [live('legacy-slug', '/tmp/legacy-slug', [session({ id: 's', project: 'legacy-slug', cost: 2, models: { opus: 2 } })])],
      [cacheDay({
        'legacy-slug': { cost: 2, calls: 4, savingsUSD: 0, sessions: 1 },
      })],
      home,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('/tmp/legacy-slug')
    expect(rows[0]!.cost).toBe(2)
    expect(rows[0]!.sessions).toBe(1)
    expect(rows[0]!.sessionDetails).toHaveLength(1)
  })

  it('joins pathless and later-pathed cache days for the same slug', () => {
    const rows = buildPayloadProjects(
      [],
      [
        cacheDay({ 'legacy-slug': { cost: 1, calls: 1, savingsUSD: 0, sessions: 1 } }),
        { ...cacheDay({ 'legacy-slug': { cost: 1, calls: 1, savingsUSD: 0, sessions: 1, path: '/tmp/legacy-slug' } }), date: '2026-09-06' },
      ],
      home,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('/tmp/legacy-slug')
    expect(rows[0]!.cost).toBe(2)
  })

  it('keeps ambiguous pathless cache authoritative and does not add matching live cost', () => {
    // Cache-authoritative: the pathless slug total already accounts for those
    // live folders. Guessing /a vs /b would double-count. Matching live stays
    // as detail on the legacy key (cost 0 assigned is not emitted as a path row).
    const rows = buildPayloadProjects(
      [
        live('vault', '/a/vault', [session({ id: 'a', project: 'vault', cost: 6, models: { opus: 6 } })]),
        live('vault', '/b/vault', [session({ id: 'b', project: 'vault', cost: 4, models: { sonnet: 4 } })]),
      ],
      [cacheDay({
        vault: { cost: 10, calls: 2, savingsUSD: 0, sessions: 2 },
      })],
      home,
    )
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBe(10)
    expect(rows.find(r => r.id === 'vault')!.cost).toBe(10)
    expect(rows.filter(r => r.id === '/a/vault' || r.id === '/b/vault').every(r => r.cost === 0)).toBe(true)
  })

  it('conserves live-only provider cost when coalescing a cached provider at the same cwd', () => {
    const shared = '/tmp/shared-vault'
    const rows = buildPayloadProjects(
      [
        live('shared-vault', shared, [
          session({ id: 'claude', project: 'shared-vault', cost: 0.45, models: { 'Opus 4.6': 0.45 } }),
        ]),
        live('-tmp-shared-vault', shared, [
          session({ id: 'codex', project: '-tmp-shared-vault', cost: 0.00091, models: { 'GPT-5.3 Codex': 0.00091 } }),
        ]),
      ],
      [cacheDay({
        'shared-vault': { cost: 0.45, calls: 1, savingsUSD: 0, sessions: 1, path: shared },
      })],
      home,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(shared)
    expect(rows[0]!.cost).toBeCloseTo(0.45091, 10)
    expect(rows[0]!.sessions).toBe(2)
    expect(rows[0]!.sessionDetails?.map(s => s.models[0]?.name)).toEqual(['Opus 4.6', 'GPT-5.3 Codex'])
  })

  // Root fixture root-project-cache-path-repro.ts — adapt only the import.
  it('Known different cwd must survive cache-day folding', () => {
    const rows = buildPayloadProjects([], [
      { date: '2026-09-06', projects: { vault: { path: '/a/vault', cost: 2, savingsUSD: 0, sessions: 1 } } },
      { date: '2026-09-07', projects: { vault: { path: '/b/vault', cost: 3, savingsUSD: 0, sessions: 1 } } },
    ] as any, '/Users/synthetic')
    expect(rows.length).toBe(2)
    expect(rows.map(r => [r.id, r.cost]).sort()).toEqual([['/a/vault', 2], ['/b/vault', 3]])
  })

  // Root fixture root-project-ambiguous-repro.ts — adapt only the import.
  it('A legacy cached total must not be added to its matching live breakdown again', () => {
    const sess = (id: string, cost: number): any => ({ sessionId: id, project: id, firstTimestamp: '2026-09-07T12:00:00Z', totalCostUSD: cost, totalSavingsUSD: 0, apiCalls: 1, totalInputTokens: 100, totalOutputTokens: 20, totalReasoningTokens: 0, modelBreakdown: {}, turns: [] })
    const liveRow = (projectPath: string, cost: number): any => ({ project: 'vault', projectPath, sessions: [sess('vault', cost)], totalCostUSD: cost, totalSavingsUSD: 0, totalApiCalls: 1 })
    const rows = buildPayloadProjects([liveRow('/a/vault', 2), liveRow('/b/vault', 3)], [{ projects: { vault: { cost: 5, savingsUSD: 0, sessions: 2 } } }] as any, '/Users/synthetic')
    expect(rows.reduce((n, r) => n + r.cost, 0)).toBe(5)
  })

  // Root fixture root-project-mixed-valid-repro.ts — adapt only the import.
  it('Other provider cache must not suppress live-only provider cost', () => {
    const sess = (id: string, cost: number): any => ({ sessionId: id, project: id, firstTimestamp: '2026-09-07T12:00:00Z', totalCostUSD: cost, totalSavingsUSD: 0, apiCalls: 1, totalInputTokens: 100, totalOutputTokens: 20, totalReasoningTokens: 0, modelBreakdown: {}, turns: [] })
    const liveRow = (project: string, cost: number): any => ({ project, projectPath: '/tmp/shared-vault', sessions: [sess(project, cost)], totalCostUSD: cost, totalSavingsUSD: 0, totalApiCalls: 1 })
    const rows = buildPayloadProjects([liveRow('claude-slug', 2), liveRow('codex-slug', 3)], [{ projects: { 'claude-slug': { path: '/tmp/shared-vault', cost: 2, savingsUSD: 0, sessions: 1 } } }] as any, '/Users/synthetic')
    expect(rows.length).toBe(1)
    expect(rows[0]!.cost).toBe(5)
  })

  // Root fixture root-project-detail-ownership-repro.ts — adapt only the import.
  it('Unallocated legacy details must exclude live-only sibling', () => {
    const sess = (id: string, cost: number): any => ({ sessionId: id, project: id, firstTimestamp: '2026-09-07T12:00:00Z', totalCostUSD: cost, totalSavingsUSD: 0, apiCalls: 1, totalInputTokens: 100, totalOutputTokens: 20, totalReasoningTokens: 0, modelBreakdown: {}, turns: [] })
    const liveRow = (path: string, sessions: any[]): any => ({ project: 'vault', projectPath: path, sessions, totalCostUSD: sessions.reduce((n: number, s: any) => n + s.totalCostUSD, 0), totalSavingsUSD: 0, totalApiCalls: sessions.length })
    const rows = buildPayloadProjects([liveRow('/a/vault', [sess('vault', 2), sess('codex-other', 7)]), liveRow('/b/vault', [sess('vault', 3)])], [{ projects: { vault: { cost: 5, savingsUSD: 0, sessions: 2 } } }] as any, '/Users/synthetic')
    expect(rows.reduce((n, r) => n + r.cost, 0)).toBe(12)
    const legacy = rows.find(r => r.id === 'vault')!
    const other = rows.find(r => r.id === '/a/vault')!
    expect(legacy.sessionDetails!.reduce((n, r) => n + r.cost, 0)).toBe(5)
    expect(other.sessionDetails!.reduce((n, r) => n + r.cost, 0)).toBe(7)
    expect(legacy.name).not.toBe(other.name)
  })

  it('conserves mixed bases when live parse already grouped both providers on one cwd row', () => {
    const shared = '/tmp/shared-vault'
    const rows = buildPayloadProjects(
      [
        live('shared-vault', shared, [
          session({ id: 'claude', project: 'shared-vault', cost: 0.45, models: { 'Opus 4.6': 0.45 } }),
          session({ id: 'codex', project: '-tmp-shared-vault', cost: 0.00091, models: { 'GPT-5.3 Codex': 0.00091 } }),
        ]),
      ],
      [cacheDay({
        'shared-vault': { cost: 0.45, calls: 1, savingsUSD: 0, sessions: 1, path: shared },
      })],
      home,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(shared)
    expect(rows[0]!.cost).toBeCloseTo(0.45091, 10)
    expect(rows[0]!.sessions).toBe(2)
  })
})

describe('menubar project identity pipeline', () => {
  const saved: Record<string, string | undefined> = {}
  const named = ['CLAUDE_CONFIG_DIR', 'CODEBURN_CACHE_DIR', 'CODEBURN_DESKTOP_SESSIONS_DIR'] as const

  beforeAll(async () => {
    await loadPricing()
  })

  afterEach(() => {
    for (const key of named) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('same cwd Claude+Codex coalesce once; distinct cwd same basename stay split', async () => {
    for (const key of named) saved[key] = process.env[key]

    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const claudeRoot = await mkdtemp(join(tmpdir(), 'cb-ident-claude-'))
    const cacheDir = await mkdtemp(join(tmpdir(), 'cb-ident-cache-'))
    const desktopDir = await mkdtemp(join(tmpdir(), 'cb-ident-desktop-'))
    process.env['CLAUDE_CONFIG_DIR'] = claudeRoot
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = desktopDir

    const shared = `/tmp/cb-ident-${stamp}/shared-vault`
    const other = `/tmp/cb-ident-${stamp}/other-vault`
    const altShared = `/tmp/cb-ident-${stamp}-alt/shared-vault`
    const projShared = join(claudeRoot, 'projects', 'shared-vault')
    const projOther = join(claudeRoot, 'projects', 'other-vault')
    const projAlt = join(claudeRoot, 'projects', 'alt-shared-vault')
    mkdirSync(projShared, { recursive: true })
    mkdirSync(projOther, { recursive: true })
    mkdirSync(projAlt, { recursive: true })
    mkdirSync(desktopDir, { recursive: true })

    const now = new Date()
    const todayTs = new Date(now.getTime() - 60_000).toISOString()
    const todayStr = toDateString(now)
    const opus = 'claude-opus-4-6'
    const sonnet = 'claude-sonnet-4-5'
    const haiku = 'claude-haiku-4-5'

    const user = (id: string, cwd: string) => JSON.stringify({
      type: 'user', sessionId: id, timestamp: todayTs, cwd,
      message: { role: 'user', content: 'work' },
    })
    const assistant = (model: string, id: string, cwd: string, usage: { input: number; output: number; cacheR?: number }) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        timestamp: todayTs,
        cwd,
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: usage.cacheR ?? 0,
          },
        },
      })

    writeFileSync(join(projShared, 'sess.jsonl'), [
      user('shared-sonnet', shared),
      assistant(sonnet, 'shared-sonnet', shared, { input: 4000, output: 400 }),
      user('shared-opus', shared),
      assistant(opus, 'shared-opus', shared, { input: 0, output: 0, cacheR: 900_000 }),
    ].join('\n') + '\n')
    writeFileSync(join(projOther, 'sess.jsonl'), [
      user('other-haiku', other),
      assistant(haiku, 'other-haiku', other, { input: 10_000, output: 1_000 }),
    ].join('\n') + '\n')
    writeFileSync(join(projAlt, 'sess.jsonl'), [
      user('alt-sonnet', altShared),
      assistant(sonnet, 'alt-sonnet', altShared, { input: 4000, output: 400 }),
    ].join('\n') + '\n')

    const y = todayStr.slice(0, 4), m = todayStr.slice(5, 7), d = todayStr.slice(8, 10)
    const codexDay = join(homedir(), '.codex', 'sessions', y, m, d)
    mkdirSync(codexDay, { recursive: true })
    const tokenEvent = (n: number, cum: number) => JSON.stringify({
      type: 'event_msg',
      timestamp: todayTs,
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, reasoning_output_tokens: 0 },
          total_token_usage: { total_tokens: cum, input_tokens: 100 * n, output_tokens: 20 * n },
        },
      },
    })
    const rolloutPath = join(codexDay, `rollout-ident-${stamp}.jsonl`)
    writeFileSync(rolloutPath, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: todayTs,
        payload: { session_id: `codex-shared-${stamp}`, cwd: shared, originator: 'codex-cli', model: 'gpt-5.3-codex' },
      }),
      tokenEvent(1, 120),
      tokenEvent(2, 240),
    ].join('\n') + '\n')

    const sonnetCost = calculateCost(sonnet, 4000, 400, 0, 0, 0)
    const opusCost = calculateCost(opus, 0, 0, 0, 900_000, 0)
    const haikuCost = calculateCost(haiku, 10_000, 1_000, 0, 0, 0)
    const codexCost = calculateCost('gpt-5.3-codex', 100, 20, 0, 0, 0) * 2
    const sharedCost = sonnetCost + opusCost + codexCost
    const expectedTotal = sharedCost + haikuCost + sonnetCost

    try {
      const period = getDateRange('today')
      const payload = await buildMenubarPayloadForRange(period, { provider: 'all', optimize: false, timeline: false })
      const flow = await computeSpendFlow(period.range, 'all')

      expect(payload.current.cost).toBeCloseTo(expectedTotal, 8)
      const projects = payload.current.topProjects
      expect(projects.map(p => p.id).sort()).toEqual([altShared, other, shared].sort())
      const sharedRow = projects.find(p => p.id === shared)!
      const altRow = projects.find(p => p.id === altShared)!
      const otherRow = projects.find(p => p.id === other)!
      expect(sharedRow.cost).toBeCloseTo(sharedCost, 8)
      expect(sharedRow.sessions).toBe(2)
      expect(sharedRow.sessionDetails.length).toBeGreaterThanOrEqual(2)
      const sharedModels = sharedRow.sessionDetails.flatMap(s => s.models.map(m => m.name)).join(' ')
      expect(sharedModels.toLowerCase()).toMatch(/opus/)
      expect(sharedModels.toLowerCase()).toMatch(/codex/)
      expect(altRow.cost).toBeCloseTo(sonnetCost, 8)
      expect(altRow.sessions).toBe(1)
      expect(otherRow.cost).toBeCloseTo(haikuCost, 8)
      expect(new Set(projects.map(p => p.id)).size).toBe(3)
      expect(sharedRow.name).not.toBe(altRow.name)
      expect(projects.reduce((s, p) => s + p.cost, 0)).toBeCloseTo(payload.current.cost, 8)
      expect(projects.reduce((s, p) => s + p.sessions, 0)).toBe(payload.current.sessions)

      expect(flow.projects.map(p => p.id).sort()).toEqual([altShared, other, shared].sort())
      expect(flow.projects.find(p => p.id === shared)!.cost).toBeCloseTo(sharedCost, 8)
    } finally {
      if (existsSync(rolloutPath)) unlinkSync(rolloutPath)
    }
  })

  it('buildMenubarPayloadForRange keeps distinct known cache paths of the same slug', async () => {
    for (const key of named) saved[key] = process.env[key]

    const claudeRoot = await mkdtemp(join(tmpdir(), 'cb-ident-cachepath-claude-'))
    const cacheDir = await mkdtemp(join(tmpdir(), 'cb-ident-cachepath-cache-'))
    const desktopDir = await mkdtemp(join(tmpdir(), 'cb-ident-cachepath-desktop-'))
    process.env['CLAUDE_CONFIG_DIR'] = claudeRoot
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = desktopDir
    mkdirSync(join(claudeRoot, 'projects'), { recursive: true })
    mkdirSync(desktopDir, { recursive: true })

    const day = (n: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return toDateString(d)
    }
    const carried = (date: string, path: string, cost: number): DailyEntry => {
      const projects = { vault: { cost, calls: 1, savingsUSD: 0, sessions: 1, path } }
      return {
        date,
        cost,
        savingsUSD: 0,
        calls: 1,
        sessions: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        editTurns: 0,
        oneShotTurns: 0,
        models: {},
        categories: {},
        providers: { claude: { calls: 1, cost, savingsUSD: 0, sessions: 1, projects } },
        projects,
        carried: true,
      }
    }
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: getDailyCacheConfigHash(),
      tzKey: currentTzKey(),
      lastComputedDate: day(1),
      days: [carried(day(3), '/a/vault', 2), carried(day(2), '/b/vault', 3)],
      complete: true,
      watermarkTrusted: true,
    }
    writeFileSync(join(cacheDir, `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify(cache))

    const period = getDateRange('week')
    const payload = await buildMenubarPayloadForRange(period, { provider: 'all', optimize: false, timeline: false })
    const ids = payload.current.topProjects.map(p => [p.id, p.cost] as const).sort()
    expect(ids).toEqual([['/a/vault', 2], ['/b/vault', 3]])
    expect(payload.current.topProjects.reduce((s, p) => s + p.cost, 0)).toBe(5)
  })
})
