import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { createCursorProvider } from '../../src/providers/cursor.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import type { DateRange } from '../../src/types.js'

const requireForTest = createRequire(import.meta.url)
const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

let tmpDir: string

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-12T12:00:00.000Z'))
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-scan-window-'))
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
})

afterEach(async () => {
  vi.useRealTimers()
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

function bubbleValue(opts: {
  type: 1 | 2
  conversationId: string
  createdAt: string
  text: string
  inputTokens: number
  outputTokens: number
}): string {
  return JSON.stringify({
    type: opts.type,
    conversationId: opts.conversationId,
    createdAt: opts.createdAt,
    text: opts.text,
    tokenCount: {
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
    },
    modelInfo: { modelName: 'claude-4.6-sonnet' },
    codeBlocks: '[]',
  })
}

function createDbWithOlderInWindowBubblePastHistoricCap(): string {
  const dbPath = join(tmpDir, 'state.vscdb')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = OFF')
  db.exec('PRAGMA synchronous = OFF')
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
  db.exec('BEGIN')

  const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  const olderComposerId = 'older-composer'
  insert.run(
    `bubbleId:${olderComposerId}:bubble-important`,
    bubbleValue({
      type: 2,
      conversationId: olderComposerId,
      createdAt: '2026-02-12T12:00:00.000Z',
      text: 'important older assistant response',
      inputTokens: 100,
      outputTokens: 50,
    }),
  )

  const emptyNewerBubble = bubbleValue({
    type: 2,
    conversationId: 'empty-newer',
    createdAt: '2026-06-11T12:00:00.000Z',
    text: '',
    inputTokens: 0,
    outputTokens: 0,
  })
  const manyNewerEmptyBubbles = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  for (let i = 0; i < 250_001; i += 1) {
    manyNewerEmptyBubbles.run(`bubbleId:empty-newer:bubble-${i}`, emptyNewerBubble)
  }

  db.exec('COMMIT')
  db.close()
  return dbPath
}

function createDbWithOldAndRequestedRangeBubbles(): string {
  const dbPath = join(tmpDir, 'state.vscdb')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')

  const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  insert.run(
    'bubbleId:old-composer:bubble-old',
    bubbleValue({
      type: 2,
      conversationId: 'old-composer',
      createdAt: '2026-06-10T12:00:00.000Z',
      text: 'older assistant response',
      inputTokens: 100,
      outputTokens: 50,
    }),
  )
  insert.run(
    'bubbleId:today-composer:bubble-today',
    bubbleValue({
      type: 2,
      conversationId: 'today-composer',
      createdAt: '2026-06-12T08:00:00.000Z',
      text: 'today assistant response',
      inputTokens: 100,
      outputTokens: 50,
    }),
  )

  db.close()
  return dbPath
}

async function collect(dbPath: string, dateRange?: DateRange): Promise<ParsedProviderCall[]> {
  const provider = createCursorProvider(dbPath)
  const source = { path: dbPath, project: 'cursor', provider: 'cursor' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set(), dateRange).parse()) {
    calls.push(call)
  }
  return calls
}

skipUnlessSqlite('cursor bubble scan window', () => {
  it('does not drop older in-window bubbles when newer rows exceed the historic cap', async () => {
    const dbPath = createDbWithOlderInWindowBubblePastHistoricCap()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const calls = await collect(dbPath)

    expect(calls.map(call => call.sessionId)).toContain('older-composer')
    expect(String(stderrSpy.mock.calls.flat().join(''))).not.toContain('Older sessions may be missing')

    stderrSpy.mockRestore()
  })

  it('uses the requested date range as the bubble scan lower bound', async () => {
    const dbPath = createDbWithOldAndRequestedRangeBubbles()

    const calls = await collect(dbPath, {
      start: new Date('2026-06-12T00:00:00.000Z'),
      end: new Date('2026-06-12T23:59:59.999Z'),
    })

    expect(calls.map(call => call.sessionId)).toEqual(['today-composer'])
  })
})
