import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { createRequire } from 'node:module'

import {
  createCursorProvider,
  clearCursorWorkspaceMapCache,
} from '../../src/providers/cursor.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { getCodeburnCacheDir } from '../../src/cache-dir.js'
import { cursorCacheFileName } from '../../src/cursor-cache.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

const sqlLog = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>)
vi.mock('../../src/sqlite.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sqlite.js')>()
  return {
    ...mod,
    openDatabase: (...args: Parameters<typeof mod.openDatabase>) => {
      const db = mod.openDatabase(...args)
      return {
        query: (sql: string, params: unknown[] = []) => {
          sqlLog.push({ sql, params })
          return db.query(sql, params)
        },
        close: () => db.close(),
      } as ReturnType<typeof mod.openDatabase>
    },
  }
})
const requestIdLookups = () => sqlLog.filter(q => q.sql.includes("json_extract(value, '$.requestId') IN"))

const skipReason = isSqliteAvailable()
  ? null
  : 'node:sqlite not available — needs Node 22+; skipping'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-tokens-test-'))
  clearCursorWorkspaceMapCache()
  sqlLog.length = 0
})

afterEach(async () => {
  clearCursorWorkspaceMapCache()
  await rm(tmpDir, { recursive: true, force: true })
})

function buildDb(fn: (db: {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}) => void): string {
  const dbPath = join(tmpDir, 'state.vscdb')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)')
  fn(db)
  db.close()
  return dbPath
}

function insertBubble(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  composerId: string
  bubbleUuid: string
  type: 1 | 2
  text: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  createdAt?: string
  requestId?: string
  codeBlocks?: string
}): void {
  const key = `bubbleId:${opts.composerId}:${opts.bubbleUuid}`
  const value = JSON.stringify({
    type: opts.type,
    conversationId: '',
    createdAt: opts.createdAt ?? new Date().toISOString(),
    tokenCount: {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
    },
    modelInfo: opts.model ? { modelName: opts.model } : undefined,
    text: opts.text,
    codeBlocks: opts.codeBlocks ?? '[]',
    requestId: opts.requestId,
  })
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value)
}

function insertComposerData(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  composerId: string
  totalUsedTokens?: number | null
  contextTokensUsed?: number | null
  createdAt?: number
}): void {
  const key = `composerData:${opts.composerId}`
  const breakdown = opts.totalUsedTokens !== undefined
    ? { totalUsedTokens: opts.totalUsedTokens }
    : {}
  const value = JSON.stringify({
    promptTokenBreakdown: breakdown,
    contextTokensUsed: opts.contextTokensUsed ?? undefined,
    createdAt: opts.createdAt ?? undefined,
  })
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value)
}

function insertAgentKv(db: {
  prepare(sql: string): { run(...params: unknown[]): void }
}, opts: {
  blobId: string
  role: string
  content: unknown
  requestId?: string
}): void {
  const key = `agentKv:blob:${opts.blobId}`
  const value = JSON.stringify({
    role: opts.role,
    content: opts.content,
    providerOptions: opts.requestId
      ? { cursor: { requestId: opts.requestId } }
      : undefined,
  })
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value)
}

