import { describe, it, expect, afterAll, vi } from 'vitest'
import { createOpenClawProvider } from '../../src/providers/openclaw.js'
import { writeFile, mkdir, rm, stat } from 'fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

let sqliteRuntimeAvailable = true
vi.mock('../../src/sqlite.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sqlite.js')>()
  return {
    ...actual,
    isSqliteAvailable: () => sqliteRuntimeAvailable,
  }
})

const requireForTest = createRequire(import.meta.url)

const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync

const SESSION_LINES = [
  JSON.stringify({ type: 'session', version: 3, id: 'test-sess-1', timestamp: '2026-04-20T10:00:00.000Z', cwd: '/tmp' }),
  JSON.stringify({ type: 'model_change', id: 'mc1', timestamp: '2026-04-20T10:00:01.000Z', provider: 'anthropic', modelId: 'claude-sonnet-4-6' }),
  JSON.stringify({
    type: 'message', id: 'u1', timestamp: '2026-04-20T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
  }),
  JSON.stringify({
    type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:03.000Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hi!' }],
      usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50, totalTokens: 850 },
    },
  }),
  JSON.stringify({
    type: 'message', id: 'a2', timestamp: '2026-04-20T10:00:05.000Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Running command' },
        { type: 'toolCall', name: 'exec', arguments: { command: 'ls -la' } },
        { type: 'toolCall', name: 'read', arguments: { path: '/tmp/x' } },
        { type: 'tool_use', name: 'write', arguments: { path: '/tmp/y' } },
      ],
      usage: { input: 600, output: 200, cacheRead: 100, cacheWrite: 0, totalTokens: 900, cost: { total: 0.05 } },
    },
  }),
]

async function setupFixture(dir: string, agentName: string, sessionId: string, lines: string[]): Promise<string> {
  const sessionsDir = join(dir, agentName, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const filePath = join(sessionsDir, `${sessionId}.jsonl`)
  await writeFile(filePath, lines.join('\n'))
  return filePath
}

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

type TranscriptSeedRow = {
  seq: number
  event: unknown
  createdAt: number
  compress?: boolean
}

type TranscriptSeedSession = {
  sessionId: string
  rows: TranscriptSeedRow[]
}

/// Builds the per-agent store the 2026-09-01 migration writes
/// (<agent>/agent/openclaw-agent.sqlite, #1259). `compressed` recreates the
/// agent-schema 23 column pair (event_json XOR event_zstd); the default
/// fixture matches the v14-v22 shape that shipped in the migration itself.
function createAgentDb(dir: string, agent: string, sessions: TranscriptSeedSession[], options?: { compressed?: boolean }): string {
  const agentDir = join(dir, agent, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const dbPath = join(agentDir, 'openclaw-agent.sqlite')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db: TestDb = new Database(dbPath)
  const zstd = options?.compressed === true
  db.exec(zstd
    ? `CREATE TABLE transcript_events(
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT,
        created_at INTEGER NOT NULL,
        event_zstd BLOB,
        PRIMARY KEY (session_id, seq)
      ) STRICT`
    : `CREATE TABLE transcript_events(
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) STRICT`)
  const insert = db.prepare(
    zstd
      ? 'INSERT INTO transcript_events(session_id, seq, event_json, created_at, event_zstd) VALUES (?, ?, ?, ?, ?)'
      : 'INSERT INTO transcript_events(session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const session of sessions) {
    for (const row of session.rows) {
      const json = JSON.stringify(row.event)
      if (zstd && row.compress) {
        insert.run(session.sessionId, row.seq, null, row.createdAt, zstdCompressSync!(Buffer.from(json, 'utf-8')))
      } else if (zstd) {
        insert.run(session.sessionId, row.seq, json, row.createdAt, null)
      } else {
        insert.run(session.sessionId, row.seq, json, row.createdAt)
      }
    }
  }
  db.close()
  return dbPath
}

function sessionEvents(): { session: unknown; modelChange: unknown; user: unknown; assistant: unknown; assistantCosted: unknown } {
  return {
    session: { type: 'session', version: 3, id: 'test-sess-1', timestamp: '2026-04-20T10:00:00.000Z', cwd: '/tmp' },
    modelChange: { type: 'model_change', id: 'mc1', timestamp: '2026-04-20T10:00:01.000Z', provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    user: { type: 'message', id: 'u1', timestamp: '2026-04-20T10:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } },
    assistant: {
      type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:03.000Z',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Hi!' }], usage: { input: 500, output: 100, cacheRead: 200, cacheWrite: 50, totalTokens: 850 } },
    },
    assistantCosted: {
      type: 'message', id: 'a2', timestamp: '2026-04-20T10:00:05.000Z',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        content: [
          { type: 'text', text: 'Running command' },
          { type: 'toolCall', name: 'exec', arguments: { command: 'ls -la' } },
        ],
        usage: { input: 600, output: 200, cacheRead: 100, cacheWrite: 0, totalTokens: 900, cost: { total: 0.05 } },
      },
    },
  }
}

