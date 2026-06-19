import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isSqliteAvailable } from '../../src/sqlite.js'
import { createDevinProvider } from '../../src/providers/devin.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string
const originalHome = process.env['HOME']

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'devin-provider-'))
  process.env['HOME'] = tmpDir
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
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
      schema_version: 'ATIF-v1.4',
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

  it('supports ATIF-v1.5 agent tool_definitions without changing parsing', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('atif-v15.json', {
      schema_version: 'ATIF-v1.5',
      session_id: 'atif-v15',
      agent: {
        model_name: 'agent-model',
        tool_definitions: [
          {
            type: 'function',
            function: { name: 'read_file' },
          },
        ],
      },
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: 'hello from v1.5',
          metadata: {
            is_user_input: true,
            created_at: '2027-01-15T08:00:00.000Z',
          },
        },
        {
          step_id: 2,
          source: 'agent',
          message: 'done',
          metadata: {
            created_at: '2027-01-15T08:00:01.000Z',
            committed_acu_cost: 0.25,
            metrics: {
              input_tokens: 12,
              output_tokens: 3,
            },
          },
          tool_calls: [{ function_name: 'read_file' }],
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'atif-v15',
      userMessage: 'hello from v1.5',
      inputTokens: 12,
      outputTokens: 3,
      costUSD: 0.25,
      tools: ['read_file'],
    })
  })

  it('supports ATIF-v1.6 content-part messages and step-level metrics', async () => {
    await configureDevinRate()
    const filePath = await writeTranscript('atif-v16.json', {
      schema_version: 'ATIF-v1.6',
      session_id: 'atif-v16',
      agent: { model_name: 'agent-v16' },
      steps: [
        {
          step_id: 1,
          source: 'user',
          message: [
            { type: 'text', text: 'review image' },
            { type: 'image', image_source: { path: 'images/1.png' } },
          ],
          metadata: {
            created_at: '2027-01-15T08:00:00.000Z',
            is_user_input: true,
          },
        },
        {
          step_id: 2,
          source: 'agent',
          timestamp: '2027-01-15T08:00:02.000Z',
          model_name: 'Claude Opus 4.6',
          message: [
            { type: 'text', text: 'analysis complete' },
          ],
          metrics: {
            prompt_tokens: 200,
            completion_tokens: 40,
            cached_tokens: 150,
            extra: {
              cache_creation_input_tokens: 20,
            },
          },
          extra: {
            generation_model: 'claude-opus-4-6-thinking',
            committed_credit_cost: 300,
          },
          tool_calls: [
            {
              function: { name: 'read_file' },
            },
          ],
        },
      ],
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'atif-v16',
      userMessage: 'review image',
      model: 'claude-opus-4-6-thinking',
      inputTokens: 30,
      outputTokens: 40,
      cacheReadInputTokens: 150,
      cacheCreationInputTokens: 20,
      costUSD: 0.03,
      tools: ['read_file'],
      timestamp: '2027-01-15T08:00:02.000Z',
    })
  })

  it('supports ATIF-v1.7 by reading source/timestamp/step metrics and trajectory_id fallback', async () => {
    await configureDevinRate(2)
    const filePath = await writeTranscript('atif-v17.json', {
      schema_version: 'ATIF-v1.7',
      trajectory_id: 'traj-001',
      agent: {
        model_name: 'Claude Opus 4.6',
        tool_definitions: [],
      },
      steps: [
        {
          step_id: 1,
          source: 'user',
          timestamp: '2027-01-15T08:00:00.000Z',
          message: [
            { type: 'text', text: 'Run checks' },
          ],
          extra: { telemetry: { source: 'user' } },
        },
        {
          step_id: 2,
          source: 'agent',
          timestamp: '2027-01-15T08:00:01.000Z',
          model_name: 'GPT-5.3-Codex',
          message: '',
          metrics: {
            prompt_tokens: 1200,
            completion_tokens: 45,
            cached_tokens: 1100,
            extra: {
              cache_creation_input_tokens: 50,
            },
          },
          extra: {
            committed_credit_cost: 150,
            generation_model: 'gpt-5-3-codex-xhigh',
          },
          tool_calls: [{ function_name: 'shell_command' }],
        },
      ],
      final_metrics: {
        total_prompt_tokens: 1200,
        total_completion_tokens: 45,
      },
    })

    const calls = await parseTranscript(filePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'traj-001',
      deduplicationKey: 'devin:traj-001:2',
      userMessage: 'Run checks',
      model: 'gpt-5-3-codex-xhigh',
      inputTokens: 50,
      outputTokens: 45,
      cacheReadInputTokens: 1100,
      cacheCreationInputTokens: 50,
      costUSD: 0.03,
      tools: ['shell_command'],
      timestamp: '2027-01-15T08:00:01.000Z',
    })
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
