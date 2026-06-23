import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, beforeAll } from 'vitest'
import { buildCodexChatsReport, buildMenubarPayloadForRange } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import type { ProjectSummary, SessionSummary, TaskCategory } from '../src/types.js'

const taskCategories: TaskCategory[] = [
  'coding',
  'debugging',
  'feature',
  'refactoring',
  'testing',
  'exploration',
  'planning',
  'delegation',
  'git',
  'build/deploy',
  'conversation',
  'brainstorming',
  'general',
]

function emptyCategoryBreakdown(): SessionSummary['categoryBreakdown'] {
  return Object.fromEntries(taskCategories.map(category => [
    category,
    { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  ])) as SessionSummary['categoryBreakdown']
}

function codexTurn(message: string, sessionId = 'fixture-session', timestamp = '2026-06-10T12:00:00Z'): SessionSummary['turns'][number] {
  return {
    userMessage: message,
    assistantCalls: [],
    timestamp,
    sessionId,
    category: 'conversation',
    retries: 0,
    hasEdits: false,
  }
}

function codexSession(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId'>): SessionSummary {
  return {
    project: 'CodeBurn',
    firstTimestamp: '2026-06-10T12:00:00Z',
    lastTimestamp: '2026-06-10T12:01:00Z',
    totalCostUSD: 0,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 0,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: emptyCategoryBreakdown(),
    skillBreakdown: {},
    subagentBreakdown: {},
    ...overrides,
  }
}

function codexProject(project: string, projectPath: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project,
    projectPath,
    sessions,
    totalCostUSD: sessions.reduce((sum, session) => sum + session.totalCostUSD, 0),
    totalSavingsUSD: sessions.reduce((sum, session) => sum + session.totalSavingsUSD, 0),
    totalApiCalls: sessions.reduce((sum, session) => sum + session.apiCalls, 0),
    totalProxiedCostUSD: 0,
  }
}

