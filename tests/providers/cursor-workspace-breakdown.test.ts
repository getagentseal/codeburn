import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  createCursorProvider,
  clearCursorWorkspaceMapCache,
} from '../../src/providers/cursor.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

let userDir: string

beforeEach(async () => {
  userDir = await mkdtemp(join(tmpdir(), 'cursor-ws-test-'))
  // Layout matches Cursor's: <userDir>/{globalStorage,workspaceStorage}/.
  await mkdir(join(userDir, 'globalStorage'), { recursive: true })
  await mkdir(join(userDir, 'workspaceStorage'), { recursive: true })
  clearCursorWorkspaceMapCache()
})

afterEach(async () => {
  clearCursorWorkspaceMapCache()
  await rm(userDir, { recursive: true, force: true })
})

function globalDbPath(): string {
  return join(userDir, 'globalStorage', 'state.vscdb')
}

/// Builds a global state.vscdb with the cursorDiskKV table and a small set of
/// bubbles for the requested composer ids. Each bubble carries enough fields
/// to satisfy parseBubbles() — created_at, tokenCount, conversationId, type.
function createGlobalDb(composerIds: string[]): string {
  const dbPath = globalDbPath()
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)`)
  // ItemTable is unused by the global parser but creating it mirrors the
  // real schema so a stray query against it does not error.
  db.exec(`CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)`)

  const insert = db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`)
  const baseTime = Date.now() - 24 * 3600 * 1000

  for (const composerId of composerIds) {
    // Exactly one assistant bubble per composer so the test math is
    // "one composer == one call". User bubbles also produce calls in the
    // real parser (text-length token estimation), but they are not
    // necessary to exercise the workspace routing logic.
    const bubbleId = `bubbleId:${composerId}:bubble-${composerId.slice(0, 6)}`
    const bubble = {
      type: 2, // assistant
      conversationId: composerId,
      createdAt: new Date(baseTime).toISOString(),
      tokenCount: { inputTokens: 100, outputTokens: 50 },
      modelInfo: { modelName: 'claude-4.6-sonnet' },
      text: 'assistant reply for ' + composerId,
      codeBlocks: '[]',
    }
    insert.run(bubbleId, JSON.stringify(bubble))
  }

  db.close()
  return dbPath
}

/// Creates one workspaceStorage/<hash>/ subdir with workspace.json (folder URI)
/// and state.vscdb (composer.composerData listing the supplied composerIds).
function createWorkspaceDir(hash: string, folderUri: string, composerIds: string[]): void {
  const dir = join(userDir, 'workspaceStorage', hash)
  mkdirSync(dir, { recursive: true })

  const wsJsonPath = join(dir, 'workspace.json')
  // We cannot do a top-level await in a sync helper; the caller writes via
  // mkdirSync above and the JSON via Node's sync writeFile shim through the
  // require'd 'fs'. Using readFileSync-friendly imports to keep this test
  // helper sync.
  const fs = requireForTest('fs') as typeof import('fs')
  fs.writeFileSync(wsJsonPath, JSON.stringify({ folder: folderUri }))

  const wsDbPath = join(dir, 'state.vscdb')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(wsDbPath)
  db.exec(`CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)`)
  const composerData = {
    allComposers: composerIds.map(id => ({
      composerId: id,
      name: 'session-' + id.slice(0, 6),
      unifiedMode: 'agent',
    })),
  }
  db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run(
    'composer.composerData',
    JSON.stringify(composerData),
  )
  db.close()
}

async function collect(parser: { parse(): AsyncGenerator<ParsedProviderCall> }): Promise<ParsedProviderCall[]> {
  const out: ParsedProviderCall[] = []
  for await (const call of parser.parse()) out.push(call)
  return out
}

