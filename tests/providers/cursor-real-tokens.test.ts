import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
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
