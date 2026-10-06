import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createAmpProvider } from '../../src/providers/amp.js'
import { calculateCost } from '../../src/models.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'amp-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// Mirrors the real on-disk layout: <amp-data>/threads/<thread-id>.json, one
// JSON document per thread. The shapes follow ccusage's amp adapter fixtures
// (rust/adapters/amp/src/parser.rs), which parse real Amp thread files.
async function writeThread(id: string, thread: unknown): Promise<string> {
  const dir = join(tmpDir, 'threads')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.json`)
  await writeFile(path, JSON.stringify(thread), 'utf-8')
  return path
}

const LEDGER_THREAD = {
  id: 'T-abc123',
  messages: [
    { role: 'user', content: 'Fix the flaky test in parser.ts' },
    {
      role: 'assistant',
      messageId: 11,
      usage: {
        model: 'claude-opus-4-6',
        inputTokens: 10,
        outputTokens: 178,
        cacheCreationInputTokens: 986,
        cacheReadInputTokens: 11372,
        timestamp: '2026-09-20T11:42:10.652Z',
      },
    },
    { role: 'user', content: 'Now make it fast' },
    {
      role: 'assistant',
      messageId: 14,
      usage: {
        model: 'claude-opus-4-6',
        inputTokens: 5,
        outputTokens: 42,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 12000,
        timestamp: '2026-09-20T11:43:00.000Z',
      },
    },
  ],
  usageLedger: {
    events: [
      {
        id: 'evt-1',
        timestamp: '2026-09-20T11:42:12.000Z',
        model: 'claude-opus-4-6',
        tokens: { input: 12368, output: 178 },
        toMessageId: 11,
      },
      {
        id: 'evt-2',
        timestamp: '2026-09-20T11:43:02.000Z',
        model: 'claude-opus-4-6',
        tokens: { input: 12005, output: 42 },
        toMessageId: 14,
      },
    ],
  },
}

async function parseAll(source: Awaited<ReturnType<ReturnType<typeof createAmpProvider>['discoverSessions']>[number]>, seenKeys = new Set<string>()) {
  const provider = createAmpProvider([tmpDir])
  const calls = []
  for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
  return calls
}

describe('amp provider', () => {
  it('reports its identity', () => {
    const provider = createAmpProvider([tmpDir])
    expect(provider.name).toBe('amp')
    expect(provider.displayName).toBe('Amp')
    expect(provider.modelDisplayName('claude-opus-4-6')).toBeTruthy()
    expect(provider.toolDisplayName('some_tool')).toBe('some_tool')
  })

  it('probes the threads dir it discovers', async () => {
    const provider = createAmpProvider([tmpDir])
    expect(await provider.probeRoots()).toEqual([{ path: join(tmpDir, 'threads'), label: 'threads' }])
  })

  it('resolves the default root from AMP_DATA_DIR, comma-separated', async () => {
    const first = await mkdtemp(join(tmpdir(), 'amp-root-a-'))
    const second = await mkdtemp(join(tmpdir(), 'amp-root-b-'))
    try {
      process.env['AMP_DATA_DIR'] = `${first}, ${second}`
      const provider = createAmpProvider()
      expect(await provider.probeRoots()).toEqual([
        { path: join(first, 'threads'), label: 'threads' },
        { path: join(second, 'threads'), label: 'threads' },
      ])
    } finally {
      delete process.env['AMP_DATA_DIR']
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  it('discovers nothing when the data dir is absent', async () => {
    const provider = createAmpProvider([join(tmpDir, 'missing')])
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('discovers JSON candidates without parsing and skips invalid threads during parsing', async () => {
    await writeThread('T-good', LEDGER_THREAD)
    await mkdir(join(tmpDir, 'threads'), { recursive: true })
    await writeFile(join(tmpDir, 'threads', 'notes.txt'), 'not a thread', 'utf-8')
    await writeFile(join(tmpDir, 'threads', 'T-broken.json'), '{not json', 'utf-8')
    await writeFile(join(tmpDir, 'threads', 'T-noid.json'), JSON.stringify({ messages: [] }), 'utf-8')

    const provider = createAmpProvider([tmpDir])
    const sources = await provider.discoverSessions()
    expect(sources.map(source => source.path).sort()).toEqual([
      join(tmpDir, 'threads', 'T-broken.json'),
      join(tmpDir, 'threads', 'T-good.json'),
      join(tmpDir, 'threads', 'T-noid.json'),
    ])
    for (const source of sources) {
      expect(source.provider).toBe('amp')
      expect(source.project).toBe('Amp')
      expect(await parseAll(source)).toHaveLength(source.path.endsWith('T-good.json') ? 2 : 0)
    }
  })

  it('discovers and parses nested threads', async () => {
    const dir = join(tmpDir, 'threads', 'sub', 'nested')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'T-2.json')
    await writeFile(path, JSON.stringify({ ...LEDGER_THREAD, id: 'T-2' }), 'utf-8')
    await writeFile(join(dir, 'notes.txt'), 'not a thread', 'utf-8')

    const sources = await createAmpProvider([tmpDir]).discoverSessions()
    expect(sources).toEqual([{ path, project: 'Amp', provider: 'amp' }])
    const calls = await parseAll(sources[0])
    expect(calls).toHaveLength(2)
    expect(calls[0].sessionId).toBe('T-2')
  })

  it('parses ledger events with cache tokens joined from the billed message', async () => {
    const path = await writeThread('T-abc123', LEDGER_THREAD)
    const calls = await parseAll({ path, project: 'Amp', provider: 'amp' })

    expect(calls).toHaveLength(2)

    expect(calls[0].model).toBe('claude-opus-4-6')
    expect(calls[0].inputTokens).toBe(12368)
    expect(calls[0].outputTokens).toBe(178)
    expect(calls[0].cacheCreationInputTokens).toBe(986)
    expect(calls[0].cacheReadInputTokens).toBe(11372)
    expect(calls[0].cachedInputTokens).toBe(11372)
    expect(calls[0].reasoningTokens).toBe(0)
    expect(calls[0].timestamp).toBe('2026-09-20T11:42:12.000Z')
    expect(calls[0].sessionId).toBe('T-abc123')
    expect(calls[0].deduplicationKey).toBe('amp:T-abc123:evt-1')
    expect(calls[0].costIsEstimated).toBe(true)
    expect(calls[0].costUSD).toBe(calculateCost('claude-opus-4-6', 12368, 178, 986, 11372, 0))
    expect(calls[0].costUSD).toBeGreaterThan(0)
    // The ledger event carries no text; attribution falls back to the
    // thread's first user message.
    expect(calls[0].userMessage).toBe('Fix the flaky test in parser.ts')

    expect(calls[1].deduplicationKey).toBe('amp:T-abc123:evt-2')
    expect(calls[1].cacheReadInputTokens).toBe(12000)
  })

  it('bills a total-only token record as output', async () => {
    await writeThread('T-total', {
      id: 'T-total',
      messages: [],
      usageLedger: {
        events: [
          { id: 'evt-t', timestamp: '2026-09-20T12:00:00.000Z', model: 'gpt-5.6-codex', tokens: { total: 345 } },
        ],
      },
    })
    const path = join(tmpDir, 'threads', 'T-total.json')
    const calls = await parseAll({ path, project: 'Amp', provider: 'amp' })

    expect(calls).toHaveLength(1)
    expect(calls[0].inputTokens).toBe(0)
    expect(calls[0].outputTokens).toBe(345)
    expect(calls[0].costUSD).toBeGreaterThan(0)
  })

  it.each([
    { input: 10, output: 20, creation: 30, read: 40, total: 150, expectedOutput: 70 },
    { input: 10, output: 20, creation: 30, read: 40, total: 100, expectedOutput: 20 },
    { input: 10, output: 20, creation: 30, read: 40, total: 50, expectedOutput: 20 },
    { input: 10, output: 20, creation: 0, read: 0, total: 50, expectedOutput: 40 },
    { input: 0, output: 0, creation: 30, read: 40, total: 100, expectedOutput: 30 },
  ])('accounts for ledger total remainders: %j', async ({ input, output, creation, read, total, expectedOutput }) => {
    const path = await writeThread('T-remainder', {
      id: 'T-remainder',
      messages: [{
        role: 'assistant',
        messageId: 1,
        usage: { cacheCreationInputTokens: creation, cacheReadInputTokens: read },
      }],
      usageLedger: {
        events: [{
          id: 'evt-remainder',
          timestamp: '2026-09-20T12:00:00.000Z',
          model: 'claude-opus-4-6',
          tokens: { input, output, total },
          toMessageId: 1,
        }],
      },
    })
    const calls = await parseAll({ path, project: 'Amp', provider: 'amp' })
    expect(calls).toHaveLength(1)
    expect(calls[0].inputTokens).toBe(input)
    expect(calls[0].outputTokens).toBe(expectedOutput)
    expect(calls[0].cacheCreationInputTokens).toBe(creation)
    expect(calls[0].cacheReadInputTokens).toBe(read)
    expect(calls[0].costUSD).toBe(calculateCost('claude-opus-4-6', input, expectedOutput, creation, read, 0))
  })

  it('falls back to per-message usage when the thread has no ledger', async () => {
    await writeThread('T-msgs', {
      id: 'T-msgs',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          messageId: 3,
          usage: {
            model: 'claude-haiku-4-5-20251001',
            inputTokens: 10,
            outputTokens: 178,
            cacheCreationInputTokens: 986,
            cacheReadInputTokens: 11372,
            timestamp: '2026-09-19T11:42:10.652Z',
          },
        },
        {
          role: 'assistant',
          // Model and timestamp may live on the message when the usage block
          // omits them.
          model: 'gpt-5.6-codex',
          timestamp: '2026-09-19T11:43:00.000Z',
          usage: { inputTokens: 5, outputTokens: 42 },
        },
      ],
    })
    const path = join(tmpDir, 'threads', 'T-msgs.json')
    const calls = await parseAll({ path, project: 'Amp', provider: 'amp' })

    expect(calls).toHaveLength(2)
    expect(calls[0].model).toBe('claude-haiku-4-5-20251001')
    expect(calls[0].inputTokens).toBe(10)
    expect(calls[0].outputTokens).toBe(178)
    expect(calls[0].cacheCreationInputTokens).toBe(986)
    expect(calls[0].cacheReadInputTokens).toBe(11372)
    expect(calls[0].timestamp).toBe('2026-09-19T11:42:10.652Z')
    expect(calls[0].userMessage).toBe('hi')
    expect(calls[1].model).toBe('gpt-5.6-codex')
    expect(calls[1].timestamp).toBe('2026-09-19T11:43:00.000Z')
  })

  it('skips records with no usable tokens', async () => {
    await writeThread('T-empty', {
      id: 'T-empty',
      messages: [],
      usageLedger: {
        events: [
          { id: 'evt-e', timestamp: '2026-09-20T12:00:00.000Z', model: 'gpt-5.6-codex', tokens: {} },
          { timestamp: '2026-09-20T12:00:01.000Z', model: 'gpt-5.6-codex', tokens: { input: 1 } },
        ],
      },
    })
    const path = join(tmpDir, 'threads', 'T-empty.json')
    const calls = await parseAll({ path, project: 'Amp', provider: 'amp' })

    expect(calls).toHaveLength(1)
    expect(calls[0].inputTokens).toBe(1)
  })

  it('deduplicates through seenKeys', async () => {
    const path = await writeThread('T-abc123', LEDGER_THREAD)
    const source = { path, project: 'Amp', provider: 'amp' }

    const seenKeys = new Set<string>()
    const first = await parseAll(source, seenKeys)
    expect(first).toHaveLength(2)

    const second = await parseAll(source, seenKeys)
    expect(second).toHaveLength(0)
  })

  it('clamps malformed token fields instead of leaking NaN', async () => {
    await writeThread('T-bad', {
      id: 'T-bad',
      messages: [],
      usageLedger: {
        events: [
          { id: 'evt-n', timestamp: '2026-09-20T12:00:00.000Z', model: 'gpt-5.6-codex', tokens: { input: -5, output: 'many' } },
        ],
      },
    })
    const path = join(tmpDir, 'threads', 'T-bad.json')
    const calls = await parseAll({ path, project: 'Amp', provider: 'amp' })

    // Every field malformed or non-positive -> nothing usable, no call.
    expect(calls).toHaveLength(0)
  })

  it('is registered in the provider registry', async () => {
    const { getAllProviders } = await import('../../src/providers/index.js')
    const providers = await getAllProviders()
    expect(providers.find(p => p.name === 'amp')).toBeDefined()
  })
})