async function collectCalls(provider: ReturnType<typeof createCursorProvider>, dbPath: string): Promise<ParsedProviderCall[]> {
  const source = { path: dbPath, project: 'test', provider: 'cursor' as const }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

describe.skipIf(skipReason !== null)('cursor real context tokens (#575)', () => {
  it('credits composerData.promptTokenBreakdown.totalUsedTokens as input', async () => {
    const composerId = 'aaaa1111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 50000 })
      insertBubble(db, {
        composerId, bubbleUuid: 'b1', type: 1, text: 'user prompt',
        inputTokens: 0, outputTokens: 0,
      })
      insertBubble(db, {
        composerId, bubbleUuid: 'b2', type: 2, text: 'assistant reply',
        model: 'claude-4.6-sonnet', inputTokens: 0, outputTokens: 0,
      })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const credited = calls.find(c => c.inputTokens === 50000)
    expect(credited).toBeDefined()
    expect(credited!.deduplicationKey).toBe(`cursor:composer-input:${composerId}`)
    expect(credited!.costIsEstimated).toBe(true)
  })

  it('credits real input tokens once per conversation, not per bubble', async () => {
    const composerId = 'bbbb1111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 30000 })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'turn 1' })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'reply 1', model: 'gpt-5' })
      insertBubble(db, { composerId, bubbleUuid: 'b3', type: 1, text: 'turn 2' })
      insertBubble(db, { composerId, bubbleUuid: 'b4', type: 2, text: 'reply 2', model: 'gpt-5' })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const credited = calls.filter(c => c.inputTokens === 30000)
    expect(credited.length).toBe(1)
    // The metered conversation's user-bubble text must not be counted on top.
    const inputTotal = calls.reduce((s, c) => s + c.inputTokens, 0)
    expect(inputTotal).toBe(30000)
  })

  it('anchors the conversation record to composerData.createdAt, independent of the parse window', async () => {
    const composerId = 'ab121111-2222-3333-4444-555566667777'
    const startMs = Date.parse('2026-06-01T10:00:00.000Z')
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 20000, createdAt: startMs })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'later turn' })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const credited = calls.find(c => c.inputTokens === 20000)
    expect(credited).toBeDefined()
    expect(credited!.timestamp).toBe(new Date(startMs).toISOString())
  })

  it('falls back to text estimation when no composerData exists', async () => {
    const composerId = 'cccc1111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertBubble(db, {
        composerId, bubbleUuid: 'b1', type: 1, text: 'hello world this is a test',
      })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const userCall = calls.find(c => c.inputTokens > 0)
    expect(userCall).toBeDefined()
    expect(userCall!.inputTokens).toBe(Math.ceil('hello world this is a test'.length / 4))
  })

  it('uses contextTokensUsed when totalUsedTokens is null', async () => {
    const composerId = 'dddd1111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: null, contextTokensUsed: 42000 })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'prompt' })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'reply', model: 'gpt-5' })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const credited = calls.find(c => c.inputTokens === 42000)
    expect(credited).toBeDefined()
  })

  it('uses contextTokensUsed when totalUsedTokens is present but zero', async () => {
    const composerId = 'de001111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 0, contextTokensUsed: 42000 })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'prompt' })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const credited = calls.find(c => c.inputTokens === 42000)
    expect(credited).toBeDefined()
  })

  it('skips the meter when any bubble carries real tokenCounts', async () => {
    const composerId = 'ef001111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 80000 })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'prompt', inputTokens: 6000 })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'reply', model: 'gpt-5', outputTokens: 900 })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    // Real per-bubble counts are authoritative; the snapshot must not stack.
    expect(calls.find(c => c.inputTokens === 80000)).toBeUndefined()
    const inputTotal = calls.reduce((s, c) => s + c.inputTokens, 0)
    expect(inputTotal).toBe(6000)
  })

  it('attributes aggregated agentKv tools once, with canonical Bash names', async () => {
    const composerId = 'eeee1111-2222-3333-4444-555566667777'
    const requestId = 'req-001'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 10000 })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'do stuff', requestId })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'doing stuff', model: 'gpt-5' })
      insertBubble(db, { composerId, bubbleUuid: 'b3', type: 1, text: 'do more stuff', requestId: 'req-002' })
      insertBubble(db, { composerId, bubbleUuid: 'b4', type: 2, text: 'doing more stuff', model: 'gpt-5' })
      insertAgentKv(db, {
        blobId: 'akv-1', role: 'user',
        content: [{ type: 'text', text: 'do stuff' }],
        requestId,
      })
      insertAgentKv(db, {
        blobId: 'akv-2', role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'Read', args: {} },
          { type: 'tool-call', toolName: 'Shell', args: { command: 'npm test' } },
        ],
      })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const callWithTools = calls.find(c => c.tools.length > 0)
    expect(callWithTools).toBeDefined()
    expect(callWithTools!.tools).toContain('Read')
    expect(callWithTools!.tools).toContain('Bash')
    expect(callWithTools!.bashCommands).toContain('npm')

    const allTools = calls.flatMap(c => c.tools)
    const allBashCommands = calls.flatMap(c => c.bashCommands)
    expect(allTools.filter(t => t === 'Read').length).toBe(1)
    expect(allTools.filter(t => t === 'Bash').length).toBe(1)
    expect(allBashCommands.filter(cmd => cmd === 'npm').length).toBe(1)
  })

  it('uses conversation model for pricing the conversation record', async () => {
    const composerId = 'ffff1111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 100000 })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'prompt' })
      insertBubble(db, {
        composerId, bubbleUuid: 'b2', type: 2, text: 'reply',
        model: 'claude-4.5-opus-high-thinking',
      })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const creditedCall = calls.find(c => c.inputTokens === 100000)
    expect(creditedCall).toBeDefined()
    expect(creditedCall!.model).toBe('claude-4.5-opus-high-thinking')
  })

  it('estimates input from the agent stream when a non-Composer turn has empty bubble text', async () => {
    const composerId = '99990000-1111-2222-3333-444455556666'
    const requestId = 'req-gpt-1'
    const prompt = '<user_info>OS: darwin</user_info> refactor the auth module and add tests'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: '', requestId })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'done', model: 'gpt-5' })
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: prompt, requestId })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const credited = calls.find(c => c.inputTokens > 0)
    expect(credited).toBeDefined()
    expect(credited!.inputTokens).toBe(Math.ceil(prompt.length / 4))
  })

  it('counts tool and system stream rows as context for meterless sessions', async () => {
    const composerId = '77770000-1111-2222-3333-444455556666'
    const requestId = 'req-gpt-2'
    const prompt = 'summarize the repo'
    const toolResult = 'x'.repeat(4000)
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: '', requestId })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'done', model: 'gpt-5' })
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: prompt, requestId })
      insertAgentKv(db, { blobId: 'akv-2', role: 'tool', content: [{ type: 'text', text: toolResult }] })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const credited = calls.find(c => c.inputTokens > 0)
    expect(credited).toBeDefined()
    expect(credited!.inputTokens).toBe(Math.ceil((prompt.length + toolResult.length) / 4))
  })

  it('does not double count turns that also have bubble text in stream-estimated conversations', async () => {
    const composerId = '66660000-1111-2222-3333-444455556666'
    const requestId = 'req-gpt-3'
    const streamPrompt = 'the full prompt with injected context'
    const dbPath = buildDb((db) => {
      // Turn 1 has visible bubble text; turn 2's lives only in the stream.
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'visible text', requestId })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 1, text: '' })
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: streamPrompt, requestId })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const inputTotal = calls.reduce((s, c) => s + c.inputTokens, 0)
    expect(inputTotal).toBe(Math.ceil(streamPrompt.length / 4))
  })

  it('emits sessions recorded only in the agent stream', async () => {
    const requestId = 'req-headless-1'
    const prompt = 'run the nightly data export'
    const reply = 'export completed with 3 warnings'
    const dbPath = buildDb((db) => {
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: prompt, requestId })
      insertAgentKv(db, { blobId: 'akv-2', role: 'assistant', content: [{ type: 'text', text: reply }] })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const session = calls.find(c => c.deduplicationKey === `cursor:agentKv:${requestId}`)
    expect(session).toBeDefined()
    expect(session!.inputTokens).toBe(Math.ceil(prompt.length / 4))
    expect(session!.outputTokens).toBe(Math.ceil(reply.length / 4))
  })

  it('does not bill the stream of a conversation older than the lookback as a new session', async () => {
    const composerId = '44440000-1111-2222-3333-444455556666'
    const requestId = 'req-old'
    const oldAt = new Date(Date.now() - 240 * 864e5).toISOString()
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'old prompt', createdAt: oldAt, requestId })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'old reply', model: 'gpt-5', createdAt: oldAt, requestId })
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: 'x'.repeat(40_000), requestId })
      insertAgentKv(db, { blobId: 'akv-2', role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(4_000) }] })
    })

    const calls = await collectCalls(createCursorProvider(dbPath), dbPath)

    expect(calls).toEqual([])
    expect(requestIdLookups().map(q => q.params)).toEqual([[requestId]])
  })

  it('bills a recent stream whose bubbles the scan budget cut, at its bubble\'s time', async () => {
    const cutAt = new Date(Date.now() - 2 * 864e5).toISOString()
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId: '44441111-1111-2222-3333-444455556666', bubbleUuid: 'b1', type: 1, text: 'cut prompt', createdAt: cutAt, requestId: 'req-cut' })
      insertBubble(db, { composerId: '44442222-1111-2222-3333-444455556666', bubbleUuid: 'b2', type: 2, text: 'kept reply', model: 'gpt-5' })
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: 'cut prompt with context', requestId: 'req-cut' })
    })
    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = '1'

    const calls = await collectCalls(createCursorProvider(dbPath), dbPath)

    const cut = calls.filter(c => c.deduplicationKey === 'cursor:agentKv:req-cut')
    expect(cut.map(c => [c.timestamp, c.inputTokens])).toEqual([[cutAt, Math.ceil('cut prompt with context'.length / 4)]])
    expect(calls.some(c => c.deduplicationKey.endsWith(':b1'))).toBe(false)
  })

  it('bills an agent-only stream whose only bubble has no createdAt, at the first-seen time', async () => {
    const requestId = 'req-undated'
    const dbPath = buildDb((db) => {
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        'bubbleId:55551111-1111-2222-3333-444455556666:b1',
        JSON.stringify({ type: 1, text: 'undated prompt', requestId }),
      )
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: 'undated prompt with context', requestId })
    })

    const calls = await collectCalls(createCursorProvider(dbPath), dbPath)

    const stream = calls.filter(c => c.deduplicationKey === `cursor:agentKv:${requestId}`)
    expect(stream.map(c => c.timestamp)).toEqual([new Date(statSync(dbPath).mtimeMs).toISOString()])
  })

  it('binds at most 900 request ids per lookup', async () => {
    const dbPath = buildDb((db) => {
      for (let i = 0; i < 901; i++) {
        insertAgentKv(db, { blobId: `akv-${i}`, role: 'user', content: 'run the export', requestId: `req-bg-${i}` })
      }
    })

    const calls = await collectCalls(createCursorProvider(dbPath), dbPath)

    expect(calls.length).toBe(901)
    expect(requestIdLookups().map(q => q.params.length)).toEqual([900, 1])
  })

  it('skips the request-id lookup when every stream joins a scanned bubble', async () => {
    const composerId = '22220000-1111-2222-3333-444455556666'
    const requestId = 'req-joined'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'prompt', requestId })
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: 'prompt', requestId })
    })

    await collectCalls(createCursorProvider(dbPath), dbPath)

    expect(sqlLog.length).toBeGreaterThan(0)
    expect(requestIdLookups()).toEqual([])
  })

  it('keeps an agent-only session on the time it was first seen after the DB changes and the result cache is cleared', async () => {
    const requestId = 'req-headless-2'
    const dbPath = buildDb((db) => {
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: 'run the export', requestId })
      insertAgentKv(db, { blobId: 'akv-2', role: 'assistant', content: [{ type: 'text', text: 'done' }] })
    })
    const firstSeen = new Date(Date.now() - 3 * 864e5)
    utimesSync(dbPath, firstSeen, firstSeen)

    const first = await collectCalls(createCursorProvider(dbPath), dbPath)
    utimesSync(dbPath, new Date(), new Date())
    rmSync(join(getCodeburnCacheDir(), cursorCacheFileName()))
    const second = await collectCalls(createCursorProvider(dbPath), dbPath)

    const key = `cursor:agentKv:${requestId}`
    const firstStamps = first.filter(c => c.deduplicationKey === key).map(c => c.timestamp)
    const recorded = JSON.parse(readFileSync(join(getCodeburnCacheDir(), 'cursor-first-seen.json'), 'utf-8'))[requestId]
    expect(firstStamps).toEqual([recorded])
    expect(Date.parse(recorded)).toBeLessThan(Date.now() - 864e5)
    expect(second.filter(c => c.deduplicationKey === key).map(c => c.timestamp)).toEqual([recorded])
  })

  it('stamps an agent-only session at the DB mtime when its recorded first-seen value is garbage', async () => {
    const requestId = 'req-headless-3'
    const dbPath = buildDb((db) => {
      insertAgentKv(db, { blobId: 'akv-1', role: 'user', content: 'run the export', requestId })
    })
    mkdirSync(getCodeburnCacheDir(), { recursive: true })
    writeFileSync(join(getCodeburnCacheDir(), 'cursor-first-seen.json'), JSON.stringify({ [requestId]: 'garbage' }))

    const calls = await collectCalls(createCursorProvider(dbPath), dbPath)

    const stamp = calls.find(c => c.deduplicationKey === `cursor:agentKv:${requestId}`)!.timestamp
    expect(stamp).toBe(new Date(statSync(dbPath).mtimeMs).toISOString())
  })

  it('pairs each assistant reply with its own turn\'s user question', async () => {
    const composerId = '55550000-1111-2222-3333-444455556666'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'first question' })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'first reply', model: 'gpt-5' })
      insertBubble(db, { composerId, bubbleUuid: 'b3', type: 1, text: 'second question' })
      insertBubble(db, { composerId, bubbleUuid: 'b4', type: 2, text: 'second reply', model: 'gpt-5' })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const firstReply = calls.find(c => c.userMessage.includes('first reply'))
    const secondReply = calls.find(c => c.userMessage.includes('second reply'))
    expect(firstReply).toBeDefined()
    expect(secondReply).toBeDefined()
    expect(firstReply!.userMessage).toContain('first question')
    expect(secondReply!.userMessage).toContain('second question')
  })

  it('does not pair a reply with a user bubble that has no createdAt', async () => {
    const composerId = '33330000-1111-2222-3333-444455556666'
    const dbPath = buildDb((db) => {
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        `bubbleId:${composerId}:u0`,
        JSON.stringify({ type: 1, text: 'stale draft' }),
      )
      insertBubble(db, { composerId, bubbleUuid: 'u1', type: 1, text: 'fix the failing login test' })
      insertBubble(db, { composerId, bubbleUuid: 'a1', type: 2, text: 'patched auth.ts', model: 'gpt-5' })
      insertBubble(db, { composerId, bubbleUuid: 'u2', type: 1, text: 'now run it' })
      insertBubble(db, { composerId, bubbleUuid: 'a2', type: 2, text: 'tests pass', model: 'gpt-5' })
    })

    const calls = await collectCalls(createCursorProvider(dbPath), dbPath)

    expect(calls.find(c => c.deduplicationKey.endsWith(':a1'))!.userMessage).toBe('fix the failing login test patched auth.ts')
    expect(calls.find(c => c.deduplicationKey.endsWith(':a2'))!.userMessage).toBe('now run it tests pass')
  })

  it('keeps later turns on their own prompts when the scan budget cuts a turn\'s user bubble', async () => {
    const composerId = '11110000-1111-2222-3333-444455556666'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'u1', type: 1, text: 'first prompt' })
      insertBubble(db, { composerId, bubbleUuid: 'a1', type: 2, text: 'first reply', model: 'gpt-5' })
      insertBubble(db, { composerId, bubbleUuid: 'u2', type: 1, text: 'second prompt' })
      insertBubble(db, { composerId, bubbleUuid: 'a2', type: 2, text: 'second reply', model: 'gpt-5' })
    })
    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = '3'

    const calls = await collectCalls(createCursorProvider(dbPath), dbPath)

    expect(calls.find(c => c.deduplicationKey.endsWith(':u1'))).toBeUndefined()
    expect(calls.find(c => c.deduplicationKey.endsWith(':a1'))!.userMessage).toBe('first reply')
    expect(calls.find(c => c.deduplicationKey.endsWith(':a2'))!.userMessage).toBe('second prompt second reply')
  })

  it('does not fabricate input when an empty-text turn has no agent stream', async () => {
    const composerId = '88880000-1111-2222-3333-444455556666'
    const dbPath = buildDb((db) => {
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: '' })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'done', model: 'gpt-5' })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    expect(calls.find(c => c.inputTokens > 0)).toBeUndefined()
  })
})