async function parseAll(provider: ReturnType<typeof createOpenClawProvider>, source: { path: string }, seen: Set<string>): Promise<any[]> {
  const parser = provider.createSessionParser(source as any, seen)
  const calls: any[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('openclaw provider', () => {
  const baseDir = join(tmpdir(), `codeburn-openclaw-test-${Date.now()}`)

  it('discovers sessions in agent directories', async () => {
    const dir = join(baseDir, 'discover')
    await setupFixture(dir, 'myproject', 'sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    expect(sources.length).toBe(1)
    expect(sources[0].provider).toBe('openclaw')
    expect(sources[0].project).toBe('myproject')
  })

  it('parses assistant messages with usage', async () => {
    const dir = join(baseDir, 'parse')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }
    expect(calls.length).toBe(2)
    expect(calls[0].provider).toBe('openclaw')
    expect(calls[0].model).toBe('claude-sonnet-4-6')
    expect(calls[0].inputTokens).toBe(500)
    expect(calls[0].outputTokens).toBe(100)
    expect(calls[0].cacheReadInputTokens).toBe(200)
    expect(calls[0].userMessage).toBe('hello world')
    expect(calls[0].sessionId).toBe('test-sess-1')
  })

  it('uses cost.total from provider when available', async () => {
    const dir = join(baseDir, 'cost')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls[1].costUSD).toBe(0.05)
  })

  it('extracts tools and bash commands', async () => {
    const dir = join(baseDir, 'tools')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls[1].tools).toContain('Bash')
    expect(calls[1].tools).toContain('Read')
    expect(calls[1].tools).toContain('Write')
    expect(calls[1].bashCommands).toContain('ls')
  })

  it('deduplicates on re-parse', async () => {
    const dir = join(baseDir, 'dedup')
    await setupFixture(dir, 'proj', 'test-sess-1', SESSION_LINES)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const parser1 = provider.createSessionParser(sources[0], seen)
    const calls1: any[] = []
    for await (const c of parser1.parse()) calls1.push(c)
    expect(calls1.length).toBe(2)
    const parser2 = provider.createSessionParser(sources[0], seen)
    const calls2: any[] = []
    for await (const c of parser2.parse()) calls2.push(c)
    expect(calls2.length).toBe(0)
  })

  it('reads model from model_change event', async () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'mc-test', timestamp: '2026-04-20T10:00:00.000Z' }),
      JSON.stringify({ type: 'model_change', id: 'mc1', modelId: 'gpt-5.5', provider: 'openai' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:01.000Z',
        message: { role: 'assistant', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
      }),
    ]
    const dir = join(baseDir, 'model-change')
    await setupFixture(dir, 'proj', 'mc-test', lines)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const c of parser.parse()) calls.push(c)
    expect(calls[0].model).toBe('gpt-5.5')
  })

  it('reads model from custom model-snapshot event', async () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'snap-test', timestamp: '2026-04-20T10:00:00.000Z' }),
      JSON.stringify({ type: 'custom', customType: 'model-snapshot', data: { modelId: 'glm-5.1:cloud', provider: 'ollama' }, id: 's1' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:01.000Z',
        message: { role: 'assistant', usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0 } },
      }),
    ]
    const dir = join(baseDir, 'snapshot')
    await setupFixture(dir, 'proj', 'snap-test', lines)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const c of parser.parse()) calls.push(c)
    expect(calls[0].model).toBe('glm-5.1:cloud')
  })

  it('falls back to file mtime when timestamps are unparseable', async () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'bad-ts', timestamp: 'not-a-date' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: 'also-bad',
        message: { role: 'assistant', model: 'test', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
      }),
    ]
    const dir = join(baseDir, 'bad-ts')
    const filePath = await setupFixture(dir, 'proj', 'bad-ts', lines)
    const { mtime } = await stat(filePath)
    const provider = createOpenClawProvider(dir)
    const sources = await provider.discoverSessions()
    const parser = provider.createSessionParser(sources[0], new Set())
    const calls: any[] = []
    for await (const c of parser.parse()) calls.push(c)
    // The call is kept (real spend), stamped with the file mtime rather than dropped.
    expect(calls.length).toBe(1)
    expect(calls[0].timestamp).toBe(mtime.toISOString())
  })

  it('tool and model display names work', () => {
    const provider = createOpenClawProvider()
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('dispatch_agent')).toBe('Agent')
    expect(provider.toolDisplayName('unknown')).toBe('unknown')
    expect(provider.modelDisplayName('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('returns empty for nonexistent directory', async () => {
    const provider = createOpenClawProvider('/tmp/nonexistent-openclaw-test')
    const sources = await provider.discoverSessions()
    expect(sources.length).toBe(0)
  })

  it('reports the agents root to doctor even when it holds no sessions', async () => {
    const dir = join(baseDir, 'empty-root')
    await mkdir(dir, { recursive: true })
    const provider = createOpenClawProvider(dir)
    expect(await provider.discoverSessions()).toEqual([])
    expect(await provider.probeRoots!()).toEqual([{ path: dir, label: 'agents' }])
  })

  describe('sqlite transcript store (#1259)', () => {
    it('discovers sessions in the per-agent sqlite store when the jsonl files are gone', async () => {
      const dir = join(baseDir, 'sqlite-discover')
      const dbPath = createAgentDb(dir, 'myproject', [{ sessionId: 'sess-sql-1', rows: [{ seq: 1, event: sessionEvents().session, createdAt: Date.parse('2026-09-05T10:00:00.000Z') }] }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      expect(sources.length).toBe(1)
      expect(sources[0].provider).toBe('openclaw')
      expect(sources[0].project).toBe('myproject')
      expect(sources[0].path).toBe(`${dbPath}:sess-sql-1`)
    })

    it('parses sqlite transcript rows with the same semantics as jsonl', async () => {
      const ev = sessionEvents()
      const dir = join(baseDir, 'sqlite-parse')
      createAgentDb(dir, 'proj', [{
        sessionId: 'test-sess-1',
        rows: [
          { seq: 0, event: ev.session, createdAt: Date.parse('2026-04-20T10:00:00.000Z') },
          { seq: 1, event: ev.modelChange, createdAt: Date.parse('2026-04-20T10:00:01.000Z') },
          { seq: 2, event: ev.user, createdAt: Date.parse('2026-04-20T10:00:02.000Z') },
          { seq: 3, event: ev.assistant, createdAt: Date.parse('2026-04-20T10:00:03.000Z') },
          { seq: 4, event: ev.assistantCosted, createdAt: Date.parse('2026-04-20T10:00:05.000Z') },
        ],
      }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(2)
      expect(calls[0].sessionId).toBe('test-sess-1')
      expect(calls[0].model).toBe('claude-sonnet-4-6')
      expect(calls[0].inputTokens).toBe(500)
      expect(calls[0].cacheReadInputTokens).toBe(200)
      expect(calls[0].userMessage).toBe('hello world')
      expect(calls[1].costUSD).toBe(0.05)
      expect(calls[1].costFromBilling).toBe(true)
      expect(calls[1].tools).toContain('Bash')
      expect(calls[1].bashCommands).toContain('ls')
      // Envelope timestamps win over the row's created_at.
      expect(calls[0].timestamp).toBe('2026-04-20T10:00:03.000Z')
    })

    it('deduplicates sqlite sessions on re-parse', async () => {
      const ev = sessionEvents()
      const dir = join(baseDir, 'sqlite-dedup')
      createAgentDb(dir, 'proj', [{
        sessionId: 'test-sess-1',
        rows: [
          { seq: 0, event: ev.session, createdAt: Date.now() },
          { seq: 1, event: ev.assistant, createdAt: Date.now() },
        ],
      }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const seen = new Set<string>()
      expect((await parseAll(provider, sources[0], seen)).length).toBe(1)
      expect((await parseAll(provider, sources[0], seen)).length).toBe(0)
    })

    it('falls back to the row created_at for an assistant row without an envelope timestamp', async () => {
      const createdAt = Date.parse('2026-09-06T08:30:00.000Z')
      const dir = join(baseDir, 'sqlite-created-at-2')
      createAgentDb(dir, 'proj', [{
        sessionId: 'no-ts-2',
        rows: [{
          seq: 0,
          event: {
            type: 'message', id: 'a1',
            message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
          },
          createdAt,
        }],
      }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(1)
      expect(calls[0].timestamp).toBe(new Date(createdAt).toISOString())
      expect(calls[0].sessionId).toBe('no-ts-2')
    })

    it('rides the store mtime when neither envelope nor created_at is usable', async () => {
      const dir = join(baseDir, 'sqlite-mtime')
      const dbPath = createAgentDb(dir, 'proj', [{
        sessionId: 'zero-ts',
        rows: [{
          seq: 0,
          event: {
            type: 'message', id: 'a1',
            message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
          },
          createdAt: 0,
        }],
      }])
      const { mtime } = await stat(dbPath)
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(1)
      expect(calls[0].timestamp).toBe(mtime.toISOString())
    })

    it('reads a whole session across the 2000-row batch boundary', async () => {
      const rows: TranscriptSeedRow[] = []
      for (let i = 0; i < 2005; i++) {
        rows.push({
          seq: i,
          event: {
            type: 'message', id: `a${i}`, timestamp: '2026-09-07T09:00:00.000Z',
            message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
          },
          createdAt: Date.parse('2026-09-07T09:00:00.000Z'),
        })
      }
      const dir = join(baseDir, 'sqlite-batches')
      createAgentDb(dir, 'proj', [{ sessionId: 'big-sess', rows }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(2005)
    })

    it('ignores an agent sqlite file without the transcript_events table', async () => {
      const dir = join(baseDir, 'sqlite-no-table')
      const agentDir = join(dir, 'other', 'agent')
      await mkdir(agentDir, { recursive: true })
      const { DatabaseSync: Database } = requireForTest('node:sqlite')
      const db: TestDb = new Database(join(agentDir, 'openclaw-agent.sqlite'))
      db.exec('CREATE TABLE something_else(id TEXT PRIMARY KEY)')
      db.close()
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      expect(sources.length).toBe(0)
    })

    it('still finds legacy jsonl alongside a sqlite store', async () => {
      const ev = sessionEvents()
      const dir = join(baseDir, 'sqlite-mixed')
      await setupFixture(dir, 'proj', 'legacy-sess', [JSON.stringify(ev.session), JSON.stringify(ev.assistant)])
      createAgentDb(dir, 'proj', [{
        sessionId: 'sql-sess',
        rows: [{ seq: 0, event: ev.assistant, createdAt: Date.parse('2026-09-05T10:00:00.000Z') }],
      }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      expect(sources.length).toBe(2)
      const seen = new Set<string>()
      const all: any[] = []
      for (const source of sources) all.push(...(await parseAll(provider, source, seen)))
      expect(all.length).toBe(2)
      expect(new Set(all.map(c => c.sessionId))).toEqual(new Set(['test-sess-1', 'sql-sess']))
    })

    it('treats the store as authoritative for a session present in both eras', async () => {
      const ev = sessionEvents()
      const dir = join(baseDir, 'sqlite-authoritative')
      // Same session id in the legacy file and in the store (partial migration
      // or a restored backup): only the store's source may survive discovery,
      // or the legacy file's cached turns would suppress the store's parse.
      await setupFixture(dir, 'proj', 'test-sess-1', [JSON.stringify(ev.session), JSON.stringify(ev.assistant)])
      createAgentDb(dir, 'proj', [{
        sessionId: 'test-sess-1',
        rows: [
          { seq: 0, event: ev.session, createdAt: Date.parse('2026-04-20T10:00:00.000Z') },
          { seq: 1, event: ev.assistant, createdAt: Date.parse('2026-04-20T10:00:03.000Z') },
        ],
      }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      expect(sources.length).toBe(1)
      expect(sources[0].path.endsWith(':test-sess-1')).toBe(true)
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(1)
    })

    it('retries a garbage envelope timestamp on the row created_at before the store mtime', async () => {
      const createdAt = Date.parse('2026-09-06T08:30:00.000Z')
      const dir = join(baseDir, 'sqlite-garbage-ts')
      createAgentDb(dir, 'proj', [{
        sessionId: 'garbage-ts',
        rows: [{
          seq: 0,
          event: {
            type: 'message', id: 'a1', timestamp: 'not-a-date',
            message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
          },
          createdAt,
        }],
      }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(1)
      expect(calls[0].timestamp).toBe(new Date(createdAt).toISOString())
    })

    it('counts distinct id-less calls instead of colliding them on position', async () => {
      const dir = join(baseDir, 'sqlite-idless')
      const usage = (input: number) => ({ input, output: 5, cacheRead: 0, cacheWrite: 0 })
      createAgentDb(dir, 'proj', [{
        sessionId: 'idless',
        rows: [5, 50].map((input, i) => ({
          seq: i,
          event: {
            type: 'message', timestamp: '2026-09-07T09:00:00.000Z',
            message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: usage(input) },
          },
          createdAt: Date.parse('2026-09-07T09:00:00.000Z'),
        })),
      }])
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(2)
      expect(calls.map(c => c.inputTokens).sort((a, b) => a - b)).toEqual([5, 50])
    })

    it('decodes zstd-compressed rows from the agent-schema 23 column pair', async () => {
      if (!zstdCompressSync) return // node < 22.15: the runtime path skips these rows too
      const ev = sessionEvents()
      const dir = join(baseDir, 'sqlite-zstd')
      createAgentDb(dir, 'proj', [{
        sessionId: 'mixed-encoding',
        rows: [
          { seq: 0, event: ev.session, createdAt: Date.parse('2026-09-08T10:00:00.000Z'), compress: false },
          { seq: 1, event: ev.assistant, createdAt: Date.parse('2026-09-08T10:00:03.000Z'), compress: true },
        ],
      }], { compressed: true })
      const provider = createOpenClawProvider(dir)
      const sources = await provider.discoverSessions()
      const calls = await parseAll(provider, sources[0], new Set())
      expect(calls.length).toBe(1)
      expect(calls[0].inputTokens).toBe(500)
      expect(calls[0].sessionId).toBe('test-sess-1')
    })

    it('skips sqlite discovery and parsing when node:sqlite is unavailable', async () => {
      const ev = sessionEvents()
      const dir = join(baseDir, 'sqlite-guard')
      createAgentDb(dir, 'proj', [{
        sessionId: 'sess-any',
        rows: [{ seq: 0, event: ev.assistant, createdAt: Date.now() }],
      }])
      const provider = createOpenClawProvider(dir)
      sqliteRuntimeAvailable = false
      try {
        expect(await provider.discoverSessions()).toEqual([])
        const parser = provider.createSessionParser({ path: `${join(dir, 'proj', 'agent', 'openclaw-agent.sqlite')}:sess-any`, project: 'proj', provider: 'openclaw' }, new Set())
        const calls: any[] = []
        for await (const call of parser.parse()) calls.push(call)
        expect(calls).toEqual([])
      } finally {
        sqliteRuntimeAvailable = true
      }
    })
  })

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })
})
