import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { getAllProviders } from '../../src/providers/index.js'
import { getCursorTimeFloor, createCursorProvider, clearCursorWorkspaceMapCache } from '../../src/providers/cursor.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { Provider } from '../../src/providers/types.js'

describe('cursor provider', () => {
  let cursorProvider: Provider

  beforeEach(async () => {
    const all = await getAllProviders()
    cursorProvider = all.find(p => p.name === 'cursor')!
  })
  it('is registered', () => {
    expect(cursorProvider).toBeDefined()
    expect(cursorProvider.name).toBe('cursor')
    expect(cursorProvider.displayName).toBe('Cursor')
  })

  describe('model display names', () => {
    it('maps cursor-auto to Cursor (auto) label', () => {
      expect(cursorProvider.modelDisplayName('cursor-auto')).toBe('Cursor (auto)')
    })

    it('maps known models to readable names', () => {
      expect(cursorProvider.modelDisplayName('claude-4.5-opus-high-thinking')).toBe('Opus 4.5 (Thinking)')
      expect(cursorProvider.modelDisplayName('claude-4-sonnet-thinking')).toBe('Sonnet 4 (Thinking)')
      expect(cursorProvider.modelDisplayName('grok-code-fast-1')).toBe('Grok Code Fast')
      expect(cursorProvider.modelDisplayName('gemini-3-pro')).toBe('Gemini 3 Pro')
      expect(cursorProvider.modelDisplayName('gpt-5')).toBe('GPT-5')
      expect(cursorProvider.modelDisplayName('composer-1')).toBe('Composer 1')
    })

    it('returns raw name for unknown models', () => {
      expect(cursorProvider.modelDisplayName('some-future-model')).toBe('some-future-model')
    })
  })

  describe('tool display names', () => {
    it('returns raw tool name as identity', () => {
      expect(cursorProvider.toolDisplayName('some_tool')).toBe('some_tool')
    })
  })

  describe('time floor', () => {
    it('uses dateRange.start when within the six-month cap', () => {
      const start = new Date(2026, 3, 1)
      expect(getCursorTimeFloor({ start, end: new Date(2026, 5, 2) })).toBe(start.toISOString())
    })
  })

  describe('session discovery', () => {
    it('returns empty when sqlite is not available', async () => {
      const sessions = await cursorProvider.discoverSessions()
      expect(Array.isArray(sessions)).toBe(true)
    })

    it('returns empty when db does not exist', async () => {
      const sessions = await cursorProvider.discoverSessions()
      expect(sessions.every(s => s.provider === 'cursor')).toBe(true)
    })
  })
})

describe('cursor sqlite adapter', () => {
  it('reports availability', async () => {
    const { isSqliteAvailable } = await import('../../src/sqlite.js')
    const available = isSqliteAvailable()
    expect(typeof available).toBe('boolean')
  })

  it('provides error message when not available', async () => {
    const { getSqliteLoadError } = await import('../../src/sqlite.js')
    const error = getSqliteLoadError()
    expect(typeof error).toBe('string')
    expect(error.length).toBeGreaterThan(0)
  })
})

describe('cursor cache', () => {
  it('returns null when no cache exists', async () => {
    const { readCachedResults } = await import('../../src/cursor-cache.js')
    const result = await readCachedResults('/nonexistent/path.db', new Date(0).toISOString())
    expect(result).toBeNull()
  })
})

// Regression: Cursor renamed the per-workspace composer list key from
// 'composer.composerData' to 'composer.composerHeaders'. loadWorkspaceMap must
// read both, otherwise every composer orphans into the 'cursor' catch-all and
// per-project attribution is lost.
describe('cursor workspace mapping (composer.composerHeaders regression)', () => {
  const requireForTest = createRequire(import.meta.url)
  type TestDb = {
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): void }
    close(): void
  }
  let root: string

  function writeItemTableDb(dbPath: string, key: string, composerIds: string[]): void {
    const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (p: string) => TestDb }
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    if (key) {
      const value = JSON.stringify({ allComposers: composerIds.map(composerId => ({ composerId })) })
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, value)
    }
    db.close()
  }

  async function makeWorkspace(hash: string, folderUri: string, key: string, composerIds: string[]): Promise<void> {
    const wsDir = join(root, 'User', 'workspaceStorage', hash)
    await mkdir(wsDir, { recursive: true })
    await writeFile(join(wsDir, 'workspace.json'), JSON.stringify({ folder: folderUri }))
    writeItemTableDb(join(wsDir, 'state.vscdb'), key, composerIds)
  }

  async function makeGlobalDb(): Promise<string> {
    const gsDir = join(root, 'User', 'globalStorage')
    await mkdir(gsDir, { recursive: true })
    const dbPath = join(gsDir, 'state.vscdb')
    // discoverSessions only needs the global DB to exist; the workspace map is
    // built from the sibling workspaceStorage dir.
    writeItemTableDb(dbPath, '', [])
    return dbPath
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cursor-ws-test-'))
    clearCursorWorkspaceMapCache()
  })

  afterEach(async () => {
    clearCursorWorkspaceMapCache()
    await rm(root, { recursive: true, force: true })
  })

  it.skipIf(!isSqliteAvailable())(
    'maps composers to their workspace via composer.composerHeaders (new Cursor key)',
    async () => {
      await makeWorkspace('ws-headers', 'file:///home/user/myapp', 'composer.composerHeaders', ['comp-1', 'comp-2'])
      const dbPath = await makeGlobalDb()

      const sources = await createCursorProvider(dbPath).discoverSessions()
      const projects = sources.map(s => s.project)

      // Before the fix these composers orphaned to the 'cursor' catch-all.
      expect(projects).toContain('-home-user-myapp')
    },
  )

  it.skipIf(!isSqliteAvailable())(
    'still maps composers via the legacy composer.composerData key',
    async () => {
      await makeWorkspace('ws-legacy', 'file:///home/user/legacy', 'composer.composerData', ['old-1'])
      const dbPath = await makeGlobalDb()

      const sources = await createCursorProvider(dbPath).discoverSessions()
      expect(sources.map(s => s.project)).toContain('-home-user-legacy')
    },
  )
})
