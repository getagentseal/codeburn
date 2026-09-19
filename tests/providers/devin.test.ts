import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { calculateCost, getModelCosts } from '../../src/models.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { createDevinProvider } from '../../src/providers/devin.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import { setHome } from '../setup/home.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'devin-provider-'))
  setHome(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

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

function createRealSessionsDb(): void {
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
      workspace_dirs TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    );
    CREATE TABLE prompt_history (
      id INTEGER PRIMARY KEY,
      content TEXT,
      timestamp INTEGER,
      session_id TEXT,
      is_shell INTEGER
    );
  `)
  const insert = db.prepare(`
    INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run('dandy-edam', '/Users/example/work/codeburn', 'kimi-k3-high', 1_789_645_675, 1_789_646_740, 'Research Code Burn platform and Devin support status', 0)
  insert.run('chrome-tricorne', '/Users/example/work/scratch', 'swe-2-high', 1_789_645_588, 1_789_645_815, '', 0)
  db.prepare('INSERT INTO prompt_history (id, content, timestamp, session_id, is_shell) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'fix the failing ledger tests', 1_789_645_588, 'chrome-tricorne', 0)
  db.close()
}

describe('devin provider', () => {
  it('discovers Devin CLI transcript json files', async () => {
    const filePath = await writeTranscript('glimmer-platinum.json', { steps: [] })
    await writeFile(join(tmpDir, 'transcripts', 'ignore.txt'), '{}')

    const provider = createDevinProvider(tmpDir)
    const sources = await provider.discoverSessions()

    expect(sources).toEqual([
      { path: filePath, project: 'devin', provider: 'devin' },
    ])
  })

  it('parses per-step tokens, cost, tools, and model resolution', async () => {
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
            metrics: { input_tokens: 1 },
          },
          tool_calls: [{ function_name: 'str_replace' }],
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(2)
    expect(calls.reduce((sum, call) => sum + call.costUSD, 0)).toBeCloseTo(
      calculateCost('claude-opus-4-6', 95, 20, 10, 5, 0) + calculateCost('claude-sonnet-4-6', 1, 0, 0, 0, 0),
      15,
    )
    expect(calls[0]).toMatchObject({
      provider: 'devin',
      model: 'Opus 4.6',
      inputTokens: 95,
      outputTokens: 20,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      cachedInputTokens: 5,
      costUSD: calculateCost('claude-opus-4-6', 95, 20, 10, 5, 0),
      tools: ['read_file'],
      timestamp: '2027-01-15T08:00:01.000Z',
      deduplicationKey: 'devin:session-123:2',
      userMessage: 'please inspect the repo',
      sessionId: 'session-123',
    })
    expect(calls[1]).toMatchObject({
      model: 'Sonnet 4.6',
      timestamp: '2027-01-15T08:00:02.000Z',
      tools: ['str_replace'],
      deduplicationKey: 'devin:session-123:3',
    })
  })

  it('renders Devin generation_model variants as friendly display names with effort tiers', async () => {
    const cases = [
      {
        schema: '1.4',
        modelName: 'GPT-5.4',
        location: 'metadata',
        generationModel: 'gpt-5-3-codex-xhigh',
        expected: 'GPT-5.3 Codex (xhigh)',
      },
      {
        schema: '1.4',
        modelName: 'GPT-5.5',
        location: 'metadata',
        generationModel: 'gpt-5-4-low',
        expected: 'GPT-5.4 (low)',
      },
      {
        schema: '1.4',
        modelName: 'GPT-5.5',
        location: 'metadata',
        generationModel: 'gpt-5-5-medium',
        expected: 'GPT-5.5 (medium)',
      },
      {
        schema: '1.4',
        modelName: 'Gemini 3 Flash',
        location: 'metadata',
        generationModel: 'MODEL_PRIVATE_11',
        expected: 'Gemini 3 Flash',
      },
      {
        schema: '1.4',
        modelName: 'Gemini 3 Flash',
        location: 'metadata',
        generationModel: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL',
        expected: 'Gemini 3 Flash',
      },
      {
        schema: '1.7',
        modelName: 'GPT-5.3-Codex',
        location: 'extra',
        generationModel: 'gpt-5-3-codex-xhigh',
        expected: 'GPT-5.3 Codex (xhigh)',
      },
      {
        schema: '1.4',
        modelName: 'GPT-5',
        location: 'metadata',
        generationModel: 'gpt-5',
        expected: 'GPT-5',
      },
      {
        schema: '1.4',
        modelName: 'GPT-5.6',
        location: 'metadata',
        generationModel: 'gpt-5-6-medium',
        expected: 'GPT-5.6 (medium)',
      },
      {
        schema: '1.4',
        modelName: 'GPT-5',
        location: 'metadata',
        generationModel: 'gpt-5-codex-xhigh',
        expected: 'GPT-5 Codex (xhigh)',
      },
      {
        schema: '1.4',
        modelName: 'GPT-5',
        location: 'metadata',
        generationModel: 'gpt-5-codex',
        expected: 'GPT-5 Codex',
      },
      {
        schema: '1.4',
        modelName: 'GPT-4',
        location: 'metadata',
        generationModel: 'gpt-4-1106-preview',
        expected: 'gpt-4-1106-preview',
      },
    ] as const

    for (let index = 0; index < cases.length; index++) {
      const row = cases[index]!
      const metadata: Record<string, unknown> = {
        created_at: '2027-01-15T08:00:01.000Z',
        metrics: { input_tokens: 1 },
      }
      const extra: Record<string, unknown> = {}
      if (row.location === 'metadata') {
        metadata['generation_model'] = row.generationModel
      } else {
        extra['generation_model'] = row.generationModel
      }

      const step: Record<string, unknown> = {
        step_id: index + 1,
        source: 'assistant',
        message: 'working',
        metadata,
      }
      if (row.location === 'extra') step['extra'] = extra

      const filePath = await writeTranscript(`model-variant-${index}.json`, {
        schema_version: row.schema,
        session_id: `model-variant-${index}`,
        agent: { model_name: row.modelName },
        steps: [step],
      })

      const calls = await parseTranscript(filePath)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.model).toBe(row.expected)
    }
  })

  it('prices a dashed gpt generation_model at its own row, not the base gpt-5 row', async () => {
    const filePath = await writeTranscript('codex-id.json', {
      session_id: 'codex-id-session',
      steps: [
        {
          step_id: 1,
          source: 'agent',
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            generation_model: 'gpt-5-3-codex-xhigh',
            metrics: { input_tokens: 1_000_000 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.3-codex-xhigh', 1_000_000, 0, 0, 0, 0))
    expect(calls[0]!.costUSD).not.toBe(calculateCost('gpt-5-3-codex-xhigh', 1_000_000, 0, 0, 0, 0))
  })

  it('leaves already-friendly Devin model display names unchanged', () => {
    const provider = createDevinProvider(tmpDir)

    expect(provider.modelDisplayName('GPT-5.3 Codex (xhigh)')).toBe('GPT-5.3 Codex (xhigh)')
  })

  it('includes token-only steps and skips user-input or empty steps', async () => {
    const filePath = await writeTranscript('token-only.json', {
      session_id: 'token-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 'user-cost',
          metadata: {
            is_user_input: true,
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

  it('falls back to filename session id and deduplicates by step id', async () => {
    const filePath = await writeTranscript('fallback-session.json', {
      steps: [
        {
          step_id: 1,
          metadata: {
            request_id: 'req-1',
            metrics: { input_tokens: 10 },
          },
        },
        {
          step_id: 2,
          metadata: {
            created_at: '2026-06-05T10:00:00.000Z',
            metrics: { input_tokens: 20 },
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
            generation_model: 'claude-sonnet-4-6',
            telemetry: { source: 'devin-cli', operation: 'generate' },
          },
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            metrics: { input_tokens: 200, output_tokens: 50, cache_creation_tokens: 20, cache_read_tokens: 10 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'devin',
      model: 'Sonnet 4.6',
      inputTokens: 190,
      outputTokens: 50,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 10,
      costUSD: calculateCost('claude-sonnet-4-6', 190, 50, 20, 10, 0),
      tools: ['read_file'],
      userMessage: 'fix the bug',
      sessionId: 'v17-session',
    })
  })

  it('handles plain string user messages alongside ContentPart[] messages', async () => {
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

  it('reads tokens from step.metrics when metadata.metrics is absent', async () => {
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
          metadata: { created_at: '2027-01-15T08:00:00.000Z' },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 285,
      outputTokens: 75,
      cacheCreationInputTokens: 25,
      cacheReadInputTokens: 15,
      cachedInputTokens: 15,
      costUSD: 0,
    })
  })

  it('prefers step.metrics over metadata.metrics when both are present', async () => {
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
      inputTokens: 480,
      outputTokens: 100,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 20,
      cachedInputTokens: 20,
    })
  })

  it('handles observation results with ContentPart[] content', async () => {
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
            metrics: { input_tokens: 100, output_tokens: 30 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tools: ['read_file'],
      costUSD: 0,
      inputTokens: 100,
      outputTokens: 30,
    })
  })

  it('falls back to metadata.metrics when step.metrics is present but empty', async () => {
    const filePath = await writeTranscript('empty-step-metrics.json', {
      session_id: 'empty-metrics-session',
      agent: { model_name: 'agent-model' },
      steps: [
        {
          step_id: 1,
          metrics: {},
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            metrics: { input_tokens: 80, output_tokens: 20, cache_read_tokens: 5 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 75,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      costUSD: 0,
    })
  })

  it('normalizes an image-only ContentPart[] user message to its path', async () => {
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
    const arrayPath = await writeTranscript('array.json', [])
    const malformedPath = join(tmpDir, 'transcripts', 'bad.json')
    await writeFile(malformedPath, '{')

    expect(await parseTranscript(arrayPath)).toEqual([])
    expect(await parseTranscript(malformedPath)).toEqual([])
  })

  it('deduplicates calls with a shared seen key set', async () => {
    const filePath = await writeTranscript('dupe.json', {
      session_id: 'dupe-session',
      steps: [{ step_id: 's1', metadata: { metrics: { input_tokens: 10 } } }],
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
    createSessionsDb()
    const filePath = await writeTranscript('db-session.json', {
      session_id: 'db-session',
      steps: [
        {
          step_id: 's1',
          metadata: {
            metrics: { input_tokens: 10 },
          },
        },
      ],
    })

    const calls = await parseTranscript(filePath, 'fallback-project')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'Sonnet 4.6',
      project: 'codeburn',
      projectPath: '/Users/example/work/codeburn',
      timestamp: '2027-01-15T08:00:10.000Z',
      costUSD: calculateCost('claude-sonnet-4-6', 10, 0, 0, 0, 0),
    })
  })

  it('uses sessions.db project labels during discovery when transcript filename matches the session id', async () => {
    createSessionsDb()
    const filePath = await writeTranscript('db-session.json', { session_id: 'db-session', steps: [] })

    const provider = createDevinProvider(tmpDir)
    const sources = await provider.discoverSessions()

    expect(sources).toEqual([
      { path: filePath, project: 'codeburn', provider: 'devin' },
    ])
  })

  it('skips sessions hidden in sessions.db', async () => {
    createSessionsDb()
    await writeTranscript('hidden-session.json', {
      session_id: 'hidden-session',
      steps: [{ step_id: 's1', metadata: { metrics: { input_tokens: 10 } } }],
    })

    const provider = createDevinProvider(tmpDir)
    expect(await provider.discoverSessions()).toEqual([])

    const calls = await parseTranscript(join(tmpDir, 'transcripts', 'hidden-session.json'))
    expect(calls).toEqual([])
  })
  it('prices a real-shape transcript per step from tokens with no config at all', async () => {
    createRealSessionsDb()
    // Real dandy-edam step metrics: [generation_model, prompt, completion, cached].
    const steps = [
      ['swe-2-high', 18009, 216, 10752],
      ['swe-2-high', 19710, 142, 17920],
      ['swe-2-high', 20018, 59, 19456],
      ['swe-2-high', 25876, 170, 19968],
      ['swe-2-high', 27719, 144, 25600],
      ['swe-2-high', 31464, 510, 27648],
      ['swe-2-high', 35889, 227, 31744],
      ['swe-2-high', 36355, 303, 35840],
      ['kimi-k3-high', 38273, 1041, 0],
      ['kimi-k3-high', 39349, 444, 35328],
      ['kimi-k3-high', 41494, 269, 36864],
      ['kimi-k3-high', 43569, 121, 39936],
      ['kimi-k3-high', 44174, 781, 41472],
      ['kimi-k3-high', 45003, 848, 41472],
      ['kimi-k3-high', 46676, 93, 43008],
      ['kimi-k3-high', 47578, 133, 44544],
      ['kimi-k3-high', 49263, 966, 44544],
    ] as const

    const filePath = await writeTranscript('dandy-edam.json', {
      schema_version: 'ATIF-v1.7',
      session_id: 'dandy-edam',
      agent: { name: 'devin', version: '3000.10.31', model_name: 'Kimi K3 High' },
      final_metrics: {
        total_prompt_tokens: 610_419,
        total_completion_tokens: 6467,
        total_cached_tokens: 516_096,
        total_steps: 28,
      },
      steps: [
        { step_id: 1, source: 'system', message: 'You are Devin.' },
        { step_id: 2, source: 'user', message: 'do we support devin in codeburn' },
        ...steps.map(([model, prompt, completion, cached], index) => ({
          step_id: index + 3,
          source: 'agent',
          message: 'working',
          tool_calls: [{ tool_call_id: `tc${index}`, function_name: 'shell', arguments: {} }],
          extra: { generation_model: model },
          metrics: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            ...(cached ? { cached_tokens: cached } : {}),
          },
        })),
      ],
    })

    const provider = createDevinProvider(tmpDir)
    // chrome-tricorne is in sessions.db but has no transcript on disk.
    expect(await provider.discoverSessions()).toEqual([
      { path: filePath, project: 'codeburn', provider: 'devin' },
    ])

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(17)
    expect(calls.map(call => call.model)).toEqual([
      ...Array(8).fill('swe-2-high'),
      ...Array(9).fill('Kimi K3'),
    ])
    const sum = (pick: (call: ParsedProviderCall) => number) => calls.reduce((total, call) => total + pick(call), 0)
    expect(sum(c => c.inputTokens) + sum(c => c.cacheReadInputTokens)).toBe(610_419)
    expect(sum(c => c.outputTokens)).toBe(6467)
    expect(sum(c => c.cacheReadInputTokens)).toBe(516_096)

    const kimiRates = getModelCosts('kimi-k3')!
    const expectedKimiCost = steps
      .filter(([model]) => model === 'kimi-k3-high')
      .reduce((total, [, prompt, completion, cached]) =>
        total
        + (prompt - cached) * kimiRates.inputCostPerToken
        + completion * kimiRates.outputCostPerToken
        + cached * kimiRates.cacheReadCostPerToken, 0)

    expect(expectedKimiCost).toBeGreaterThan(0)
    expect(sum(c => (c.model === 'Kimi K3' ? c.costUSD : 0))).toBeCloseTo(expectedKimiCost, 12)
    // swe-2-high has no pricing table entry: unpriced, never silently priced.
    expect(getModelCosts('swe-2-high')).toBeNull()
    expect(calls.filter(c => c.model === 'swe-2-high').every(c => c.costUSD === 0)).toBe(true)

    expect(calls[0]).toMatchObject({
      project: 'codeburn',
      projectPath: '/Users/example/work/codeburn',
      sessionId: 'dandy-edam',
      tools: ['shell'],
      // The transcript's own user turn, marked source: 'user', beats the title.
      userMessage: 'do we support devin in codeburn',
    })
  })

  it('falls back to the sessions.db title, then prompt_history, for task text', async () => {
    createRealSessionsDb()
    const untitled = await writeTranscript('chrome-tricorne.json', {
      session_id: 'chrome-tricorne',
      steps: [{ step_id: 1, source: 'agent', metrics: { prompt_tokens: 10, completion_tokens: 2 } }],
    })
    const titled = await writeTranscript('dandy-edam.json', {
      session_id: 'dandy-edam',
      steps: [{ step_id: 1, source: 'agent', metrics: { prompt_tokens: 10, completion_tokens: 2 } }],
    })

    expect((await parseTranscript(titled))[0]!.userMessage).toBe('Research Code Burn platform and Devin support status')
    expect((await parseTranscript(untitled))[0]!.userMessage).toBe('fix the failing ledger tests')
  })
})

