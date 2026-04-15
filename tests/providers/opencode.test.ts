import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'

import { createOpenCodeProvider } from '../../src/providers/opencode.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'opencode-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function createTestDb(dir: string): Promise<string> {
  const ocDir = join(dir, 'opencode')
  await mkdir(ocDir, { recursive: true })
  const dbPath = join(ocDir, 'opencode.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT NOT NULL
    );
  `)
  db.close()
  return dbPath
}

describe('opencode provider - model display names', () => {
  it('strips provider prefix and date suffix', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('claude-opus-4-6-20260205')).toBe(
      'Opus 4.6',
    )
  })

  it('handles google provider prefix', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('google/gemini-2.5-pro')).toBe(
      'Gemini 2.5 Pro',
    )
  })

  it('maps known models', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('gpt-4o')).toBe('GPT-4o')
    expect(provider.modelDisplayName('gpt-4o-mini')).toBe('GPT-4o Mini')
  })

  it('returns unknown models as-is', () => {
    const provider = createOpenCodeProvider()
    expect(provider.modelDisplayName('big-pickle')).toBe('big-pickle')
  })
})

describe('opencode provider - tool display names', () => {
  it('maps opencode builtins', () => {
    const provider = createOpenCodeProvider()
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('edit')).toBe('Edit')
    expect(provider.toolDisplayName('task')).toBe('Agent')
    expect(provider.toolDisplayName('fetch')).toBe('WebFetch')
  })

  it('returns unknown tools as-is', () => {
    const provider = createOpenCodeProvider()
    expect(provider.toolDisplayName('github_search_code')).toBe(
      'github_search_code',
    )
  })
})

describe('opencode provider - session discovery', () => {
  it('discovers sessions from database', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)
    db.prepare(
      `
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-1',
      'proj-1',
      'slug-1',
      '/home/user/myproject',
      'My Project',
      '1.0',
      1700000000000,
    )
    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('opencode')
    expect(sessions[0]!.project).toBe('home-user-myproject')
    expect(sessions[0]!.path).toContain('sess-1')
  })

  it('excludes archived sessions', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)
    db.prepare(
      `
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-archived',
      'proj-1',
      'slug-1',
      '/home/user/myproject',
      'My Project',
      '1.0',
      1700000000000,
      1700000001000,
    )
    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(0)
  })

  it('excludes child sessions', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)
    db.prepare(
      `
      INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-child',
      'proj-1',
      'parent-id',
      'slug-1',
      '/home/user/myproject',
      'My Project',
      '1.0',
      1700000000000,
    )
    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(0)
  })

  it('returns empty for non-existent database', async () => {
    const provider = createOpenCodeProvider('/nonexistent/path')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('returns empty for empty database', async () => {
    await createTestDb(tmpDir)
    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('uses title when directory is empty', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)
    db.prepare(
      `
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-1',
      'proj-1',
      'slug-1',
      '',
      'My Session Title',
      '1.0',
      1700000000000,
    )
    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions[0]!.project).toBe('My Session Title')
  })
})

describe('opencode provider - session parsing', () => {
  it('parses assistant messages with tokens and tools', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)

    db.prepare(
      `
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-1',
      'proj-1',
      'slug-1',
      '/home/user/myproject',
      'My Project',
      '1.0',
      1700000000000,
    )

    db.prepare(
      `
      INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'msg-1',
      'sess-1',
      1700000000000,
      JSON.stringify({
        role: 'user',
        time: { created: 1700000000000 },
        agent: 'default',
        model: { providerID: 'anthropic', modelID: 'claude-opus-4-6' },
        format: 'text',
      }),
    )

    db.prepare(
      `
      INSERT INTO part (id, message_id, session_id, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'part-1',
      'msg-1',
      'sess-1',
      JSON.stringify({ type: 'text', text: 'fix the login bug' }),
    )

    db.prepare(
      `
      INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'msg-2',
      'sess-1',
      1700000001000,
      JSON.stringify({
        role: 'assistant',
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: 'msg-1',
        modelID: 'claude-opus-4-6',
        providerID: 'anthropic',
        mode: 'code',
        agent: 'default',
        path: { cwd: '/tmp', root: '/tmp' },
        cost: 0.05,
        tokens: {
          input: 100,
          output: 200,
          reasoning: 50,
          cache: { read: 500, write: 300 },
        },
      }),
    )

    db.prepare(
      `
      INSERT INTO part (id, message_id, session_id, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'part-2',
      'msg-2',
      'sess-1',
      JSON.stringify({
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: {},
          output: 'ok',
          title: 'bash',
          metadata: {},
          time: { start: 1700000001100, end: 1700000001200 },
        },
      }),
    )

    db.prepare(
      `
      INSERT INTO part (id, message_id, session_id, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'part-3',
      'msg-2',
      'sess-1',
      JSON.stringify({
        type: 'tool',
        callID: 'call-2',
        tool: 'edit',
        state: {
          status: 'completed',
          input: {},
          output: 'ok',
          title: 'edit',
          metadata: {},
          time: { start: 1700000001300, end: 1700000001400 },
        },
      }),
    )

    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const source = {
      path: `${dbPath}:sess-1`,
      project: 'myproject',
      provider: 'opencode',
    }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('opencode')
    expect(call.model).toBe('claude-opus-4-6')
    expect(call.inputTokens).toBe(100)
    expect(call.outputTokens).toBe(200)
    expect(call.reasoningTokens).toBe(50)
    expect(call.cacheReadInputTokens).toBe(500)
    expect(call.cacheCreationInputTokens).toBe(300)
    expect(call.tools).toEqual(['bash', 'edit'])
    expect(call.userMessage).toBe('fix the login bug')
    expect(call.sessionId).toBe('sess-1')
    expect(call.timestamp).toBe(new Date(1700000001000).toISOString())
    expect(call.deduplicationKey).toBe('opencode:sess-1:msg-2')
  })

  it('skips zero-token messages with zero cost', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)

    db.prepare(
      `
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-1',
      'proj-1',
      'slug-1',
      '/home/user/myproject',
      'My Project',
      '1.0',
      1700000000000,
    )

    db.prepare(
      `
      INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'msg-1',
      'sess-1',
      1700000001000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    )

    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const source = {
      path: `${dbPath}:sess-1`,
      project: 'myproject',
      provider: 'opencode',
    }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(0)
  })

  it('deduplicates messages', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)

    db.prepare(
      `
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-1',
      'proj-1',
      'slug-1',
      '/home/user/myproject',
      'My Project',
      '1.0',
      1700000000000,
    )

    db.prepare(
      `
      INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'msg-1',
      'sess-1',
      1700000001000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'claude-opus-4-6',
        cost: 0.05,
        tokens: {
          input: 100,
          output: 200,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    )

    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const source = {
      path: `${dbPath}:sess-1`,
      project: 'myproject',
      provider: 'opencode',
    }
    const seenKeys = new Set<string>()

    const parser1 = provider.createSessionParser(source, seenKeys)
    const calls1: ParsedProviderCall[] = []
    for await (const call of parser1.parse()) {
      calls1.push(call)
    }

    const parser2 = provider.createSessionParser(source, seenKeys)
    const calls2: ParsedProviderCall[] = []
    for await (const call of parser2.parse()) {
      calls2.push(call)
    }

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
  })

  it('uses pre-calculated cost for unknown models', async () => {
    const dbPath = await createTestDb(tmpDir)
    const db = new Database(dbPath)

    db.prepare(
      `
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'sess-1',
      'proj-1',
      'slug-1',
      '/home/user/myproject',
      'My Project',
      '1.0',
      1700000000000,
    )

    db.prepare(
      `
      INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'msg-1',
      'sess-1',
      1700000001000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'totally-unknown-model-xyz',
        cost: 0.42,
        tokens: {
          input: 100,
          output: 200,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    )

    db.close()

    const provider = createOpenCodeProvider(tmpDir)
    const source = {
      path: `${dbPath}:sess-1`,
      project: 'myproject',
      provider: 'opencode',
    }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(0.42)
  })
})
