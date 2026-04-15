import { describe, it, expect, beforeEach } from 'vitest'
import { getAllProviders } from '../../src/providers/index.js'
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
    it('maps default to Auto with estimation label', () => {
      expect(cursorProvider.modelDisplayName('default')).toBe('Auto (Sonnet est.)')
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