describe('buildMenubarPayloadForRange', () => {
  beforeAll(async () => { await loadPricing() })

  it('uses worktree task slug as chat fallback title', () => {
    const now = new Date('2026-06-11T12:00:00.000Z')
    const report = buildCodexChatsReport([
      codexProject('x', 'Users/test/.codex/worktrees/baza/codex/v/podrazdele/dublikaty/tovarov', [
        codexSession({
          sessionId: 'session-312c1ed3',
          apiCalls: 1,
          firstTimestamp: '2026-06-10T12:00:00Z',
          lastTimestamp: '2026-06-10T12:01:00Z',
          turns: [codexTurn('# AGENTS.md instructions', 'session-312c1ed3')],
          modelBreakdown: {
            m: {
              calls: 1,
              costUSD: 1,
              savingsUSD: 0,
              tokens: {
                inputTokens: 1,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
              },
            },
          },
          totalInputTokens: 1,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalCostUSD: 1,
        }),
      ]),
    ], 48, 5000, now)

    const chat = report.chats.find(c => c.sessionId === 'session-312c1ed3')

    expect(chat?.projectDisplayName).toBe('Baza')
    expect(chat?.chatTitle).toBe('V Podrazdele Dublikaty Tovarov')
  })

  it('normalizes Codex worktree sessions to stable project display names', () => {
    const now = new Date('2026-06-11T12:00:00.000Z')
    const report = buildCodexChatsReport([
      codexProject('x1', 'Users/test/.codex/worktrees/baza/codex/v/podrazdele/dublikaty/tovarov', [
        codexSession({
          sessionId: 'session-a',
          apiCalls: 1,
          firstTimestamp: '2026-06-10T12:00:00Z',
          lastTimestamp: '2026-06-10T12:01:00Z',
          turns: [codexTurn('fix duplicates', 'session-a')],
          totalInputTokens: 100,
          totalOutputTokens: 10,
        }),
      ]),
      codexProject('x2', 'Users/test/.codex/worktrees/baza/codex/pri/sozdanii/novoi/fasovki/v/tovare', [
        codexSession({
          sessionId: 'session-b',
          apiCalls: 1,
          firstTimestamp: '2026-06-10T12:02:00Z',
          lastTimestamp: '2026-06-10T12:03:00Z',
          turns: [codexTurn('fix totals', 'session-b', '2026-06-10T12:02:00Z')],
          totalInputTokens: 200,
          totalOutputTokens: 20,
        }),
      ]),
    ], 48, 5000, now)

    const targetChats = report.chats.filter(chat => ['session-a', 'session-b'].includes(chat.sessionId))

    expect(targetChats.map(chat => chat.projectDisplayName)).toEqual(['Baza', 'Baza'])
    expect(targetChats.reduce((sum, chat) => sum + chat.totalTokens, 0)).toBe(330)
  })

  it('filters Codex chat report by last message time and recalculates totals', async () => {
    const oldCodexHome = process.env['CODEX_HOME']
    const codexHome = await mkdtemp(join(tmpdir(), 'codeburn-empty-codex-state-'))
    const now = new Date('2026-06-11T12:00:00.000Z')
    try {
      process.env['CODEX_HOME'] = codexHome
      const makeSession = (id: string, lastSeenAt: string, tokens: number, cost: number, reasoning = 0) => codexSession({
        sessionId: id,
        apiCalls: 2,
        firstTimestamp: '2026-06-01T00:00:00.000Z',
        lastTimestamp: lastSeenAt,
        turns: [codexTurn(`chat ${id}`, id, lastSeenAt || '2026-06-01T00:00:00.000Z')],
        modelBreakdown: {
          'gpt-5': {
            calls: 2,
            costUSD: cost,
            savingsUSD: 0,
            tokens: {
              inputTokens: tokens,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              cachedInputTokens: 0,
              reasoningTokens: reasoning,
              webSearchRequests: 0,
            },
          },
        },
        totalInputTokens: tokens,
        totalOutputTokens: 0,
        totalReasoningTokens: reasoning,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalCostUSD: cost,
      })
      const projects = [
        codexProject('CodeBurn', '/Users/test/codeburn', [
          makeSession('recent', '2026-06-11T10:00:00.000Z', 100, 1, 7),
          makeSession('boundary', '2026-06-10T12:00:00.000Z', 200, 2, 11),
          makeSession('older', '2026-06-10T00:00:00.000Z', 400, 4, 13),
          { ...makeSession('missing-last', '', 800, 8), lastTimestamp: '' },
        ]),
      ]

      const day = buildCodexChatsReport(projects, 24, 5000, now)
      const twoDays = buildCodexChatsReport(projects, 48, 5000, now)

      expect(day.chats.map(chat => chat.sessionId)).toEqual(['recent', 'boundary'])
      expect(day.totalChats).toBe(2)
      expect(day.totals.calls).toBe(4)
      expect(day.totals.reasoningTokens).toBe(18)
      expect(day.totals.totalTokens).toBe(318)
      expect(day.totals.cost).toBe(3)

      expect(twoDays.chats.map(chat => chat.sessionId)).toEqual(['recent', 'boundary', 'older'])
      expect(twoDays.totalChats).toBe(3)
      expect(twoDays.totals.calls).toBe(6)
      expect(twoDays.totals.reasoningTokens).toBe(31)
      expect(twoDays.totals.totalTokens).toBe(731)
      expect(twoDays.totals.cost).toBe(7)
    } finally {
      if (oldCodexHome === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = oldCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('matches short parsed session ids to Codex sqlite thread titles', async () => {
    const oldCodexHome = process.env['CODEX_HOME']
    const codexHome = await mkdtemp(join(tmpdir(), 'codeburn-codex-state-'))
    const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
    try {
      process.env['CODEX_HOME'] = codexHome
      const now = Math.floor(Date.now() / 1000)
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          created_at INTEGER,
          updated_at INTEGER,
          tokens_used INTEGER,
          model TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT,
          archived INTEGER
        );
        INSERT INTO threads VALUES (
          '019eb10c-56e1-7bd3-9020-ddd32b5e38df',
          ${now - 60},
          ${now},
          0,
          'gpt-5',
          '/Users/test/Documents/Codex Project/Life',
          'Fix proxy for normal sites',
          NULL,
          0
        );
      `)
      db.close()

      const report = buildCodexChatsReport([
        codexProject('Life', '/Users/test/Documents/Codex Project/Life', [
          codexSession({
          sessionId: '2b5e38df',
          apiCalls: 1,
          firstTimestamp: new Date((now - 60) * 1000).toISOString(),
          lastTimestamp: new Date(now * 1000).toISOString(),
          chatTitle: '# AGENTS.md instructions',
          turns: [codexTurn('# AGENTS.md instructions', '2b5e38df', new Date((now - 60) * 1000).toISOString())],
          totalInputTokens: 1,
          }),
        ]),
      ], 48)

      expect(report.chats).toHaveLength(1)
      expect(report.chats[0]?.chatTitle).toBe('Fix proxy for normal sites')
    } finally {
      try { db.close() } catch {}
      if (oldCodexHome === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = oldCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('uses fresh Codex sqlite token totals for display only', async () => {
    const oldCodexHome = process.env['CODEX_HOME']
    const codexHome = await mkdtemp(join(tmpdir(), 'codeburn-live-token-state-'))
    const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
    const nowDate = new Date('2026-06-11T12:00:00.000Z')
    const now = Math.floor(nowDate.getTime() / 1000)
    try {
      process.env['CODEX_HOME'] = codexHome
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          created_at INTEGER,
          updated_at INTEGER,
          tokens_used INTEGER,
          model TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT,
          archived INTEGER
        );
        INSERT INTO threads VALUES (
          '019eb10c-56e1-7bd3-9020-ddd32b5e38df',
          ${now - 60},
          ${now - 60},
          1000,
          'gpt-5',
          '/Users/test/Documents/Codex Project/Life',
          'Fresh active chat',
          NULL,
          0
        );
        INSERT INTO threads VALUES (
          '019eb10c-56e1-7bd3-9020-ddd32b5e38d0',
          ${now - 900},
          ${now - 301},
          2000,
          'gpt-5',
          '/Users/test/Documents/Codex Project/Life',
          'Stale active chat',
          NULL,
          0
        );
      `)
      db.close()

      const report = buildCodexChatsReport([
        codexProject('Life', '/Users/test/Documents/Codex Project/Life', [
          codexSession({
          sessionId: '019eb10c-56e1-7bd3-9020-ddd32b5e38df',
          apiCalls: 1,
          firstTimestamp: new Date((now - 60) * 1000).toISOString(),
          lastTimestamp: new Date((now - 60) * 1000).toISOString(),
          chatTitle: 'Fresh parsed chat',
          turns: [codexTurn('fresh parsed chat', '019eb10c-56e1-7bd3-9020-ddd32b5e38df', new Date((now - 60) * 1000).toISOString())],
          modelBreakdown: {
            'gpt-5': {
              calls: 1,
              costUSD: 0.5,
              savingsUSD: 0,
              tokens: {
                inputTokens: 100,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
              },
            },
          },
          totalInputTokens: 100,
          totalOutputTokens: 0,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalCostUSD: 0.5,
          }),
          codexSession({
          sessionId: '019eb10c-56e1-7bd3-9020-ddd32b5e38d0',
          apiCalls: 1,
          firstTimestamp: new Date((now - 900) * 1000).toISOString(),
          lastTimestamp: new Date((now - 301) * 1000).toISOString(),
          chatTitle: 'Stale parsed chat',
          turns: [codexTurn('stale parsed chat', '019eb10c-56e1-7bd3-9020-ddd32b5e38d0', new Date((now - 301) * 1000).toISOString())],
          modelBreakdown: {
            'gpt-5': {
              calls: 1,
              costUSD: 1,
              savingsUSD: 0,
              tokens: {
                inputTokens: 200,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
              },
            },
          },
          totalInputTokens: 200,
          totalOutputTokens: 0,
          totalReasoningTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalCostUSD: 1,
          }),
        ]),
      ], 48, 5000, nowDate)

      const fresh = report.chats.find(chat => chat.sessionId.endsWith('2b5e38df'))
      const stale = report.chats.find(chat => chat.sessionId.endsWith('2b5e38d0'))

      expect(fresh?.inputTokens).toBe(1000)
      expect(fresh?.totalTokens).toBe(1000)
      expect(fresh?.models[0]?.inputTokens).toBe(1000)
      expect(fresh?.cost).toBe(0.5)
      expect(fresh?.calls).toBe(1)

      expect(stale?.inputTokens).toBe(200)
      expect(stale?.totalTokens).toBe(200)
      expect(stale?.models[0]?.inputTokens).toBe(200)
      expect(report.totals.inputTokens).toBe(1200)
      expect(report.totals.totalTokens).toBe(1200)
      expect(report.totals.cost).toBe(1.5)
    } finally {
      try { db.close() } catch {}
      if (oldCodexHome === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = oldCodexHome
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('returns a valid payload and skips optimize findings when optimize:false', async () => {
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { provider: 'all', optimize: false })
    expect(typeof payload.current.label).toBe('string')
    expect(payload.current.cost).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(payload.current.topProjects)).toBe(true)
    expect(Array.isArray(payload.current.topModels)).toBe(true)
    expect(Array.isArray(payload.history.daily)).toBe(true)
    expect(payload.current.retryTax.totalUSD).toBeGreaterThanOrEqual(0)
    // optimize:false => scanAndDetect skipped => empty optimize block regardless of data
    expect(payload.optimize).toEqual({ findingCount: 0, savingsUSD: 0, topFindings: [] })
  })
})
