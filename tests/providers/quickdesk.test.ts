import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { calculateCost, getShortModelName } from '../../src/models.js'
import { providers } from '../../src/providers/index.js'
import { quickdesk } from '../../src/providers/quickdesk.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let quickworkHome: string
let originalQuickworkHome: string | undefined
let externalDirs: string[]

beforeEach(async () => {
  quickworkHome = await mkdtemp(join(tmpdir(), 'quickdesk-provider-test-'))
  originalQuickworkHome = process.env['QUICKWORK_HOME']
  process.env['QUICKWORK_HOME'] = quickworkHome
  externalDirs = []
})

afterEach(async () => {
  if (originalQuickworkHome === undefined) delete process.env['QUICKWORK_HOME']
  else process.env['QUICKWORK_HOME'] = originalQuickworkHome
  await rm(quickworkHome, { recursive: true, force: true })
  for (const path of externalDirs) await rm(path, { recursive: true, force: true })
})

async function writeMetrics(basePath: string, date: string, lines: Array<Record<string, unknown> | string>): Promise<string> {
  const metricsDir = join(basePath, 'metrics')
  await mkdir(metricsDir, { recursive: true })
  const path = join(metricsDir, `metrics-${date}.jsonl`)
  await writeFile(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
  return path
}

async function writeProfiles(entries: Array<{ id: string, data_path: string }>): Promise<void> {
  await writeFile(join(quickworkHome, 'profiles.json'), JSON.stringify({ last_active: entries[0]?.id, entries }))
}

async function createSessionsDb(basePath: string, withMessages = true): Promise<string> {
  const sessionsDir = join(basePath, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const dbPath = join(sessionsDir, 'sessions.db')
  const { DatabaseSync: Database } = requireForTest('node:sqlite') as {
    DatabaseSync: new (path: string) => TestDb
  }
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at REAL,
      updated_at REAL,
      message_count INTEGER,
      agent_mode TEXT,
      deleted_at REAL
    )
  `)
  if (withMessages) {
    db.exec(`
      CREATE TABLE session_messages (
        session_id TEXT,
        role TEXT,
        content TEXT,
        timestamp REAL,
        tool_names TEXT
      )
    `)
  }
  db.close()
  return dbPath
}

function withDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite') as {
    DatabaseSync: new (path: string) => TestDb
  }
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

async function collectCalls(sources: SessionSource[]): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  const seenKeys = new Set<string>()
  for (const source of sources) {
    for await (const call of quickdesk.createSessionParser(source, seenKeys).parse()) calls.push(call)
  }
  return calls
}

describe('quickdesk pure metrics', () => {
  it('parses metrics without requiring a SQLite fixture', async () => {
    await writeMetrics(quickworkHome, '2026-07-17', [
      { Model: 'claude-sonnet-4-5', InputTokens: 12, OutputTokens: 6, CostUSD: 0.002 },
    ])

    const calls = await collectCalls(await quickdesk.discoverSessions())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'quickdesk',
      inputTokens: 12,
      outputTokens: 6,
      costUSD: 0.002,
      costIsEstimated: false,
    })
  })

  it('discovers an absolute data_path outside the store root', async () => {
    const absoluteBase = await mkdtemp(join(tmpdir(), 'quickdesk-absolute-profile-'))
    externalDirs.push(absoluteBase)
    await writeProfiles([{ id: 'absolute-profile', data_path: absoluteBase }])
    const metricsPath = await writeMetrics(absoluteBase, '2026-07-18', [
      { Model: 'claude-sonnet-4-5', InputTokens: 9, OutputTokens: 3, CostUSD: 0.001 },
    ])

    expect(await quickdesk.discoverSessions()).toEqual([{
      path: metricsPath,
      project: 'absolute-profile',
      provider: 'quickdesk',
      sourceId: 'metrics',
      sourcePath: absoluteBase,
    }])
    expect(await quickdesk.probeRoots?.()).toEqual([{ path: absoluteBase, label: 'absolute-profile' }])
  })

  it('namespaces session-less metric keys by profile', async () => {
    const firstBase = join(quickworkHome, 'profiles', 'first')
    const secondBase = join(quickworkHome, 'profiles', 'second')
    await writeProfiles([
      { id: 'first-profile', data_path: 'profiles/first' },
      { id: 'second-profile', data_path: 'profiles/second' },
    ])
    const row = { Model: 'claude-sonnet-4-5', InputTokens: 20, OutputTokens: 5, CostUSD: 0.003 }
    await writeMetrics(firstBase, '2026-07-19', [row])
    await writeMetrics(secondBase, '2026-07-19', [row])

    const calls = await collectCalls(await quickdesk.discoverSessions())
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.deduplicationKey)).toEqual([
      'quickdesk:first-profile:metrics-2026-07-19.jsonl:2026-07-19T00:00:00.000Z:claude-sonnet-4-5:20:5',
      'quickdesk:second-profile:metrics-2026-07-19.jsonl:2026-07-19T00:00:00.000Z:claude-sonnet-4-5:20:5',
    ])
  })
})

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('quickdesk provider', () => {
  it('discovers every profile data_path and parses EMF usage, linked tools, real cost, and malformed lines', async () => {
    const firstBase = join(quickworkHome, 'stores', 'alpha-data')
    const secondBase = join(quickworkHome, 'custom-location', 'beta-data')
    await writeProfiles([
      { id: 'profile-alpha', data_path: 'stores/alpha-data' },
      { id: 'profile-beta', data_path: 'custom-location/beta-data' },
    ])
    await writeMetrics(firstBase, '2026-07-14', [
      '{malformed json',
      { _aws: { Timestamp: 1783987200000 } },
      { session_id: 'session-alpha', ToolName: 'read_file', ToolCallCount: 1 },
      {
        _aws: { Timestamp: 1783987200123 },
        session_id: 'session-alpha',
        thread_id: 'thread-1',
        Model: 'claude-sonnet-4-5',
        InputTokens: 120,
        OutputTokens: 30,
        CostUSD: 0.0042,
      },
    ])
    await writeMetrics(secondBase, '2026-07-15', [
      { session_id: 'session-beta', Model: 'claude-sonnet-4-5', InputTokens: 40, OutputTokens: 10 },
    ])

    const sources = await quickdesk.discoverSessions()
    expect(sources.map(source => [source.project, source.sourcePath])).toEqual([
      ['profile-alpha', firstBase],
      ['profile-beta', secondBase],
    ])
    expect(await quickdesk.probeRoots?.()).toEqual([
      { path: firstBase, label: 'profile-alpha' },
      { path: secondBase, label: 'profile-beta' },
    ])

    const calls = await collectCalls(sources)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      provider: 'quickdesk',
      model: 'claude-sonnet-4-5',
      inputTokens: 120,
      outputTokens: 30,
      costUSD: 0.0042,
      costIsEstimated: false,
      tools: ['Read'],
      timestamp: '2026-07-14T00:00:00.123Z',
      sessionId: 'session-alpha',
      project: 'profile-alpha',
    })
    expect(calls[0]!.deduplicationKey).toBe(
      'quickdesk:session-alpha:2026-07-14T00:00:00.123Z:claude-sonnet-4-5:120:30',
    )
    expect(calls[1]).toMatchObject({
      inputTokens: 40,
      outputTokens: 10,
      costIsEstimated: true,
      timestamp: '2026-07-15T00:00:00.000Z',
      project: 'profile-beta',
    })
    expect(calls[1]!.costUSD).toBe(calculateCost('claude-sonnet-4-5', 40, 10, 0, 0, 0))
  })

  it('falls back to the legacy store root when profiles.json is absent', async () => {
    const metricsPath = await writeMetrics(quickworkHome, '2026-07-16', [
      { Model: 'claude-sonnet-4-5', InputTokens: 8, OutputTokens: 4, CostUSD: 0.001 },
    ])

    const sources = await quickdesk.discoverSessions()
    expect(sources).toEqual([{
      path: metricsPath,
      project: 'default',
      provider: 'quickdesk',
      sourceId: 'metrics',
      sourcePath: quickworkHome,
    }])
    expect(await quickdesk.probeRoots?.()).toEqual([{ path: quickworkHome, label: 'default' }])

    const calls = await collectCalls(sources)
    expect(calls[0]).toMatchObject({
      sessionId: 'metrics-2026-07-16.jsonl',
      project: 'default',
      userMessage: '',
    })
  })

  it('emits sessions from active profiles and a coexisting migrated legacy root database', async () => {
    const profileBase = join(quickworkHome, 'profiles', 'active-data')
    await writeProfiles([{ id: 'active-profile', data_path: 'profiles/active-data' }])
    const profileDbPath = await createSessionsDb(profileBase)
    const legacyDbPath = await createSessionsDb(quickworkHome)

    withDb(profileDbPath, db => {
      db.prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('profile-session', 'Profile session', 1783987200, 1783987300, 2, 'agent', null)
      db.prepare(
        'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
      ).run('profile-session', 'user', 'profile prompt', 1783987201, null)
      db.prepare(
        'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
      ).run('profile-session', 'assistant', 'profile answer', 1783987202, null)
    })
    withDb(legacyDbPath, db => {
      db.prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('legacy-session', 'Legacy session', 1777507200, 1777507300, 2, 'agent', null)
      db.prepare(
        'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
      ).run('legacy-session', 'user', 'legacy prompt', 1777507201, null)
      db.prepare(
        'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
      ).run('legacy-session', 'assistant', 'legacy answer', 1777507202, null)
    })

    const sources = await quickdesk.discoverSessions()
    expect(sources.map(source => [source.project, source.path])).toEqual([
      ['active-profile', profileDbPath],
      ['default', legacyDbPath],
    ])
    const calls = await collectCalls(sources)
    expect(calls.map(call => [call.project, call.sessionId])).toEqual([
      ['active-profile', 'profile-session'],
      ['default', 'legacy-session'],
    ])
  })

  it('suppresses database estimates globally when profile metrics contain the migrated session id', async () => {
    const profileBase = join(quickworkHome, 'profiles', 'active-data')
    await writeProfiles([{ id: 'active-profile', data_path: 'profiles/active-data' }])
    const profileDbPath = await createSessionsDb(profileBase)
    const legacyDbPath = await createSessionsDb(quickworkHome)

    for (const dbPath of [profileDbPath, legacyDbPath]) {
      withDb(dbPath, db => {
        db.prepare(
          'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run('shared-session', 'Shared session', 1783987200, 1783987300, 2, 'agent', null)
        db.prepare(
          'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
        ).run('shared-session', 'user', 'shared prompt', 1783987201, null)
        db.prepare(
          'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
        ).run('shared-session', 'assistant', 'shared answer', 1783987202, null)
      })
    }
    await writeMetrics(profileBase, '2026-07-14', [{
      session_id: 'shared-session',
      Model: 'claude-sonnet-4-5',
      InputTokens: 40,
      OutputTokens: 10,
      CostUSD: 0.004,
    }])

    const calls = await collectCalls(await quickdesk.discoverSessions())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'shared-session',
      costUSD: 0.004,
      costIsEstimated: false,
    })
    expect(calls.filter(call => call.costIsEstimated)).toHaveLength(0)
  })

  it('enriches metrics and estimates only non-deleted sessions absent from all metrics', async () => {
    const dbPath = await createSessionsDb(quickworkHome)
    withDb(dbPath, db => {
      const insertSession = db.prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      insertSession.run('metered', 'Metered session', 1783900800, 1783900900, 2, 'agent', null)
      insertSession.run('fallback', 'Fallback session', 1783987200, 1783987300, 3, 'agent', null)
      insertSession.run('deleted', 'Deleted session', 1784073600, 1784073700, 2, 'agent', 1784073800)

      const insertMessage = db.prepare(
        'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
      )
      insertMessage.run('metered', 'user', 'metered prompt', 1783900801, null)
      insertMessage.run('metered', 'assistant', 'metered answer', 1783900802, '["write_file"]')
      insertMessage.run('fallback', 'user', '12345678', 1783987201, null)
      insertMessage.run('fallback', 'tool', '1234', 1783987202, '["run_command"]')
      insertMessage.run('fallback', 'assistant', '123456789', 1783987203, null)
      insertMessage.run('deleted', 'user', 'must not appear', 1784073601, null)
      insertMessage.run('deleted', 'assistant', 'deleted answer', 1784073602, null)
    })
    await writeMetrics(quickworkHome, '2026-07-13', [
      { session_id: 'metered', thread_id: 'thread-a', ToolName: 'read_file' },
      {
        session_id: 'metered',
        thread_id: 'thread-a',
        Model: 'claude-sonnet-4-5',
        InputTokens: 50,
        OutputTokens: 20,
        CostUSD: 0.003,
      },
      {
        session_id: 'deleted',
        Model: 'claude-sonnet-4-5',
        InputTokens: 99,
        OutputTokens: 99,
        CostUSD: 0.9,
      },
    ])

    const calls = await collectCalls(await quickdesk.discoverSessions())
    expect(calls.map(call => call.sessionId)).toEqual(['metered', 'fallback'])
    expect(calls[0]).toMatchObject({
      userMessage: 'metered prompt',
      tools: ['Read', 'Edit'],
      costIsEstimated: false,
    })
    expect(calls[1]).toMatchObject({
      model: 'quickdesk-auto',
      inputTokens: 3,
      outputTokens: 3,
      costIsEstimated: true,
      tools: ['Bash'],
      timestamp: '2026-07-14T00:00:00.000Z',
      deduplicationKey: 'quickdesk-est:fallback',
      userMessage: '12345678',
    })
    expect(calls[1]!.costUSD).toBeGreaterThan(0)
  })

  it('treats millisecond sessions.created_at values as milliseconds', async () => {
    const dbPath = await createSessionsDb(quickworkHome)
    withDb(dbPath, db => {
      db.prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('milliseconds-session', 'Milliseconds', 1783987200000, 1783987300000, 2, 'agent', null)
      db.prepare(
        'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
      ).run('milliseconds-session', 'user', 'millisecond prompt', 1783987201, null)
      db.prepare(
        'INSERT INTO session_messages (session_id, role, content, timestamp, tool_names) VALUES (?, ?, ?, ?, ?)',
      ).run('milliseconds-session', 'assistant', 'millisecond answer', 1783987202, null)
    })

    const calls = await collectCalls(await quickdesk.discoverSessions())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'milliseconds-session',
      timestamp: '2026-07-14T00:00:00.000Z',
      costIsEstimated: true,
    })
  })

  it('keeps metrics when sessions.db has no session_messages table', async () => {
    const dbPath = await createSessionsDb(quickworkHome, false)
    withDb(dbPath, db => {
      db.prepare(
        'INSERT INTO sessions (id, title, created_at, updated_at, message_count, agent_mode, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('metrics-only', 'Metrics only', 1783987200, 1783987300, 0, 'agent', null)
    })
    await writeMetrics(quickworkHome, '2026-07-14', [
      {
        session_id: 'metrics-only',
        Model: 'claude-sonnet-4-5',
        InputTokens: 16,
        OutputTokens: 4,
        CostUSD: 0.002,
      },
    ])

    await expect(collectCalls(await quickdesk.discoverSessions())).resolves.toMatchObject([{
      sessionId: 'metrics-only',
      inputTokens: 16,
      outputTokens: 4,
      userMessage: '',
    }])
  })

  it('uses raw display values outside the small obvious maps', () => {
    expect(providers).toContain(quickdesk)
    expect(quickdesk.modelDisplayName('quickdesk-auto')).toBe('Quick Desktop (auto)')
    expect(getShortModelName('quickdesk-auto')).toBe('Quick Desktop (auto)')
    expect(quickdesk.modelDisplayName('claude-sonnet-4-5')).toBe('Sonnet 4.5')
    expect(quickdesk.modelDisplayName('future-model')).toBe('future-model')
    expect(quickdesk.toolDisplayName('read_file')).toBe('Read')
    expect(quickdesk.toolDisplayName('future_tool')).toBe('future_tool')
  })
})
