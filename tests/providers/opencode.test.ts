import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createOpenCodeProvider } from '../../src/providers/opencode.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'opencode-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function createTestDb(dir: string): string {
  const ocDir = join(dir, 'opencode')
  mkdirSync(ocDir, { recursive: true })
  const dbPath = join(ocDir, 'opencode.db')

  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER,
      time_updated INTEGER, data TEXT NOT NULL
    )
  `)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  fn(db)
  db.close()
}

function insertSession(
  db: TestDb,
  id: string,
  opts: { directory?: string; title?: string; parentId?: string | null; archived?: number | null } = {},
): void {
  db.prepare(`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_archived, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'proj-1', 'slug-1', opts.directory ?? '/home/user/myproject', opts.title ?? 'My Project', '1.0', 1700000000000, opts.archived ?? null, opts.parentId ?? null)
}

type MessageFixture = {
  role: string
  modelID?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

type PartFixture = {
  type: string
  text?: string
  tool?: string
  state?: { status: string; input: { command?: string } }
}

function insertMessage(db: TestDb, id: string, sessionId: string, timeCreated: number, data: MessageFixture): void {
  db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
    .run(id, sessionId, timeCreated, JSON.stringify(data))
}

function insertPart(db: TestDb, id: string, messageId: string, sessionId: string, data: PartFixture): void {
  db.prepare(`INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)`)
    .run(id, messageId, sessionId, JSON.stringify(data))
}

async function collectCalls(
  provider: ReturnType<typeof createOpenCodeProvider>,
  dbPath: string,
  sessionIdOrSeenKeys?: string | Set<string>,
  seenKeys?: Set<string>,
): Promise<ParsedProviderCall[]> {
  const source = { path: dbPath, project: 'opencode', provider: 'opencode' }
  const keys = sessionIdOrSeenKeys instanceof Set ? sessionIdOrSeenKeys : seenKeys
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, keys ?? new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('opencode provider - model display names', () => {
  it('strips provider prefix and delegates to shared lookup', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('claude-opus-4-6-20260205')).toBe('Opus 4.6')
  })

  it('strips google provider prefix', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('google/gemini-2.5-pro')).toBe('Gemini 2.5 Pro')
  })

  it('strips openai provider prefix', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('openai/gpt-4o')).toBe('GPT-4o')
  })

  it('passes through models without prefix unchanged', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('gpt-4o')).toBe('GPT-4o')
    expect(provider.modelDisplayName('gpt-4o-mini')).toBe('GPT-4o Mini')
  })

  it('returns unknown models as-is', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('big-pickle')).toBe('big-pickle')
  })

  it('has correct displayName', () => {
    const provider = createOpenCodeProvider()
    expect(provider.displayName).toBe('OpenCode')
    expect(provider.name).toBe('opencode')
  })
})

skipUnlessSqlite('opencode provider - tool display names', () => {
  it('maps opencode builtins', () => {
    const provider = createOpenCodeProvider()
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('edit')).toBe('Edit')
    expect(provider.toolDisplayName('task')).toBe('Agent')
    expect(provider.toolDisplayName('fetch')).toBe('WebFetch')
    expect(provider.toolDisplayName('grep')).toBe('Grep')
    expect(provider.toolDisplayName('write')).toBe('Write')
    expect(provider.toolDisplayName('skill')).toBe('Skill')
  })

  it('returns unknown tools as-is', () => {
    const provider = createOpenCodeProvider()
    expect(provider.toolDisplayName('github_search_code')).toBe('github_search_code')
  })
})

