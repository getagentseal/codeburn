import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isSqliteAvailable } from '../../src/sqlite.js'
import { createDevinProvider } from '../../src/providers/devin.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'devin-provider-'))
  process.env['HOME'] = tmpDir
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function configureDevinRate(rate = 1): Promise<void> {
  await mkdir(join(tmpDir, '.config', 'codeburn'), { recursive: true })
  await writeFile(join(tmpDir, '.config', 'codeburn', 'config.json'), JSON.stringify({
    devin: { acuUsdRate: rate },
  }))
}

async function writeTranscript(name: string, transcript: unknown): Promise<string> {
  const transcriptsDir = join(tmpDir, 'transcripts')
  await mkdir(transcriptsDir, { recursive: true })
  const filePath = join(transcriptsDir, name)
  await writeFile(filePath, JSON.stringify(transcript))
  return filePath
}

async function parseTranscript(filePath: string, project = 'devin'): Promise<ParsedProviderCall[]> {
  const provider = createDevinProvider(tmpDir)
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser({ path: filePath, project, provider: 'devin' }, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

function createSessionsDb(): void {
  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(join(tmpDir, 'sessions.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT,
      backend_type TEXT,
      model TEXT,
      agent_mode TEXT,
      created_at INTEGER,
      last_activity_at INTEGER,
      title TEXT,
      hidden INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.prepare(`
    INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('db-session', '/Users/example/work/codeburn', 'claude-sonnet-4-6', 1_800_000_000, 1_800_000_010, 'CodeBurn', 0)
  db.prepare(`
    INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('hidden-session', '/Users/example/work/hidden', 'claude-opus-4-6', 1_800_000_000, 1_800_000_010, 'Hidden', 1)
  db.close()
}

describe('devin provider', () => {
  it('discovers Devin CLI transcript json files', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('glimmer-platinum.json', { steps: [] })
    await writeFile(join(tmpDir, 'transcripts', 'ignore.txt'), '{}')

    const provider = createDevinProvider(tmpDir)
    const sources = await provider.discoverSessions()

    expect(sources).toEqual([
      { path: filePath, project: 'devin', provider: 'devin' },
    ])
  })

  it('stays disabled until the Devin ACU rate is configured', async () => {
    await writeTranscript('glimmer-platinum.json', {
      session_id: 'session-123',
      steps: [{ step_id: 's1', metadata: { committed_acu_cost: 0.5 } }],
    })

    const provider = createDevinProvider(tmpDir)
    expect(await provider.discoverSessions()).toEqual([])
    expect(await parseTranscript(join(tmpDir, 'transcripts', 'glimmer-platinum.json'))).toEqual([])
  })

  it('parses per-step ACUs, tokens, tools, and model resolution', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('glimmer-platinum.json', {
      schema_version: '1',
      session_id: 'session-123',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          message: 'please inspect the repo',
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          model_name: 'step-model',
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.02076149918138981,
            generation_model: 'claude-opus-4-6',
            metrics: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_tokens: 10,
              cache_read_tokens: 5,
            },
          },
          tool_calls: [{ function_name: 'read_file' }],
        },
        {
          step_id: 3,
          model_name: 'claude-sonnet-4-6',
          metadata: {
            created_at: '2027-01-15T08:00:02.000Z',
            committed_acu_cost: 0.005421000067144632,
            metrics: { input_tokens: 1 },
          },
          tool_calls: [{ function_name: 'str_replace' }],
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(2)
    expect(calls.reduce((sum, call) => sum + call.costUSD, 0)).toBeCloseTo(0.026182499248534442, 15)
    expect(calls[0]).toMatchObject({
      provider: 'devin',
      model: 'claude-opus-4-6',
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      cachedInputTokens: 5,
      costUSD: 0.02076149918138981,
      tools: ['read_file'],
      timestamp: '2027-01-15T08:00:01.000Z',
      deduplicationKey: 'devin:session-123:2',
      userMessage: 'please inspect the repo',
      sessionId: 'session-123',
    })
    expect(calls[1]).toMatchObject({
      model: 'claude-sonnet-4-6',
      timestamp: '2027-01-15T08:00:02.000Z',
      tools: ['str_replace'],
      deduplicationKey: 'devin:session-123:3',
    })
  })

  it('includes token-only steps and skips user-input or empty steps', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('token-only.json', {
      session_id: 'token-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 'user-cost',
          metadata: {
            is_user_input: true,
            committed_acu_cost: 99,
            metrics: { input_tokens: 99 },
          },
        },
        { step_id: 'empty', metadata: { created_at: '2026-06-05T10:00:00.000Z' } },
        {
          step_id: 'tokens',
          metadata: {
            created_at: '2026-06-05T10:00:01.000Z',
            metrics: { output_tokens: 42 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('agent-model')
    expect(calls[0]!.outputTokens).toBe(42)
    expect(calls[0]!.costUSD).toBe(0)
  })

  it('converts ACUs to costUSD using the configured Devin rate', async () => {
    await configureDevinRate(2.5)
    const filePath = await writeTranscript('configured-rate.json', {
      session_id: 'configured-rate',
      agent: { model_name: 'agent-model' },
      steps: [
        { step_id: 's1', metadata: { committed_acu_cost: 0.4 } },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeCloseTo(1, 12)
  })

  it('falls back to filename session id and deduplicates by step id', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('fallback-session.json', {
      steps: [
        {
          step_id: 1,
          metadata: {
            request_id: 'req-1',
            committed_acu_cost: 0.1,
          },
        },
        {
          step_id: 2,
          metadata: {
            created_at: '2026-06-05T10:00:00.000Z',
            committed_acu_cost: 0.2,
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls.map(c => c.sessionId)).toEqual(['fallback-session', 'fallback-session'])
    expect(calls.map(c => c.model)).toEqual(['devin', 'devin'])
    expect(calls.map(c => c.deduplicationKey)).toEqual([
      'devin:fallback-session:1',
      'devin:fallback-session:2',
    ])
  })

  it('extracts user message from ContentPart[] messages (ATIF v1.7 multimodal)', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('content-parts.json', {
      session_id: 'cp-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          message: [
            { type: 'text', text: 'look at this screenshot' },
            { type: 'image', source: { media_type: 'image/png', path: '/tmp/screenshot.png' } },
          ],
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 50 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('look at this screenshot /tmp/screenshot.png')
  })

  it('parses ATIF v1.7 transcripts with agent.extra, final_metrics, and observations', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('atif-v17.json', {
      schema_version: '1.7',
      session_id: 'v17-session',
      agent: {
        name: 'devin',
        version: '2.0',
        model_name: 'claude-sonnet-4-6',
        extra: { backend: 'cloud', permission_mode: 'auto' },
      },
      final_metrics: {
        total_prompt_tokens: 500,
        total_completion_tokens: 200,
        total_cached_tokens: 50,
        total_steps: 2,
      },
      steps: [
        {
          step_id: 1,
          message: 'fix the bug',
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          source: 'assistant',
          model_name: 'claude-sonnet-4-6',
          message: 'I will read the file first',
          tool_calls: [{ tool_call_id: 'tc1', function_name: 'read_file', arguments: { path: 'src/main.ts' } }],
          observation: {
            results: [{ source_call_id: 'tc1', content: 'file contents here' }],
          },
          extra: {
            committed_acu_cost: 0.15,
            generation_model: 'claude-sonnet-4-6',
            telemetry: { source: 'devin-cli', operation: 'generate' },
          },
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.15,
            metrics: { input_tokens: 200, output_tokens: 50, cache_creation_tokens: 20, cache_read_tokens: 10 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'devin',
      model: 'claude-sonnet-4-6',
      inputTokens: 200,
      outputTokens: 50,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 10,
      costUSD: 0.15,
      tools: ['read_file'],
      userMessage: 'fix the bug',
      sessionId: 'v17-session',
    })
  })

  it('handles plain string user messages alongside ContentPart[] messages', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('mixed-messages.json', {
      session_id: 'mixed-msg-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          message: 'plain text user message',
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 50 },
          },
        },
        {
          step_id: 3,
          message: [{ type: 'text', text: 'multimodal user message' }],
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:02.000Z' },
        },
        {
          step_id: 4,
          metadata: {
            created_at: '2027-01-15T08:00:03.000Z',
            committed_acu_cost: 0.2,
            metrics: { input_tokens: 100 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('plain text user message')
    expect(calls[1]!.userMessage).toBe('multimodal user message')
  })

  it('reads ACU cost from step.extra when metadata.committed_acu_cost is absent', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('extra-acu.json', {
      session_id: 'extra-acu-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          extra: { committed_acu_cost: 0.3 },
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            metrics: { input_tokens: 10 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeCloseTo(0.3, 12)
  })

  it('prefers metadata.committed_acu_cost over extra.committed_acu_cost', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('acu-priority.json', {
      session_id: 'acu-priority-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          extra: { committed_acu_cost: 0.99 },
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.11,
            metrics: { input_tokens: 10 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeCloseTo(0.11, 12)
  })

  it('reads tokens from step.metrics when metadata.metrics is absent', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('step-metrics.json', {
      session_id: 'step-metrics-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          metrics: {
            prompt_tokens: 300,
            completion_tokens: 75,
            cached_tokens: 15,
            extra: { cache_creation_input_tokens: 25 },
          },
          extra: { committed_acu_cost: 0.2 },
          metadata: { created_at: '2027-01-15T08:00:00.000Z' },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 300,
      outputTokens: 75,
      cacheCreationInputTokens: 25,
      cacheReadInputTokens: 15,
      cachedInputTokens: 15,
      costUSD: 0.2,
    })
  })

  it('prefers step.metrics over metadata.metrics when both are present', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('metrics-priority.json', {
      session_id: 'metrics-priority-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          metrics: {
            prompt_tokens: 500,
            completion_tokens: 100,
            cached_tokens: 20,
            extra: { cache_creation_input_tokens: 30 },
          },
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.1,
            metrics: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_tokens: 1,
              cache_read_tokens: 1,
            },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 500,
      outputTokens: 100,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 20,
      cachedInputTokens: 20,
    })
  })

  it('handles observation results with ContentPart[] content', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('observation-content-parts.json', {
      session_id: 'obs-cp-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          message: 'check the image',
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          source: 'assistant',
          message: 'reading file',
          tool_calls: [{ tool_call_id: 'tc1', function_name: 'read_file', arguments: {} }],
          observation: {
            results: [{
              source_call_id: 'tc1',
              content: [
                { type: 'text', text: 'file output here' },
                { type: 'image', source: { media_type: 'image/png', path: '/tmp/output.png' } },
              ],
            }],
          },
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 100, output_tokens: 30 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tools: ['read_file'],
      costUSD: 0.1,
      inputTokens: 100,
      outputTokens: 30,
    })
  })

  it('falls back to metadata.metrics when step.metrics is present but empty', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('empty-step-metrics.json', {
      session_id: 'empty-metrics-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          metrics: {},
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 80, output_tokens: 20, cache_read_tokens: 5 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 80,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      costUSD: 0.1,
    })
  })

  it('normalizes an image-only ContentPart[] user message to its path', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('image-only.json', {
      session_id: 'image-only-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          message: [
            { type: 'image', source: { media_type: 'image/png', path: '/tmp/only.png' } },
          ],
          metadata: { is_user_input: true, created_at: '2027-01-15T08:00:00.000Z' },
        },
        {
          step_id: 2,
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.1,
            metrics: { input_tokens: 40 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('/tmp/only.png')
  })

  it('ignores array-root and malformed transcripts', async () => {
    await configureDevinRate()
    const arrayPath = await writeTranscript('array.json', [])
    const malformedPath = join(tmpDir, 'transcripts', 'bad.json')
    await writeFile(malformedPath, '{')

    expect(await parseTranscript(arrayPath)).toEqual([])
    expect(await parseTranscript(malformedPath)).toEqual([])
  })

  it('deduplicates calls with a shared seen key set', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('dupe.json', {
      session_id: 'dupe-session',
      steps: [{ step_id: 's1', metadata: { committed_acu_cost: 0.5 } }],
    })
    const provider = createDevinProvider(tmpDir)
    const seenKeys = new Set<string>()
    const source = { path: filePath, project: 'devin', provider: 'devin' }

    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) second.push(call)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })
})

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('devin provider sessions.db enrichment', () => {
  it('uses sessions.db to enrich project, projectPath, model, and timestamp fallbacks', async () => {
    await configureDevinRate()
    createSessionsDb()
    const filePath = await writeTranscript('db-session.json', {
      session_id: 'db-session',
      steps: [
        {
          step_id: 's1',
          metadata: {
            committed_acu_cost: 0.25,
            metrics: { input_tokens: 10 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath, 'fallback-project')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      project: 'codeburn',
      projectPath: '/Users/example/work/codeburn',
      timestamp: '2027-01-15T08:00:10.000Z',
      costUSD: 0.25,
    })
  })

  it('uses sessions.db project labels during discovery when transcript filename matches the session id', async () => {
    await configureDevinRate()
    createSessionsDb()
    const filePath = await writeTranscript('db-session.json', { session_id: 'db-session', steps: [] })

    const provider = createDevinProvider(tmpDir)
    const sources = await provider.discoverSessions()

    expect(sources).toEqual([
      { path: filePath, project: 'codeburn', provider: 'devin' },
    ])
  })

  it('skips sessions hidden in sessions.db', async () => {
    await configureDevinRate()
    createSessionsDb()
    await writeTranscript('hidden-session.json', {
      session_id: 'hidden-session',
      steps: [{ step_id: 's1', metadata: { committed_acu_cost: 0.25 } }],
    })

    const provider = createDevinProvider(tmpDir)
    expect(await provider.discoverSessions()).toEqual([])

    const calls = await parseTranscript(join(tmpDir, 'transcripts', 'hidden-session.json'))
    expect(calls).toEqual([])
  })
})