describe('cursor provider — per-project breakdown (#196)', () => {
  it('emits one source per workspace plus an orphan source', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb([
      'composer-work-1',
      'composer-work-2',
      'composer-personal-1',
      'composer-orphan-1',
    ])
    createWorkspaceDir('hash-work', 'file:///Users/me/work-app', ['composer-work-1', 'composer-work-2'])
    createWorkspaceDir('hash-personal', 'file:///Users/me/personal-app', ['composer-personal-1'])

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()

    const projects = sources.map(s => s.project).sort()
    expect(projects).toContain('-Users-me-work-app')
    expect(projects).toContain('-Users-me-personal-app')
    // Orphan source is labeled 'cursor' so a user with no workspaces
    // sees the same project name as before the breakdown change.
    expect(projects).toContain('cursor')
  })

  it('picks up workspaces and chats created after an earlier discovery in the same process', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb(['composer-alpha', 'composer-alpha-2', 'composer-beta'])
    createWorkspaceDir('hash-alpha', 'file:///Users/me/alpha', ['composer-alpha'])

    const provider = createCursorProvider(dbPath)
    await provider.discoverSessions()
    const { DatabaseSync: Database } = requireForTest('node:sqlite')
    const alphaDb = new Database(join(userDir, 'workspaceStorage', 'hash-alpha', 'state.vscdb'))
    alphaDb.prepare(`UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'`).run(
      JSON.stringify({ allComposers: [{ composerId: 'composer-alpha' }, { composerId: 'composer-alpha-2' }] }),
    )
    alphaDb.close()
    createWorkspaceDir('hash-beta', 'file:///Users/me/beta', ['composer-beta'])
    const sources = await provider.discoverSessions()

    const byProject = new Map<string, Set<string>>()
    for (const source of sources) {
      const calls = await collect(provider.createSessionParser(source, new Set()))
      byProject.set(source.project, new Set(calls.map(c => c.sessionId)))
    }
    expect(byProject.get('-Users-me-alpha')).toEqual(new Set(['composer-alpha', 'composer-alpha-2']))
    expect(byProject.get('-Users-me-beta')).toEqual(new Set(['composer-beta']))
    expect(byProject.get('cursor')).toEqual(new Set())
  })

  it('routes calls to the right workspace and excludes others', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb([
      'composer-work-1',
      'composer-work-2',
      'composer-personal-1',
    ])
    createWorkspaceDir('hash-work', 'file:///Users/me/work-app', ['composer-work-1', 'composer-work-2'])
    createWorkspaceDir('hash-personal', 'file:///Users/me/personal-app', ['composer-personal-1'])

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()
    const workSource = sources.find(s => s.project === '-Users-me-work-app')!
    const personalSource = sources.find(s => s.project === '-Users-me-personal-app')!

    const workCalls = await collect(provider.createSessionParser(workSource, new Set()))
    const personalCalls = await collect(provider.createSessionParser(personalSource, new Set()))

    const workComposerIds = new Set(workCalls.map(c => c.sessionId))
    expect(workComposerIds).toEqual(new Set(['composer-work-1', 'composer-work-2']))
    const personalComposerIds = new Set(personalCalls.map(c => c.sessionId))
    expect(personalComposerIds).toEqual(new Set(['composer-personal-1']))
  })

  it('orphan source captures composers not registered in any workspace', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb([
      'composer-mapped',
      'composer-orphan-a',
      'composer-orphan-b',
    ])
    createWorkspaceDir('hash-only', 'file:///Users/me/only-app', ['composer-mapped'])

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()
    const orphanSource = sources.find(s => s.project === 'cursor')!

    const orphanCalls = await collect(provider.createSessionParser(orphanSource, new Set()))
    const ids = new Set(orphanCalls.map(c => c.sessionId))
    expect(ids).toEqual(new Set(['composer-orphan-a', 'composer-orphan-b']))
  })

  it('totals across all sources equal totals from the legacy single-source behavior', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb([
      'composer-work-1',
      'composer-personal-1',
      'composer-orphan-1',
    ])
    createWorkspaceDir('hash-work', 'file:///Users/me/work-app', ['composer-work-1'])
    createWorkspaceDir('hash-personal', 'file:///Users/me/personal-app', ['composer-personal-1'])

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()

    const seen = new Set<string>()
    let totalCalls = 0
    let totalCost = 0
    for (const source of sources) {
      const calls = await collect(provider.createSessionParser(source, seen))
      totalCalls += calls.length
      for (const call of calls) totalCost += call.costUSD
    }
    // Three composers, one assistant call each => three calls overall.
    expect(totalCalls).toBe(3)
    expect(totalCost).toBeGreaterThan(0)
  })

  it('emits a single `cursor` source (legacy-equivalent) when no workspace mapping exists', async () => {
    if (!isSqliteAvailable()) return

    // No createWorkspaceDir calls -> workspaceStorage exists but is empty.
    const dbPath = createGlobalDb(['composer-1', 'composer-2'])

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.project).toBe('cursor')

    const calls = await collect(provider.createSessionParser(sources[0]!, new Set()))
    // All composers fall through to the orphan/catch-all source, matching
    // the pre-PR behavior where every Cursor session showed under one row.
    const ids = new Set(calls.map(c => c.sessionId))
    expect(ids).toEqual(new Set(['composer-1', 'composer-2']))
  })

  it('handles multi-root workspaces (workspace.json without folder) by skipping them', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb(['composer-multi'])
    // Multi-root workspace: workspace.json carries `configuration` not `folder`.
    const dir = join(userDir, 'workspaceStorage', 'hash-multi')
    mkdirSync(dir, { recursive: true })
    await writeFile(
      join(dir, 'workspace.json'),
      JSON.stringify({ configuration: 'file:///path/to/.code-workspace' }),
    )
    // No state.vscdb either — multi-root composer never registers.

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()
    // Multi-root produces no workspace mapping; only the orphan source
    // (labeled 'cursor') remains, and it captures the multi-root composer.
    const projects = sources.map(s => s.project)
    expect(projects).toEqual(['cursor'])
    const calls = await collect(provider.createSessionParser(sources[0]!, new Set()))
    expect(calls.map(c => c.sessionId)).toEqual(['composer-multi'])
  })

  it('sanitizes vscode-remote URIs into a slug', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb(['composer-remote'])
    createWorkspaceDir(
      'hash-remote',
      'vscode-remote://wsl+Ubuntu/home/me/proj',
      ['composer-remote'],
    )

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()
    const project = sources.find(s => s.project !== 'cursor')!.project
    // file:// would yield "-Users-me-proj"; remote URIs get the scheme rewritten.
    expect(project).toMatch(/wsl-Ubuntu/)
    expect(project).toContain('home')
    expect(project).toContain('proj')
  })

  it('drops sub-composer rows whose composer id is not a UUID', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = globalDbPath()
    const { DatabaseSync: Database } = requireForTest('node:sqlite')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)`)
    db.exec(`CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)`)
    const insert = db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`)

    // One real composer with one bubble. Real composer ids are UUIDs.
    const realComposerId = 'cccc1111-2222-3333-4444-555566667777'
    insert.run(`bubbleId:${realComposerId}:bubble-real`, JSON.stringify({
      type: 2,
      conversationId: realComposerId,
      createdAt: new Date().toISOString(),
      tokenCount: { inputTokens: 100, outputTokens: 50 },
      modelInfo: { modelName: 'claude-4.6-sonnet' },
      text: 'real',
      codeBlocks: '[]',
    }))
    // A sub-composer row mirroring the real Cursor shape: the composer
    // segment has an embedded newline and is not UUID-shaped. Must be
    // dropped, not surfaced as its own session.
    insert.run(`bubbleId:task-call_xxx\nfc_yyy:bubble-sub`, JSON.stringify({
      type: 2,
      conversationId: '',
      createdAt: new Date().toISOString(),
      tokenCount: { inputTokens: 10, outputTokens: 5 },
      modelInfo: { modelName: 'claude-4.6-sonnet' },
      text: 'sub',
      codeBlocks: '[]',
    }))
    db.close()

    createWorkspaceDir('hash-only', 'file:///Users/me/only', [realComposerId])

    const provider = createCursorProvider(dbPath)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    let allCalls = 0
    for (const source of sources) {
      const calls = await collect(provider.createSessionParser(source, seen))
      allCalls += calls.length
    }
    // One real composer -> one call. Sub-composer dropped. Total: 1.
    expect(allCalls).toBe(1)
  })

  it('remains backwards-compatible when given a legacy bare DB path', async () => {
    if (!isSqliteAvailable()) return

    const dbPath = createGlobalDb(['composer-legacy-1', 'composer-legacy-2'])
    createWorkspaceDir('hash-legacy', 'file:///Users/me/legacy', ['composer-legacy-1'])

    const provider = createCursorProvider(dbPath)
    // Hand-construct a legacy SessionSource (no workspace tag) and verify
    // it still yields every call regardless of workspace mapping.
    const legacySource = { path: dbPath, project: 'cursor', provider: 'cursor' }
    const calls = await collect(provider.createSessionParser(legacySource, new Set()))
    const ids = new Set(calls.map(c => c.sessionId))
    expect(ids).toEqual(new Set(['composer-legacy-1', 'composer-legacy-2']))
  })
})
