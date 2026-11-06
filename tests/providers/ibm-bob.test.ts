import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { ibmBob, createIBMBobProvider } from '../../src/providers/ibm-bob.js'
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
    messages.push({ type: 'say', say: 'user_feedback', text: opts.userMessage, ts: 1_700_000_000_000 })
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
    ts: opts.ts ?? 1_700_000_001_000,
  })

  return JSON.stringify(messages)
}

function makeApiHistory(model?: string): string {
  const modelTag = model ? `<model>${model}</model>` : ''
  return JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: `hello\n<environment_details>\n${modelTag}\n</environment_details>` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
  ])
}

describe('ibm-bob provider - discovery and parsing', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ibm-bob-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers IBM Bob task directories with ui_messages.json', async () => {
    const task1 = join(tmpDir, 'tasks', 'task-a')
    const task2 = join(tmpDir, 'tasks', 'task-b')
    await mkdir(task1, { recursive: true })
    await mkdir(task2, { recursive: true })
    await writeFile(join(task1, 'ui_messages.json'), '[]')
    await writeFile(join(task2, 'ui_messages.json'), '[]')

    const provider = createIBMBobProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.provider === 'ibm-bob')).toBe(true)
    expect(sessions.every(s => s.project === 'IBM Bob')).toBe(true)
  })

  it('skips tasks without ui_messages.json', async () => {
    const task = join(tmpDir, 'tasks', 'task-no-ui')
    await mkdir(task, { recursive: true })
    await writeFile(join(task, 'api_conversation_history.json'), '[]')

    const provider = createIBMBobProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(0)
  })

  it('parses token usage and provider cost from Bob ui messages', async () => {
    const taskDir = join(tmpDir, 'tasks', 'task-001')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'ui_messages.json'), makeUiMessages({
      tokensIn: 250,
      tokensOut: 125,
      cacheReads: 60,
      cacheWrites: 30,
      cost: 0.08,
      userMessage: 'modernize this class',
    }))
    await writeFile(join(taskDir, 'api_conversation_history.json'), makeApiHistory('anthropic/claude-sonnet-4-6'))

    const source = { path: join(taskDir, 'ui_messages.json'), project: 'IBM Bob', provider: 'ibm-bob' }
    const calls: ParsedProviderCall[] = []
    for await (const call of ibmBob.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!).toMatchObject({
      provider: 'ibm-bob',
      model: 'claude-sonnet-4-6',
      inputTokens: 250,
      outputTokens: 125,
      cacheReadInputTokens: 60,
      cacheCreationInputTokens: 30,
      costUSD: 0.08,
      userMessage: 'modernize this class',
      sessionId: 'task-001',
    })
    expect(calls[0]!.deduplicationKey).toBe('ibm-bob:task-001:0')
  })

  it('falls back to IBM Bob auto model when history has no model tag', async () => {
    const taskDir = join(tmpDir, 'tasks', 'task-002')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'ui_messages.json'), makeUiMessages({ tokensIn: 100, tokensOut: 50 }))
    await writeFile(join(taskDir, 'api_conversation_history.json'), makeApiHistory())

    const source = { path: join(taskDir, 'ui_messages.json'), project: 'IBM Bob', provider: 'ibm-bob' }
    const calls: ParsedProviderCall[] = []
    for await (const call of ibmBob.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('ibm-bob-auto')
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('deduplicates across parser runs', async () => {
    const taskDir = join(tmpDir, 'tasks', 'task-003')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'ui_messages.json'), makeUiMessages({ tokensIn: 100, tokensOut: 50 }))

    const source = { path: join(taskDir, 'ui_messages.json'), project: 'IBM Bob', provider: 'ibm-bob' }
    const seenKeys = new Set<string>()

    const calls1: ParsedProviderCall[] = []
    for await (const call of ibmBob.createSessionParser(source, seenKeys).parse()) calls1.push(call)

    const calls2: ParsedProviderCall[] = []
    for await (const call of ibmBob.createSessionParser(source, seenKeys).parse()) calls2.push(call)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
  })
})

describe('ibm-bob provider - metadata', () => {
  it('has correct name and displayName', () => {
    expect(ibmBob.name).toBe('ibm-bob')
    expect(ibmBob.displayName).toBe('IBM Bob')
  })

  it('uses shared short model display names', () => {
    expect(ibmBob.modelDisplayName('ibm-bob-auto')).toBe('IBM Bob (auto)')
    expect(ibmBob.modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })
})