skipUnlessSqlite('opencode provider - session discovery', () => {
  it('discovers databases with real filesystem paths', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
    })

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('opencode')
    expect(sessions[0]!.project).toBe('opencode')
    expect(sessions[0]!.path).toBe(dbPath)
  })

  it('discovers the database even when it only contains archived sessions', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-archived', { archived: 1700000001000 })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(dbPath)
  })

  it('discovers the database even when it only contains child sessions', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-child', { parentId: 'parent-id' })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(dbPath)
  })

  it('returns empty for non-existent path', async () => {
    const provider = createOpenCodeProvider('/nonexistent/path')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('discovers empty databases so stale cache entries can be reconciled', async () => {
    const dbPath = createTestDb(tmpDir)
    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(dbPath)
  })

  it('discovers sessions across multiple channel databases', async () => {
    const ocDir = join(tmpDir, 'opencode')
    await mkdir(ocDir, { recursive: true })

    const { DatabaseSync: Database } = require('node:sqlite')
    for (const file of ['opencode.db', 'opencode-dev.db']) {
      const dbPath = join(ocDir, file)
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
          slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
          version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)
      `)
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
      db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
        session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`)
      db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`sess-${file}`, 'proj-1', 'slug-1', '/home/user/myproject', 'My Project', '1.0', 1700000000000)
      db.close()
    }

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('opencode.db'),
        expect.stringContaining('opencode-dev.db'),
      ]),
    )
    expect(sessions.every(s => s.provider === 'opencode')).toBe(true)
  })

  it('ignores non-opencode db files in the directory', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
    })
    await writeFile(join(tmpDir, 'opencode', 'other.db'), '')
    await writeFile(join(tmpDir, 'opencode', 'opencode.txt'), '')

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
  })

  it('uses session project metadata while parsing when directory is empty', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { directory: '', title: 'My Session Title' })
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')
    expect(calls[0]!.project).toBe('My Session Title')
  })

  it('discovers one source for multiple sessions in one database', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { directory: '/home/user/project-a', title: 'A' })
      insertSession(db, 'sess-2', { directory: '/home/user/project-b', title: 'B' })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(dbPath)
  })
})

