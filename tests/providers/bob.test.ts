import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { bob, createBobProvider } from '../../src/providers/bob.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

function makeUiMessages(opts: {
  tokensIn?: number
  tokensOut?: number
  cacheReads?: number
  cacheWrites?: number
  cost?: number
  userMessage?: string
  ts?: number
}): string {
  const messages: unknown[] = []

  if (opts.userMessage) {
    messages.push({ type: 'say', say: 'user_feedback', text: opts.userMessage, ts: 1700000000000 })
  }

  const apiData: Record<string, unknown> = {
    tokensIn: opts.tokensIn ?? 100,
    tokensOut: opts.tokensOut ?? 50,
    cacheReads: opts.cacheReads ?? 0,
    cacheWrites: opts.cacheWrites ?? 0,
  }
  if (opts.cost !== undefined) apiData.cost = opts.cost

  messages.push({
    type: 'say',
    say: 'api_req_started',
    text: JSON.stringify(apiData),
    ts: opts.ts ?? 1700000001000,
  })

  return JSON.stringify(messages)
}

function makeApiHistory(opts?: { model?: string }): string {
  const modelTag = opts?.model ? `<model>${opts.model}</model>` : ''
  const messages = [
    { role: 'user', content: [{ type: 'text', text: `hello\n<environment_details>\n${modelTag}\n</environment_details>` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
  ]
  return JSON.stringify(messages)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bob-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('IBM Bob provider', () => {
  it('discovers tasks from globalStorage directory', async () => {
    const tasksDir = join(tmpDir, 'tasks')
    const task1 = join(tasksDir, 'task-001')
    await mkdir(task1, { recursive: true })
    await writeFile(join(task1, 'ui_messages.json'), makeUiMessages({ tokensIn: 100, tokensOut: 50 }))
    await writeFile(join(task1, 'api_conversation_history.json'), makeApiHistory())

    const provider = createBobProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0].provider).toBe('bob')
    expect(sessions[0].project).toBe('IBM Bob')
  })

  it('parses token usage from ui_messages.json', async () => {
    const tasksDir = join(tmpDir, 'tasks')
    const task1 = join(tasksDir, 'task-001')
    await mkdir(task1, { recursive: true })
    await writeFile(join(task1, 'ui_messages.json'), makeUiMessages({ tokensIn: 200, tokensOut: 100, cacheReads: 50 }))
    await writeFile(join(task1, 'api_conversation_history.json'), makeApiHistory({ model: 'claude-sonnet-4-6' }))

    const provider = createBobProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    const parser = provider.createSessionParser(sessions[0], new Set())

    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0].inputTokens).toBe(200)
    expect(calls[0].outputTokens).toBe(100)
    expect(calls[0].cacheReadInputTokens).toBe(50)
    expect(calls[0].provider).toBe('bob')
  })

  it('extracts model from api_conversation_history', async () => {
    const tasksDir = join(tmpDir, 'tasks')
    const task1 = join(tasksDir, 'task-001')
    await mkdir(task1, { recursive: true })
    await writeFile(join(task1, 'ui_messages.json'), makeUiMessages({ tokensIn: 100, tokensOut: 50 }))
    await writeFile(join(task1, 'api_conversation_history.json'), makeApiHistory({ model: 'anthropic/claude-opus-4-6' }))

    const provider = createBobProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    const parser = provider.createSessionParser(sessions[0], new Set())

    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('claude-opus-4-6')
  })

  it('deduplicates calls using seenKeys', async () => {
    const tasksDir = join(tmpDir, 'tasks')
    const task1 = join(tasksDir, 'task-001')
    await mkdir(task1, { recursive: true })
    await writeFile(join(task1, 'ui_messages.json'), makeUiMessages({ tokensIn: 100, tokensOut: 50, ts: 1700000001000 }))
    await writeFile(join(task1, 'api_conversation_history.json'), makeApiHistory())

    const provider = createBobProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    const seenKeys = new Set<string>()
    const parser1 = provider.createSessionParser(sessions[0], seenKeys)

    const calls1: ParsedProviderCall[] = []
    for await (const call of parser1.parse()) {
      calls1.push(call)
    }

    expect(calls1).toHaveLength(1)

    const parser2 = provider.createSessionParser(sessions[0], seenKeys)
    const calls2: ParsedProviderCall[] = []
    for await (const call of parser2.parse()) {
      calls2.push(call)
    }

    expect(calls2).toHaveLength(0)
  })
})
