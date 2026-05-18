import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSqliteAvailable } from '../../src/sqlite.js'

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let home: string
let dataHome: string
let cacheDir: string
let previousHome: string | undefined
let previousXdgDataHome: string | undefined
let previousCacheDir: string | undefined

beforeEach(async () => {
  vi.resetModules()
  home = await mkdtemp(join(tmpdir(), 'opencode-cache-home-'))
  dataHome = await mkdtemp(join(tmpdir(), 'opencode-cache-data-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'opencode-cache-store-'))

  previousHome = process.env['HOME']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  previousCacheDir = process.env['CODEBURN_CACHE_DIR']

  process.env['HOME'] = home
  process.env['XDG_DATA_HOME'] = dataHome
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  try {
    const parser = await import('../../src/parser.js')
    parser.clearSessionCache()
  } catch {}
  vi.resetModules()

  if (previousHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = previousHome
  if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousXdgDataHome
  if (previousCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = previousCacheDir

  await rm(home, { recursive: true, force: true })
  await rm(dataHome, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

function createDb(dbPath: string, baseTs: number): void {
  const { DatabaseSync: Database } = require('node:sqlite')
  const db: TestDb = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER, time_updated INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      session_id TEXT NOT NULL, time_created INTEGER,
      time_updated INTEGER, data TEXT NOT NULL
    );
  `)

  const insertSession = db.prepare(`
    INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
    VALUES (?, 'proj', ?, ?, ?, ?, '1.0', ?, ?, NULL)
  `)
  insertSession.run('root-a', null, 'root-a', '/tmp/project-a', 'Project A', baseTs, baseTs)
  insertSession.run('child-a', 'root-a', 'child-a', '/tmp/project-a', 'Child A', baseTs + 1000, baseTs + 1000)
  insertSession.run('root-b', null, 'root-b', '/tmp/project-b', 'Project B', baseTs + 2000, baseTs + 2000)

  const insertMessage = db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `)
  const assistant = (tokens: number, cost: number) => JSON.stringify({
    role: 'assistant',
    modelID: 'claude-opus-4-6',
    cost,
    tokens: {
      input: tokens,
      output: tokens * 2,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })
  insertMessage.run('msg-root-a-user', 'root-a', baseTs, baseTs, JSON.stringify({ role: 'user' }))
  insertMessage.run('msg-root-a-assistant', 'root-a', baseTs + 100, baseTs + 100, assistant(10, 0.01))
  insertMessage.run('msg-child-a-user', 'child-a', baseTs + 1000, baseTs + 1000, JSON.stringify({ role: 'user' }))
  insertMessage.run('msg-child-a-assistant', 'child-a', baseTs + 1100, baseTs + 1100, assistant(20, 0.02))
  insertMessage.run('msg-root-b-user', 'root-b', baseTs + 2000, baseTs + 2000, JSON.stringify({ role: 'user' }))
  insertMessage.run('msg-root-b-assistant', 'root-b', baseTs + 2100, baseTs + 2100, assistant(30, 0.03))

  const insertPart = db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insertPart.run('part-root-a-user', 'msg-root-a-user', 'root-a', baseTs, baseTs, JSON.stringify({ type: 'text', text: 'root a prompt' }))
  insertPart.run('part-root-a-tool', 'msg-root-a-assistant', 'root-a', baseTs + 100, baseTs + 100, JSON.stringify({ type: 'tool', tool: 'read', state: { input: {} } }))
  insertPart.run('part-child-a-user', 'msg-child-a-user', 'child-a', baseTs + 1000, baseTs + 1000, JSON.stringify({ type: 'text', text: 'child a prompt' }))
  insertPart.run('part-child-a-tool', 'msg-child-a-assistant', 'child-a', baseTs + 1100, baseTs + 1100, JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }))
  insertPart.run('part-root-b-user', 'msg-root-b-user', 'root-b', baseTs + 2000, baseTs + 2000, JSON.stringify({ type: 'text', text: 'root b prompt' }))
  insertPart.run('part-root-b-tool', 'msg-root-b-assistant', 'root-b', baseTs + 2100, baseTs + 2100, JSON.stringify({ type: 'tool', tool: 'edit', state: { input: {} } }))
  db.close()
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('OpenCode shared session cache', () => {
  it('keys the cache by the real database path while preserving root and child calls', async () => {
    const opencodeDir = join(dataHome, 'opencode')
    await mkdir(opencodeDir, { recursive: true })
    const dbPath = join(opencodeDir, 'opencode.db')
    const baseTs = Date.parse('2026-05-16T12:00:00.000Z')
    createDb(dbPath, baseTs)

    const { clearSessionCache, parseAllSessions } = await import('../../src/parser.js')
    const range = {
      start: new Date(baseTs - 1000),
      end: new Date(baseTs + 10_000),
    }

    const projects = await parseAllSessions(range, 'opencode')
    expect(projects.map(project => ({
      project: project.project,
      calls: project.totalApiCalls,
      sessions: project.sessions.length,
    })).sort((a, b) => a.project.localeCompare(b.project))).toEqual([
      { project: 'tmp-project-a', calls: 2, sessions: 1 },
      { project: 'tmp-project-b', calls: 1, sessions: 1 },
    ])

    const cachePath = join(cacheDir, 'session-cache.json')
    const coldCacheRaw = await readFile(cachePath, 'utf8')
    const coldStat = await stat(cachePath)
    const coldCache = JSON.parse(coldCacheRaw)
    const files = coldCache.providers?.opencode?.files ?? {}
    expect(Object.keys(files)).toEqual([dbPath])

    const turns = files[dbPath].turns
    expect(turns).toHaveLength(3)
    expect(turns.map((turn: { sessionId: string }) => turn.sessionId).sort()).toEqual([
      'root-a',
      'root-a',
      'root-b',
    ])
    expect(turns.flatMap((turn: { calls: Array<{ deduplicationKey: string; project?: string }> }) =>
      turn.calls.map(call => call.deduplicationKey),
    ).sort()).toEqual([
      'opencode:child-a:msg-child-a-assistant',
      'opencode:root-a:msg-root-a-assistant',
      'opencode:root-b:msg-root-b-assistant',
    ])
    expect(turns.flatMap((turn: { calls: Array<{ project?: string }> }) =>
      turn.calls.map(call => call.project),
    ).sort()).toEqual([
      'tmp-project-a',
      'tmp-project-a',
      'tmp-project-b',
    ])

    clearSessionCache()
    await parseAllSessions(range, 'opencode')
    expect((await stat(cachePath)).mtimeMs).toBe(coldStat.mtimeMs)
    expect(await readFile(cachePath, 'utf8')).toBe(coldCacheRaw)
  })

  it('prunes legacy database/session cache keys during upgrade', async () => {
    const opencodeDir = join(dataHome, 'opencode')
    await mkdir(opencodeDir, { recursive: true })
    const dbPath = join(opencodeDir, 'opencode.db')
    const baseTs = Date.parse('2026-05-16T12:00:00.000Z')
    createDb(dbPath, baseTs)

    const cachePath = join(cacheDir, 'session-cache.json')
    const { computeEnvFingerprint } = await import('../../src/session-cache.js')
    await writeFile(cachePath, JSON.stringify({
      version: 1,
      providers: {
        opencode: {
          envFingerprint: computeEnvFingerprint('opencode'),
          files: {
            [`${dbPath}:root-a`]: {
              fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 },
              mcpInventory: [],
              turns: [],
            },
            [`${dbPath}:root-b`]: {
              fingerprint: { dev: 1, ino: 2, mtimeMs: 1, sizeBytes: 1 },
              mcpInventory: [],
              turns: [],
            },
          },
        },
      },
    }))

    const { parseAllSessions } = await import('../../src/parser.js')
    await parseAllSessions({
      start: new Date(baseTs - 1000),
      end: new Date(baseTs + 10_000),
    }, 'opencode')

    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(Object.keys(cache.providers.opencode.files).sort()).toEqual([dbPath])
    expect(cache.providers.opencode.files[dbPath].turns).toHaveLength(3)
  })
})