skipUnlessSqlite('opencode provider - session parsing', () => {
  it('parses all root sessions from one database source', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1', { directory: '/home/user/project-a', title: 'A' })
      insertSession(db, 'sess-2', { directory: '/home/user/project-b', title: 'B' })

      insertMessage(db, 'msg-a1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertMessage(db, 'msg-b1', 'sess-2', 1700000002000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.02,
        tokens: { input: 30, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath)

    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.sessionId).sort()).toEqual(['sess-1', 'sess-2'])
    expect(calls.map(call => call.project).sort()).toEqual([
      'home-user-project-a',
      'home-user-project-b',
    ])
  })

  it('does not parse archived root sessions from a database source', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-archived', { archived: 1700000001000 })
      insertMessage(db, 'msg-archived', 'sess-archived', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath)

    expect(calls).toHaveLength(0)
  })

  it('still accepts legacy compound database/session source paths', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertSession(db, 'sess-2')

      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertMessage(db, 'msg-2', 'sess-2', 1700000002000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.02,
        tokens: { input: 30, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const source = { path: `${dbPath}:sess-2`, project: 'legacy', provider: 'opencode' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('sess-2')
    expect(calls[0]!.deduplicationKey).toBe('opencode:sess-2:msg-2')
  })

  it('parses assistant messages with all fields', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'fix the login bug' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 500, write: 300 } },
      })
      insertPart(db, 'part-2', 'msg-2', 'sess-1', {
        type: 'tool', tool: 'bash',
        state: { status: 'completed', input: { command: 'npm test && git push' } },
      })
      insertPart(db, 'part-3', 'msg-2', 'sess-1', {
        type: 'tool', tool: 'edit', state: { status: 'completed', input: {} },
      })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const calls = await collectCalls(provider, dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('opencode')
    expect(call.model).toBe('claude-opus-4-6')
    expect(call.inputTokens).toBe(100)
    expect(call.outputTokens).toBe(200)
    expect(call.reasoningTokens).toBe(50)
    expect(call.cacheReadInputTokens).toBe(500)
    expect(call.cacheCreationInputTokens).toBe(300)
    expect(call.cachedInputTokens).toBe(500)
    expect(call.webSearchRequests).toBe(0)
    expect(call.speed).toBe('standard')
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.tools).toEqual(['Bash', 'Edit'])
    expect(call.bashCommands).toEqual(['npm', 'git'])
    expect(call.userMessage).toBe('fix the login bug')
    expect(call.sessionId).toBe('sess-1')
    expect(call.timestamp).toBe(new Date(1700000001000).toISOString())
    expect(call.deduplicationKey).toBe('opencode:sess-1:msg-2')
  })

  it('normalizes opencode MCP tool names for shared MCP reporting', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', { type: 'text', text: 'look up the ClickUp task' })

      insertMessage(db, 'msg-2', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-2', 'msg-2', 'sess-1', {
        type: 'tool',
        tool: 'clickup_clickup_get_task',
        state: { status: 'completed', input: {} },
      })
      insertPart(db, 'part-3', 'msg-2', 'sess-1', {
        type: 'tool',
        tool: 'figma_get_file',
        state: { status: 'completed', input: {} },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual([
      'mcp__clickup__clickup_get_task',
      'mcp__figma__get_file',
    ])
  })

  it('preserves already-normalized MCP tool names', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', {
        type: 'tool',
        tool: 'mcp__github__search_code',
        state: { status: 'completed', input: {} },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['mcp__github__search_code'])
  })

  it('keeps extension tool names without a server prefix as regular tools', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', {
        type: 'tool',
        tool: 'customtool',
        state: { status: 'completed', input: {} },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['customtool'])
  })

  it('keeps malformed server-prefixed tool names as regular tools', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-1', 'msg-1', 'sess-1', {
        type: 'tool',
        tool: '_missing_server',
        state: { status: 'completed', input: {} },
      })
      insertPart(db, 'part-2', 'msg-1', 'sess-1', {
        type: 'tool',
        tool: 'missing_',
        state: { status: 'completed', input: {} },
      })
      insertPart(db, 'part-3', 'msg-1', 'sess-1', {
        type: 'tool',
        tool: '_',
        state: { status: 'completed', input: {} },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual([
      '_missing_server',
      'missing_',
      '_',
    ])
  })

  it('skips zero-token messages with zero cost', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(0)
  })

  it('deduplicates messages across parses', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const provider = createOpenCodeProvider(tmpDir)
    const seenKeys = new Set<string>()
    const calls1 = await collectCalls(provider, dbPath, 'sess-1', seenKeys)
    const calls2 = await collectCalls(provider, dbPath, 'sess-1', seenKeys)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
    expect(seenKeys.has('opencode:sess-1:msg-1')).toBe(true)
  })

  it('falls back to pre-calculated cost for unknown models', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'totally-unknown-model-xyz', cost: 0.42,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(0.42)
  })

  it('uses calculated cost over pre-calculated for known models', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 999.99,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
    expect(calls[0]!.costUSD).not.toBe(999.99)
  })

  it('handles missing tokens field gracefully', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.10,
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(0)
    expect(calls[0]!.outputTokens).toBe(0)
    expect(calls[0]!.costUSD).toBe(0.10)
  })

  it('uses "unknown" for missing modelID', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'assistant', cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('unknown')
  })

  it('handles corrupt JSON in message and part data', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
        .run('msg-corrupt', 'sess-1', 1700000000500, 'not valid json {]')

      insertMessage(db, 'msg-valid', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      db.prepare(`INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)`)
        .run('part-corrupt', 'msg-valid', 'sess-1', 'corrupt {[}')

      insertPart(db, 'part-valid', 'msg-valid', 'sess-1', {
        type: 'tool', tool: 'bash', state: { status: 'completed', input: {} },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('claude-opus-4-6')
    expect(calls[0]!.tools).toEqual(['Bash'])
  })

  it('converts seconds-epoch timestamps to milliseconds', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.05,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe(new Date(1700000001 * 1000).toISOString())
  })

  it('skips non-user non-assistant roles', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-1', 'sess-1', 1700000001000, {
        role: 'system', modelID: 'claude-opus-4-6',
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(0)
  })

  it('returns empty for invalid db path', async () => {
    const provider = createOpenCodeProvider(tmpDir)
    const source = { path: '/nonexistent/db.db:sess-1', project: 'test', provider: 'opencode' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })

  it('tracks user messages per assistant response', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-u1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-u1', 'msg-u1', 'sess-1', { type: 'text', text: 'first question' })

      insertMessage(db, 'msg-a1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.01,
        tokens: { input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      insertMessage(db, 'msg-u2', 'sess-1', 1700000002000, { role: 'user' })
      insertPart(db, 'part-u2', 'msg-u2', 'sess-1', { type: 'text', text: 'second question' })

      insertMessage(db, 'msg-a2', 'sess-1', 1700000003000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.02,
        tokens: { input: 80, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[1]!.userMessage).toBe('second question')
  })

  it('attributes child and grandchild session calls back to the root session', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'root')
      insertSession(db, 'child', { parentId: 'root' })
      insertSession(db, 'grandchild', { parentId: 'child' })

      insertMessage(db, 'msg-root-user', 'root', 1700000000000, { role: 'user' })
      insertPart(db, 'part-root-user', 'msg-root-user', 'root', { type: 'text', text: 'root prompt' })
      insertMessage(db, 'msg-root-assistant', 'root', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-root-tool', 'msg-root-assistant', 'root', {
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: {} },
      })

      insertMessage(db, 'msg-child-user', 'child', 1700000002000, { role: 'user' })
      insertPart(db, 'part-child-user', 'msg-child-user', 'child', { type: 'text', text: 'child prompt' })
      insertMessage(db, 'msg-child-assistant', 'child', 1700000003000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.02,
        tokens: { input: 30, output: 40, reasoning: 5, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-child-tool', 'msg-child-assistant', 'child', {
        type: 'tool',
        tool: 'task',
        state: { status: 'completed', input: {} },
      })

      insertMessage(db, 'msg-grand-user', 'grandchild', 1700000004000, { role: 'user' })
      insertPart(db, 'part-grand-user', 'msg-grand-user', 'grandchild', { type: 'text', text: 'grandchild prompt' })
      insertMessage(db, 'msg-grand-assistant', 'grandchild', 1700000005000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.03,
        tokens: { input: 50, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      insertPart(db, 'part-grand-tool', 'msg-grand-assistant', 'grandchild', {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'npm test' } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'root')

    expect(calls).toHaveLength(3)
    expect(calls.map(call => call.sessionId)).toEqual(['root', 'root', 'root'])
    expect(calls.map(call => call.deduplicationKey)).toEqual([
      'opencode:root:msg-root-assistant',
      'opencode:child:msg-child-assistant',
      'opencode:grandchild:msg-grand-assistant',
    ])
    expect(calls.map(call => call.userMessage)).toEqual([
      'root prompt',
      'child prompt',
      'grandchild prompt',
    ])
    expect(calls[0]!.tools).toEqual(['Read'])
    expect(calls[1]!.tools).toEqual(['Agent'])
    expect(calls[2]!.tools).toEqual(['Bash'])
    expect(calls[2]!.bashCommands).toEqual(['npm'])
  })

  it('does not include archived child sessions in the root subtree', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'root')
      insertSession(db, 'archived-child', { parentId: 'root', archived: 1700000002500 })

      insertMessage(db, 'msg-root-assistant', 'root', 1700000001000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      insertMessage(db, 'msg-child-assistant', 'archived-child', 1700000003000, {
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.02,
        tokens: { input: 30, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'root')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.deduplicationKey).toBe('opencode:root:msg-root-assistant')
  })

  it('joins multiple text parts in user messages', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')

      insertMessage(db, 'msg-u1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-a', 'msg-u1', 'sess-1', { type: 'text', text: 'hello' })
      insertPart(db, 'part-b', 'msg-u1', 'sess-1', { type: 'text', text: 'world' })

      insertMessage(db, 'msg-a1', 'sess-1', 1700000001000, {
        role: 'assistant', modelID: 'claude-opus-4-6', cost: 0.01,
        tokens: { input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls[0]!.userMessage).toBe('hello world')
  })

  it('yields nothing for session with only user messages', async () => {
    const dbPath = createTestDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertSession(db, 'sess-1')
      insertMessage(db, 'msg-u1', 'sess-1', 1700000000000, { role: 'user' })
      insertPart(db, 'part-u1', 'msg-u1', 'sess-1', { type: 'text', text: 'hello?' })
    })

    const calls = await collectCalls(createOpenCodeProvider(tmpDir), dbPath, 'sess-1')
    expect(calls).toHaveLength(0)
  })
})
