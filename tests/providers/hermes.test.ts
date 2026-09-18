import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { tmpdir, homedir } from 'os'
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
  process.env['HERMES_HOME'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  const { resetHermesSessionLedgerForTests } = await import('../../src/hermes-session-ledger.js')
  resetHermesSessionLedgerForTests()
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
      cwd TEXT,
      git_repo_root TEXT,
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
  cwd?: string | null
  gitRepoRoot?: string | null
  billingProvider?: string
  costStatus?: string
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
      id, source, model, cwd, git_repo_root, billing_provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd,
      actual_cost_usd, cost_status, api_call_count, tool_call_count, started_at, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    values.source ?? 'cli',
    values.model ?? 'gpt-5.5',
    values.cwd ?? null,
    values.gitRepoRoot ?? null,
    values.billingProvider ?? 'openai-codex',
    values.inputTokens,
    values.outputTokens,
    values.cacheReadTokens,
    values.cacheWriteTokens,
    values.reasoningTokens,
    values.estimatedCost ?? null,
    values.actualCost ?? null,
    values.costStatus ?? null,
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
    expect(sessions[0]!.project).toBe('hermes')
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

  it('carries the billing route the session recorded, and stays silent for every other door', async () => {
    // billing_provider is the door the call went through; it was SELECTed and
    // dropped before #1450. The direct `anthropic` door has no route: its row
    // IS the direct row. `openrouter` joined `bedrock` once usage-bearing
    // sessions existed (#1451); `bedrock-mantle` is still a real Hermes value
    // with no sessions on disk, so it is treated as an unknown door.
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      const rows: Array<[string, string, string]> = [
        ['route-bedrock', 'openai.gpt-5.6-luna', 'bedrock'],
        ['route-plain-id-bedrock', 'claude-sonnet-4-5', 'bedrock'],
        ['route-openrouter', 'claude-sonnet-4-5', 'openrouter'],
        ['route-codex', 'gpt-5.6-sol', 'openai-codex'],
        ['route-anthropic', 'claude-fable-5-1', 'anthropic'],
        ['route-mantle', 'claude-fable-5-1', 'bedrock-mantle'],
      ]
      for (const [id, model, billingProvider] of rows) {
        insertSession(db, { id, model, billingProvider, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, startedAt: 1779549200 })
        db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(id, 'user', 'hi', 1779549201)
      }
    })

    const byId = new Map<string, ParsedProviderCall>()
    for (const id of ['route-bedrock', 'route-plain-id-bedrock', 'route-openrouter', 'route-codex', 'route-anthropic', 'route-mantle']) {
      const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=${id}`)
      expect(calls, id).toHaveLength(1)
      byId.set(id, calls[0]!)
    }
    expect(byId.get('route-bedrock')!.route).toBe('bedrock')
    expect(byId.get('route-plain-id-bedrock')!.route).toBe('bedrock')
    expect(byId.get('route-openrouter')!.route).toBe('openrouter')
    for (const id of ['route-codex', 'route-anthropic', 'route-mantle']) {
      expect(byId.get(id)!.route, id).toBeUndefined()
    }
  })

  it('carries the billing mode only where the session recorded the cost basis', async () => {
    // Hermes resolves each session's cost to a basis. `included` is usage a
    // subscription already paid for; an `actual` amount is a recorded invoice
    // line, so it is metered — an explicit $0 still counts as recorded, which
    // is what the two OpenRouter `:free` sessions of 2026-09-18 look like. An
    // estimate proves nothing about which account was charged, so it carries
    // no mode at all rather than being guessed into one.
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      const rows: Array<{ id: string; billingProvider: string; costStatus?: string; actualCost?: number | null }> = [
        { id: 'basis-included', billingProvider: 'openai-codex', costStatus: 'included' },
        { id: 'basis-actual', billingProvider: 'anthropic', actualCost: 0.42 },
        { id: 'basis-openrouter-free', billingProvider: 'openrouter', actualCost: 0 },
        { id: 'basis-estimated', billingProvider: 'anthropic', costStatus: 'estimated' },
        { id: 'basis-calculated', billingProvider: 'anthropic' },
        // A recorded `included` outranks the door's own metered default.
        { id: 'basis-included-on-bedrock', billingProvider: 'bedrock', costStatus: 'included' },
      ]
      for (const row of rows) {
        insertSession(db, {
          id: row.id, model: 'claude-sonnet-4-5', billingProvider: row.billingProvider,
          costStatus: row.costStatus, actualCost: row.actualCost ?? null, estimatedCost: row.costStatus === 'estimated' ? 0.01 : null,
          inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, startedAt: 1779549200,
        })
        db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(row.id, 'user', 'hi', 1779549201)
      }
    })

    const byId = new Map<string, ParsedProviderCall>()
    for (const id of ['basis-included', 'basis-actual', 'basis-openrouter-free', 'basis-estimated', 'basis-calculated', 'basis-included-on-bedrock']) {
      const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=${id}`)
      expect(calls, id).toHaveLength(1)
      byId.set(id, calls[0]!)
    }
    expect(byId.get('basis-included')!.billing).toBe('subscription')
    expect(byId.get('basis-included-on-bedrock')!.billing).toBe('subscription')
    expect(byId.get('basis-actual')!.billing).toBe('metered')
    expect(byId.get('basis-openrouter-free')!.billing).toBe('metered')
    expect(byId.get('basis-openrouter-free')!.route).toBe('openrouter')
    for (const id of ['basis-estimated', 'basis-calculated']) {
      expect(byId.get(id)!.billing, id).toBeUndefined()
    }
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
    expect(discovered.map(s => s.project).sort()).toEqual(['coder', 'hermes'])

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
    // Prompt-derived names remain useful for local grouping, but never become
    // trusted projectPath/workingDirectory provenance.
    expect(projects.map(project => project.project).sort()).toEqual(['tmp-profile-project', 'tmp-root-project'])

    const modelTokens = sessions.flatMap(session => Object.values(session.modelBreakdown).map(model => model.tokens))
    expect(modelTokens.reduce((sum, tokens) => sum + tokens.outputTokens, 0)).toBe(90)
    expect(modelTokens.reduce((sum, tokens) => sum + tokens.reasoningTokens, 0)).toBe(22)
  })

  // Regression for issue #913: Hermes writes state.db in WAL mode and keeps
  // the writer connection open for the life of the agent, so recent sessions
  // live in state.db-wal while the main file's mtime stays at the last
  // checkpoint. The date-range mtime pre-filter in parseProviderSources
  // then reads the source as "older than the range" and skips it, and every
  // session committed since the last checkpoint disappears from reports.
  // The fingerprint must fold the -wal sibling in so a stale main-file stat
  // cannot hide fresh sessions.
  it('still parses sessions committed to the WAL when the main db stat is checkpoint-stale', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'wal-session',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
        title: 'WAL Session',
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('wal-session', 'user', 'Session committed after the last checkpoint', 1779549201)
    })

    // Simulate the WAL-mode stat shape: the main file's mtime predates the
    // requested range (last checkpoint days ago), while a fresh -wal sibling
    // holds the recent commits. The db itself was written in rollback-journal
    // mode, so SQLite ignores the stray -wal on open; only its stat matters.
    const beforeRange = new Date('2026-05-20T00:00:00.000Z')
    await utimes(dbPath, beforeRange, beforeRange)
    await writeFile(`${dbPath}-wal`, 'wal-frames')

    const { clearSessionCache, parseAllSessions } = await loadParserWithHermesHome(tmpDir, cacheDir)
    clearSessionCache()
    const projects = await parseAllSessions(dayRange(), 'hermes')
    const sessions = projects.flatMap(project => project.sessions)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.totalInputTokens).toBe(100)
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
      project: 'hermes',
    })
  })

  it('does not attribute pull URLs without an origin-backed workspace', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'pr-session',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('pr-session', 'assistant', 'Opened https://github.com/getagentseal/codeburn/pull/1037 for review', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=pr-session`)
    expect(calls[0]?.prLinks).toBeUndefined()
    expect(calls[0]?.project).toBe('hermes')
  })

  it('captures GitHub pull URLs that are wrapped in prose punctuation', async () => {
    const repo = join(tmpDir, 'punct-repo')
    await mkdir(join(repo, '.git'), { recursive: true })
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/getagentseal/codeburn.git\n')
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'pr-punct',
        gitRepoRoot: repo,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('pr-punct', 'assistant', 'See (https://github.com/getagentseal/codeburn/pull/1037).', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=pr-punct`)
    expect(calls[0]?.prLinks).toEqual(['https://github.com/getagentseal/codeburn/pull/1037'])
  })

  it('ignores GitHub pull URLs that only appear in tool dumps', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'tool-pr-noise',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('tool-pr-noise', 'tool', 'https://github.com/getagentseal/codeburn/pull/677 https://github.com/getagentseal/codeburn/pull/691', 1779549201)
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('tool-pr-noise', 'assistant', 'Closed the stale draft. Next is Keychain.', 1779549202)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=tool-pr-noise`)
    expect(calls[0]?.prLinks).toBeUndefined()
  })

  it('keeps ACP sessions on Hermes because source=acp is a transport, not Buzz', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'acp-session',
        source: 'acp',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('acp-session', 'user', 'hello from buzz', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=acp-session`)
    expect(calls[0]).toMatchObject({
      provider: 'hermes',
      project: 'hermes',
    })
  })

  it('does not treat $HOME as a project', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'home-cwd',
        source: 'desktop',
        cwd: homedir(),
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('home-cwd', 'user', 'hi', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=home-cwd`)
    expect(calls[0]?.provider).toBe('hermes')
    expect(calls[0]?.project).toBe('hermes')
    expect(calls[0]?.workingDirectory).toBeUndefined()
  })

  it('does not treat a relative cwd as a workspace', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'rel-cwd',
        source: 'desktop',
        cwd: '.',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('rel-cwd', 'user', 'hi', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=rel-cwd`)
    expect(calls[0]?.project).toBe('hermes')
    expect(calls[0]?.projectPath).toBeUndefined()
  })

  it('ignores fenced and unrelated-repo pull URLs when a git root is known', async () => {
    const repo = join(tmpDir, 'codeburn-src')
    await mkdir(join(repo, '.git'), { recursive: true })
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/getagentseal/codeburn.git\n')
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'pr-filter',
        gitRepoRoot: repo,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(
          'pr-filter',
          'assistant',
          [
            'Opened https://github.com/getagentseal/codeburn/pull/1037',
            'Also see https://github.com/evil/codeburn/pull/2',
            '```',
            'https://github.com/getagentseal/codeburn/pull/677',
            '```',
            '~~~',
            'https://github.com/getagentseal/codeburn/pull/4',
            '~~~',
          ].join('\n'),
          1779549201,
        )
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=pr-filter`)
    expect(calls[0]?.prLinks).toEqual(['https://github.com/getagentseal/codeburn/pull/1037'])
    expect(calls[0]?.project).toBe('codeburn-src')
  })

  it('uses origin even when another remote is listed first', async () => {
    const repo = join(tmpDir, 'multi-remote')
    await mkdir(join(repo, '.git'), { recursive: true })
    await writeFile(
      join(repo, '.git', 'config'),
      [
        '[remote "evil"]',
        '\turl = https://github.com/evil/codeburn.git',
        '[remote "origin"]',
        '\turl = https://github.com/getagentseal/codeburn.git',
        '',
      ].join('\n'),
    )
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'origin-wins',
        gitRepoRoot: repo,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(
          'origin-wins',
          'assistant',
          'https://github.com/evil/codeburn/pull/3 https://github.com/getagentseal/codeburn/pull/4',
          1779549201,
        )
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=origin-wins`)
    expect(calls[0]?.prLinks).toEqual(['https://github.com/getagentseal/codeburn/pull/4'])
  })

  it('emits no pull links when only upstream exists', async () => {
    const repo = join(tmpDir, 'upstream-only')
    await mkdir(join(repo, '.git'), { recursive: true })
    await writeFile(join(repo, '.git', 'config'), '[remote "upstream"]\n\turl = https://github.com/getagentseal/codeburn.git\n')
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'upstream-only',
        gitRepoRoot: repo,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('upstream-only', 'assistant', 'https://github.com/getagentseal/codeburn/pull/2', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=upstream-only`)
    expect(calls[0]?.prLinks).toBeUndefined()
  })

  it('ignores unclosed fenced pull URLs', async () => {
    const repo = join(tmpDir, 'unclosed-fence')
    await mkdir(join(repo, '.git'), { recursive: true })
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/getagentseal/codeburn.git\n')
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'unclosed',
        gitRepoRoot: repo,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(
          'unclosed',
          'assistant',
          'Opened https://github.com/getagentseal/codeburn/pull/8\n~~~\nhttps://github.com/getagentseal/codeburn/pull/6',
          1779549201,
        )
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=unclosed`)
    expect(calls[0]?.prLinks).toEqual(['https://github.com/getagentseal/codeburn/pull/8'])
  })

  it('ignores unclosed backtick fences and non-GitHub origin', async () => {
    const repo = join(tmpDir, 'unclosed-tick')
    await mkdir(join(repo, '.git'), { recursive: true })
    await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/getagentseal/codeburn.git\n')
    const other = join(tmpDir, 'gitlab-origin')
    await mkdir(join(other, '.git'), { recursive: true })
    await writeFile(join(other, '.git', 'config'), '[remote "origin"]\n\turl = git@gitlab.com:getagentseal/codeburn.git\n')
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'unclosed-tick',
        gitRepoRoot: repo,
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        startedAt: 1779549200,
      })
      insertSession(db, {
        id: 'gitlab-origin',
        gitRepoRoot: other,
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        startedAt: 1779549300,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('unclosed-tick', 'assistant', 'Opened https://github.com/getagentseal/codeburn/pull/10\n```\nhttps://github.com/getagentseal/codeburn/pull/11', 1779549201)
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('gitlab-origin', 'assistant', 'https://github.com/getagentseal/codeburn/pull/12', 1779549301)
    })

    const tick = await collectCalls(tmpDir, `${dbPath}#hermes-session=unclosed-tick`)
    expect(tick[0]?.prLinks).toEqual(['https://github.com/getagentseal/codeburn/pull/10'])
    const gitlab = await collectCalls(tmpDir, `${dbPath}#hermes-session=gitlab-origin`)
    expect(gitlab[0]?.prLinks).toBeUndefined()
  })

  it('reads origin from a linked worktree commondir', async () => {
    const common = join(tmpDir, 'main.git')
    const worktreeGit = join(tmpDir, 'main.git', 'worktrees', 'wt')
    const repo = join(tmpDir, 'linked-wt')
    await mkdir(worktreeGit, { recursive: true })
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, '.git'), `gitdir: ${worktreeGit}\n`)
    await writeFile(join(worktreeGit, 'commondir'), `${common}\n`)
    await writeFile(join(common, 'config'), '[remote "origin"]\n\turl = git@github.com:getagentseal/codeburn.git\n')
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'wt-origin',
        gitRepoRoot: repo,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('wt-origin', 'assistant', 'https://github.com/getagentseal/codeburn/pull/9', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=wt-origin`)
    expect(calls[0]?.prLinks).toEqual(['https://github.com/getagentseal/codeburn/pull/9'])
  })

  it('rejects a slash-UNC path as a workspace on POSIX', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'unc-cwd',
        source: 'desktop',
        cwd: '//server/share/repo',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('unc-cwd', 'user', 'hi', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=unc-cwd`)
    expect(calls[0]?.project).toBe('hermes')
    expect(calls[0]?.projectPath).toBeUndefined()
  })

  it('takes a drive-letter cwd as a workspace only on a Windows host', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'drive-cwd',
        source: 'desktop',
        cwd: 'C:\\repos\\codeburn',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('drive-cwd', 'user', 'hi', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=drive-cwd`)
    // A state.db is only ever read from this host's own Hermes home, so a
    // drive-letter path is a real workspace on Windows and an odd relative
    // filename anywhere else.
    if (process.platform === 'win32') {
      expect(calls[0]?.projectPath).toBe('C:\\repos\\codeburn')
      expect(calls[0]?.workingDirectory).toBe('C:\\repos\\codeburn')
    } else {
      expect(calls[0]?.project).toBe('hermes')
      expect(calls[0]?.projectPath).toBeUndefined()
    }
  })

  it('never promotes prompt text into project or cwd provenance', async () => {
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
        .run('windows-cwd-session', 'user', 'Current working directory: /tmp/secret-client\nAdd path support', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=windows-cwd-session`)
    expect(calls[0]?.project).toBe('tmp-secret-client')
    expect(calls[0]?.projectPath).toBeUndefined()
    expect(calls[0]?.workingDirectory).toBeUndefined()
  })

  it('groups by the sessions.cwd column when present, ahead of message scraping', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'cwd-session',
        cwd: '/Users/me/projects/codeburn',
        inputTokens: 30,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run('cwd-session', 'user', 'Current working directory: /tmp/decoy\nbuild it', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=cwd-session`)
    expect(calls[0]).toMatchObject({
      project: 'Users-me-projects-codeburn',
      projectPath: '/Users/me/projects/codeburn',
      workingDirectory: '/Users/me/projects/codeburn',
    })
  })

  it('flags estimated cost only when Hermes recorded none', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'no-cost',
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        startedAt: 1779549200,
      })
      insertSession(db, {
        id: 'recorded-cost',
        actualCost: 1.23,
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        startedAt: 1779549300,
      })
    })

    const noCost = await collectCalls(tmpDir, `${dbPath}#hermes-session=no-cost`)
    expect(noCost[0]!.costIsEstimated).toBe(true)

    const recorded = await collectCalls(tmpDir, `${dbPath}#hermes-session=recorded-cost`)
    expect(recorded[0]).toMatchObject({ costUSD: 1.23, costIsEstimated: false })
  })

  it('counts tool-result messages by their tool_name', async () => {
    const dbPath = createHermesDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, {
        id: 'tool-result-session',
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        startedAt: 1779549200,
      })
      db.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('tool-result-session', 'tool', null, 'read_file', 1779549201)
    })

    const calls = await collectCalls(tmpDir, `${dbPath}#hermes-session=tool-result-session`)
    expect(calls[0]!.tools).toContain('Read')
  })
})
