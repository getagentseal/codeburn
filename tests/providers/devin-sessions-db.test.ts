import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { calculateCost } from '../../src/models.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createDevinProvider } from '../../src/providers/devin.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import { setHome } from '../setup/home.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'devin-sessions-db-'))
  setHome(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

type Metrics = { input_tokens: number; output_tokens: number; cache_read_tokens: number | null; cache_creation_tokens: number | null }

function assistant(requestId: string, model: string, createdAt: string, metrics: Metrics, tools: string[] = []) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: tools.map((name, index) => ({ id: `c${index}`, name, arguments: {}, index, kind: 'function' })),
    metadata: { request_id: requestId, generation_model: model, created_at: createdAt, metrics, is_user_input: null },
  }
}

function user(content: string, isUserInput: boolean | null) {
  return { role: 'user', content, metadata: { is_user_input: isUserInput, request_id: null, metrics: null } }
}

function createDb(): string {
  const { DatabaseSync: Database } = require('node:sqlite')
  const dbPath = join(tmpDir, 'sessions.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT, model TEXT NOT NULL,
      agent_mode TEXT, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT,
      main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT
    );
    CREATE TABLE prompt_history (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, timestamp INTEGER NOT NULL, session_id TEXT NOT NULL, is_shell INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT,
      UNIQUE(session_id, node_id)
    );
  `)
  const session = db.prepare('INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, main_chain_id, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  session.run('alpha', '/Users/example/work/codeburn', 'swe-2-high', 1_800_000_000, 1_800_000_100, null, 7, 0)
  session.run('ghost', '/Users/example/work/hidden', 'swe-2-high', 1_800_000_000, 1_800_000_100, 'Hidden', 1, 1)
  db.prepare('INSERT INTO prompt_history (content, timestamp, session_id) VALUES (?, ?, ?)').run('fix the ledger', 1_800_000_000, 'alpha')

  const node = db.prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)')
  const add = (sessionId: string, id: number, parent: number | null, message: unknown) =>
    node.run(sessionId, id, parent, JSON.stringify(message), 1_800_000_000)
  const r1 = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 400, cache_creation_tokens: null }

  add('alpha', 1, null, { role: 'system', content: 'You are Devin.' })
  add('alpha', 2, 1, user('fix the ledger tests', true))
  add('alpha', 3, 2, assistant('r1', 'kimi-k3-high', '2027-01-15T08:00:01Z', r1, ['exec']))
  // A sibling retry of the same request: identical metrics, must count once.
  add('alpha', 4, 2, assistant('r1', 'kimi-k3-high', '2027-01-15T08:00:01Z', r1, ['exec']))
  add('alpha', 5, 3, { role: 'tool', content: 'ok' })
  add('alpha', 6, 5, user('continue', null))
  add('alpha', 7, 6, assistant('r2', 'gpt-6-sol-high', '2027-01-15T08:00:02Z', { input_tokens: 30, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: 50 }))
  // Off the main chain (a branch from node 2): a distinct request that counts.
  add('alpha', 8, 2, assistant('r3', 'swe-2-high', '2027-01-15T08:00:03Z', { input_tokens: 10, output_tokens: 1, cache_read_tokens: null, cache_creation_tokens: null }))
  add('alpha', 9, 7, assistant('r4', 'compactor', '2027-01-15T08:00:04Z', { input_tokens: 7, output_tokens: 3, cache_read_tokens: null, cache_creation_tokens: null }))
  add('ghost', 1, null, assistant('g1', 'swe-2-high', '2027-01-15T08:00:05Z', r1))
  db.close()
  return dbPath
}

async function parseAll(provider = createDevinProvider(tmpDir)): Promise<ParsedProviderCall[]> {
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of await provider.discoverSessions()) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('devin provider sessions.db usage', () => {
  it('reads usage from message_nodes, one call per request id', async () => {
    const dbPath = createDb()
    const provider = createDevinProvider(tmpDir)

    expect(await provider.discoverSessions()).toEqual([
      { path: `${dbPath}:alpha`, project: 'codeburn', provider: 'devin' },
    ])

    const calls = await parseAll(provider)
    expect(calls.map(c => c.deduplicationKey)).toEqual([
      'devin:alpha:r1', 'devin:alpha:r2', 'devin:alpha:r3', 'devin:alpha:r4',
    ])
    expect(calls[0]).toMatchObject({
      provider: 'devin',
      model: 'Kimi K3',
      // input_tokens already excludes cache reads: nothing carved out.
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 0,
      costUSD: calculateCost('kimi-k3-high', 100, 20, 0, 400, 0),
      tools: ['exec'],
      timestamp: '2027-01-15T08:00:01Z',
      userMessage: 'fix the ledger tests',
      sessionId: 'alpha',
      project: 'codeburn',
      projectPath: '/Users/example/work/codeburn',
    })
    expect(calls[1]).toMatchObject({
      model: 'GPT-6 Sol (high)',
      inputTokens: 30,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 50,
      costUSD: calculateCost('gpt-6-sol', 30, 5, 50, 0, 0),
      // A cache_keepalive "continue" is not the user's prompt.
      userMessage: 'fix the ledger tests',
    })
    expect(calls[1]!.costUSD).toBeGreaterThan(0)
    expect(calls[2]).toMatchObject({ model: 'swe-2-high', costUSD: 0, inputTokens: 10 })
    expect(calls[3]).toMatchObject({ model: 'compactor', costUSD: 0, inputTokens: 7 })
  })

  it('skips transcripts when sessions.db is readable, so an overlap never double counts', async () => {
    createDb()
    const transcripts = join(tmpDir, 'transcripts')
    await mkdir(transcripts, { recursive: true })
    await writeFile(join(transcripts, 'alpha.json'), JSON.stringify({
      session_id: 'alpha',
      steps: [{ step_id: 3, source: 'agent', metrics: { prompt_tokens: 500, completion_tokens: 20, cached_tokens: 400 } }],
    }))

    const calls = await parseAll()
    expect(calls).toHaveLength(4)
    expect(calls.every(c => c.deduplicationKey.startsWith('devin:alpha:r'))).toBe(true)
  })

  it('falls back to transcripts when sessions.db has no message_nodes', async () => {
    const { DatabaseSync: Database } = require('node:sqlite')
    const db = new Database(join(tmpDir, 'sessions.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, model TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT, hidden INTEGER NOT NULL DEFAULT 0)')
    db.close()
    const transcripts = join(tmpDir, 'transcripts')
    await mkdir(transcripts, { recursive: true })
    await writeFile(join(transcripts, 'beta.json'), JSON.stringify({
      session_id: 'beta',
      steps: [{ step_id: 1, source: 'agent', metrics: { prompt_tokens: 50, completion_tokens: 5 } }],
    }))

    const calls = await parseAll()
    expect(calls.map(c => c.deduplicationKey)).toEqual(['devin:beta:1'])
  })

  it('does not parse a hidden session even when asked directly', async () => {
    const dbPath = createDb()
    const provider = createDevinProvider(tmpDir)
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser({ path: `${dbPath}:ghost`, project: 'hidden', provider: 'devin' }, new Set()).parse()) calls.push(call)
    expect(calls).toEqual([])
  })
})
