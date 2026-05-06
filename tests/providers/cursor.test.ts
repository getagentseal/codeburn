import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getAllProviders } from '../../src/providers/index.js'
import type { Provider } from '../../src/providers/types.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createCursorProvider } from '../../src/providers/cursor.js'

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
    const result = await readCachedResults('/nonexistent/path.db')
    expect(result).toBeNull()
  })
})

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('cursor provider timestamps', () => {
  it('does not emit calls for rows missing createdAt', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codeburn-cursor-test-'))
    const dbPath = join(tempDir, 'state.vscdb')
    try {
      const { DatabaseSync: Database } = require('node:sqlite')
      const db = new Database(dbPath)
      db.prepare(`
        CREATE TABLE cursorDiskKV (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `).run()

      const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const withTimestamp = JSON.stringify({
        tokenCount: { inputTokens: 10, outputTokens: 20 },
        modelInfo: { modelName: 'default' },
        createdAt,
        conversationId: 'conv-a',
        text: 'assistant reply',
        type: 2,
        codeBlocks: [],
      })
      const missingTimestamp = JSON.stringify({
        tokenCount: { inputTokens: 99, outputTokens: 199 },
        modelInfo: { modelName: 'default' },
        conversationId: 'conv-b',
        text: 'missing time',
        type: 2,
        codeBlocks: [],
      })
      db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run('bubbleId:conv-a:b1', withTimestamp)
      db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run('bubbleId:conv-b:b2', missingTimestamp)
      db.close()

      const provider = createCursorProvider(dbPath)
      const [source] = await provider.discoverSessions()
      const calls = []
      for await (const call of provider.createSessionParser(source!, new Set()).parse()) {
        calls.push(call)
      }

      expect(calls).toHaveLength(1)
      expect(calls[0]!.timestamp).toBe(createdAt)
      expect(calls[0]!.sessionId).toBe('conv-a')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
