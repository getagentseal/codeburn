import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'

import {
  createCursorProvider,
  clearCursorWorkspaceMapCache,
} from '../../src/providers/cursor.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

const skipReason = isSqliteAvailable()
  ? null
  : 'node:sqlite not available — needs Node 22+; skipping'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-tokens-test-'))
  clearCursorWorkspaceMapCache()
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
  writeFile(dbPath, '')
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
}): void {
  const key = `composerData:${opts.composerId}`
  const breakdown = opts.totalUsedTokens !== undefined
    ? { totalUsedTokens: opts.totalUsedTokens }
    : {}
  const value = JSON.stringify({
    promptTokenBreakdown: breakdown,
    contextTokensUsed: opts.contextTokensUsed ?? undefined,
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

    // User bubble gets the real context; assistant gets text estimate.
    const userCall = calls.find(c => c.inputTokens === 50000)
    expect(userCall).toBeDefined()
    expect(userCall!.inputTokens).toBe(50000)
  })

  it('credits real input tokens once per conversation, not per bubble', async () => {
    const composerId = 'bbbb1111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 30000 })
      // Multiple user bubbles in the same conversation
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'turn 1' })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'reply 1', model: 'gpt-5' })
      insertBubble(db, { composerId, bubbleUuid: 'b3', type: 1, text: 'turn 2' })
      insertBubble(db, { composerId, bubbleUuid: 'b4', type: 2, text: 'reply 2', model: 'gpt-5' })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    // Exactly one call should have 30000 input tokens
    const credited = calls.filter(c => c.inputTokens === 30000)
    expect(credited.length).toBe(1)
  })

  it('falls back to text estimation when no composerData exists', async () => {
    const composerId = 'cccc1111-2222-3333-4444-555566667777'
    const dbPath = buildDb((db) => {
      // No composerData row
      insertBubble(db, {
        composerId, bubbleUuid: 'b1', type: 1, text: 'hello world this is a test',
      })
    })

    const provider = createCursorProvider(dbPath)
    const calls = await collectCalls(provider, dbPath)

    const userCall = calls.find(c => c.inputTokens > 0)
    expect(userCall).toBeDefined()
    // text length 25 / 4 = 7 tokens
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

  it('attributes tools and bash commands from agentKv to the correct conversation', async () => {
    const composerId = 'eeee1111-2222-3333-4444-555566667777'
    const requestId = 'req-001'
    const dbPath = buildDb((db) => {
      insertComposerData(db, { composerId, totalUsedTokens: 10000 })
      insertBubble(db, { composerId, bubbleUuid: 'b1', type: 1, text: 'do stuff', requestId })
      insertBubble(db, { composerId, bubbleUuid: 'b2', type: 2, text: 'doing stuff', model: 'gpt-5' })
      // agentKv with tool calls
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
    expect(callWithTools!.tools).toContain('Shell')
    expect(callWithTools!.bashCommands).toContain('npm test')
  })

  it('uses conversation model for pricing when input is on a user bubble', async () => {
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
    // Should NOT be cursor-auto (the fallback for user bubbles without model)
    expect(creditedCall!.model).not.toBe('cursor-auto')
    // Should be the conversation's actual model
    expect(creditedCall!.model).toBe('claude-4.5-opus-high-thinking')
  })
})
