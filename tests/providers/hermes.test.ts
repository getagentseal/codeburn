import { mkdir, mkdtemp, rm } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateCost } from '../../src/models.js'
import { createHermesProvider } from '../../src/providers/hermes.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import type { DateRange } from '../../src/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string
let cacheDir: string
let originalHermesHome: string | undefined
let originalCodeburnCacheDir: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hermes-provider-test-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'hermes-provider-cache-'))
  originalHermesHome = process.env['HERMES_HOME']
  originalCodeburnCacheDir = process.env['CODEBURN_CACHE_DIR']
})

afterEach(async () => {
  if (originalHermesHome === undefined) delete process.env['HERMES_HOME']
  else process.env['HERMES_HOME'] = originalHermesHome
  if (originalCodeburnCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCodeburnCacheDir
  await rm(tmpDir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

function createHermesDb(homeDir: string): string {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const dbPath = join(homeDir, 'state.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      api_call_count INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      started_at REAL,
      ended_at REAL,
      title TEXT
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL
    )
  `)
  db.close()
  return dbPath
}

function createLegacyHermesDb(homeDir: string): string {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const dbPath = join(homeDir, 'state.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      started_at REAL
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      timestamp REAL NOT NULL
    )
  `)
  db.close()
  return dbPath
}

async function createProfileHermesDb(hermesHome: string, profile: string): Promise<string> {
  const profileDir = join(hermesHome, 'profiles', profile)
  await mkdir(profileDir, { recursive: true })
  return createHermesDb(profileDir)
}

function insertSession(db: TestDb, values: {
  id: string
  source?: string
  model?: string
  billingProvider?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCost?: number | null
  actualCost?: number | null
  apiCalls?: number
  toolCalls?: number
  startedAt: number
  title?: string
}): void {
  db.prepare(
    `INSERT INTO sessions (
      id, source, model, billing_provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd,
      actual_cost_usd, api_call_count, tool_call_count, started_at, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    values.source ?? 'cli',
    values.model ?? 'gpt-5.5',
    values.billingProvider ?? 'openai-codex',
    values.inputTokens,
    values.outputTokens,
    values.cacheReadTokens,
    values.cacheWriteTokens,
    values.reasoningTokens,
    values.estimatedCost ?? null,
    values.actualCost ?? null,
    values.apiCalls ?? 1,
    values.toolCalls ?? 0,
    values.startedAt,
    values.title ?? values.id,
  )
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function dayRange(): DateRange {
  return {
    start: new Date('2026-05-23T00:00:00.000Z'),
    end: new Date('2026-05-23T23:59:59.999Z'),
  }
}

async function loadParserWithHermesHome(hermesHome: string, codeburnCacheDir: string) {
  process.env['HERMES_HOME'] = hermesHome
  process.env['CODEBURN_CACHE_DIR'] = codeburnCacheDir
  vi.resetModules()
  const parser = await import('../../src/parser.js')
  return parser
}

async function collectCalls(hermesHome: string, sourcePath: string): Promise<ParsedProviderCall[]> {
  const provider = createHermesProvider(hermesHome)
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser({ path: sourcePath, project: 'hermes', provider: 'hermes' }, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('hermes provider', () => {
  it('discovers state.db sessions with token usage', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'session-1',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
        startedAt: 1779549200,
        title: 'Test Project',
      })
      db.prepare(
        `INSERT INTO sessions (id, source, model, input_tokens, output_tokens, started_at, title)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('empty', 'cli', 'gpt-5.5', 0, 0, 1779549300, 'Empty')
    })

    const provider = createHermesProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('hermes')
    expect(sessions[0]!.path).toBe(`${dbPath}#hermes-session=session-1`)
    expect(sessions[0]!.project).toBe('default')
  })

  it('parses session-level token usage and tool calls from messages', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'session-1',
        source: 'tui',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
        reasoningTokens: 25,
        estimatedCost: 0.12,
        apiCalls: 3,
        toolCalls: 2,
        startedAt: 1779549200,
        title: 'Provider Work',
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('session-1', 'user', 'Add Hermes support', 1779549201)
      db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(
          'session-1',
          'assistant',
          '',
          JSON.stringify([
            { function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/file.ts' }) } },
            { function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test' }) } },
          ]),
          1779549202,
        )
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=session-1`)
    expect(calls).toHaveLength(1)
    expect(calls[0]!).toMatchObject({
      provider: 'hermes',
      model: 'gpt-5.5',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 40,
      cachedInputTokens: 300,
      reasoningTokens: 25,
      costUSD: 0.12,
      userMessage: 'Add Hermes support',
      sessionId: 'session-1',
      deduplicationKey: 'hermes:default:session-1',
    })
    expect(calls[0]!.tools).toEqual(['Read', 'Bash'])
    expect(calls[0]!.bashCommands).toEqual(['npm test'])
    expect(calls[0]!.toolSequence).toEqual([
      [{ tool: 'Read', file: '/tmp/file.ts' }, { tool: 'Bash', command: 'npm test' }],
    ])
  })


  it('maps composio MCP tools before generic MCP prefixes', () => {
    const provider = createHermesProvider(tmpDir)
    expect(provider.toolDisplayName('mcp_composio_GMAIL_SEND_EMAIL')).toBe('MCP')
    expect(provider.toolDisplayName('mcp__github__create_issue')).toBe('mcp__github__create_issue')
  })

  it('falls back to calculateCost when no actual or estimated cost is recorded', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'no-cost-session',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 50,
        estimatedCost: null,
        actualCost: null,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('no-cost-session', 'user', 'Test calculateCost fallback', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=no-cost-session`)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(calculateCost('claude-sonnet-4-20250514', 1000, 250, 0, 0, 0))
    expect(calls[0]!.reasoningTokens).toBe(50)
  })

  it('does not split multibyte characters when truncating the first user message', async () => {
    const dbPath = createHermesDb(tmpDir)
    const message = `${'a'.repeat(499)}😀truncated tail`
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'emoji-session',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedCost: 0.01,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('emoji-session', 'user', message, 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=emoji-session`)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe(`${'a'.repeat(499)}😀`)
  })

  it('parses legacy databases that predate optional accounting columns', async () => {
    const dbPath = createLegacyHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO sessions (id, model, input_tokens, output_tokens, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('legacy-session', 'gpt-5.5', 12, 34, 1779549200)
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('legacy-session', 'user', 'Legacy Hermes DB', 1779549201)
    })

    const provider = createHermesProvider(tmpDir)
    const discovered = await provider.discoverSessions()
    expect(discovered.map(s => s.path)).toEqual([`${dbPath}#hermes-session=legacy-session`])

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=legacy-session`)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      userMessage: 'Legacy Hermes DB',
    })
  })

  it('discovers root and profile databases and preserves Hermes DB accounting through parser aggregation', async () => {
    const rootDbPath = createHermesDb(tmpDir)
    const profileDbPath = await createProfileHermesDb(tmpDir, 'coder')

    withTestDb(rootDbPath, (db) => {
      insertSession(db, {
        id: 'root-session',
        model: 'gpt-5.5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        reasoningTokens: 5,
        estimatedCost: 0.25,
        actualCost: 0.30,
        startedAt: 1779494400,
        title: 'Root session',
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('root-session', 'user', 'Current working directory: /tmp/root-project\nImplement root support', 1779494401)
    })
    withTestDb(profileDbPath, (db) => {
      insertSession(db, {
        id: 'profile-session',
        model: 'gpt-5.5',
        inputTokens: 200,
        outputTokens: 70,
        cacheReadTokens: 11,
        cacheWriteTokens: 13,
        reasoningTokens: 17,
        estimatedCost: 0.42,
        actualCost: null,
        startedAt: 1779501600,
        title: 'Profile session',
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('profile-session', 'user', 'Current working directory: /tmp/profile-project\nImplement profile support', 1779501601)
    })

    const provider = createHermesProvider(tmpDir)
    const discovered = await provider.discoverSessions()
    expect(discovered.map(s => s.path).sort()).toEqual([
      `${profileDbPath}#hermes-session=profile-session`,
      `${rootDbPath}#hermes-session=root-session`,
    ].sort())
    expect(discovered.map(s => s.project).sort()).toEqual(['coder', 'default'])

    const rootCalls = await collectCalls(tmpDir, `${rootDbPath}#hermes-session=root-session`)
    const profileCalls = await collectCalls(tmpDir, `${profileDbPath}#hermes-session=profile-session`)
    expect(rootCalls[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, reasoningTokens: 5, costUSD: 0.30 })
    expect(profileCalls[0]).toMatchObject({ inputTokens: 200, outputTokens: 70, cacheReadInputTokens: 11, cacheCreationInputTokens: 13, reasoningTokens: 17, costUSD: 0.42 })

    const { clearSessionCache, parseAllSessions } = await loadParserWithHermesHome(tmpDir, cacheDir)
    clearSessionCache()
    const projects = await parseAllSessions(dayRange(), 'hermes')
    const sessions = projects.flatMap(project => project.sessions)
    expect(sessions).toHaveLength(2)
    expect(sessions.reduce((sum, session) => sum + session.totalInputTokens, 0)).toBe(300)
    expect(sessions.reduce((sum, session) => sum + session.totalOutputTokens, 0)).toBe(90)
    expect(sessions.reduce((sum, session) => sum + session.totalReasoningTokens, 0)).toBe(22)
    expect(sessions.reduce((sum, session) => sum + session.totalCacheReadTokens, 0)).toBe(41)
    expect(sessions.reduce((sum, session) => sum + session.totalCacheWriteTokens, 0)).toBe(53)
    expect(sessions.reduce((sum, session) => sum + session.totalCostUSD, 0)).toBeCloseTo(0.72)
    expect(projects.map(project => project.project).sort()).toEqual(['tmp-profile-project', 'tmp-root-project'])

    const modelTokens = sessions.flatMap(session => Object.values(session.modelBreakdown).map(model => model.tokens))
    expect(modelTokens.reduce((sum, tokens) => sum + tokens.outputTokens, 0)).toBe(90)
    expect(modelTokens.reduce((sum, tokens) => sum + tokens.reasoningTokens, 0)).toBe(22)
  })

  it('treats sibling profile-like directories as default sessions', async () => {
    const profileLikeDir = join(dirname(tmpDir), `${basename(tmpDir)}-profiles_backup`, 'coder')
    await mkdir(profileLikeDir, { recursive: true })
    const dbPath = createHermesDb(profileLikeDir)

    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'sibling-session',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('sibling-session', 'user', 'Sibling profile-like directory', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=sibling-session`)
    expect(calls[0]).toMatchObject({
      deduplicationKey: 'hermes:default:sibling-session',
      project: 'default',
    })
  })

  it('infers projects from Windows current working directory messages', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'windows-cwd-session',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('windows-cwd-session', 'user', 'Current working directory: C:\\AI_LAB\\OPENCLAW\nAdd Windows path support', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=windows-cwd-session`)
    expect(calls[0]).toMatchObject({
      project: 'C--AI_LAB-OPENCLAW',
      projectPath: 'C:\\AI_LAB\\OPENCLAW',
    })
  })
})
