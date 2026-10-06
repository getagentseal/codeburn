import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { isSqliteAvailable } from '../../src/sqlite.js'
import {
  antigravityAppDataDirFromSourcePath,
  antigravityCascadeIdFromPath,
  createAntigravityProvider,
  discoverAntigravitySessionSources,
  extractAntigravityAppDataDirFromLine,
  extractAntigravityGeneratorMetadata,
  extractAntigravityModelMap,
  getAntigravityStatusLineEventsPath,
  parseAntigravityServerInfo,
  parseAntigravityServerInfoFromLine,
  recordAntigravityStatusLinePayload,
  shouldReparseAntigravitySource,
  normalizeAntigravityToolCall,
  antigravityCacheFileName,
  flushAntigravityCache,
} from '../../src/providers/antigravity.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import { classifyTurn } from '../../src/classifier.js'
import type { ParsedApiCall, ParsedTurn } from '../../src/types.js'

const requireForTest = createRequire(import.meta.url)

// Mirrors the parsed-call -> turn shape src/parser.ts builds (cachedCallToApiCall).
function turnFromCall(call: ParsedProviderCall): ParsedTurn {
  const apiCall: ParsedApiCall = {
    provider: call.provider,
    model: call.model,
    usage: {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheCreationInputTokens: call.cacheCreationInputTokens,
      cacheReadInputTokens: call.cacheReadInputTokens,
      cachedInputTokens: call.cachedInputTokens,
      reasoningTokens: call.reasoningTokens,
      webSearchRequests: call.webSearchRequests,
    },
    costUSD: call.costUSD,
    tools: call.tools,
    mcpTools: call.tools.filter(t => t.startsWith('mcp__')),
    skills: call.skills ?? [],
    subagentTypes: call.subagentTypes ?? [],
    hasAgentSpawn: call.tools.includes('Agent'),
    hasPlanMode: call.tools.includes('EnterPlanMode'),
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands,
    deduplicationKey: call.deduplicationKey,
  }
  return { userMessage: '', assistantCalls: [apiCall], timestamp: call.timestamp, sessionId: call.sessionId }
}

type CurrentCliFixture = {
  conversationId: string
  rows: Array<{ idx: number; hex: string }>
}

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

function createCurrentAntigravityCliDb(dbPath: string, fixture: CurrentCliFixture): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath) as TestDb
  try {
    db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))')
    db.exec('CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id))')
    db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
      'main',
      Buffer.from('file:///Users/example/private-project'),
    )
    for (const row of fixture.rows) {
      const data = Buffer.from(row.hex, 'hex')
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(row.idx, data, data.length)
    }
  } finally {
    db.close()
  }
}

async function collectAntigravityCalls(source: { path: string; project: string; provider: string }): Promise<ParsedProviderCall[]> {
  const parser = createAntigravityProvider().createSessionParser(source, new Set())
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('antigravity provider helpers', () => {
  it('parses legacy https server flags from POSIX process args', () => {
    const server = parseAntigravityServerInfoFromLine(
      '/Applications/Antigravity.app/language_server_macos_arm --app_data_dir antigravity --https_server_port 57101 --csrf_token 01234567-89ab-cdef-0123-456789abcdef',
    )

    expect(server).toEqual({
      port: 57101,
      csrfToken: '01234567-89ab-cdef-0123-456789abcdef',
    })
  })

  it('parses Windows extension server flags and equals syntax', () => {
    const server = parseAntigravityServerInfoFromLine(
      'C:\\Users\\Admin\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe --extension_server_port=62225 --extension_server_csrf_token=abcdef01-2345-6789-abcd-ef0123456789',
    )

    expect(server).toEqual({
      port: 62225,
      csrfToken: 'abcdef01-2345-6789-abcd-ef0123456789',
    })
  })

  it('parses Windows extension server flags and space syntax', () => {
    const server = parseAntigravityServerInfo([
      'node something-unrelated',
      'language_server_windows_x64.exe --app_data_dir C:\\Users\\Admin\\.gemini\\antigravity --extension_server_port 62300 --extension_server_csrf_token fedcba98-7654-3210-fedc-ba9876543210',
    ])

    expect(server).toEqual({
      port: 62300,
      csrfToken: 'fedcba98-7654-3210-fedc-ba9876543210',
    })
  })

  it('parses quoted flag values', () => {
    const server = parseAntigravityServerInfoFromLine(
      'Antigravity language_server_windows_x64.exe --extension_server_port "62301" --extension_server_csrf_token "fedcba98-7654-3210-fedc-ba9876543211"',
    )

    expect(server).toEqual({
      port: 62301,
      csrfToken: 'fedcba98-7654-3210-fedc-ba9876543211',
    })
  })

  it('normalizes app_data_dir from app and CLI process args', () => {
    expect(extractAntigravityAppDataDirFromLine(
      'language_server --app_data_dir antigravity --https_server_port 0 --csrf_token 01234567-89ab-cdef-0123-456789abcdef',
    )).toBe('antigravity')

    expect(extractAntigravityAppDataDirFromLine(
      'language_server --app_data_dir /Users/dev/.gemini/antigravity-cli --https_server_port 0 --csrf_token 01234567-89ab-cdef-0123-456789abcdef',
    )).toBe('antigravity-cli')

    expect(extractAntigravityAppDataDirFromLine(
      'language_server.exe --app_data_dir "C:\\Users\\Admin\\.gemini\\antigravity-cli" --extension_server_port 62225 --extension_server_csrf_token abcdef01-2345-6789-abcd-ef0123456789',
    )).toBe('antigravity-cli')

    expect(extractAntigravityAppDataDirFromLine(
      'language_server_windows_x64.exe --app_data_dir antigravity-ide --extension_server_port 8720 --extension_server_csrf_token 39800f1b-343a-40b0-8eb5-850702450346',
    )).toBe('antigravity-ide')
  })

  it('accepts Antigravity 2 ephemeral port zero', () => {
    const server = parseAntigravityServerInfoFromLine(
      'antigravity language_server_macos_arm --https_server_port 0 --csrf_token 01234567-89ab-cdef-0123-456789abcdef',
    )

    expect(server).toEqual({
      port: 0,
      csrfToken: '01234567-89ab-cdef-0123-456789abcdef',
    })
  })

  it('matches language-server and antigravity markers case-insensitively', () => {
    const server = parseAntigravityServerInfoFromLine(
      'ANTIGRAVITY LANGUAGE_SERVER_WINDOWS_X64.EXE --extension_server_port 62302 --extension_server_csrf_token fedcba98-7654-3210-fedc-ba9876543212',
    )

    expect(server).toEqual({
      port: 62302,
      csrfToken: 'fedcba98-7654-3210-fedc-ba9876543212',
    })
  })

  it('ignores process args without an antigravity marker', () => {
    expect(parseAntigravityServerInfoFromLine(
      'language_server --extension_server_port 62300 --extension_server_csrf_token fedcba98-7654-3210-fedc-ba9876543210',
    )).toBeNull()
  })

  it('ignores invalid ports', () => {
    expect(parseAntigravityServerInfoFromLine(
      'antigravity language_server --extension_server_port 99999 --extension_server_csrf_token fedcba98-7654-3210-fedc-ba9876543210',
    )).toBeNull()
  })

  it('ignores chained flag names as values', () => {
    expect(parseAntigravityServerInfoFromLine(
      'antigravity language_server --extension_server_port=--extension_server_csrf_token --extension_server_csrf_token fedcba98-7654-3210-fedc-ba9876543210',
    )).toBeNull()
  })

  it('ignores implausibly short CSRF tokens', () => {
    expect(parseAntigravityServerInfoFromLine(
      'antigravity language_server --extension_server_port 62300 --extension_server_csrf_token short',
    )).toBeNull()
  })

  it('extracts model maps from wrapped and unwrapped RPC responses', () => {
    expect(extractAntigravityModelMap({
      response: { models: { high: { model: 'MODEL_PLACEHOLDER_M7' } } },
    })).toEqual({ MODEL_PLACEHOLDER_M7: 'high' })

    expect(extractAntigravityModelMap({
      models: { low: { model: 'MODEL_PLACEHOLDER_M8' } },
    })).toEqual({ MODEL_PLACEHOLDER_M8: 'low' })
    expect(extractAntigravityModelMap({
      models: { bad: null, good: { model: 'MODEL_PLACEHOLDER_M9' } },
    })).toEqual({ MODEL_PLACEHOLDER_M9: 'good' })
    expect(extractAntigravityModelMap({
      models: { 'gemini-3-flash-agent': { model: 'MODEL_PLACEHOLDER_M133', displayName: 'Gemini 3.5 Flash (High)' } },
    })).toEqual({ MODEL_PLACEHOLDER_M133: 'gemini-3.5-flash-high' })
    expect(extractAntigravityModelMap(null)).toEqual({})
  })

  it('never leaks a raw MODEL_PLACEHOLDER id as the canonical model name', () => {
    // The config key itself is still the unresolved placeholder (Antigravity
    // hasn't shipped a friendly key/displayName for this model yet).
    expect(extractAntigravityModelMap({
      models: { MODEL_PLACEHOLDER_M26: { model: 'MODEL_PLACEHOLDER_M26' } },
    })).toEqual({ MODEL_PLACEHOLDER_M26: 'unknown' })
  })

  it('extracts generator metadata from wrapped and unwrapped RPC responses', () => {
    const metadata = [{
      chatModel: {
        model: 'gemini-3-pro',
        usage: {
          model: 'gemini-3-pro',
          inputTokens: '10',
          outputTokens: '4',
          apiProvider: 'google',
        },
      },
    }]

    expect(extractAntigravityGeneratorMetadata({ response: { generatorMetadata: metadata } })).toEqual(metadata)
    expect(extractAntigravityGeneratorMetadata({ generatorMetadata: metadata })).toEqual(metadata)
    expect(extractAntigravityGeneratorMetadata({ response: { generatorMetadata: null } })).toEqual([])
    expect(extractAntigravityGeneratorMetadata(null)).toEqual([])
  })

  it('derives cascade ids from legacy .pb and Antigravity 2 .db files', () => {
    expect(antigravityCascadeIdFromPath('/tmp/123.pb')).toBe('123')
    expect(antigravityCascadeIdFromPath('/tmp/456.db')).toBe('456')
    expect(antigravityCascadeIdFromPath('/tmp/789.db-wal')).toBe('789.db-wal')
  })

  it('routes app and CLI source paths to matching Antigravity app data dirs', () => {
    expect(antigravityAppDataDirFromSourcePath(
      '/Users/dev/.gemini/antigravity/conversations/session.db',
    )).toBe('antigravity')

    expect(antigravityAppDataDirFromSourcePath(
      '/Users/dev/.gemini/antigravity-cli/conversations/session.pb',
    )).toBe('antigravity-cli')

    expect(antigravityAppDataDirFromSourcePath(
      'C:\\Users\\Admin\\.gemini\\antigravity-cli\\implicit\\session.pb',
    )).toBe('antigravity-cli')

    expect(antigravityAppDataDirFromSourcePath(
      '/Users/dev/.gemini/antigravity-ide/conversations/session.db',
    )).toBe('antigravity-ide')

    expect(antigravityAppDataDirFromSourcePath(
      'C:\\Users\\Admin\\.gemini\\antigravity-ide\\implicit\\session.pb',
    )).toBe('antigravity-ide')
  })

  it('discovers legacy .pb files and Antigravity 2 .db files only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-'))

    try {
      await writeFile(join(dir, 'legacy.pb'), '')
      await writeFile(join(dir, 'antigravity-2.db'), '')
      await writeFile(join(dir, 'uppercase.DB'), '')
      await writeFile(join(dir, 'antigravity-2.db-wal'), '')
      await mkdir(join(dir, 'directory.pb'))

      const sources = await discoverAntigravitySessionSources([{
        dir,
        project: 'test-project',
        extensions: ['.pb', '.db'],
      }])

      expect(sources).toEqual([
        { path: join(dir, 'antigravity-2.db'), project: 'test-project', provider: 'antigravity' },
        { path: join(dir, 'legacy.pb'), project: 'test-project', provider: 'antigravity' },
        { path: join(dir, 'uppercase.DB'), project: 'test-project', provider: 'antigravity' },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('discovers antigravity-ide conversation and implicit files', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'codeburn-home-'))
    const conversationsDir = join(tempHome, '.gemini', 'antigravity-ide', 'conversations')
    const implicitDir = join(tempHome, '.gemini', 'antigravity-ide', 'implicit')

    await mkdir(conversationsDir, { recursive: true })
    await mkdir(implicitDir, { recursive: true })

    await writeFile(join(conversationsDir, 'session1.db'), '')
    await writeFile(join(implicitDir, 'session2.pb'), '')

    const roots = [
      {
        dir: conversationsDir,
        project: 'antigravity-ide',
        extensions: ['.pb', '.db'] as const,
      },
      {
        dir: implicitDir,
        project: 'antigravity-ide',
        extensions: ['.pb'] as const,
      },
    ]

    const sources = await discoverAntigravitySessionSources(roots)
    expect(sources).toEqual([
      { path: join(conversationsDir, 'session1.db'), project: 'antigravity-ide', provider: 'antigravity' },
      { path: join(implicitDir, 'session2.pb'), project: 'antigravity-ide', provider: 'antigravity' },
    ])

    await rm(tempHome, { recursive: true, force: true })
  })

  it('displays Gemini 3.5 Flash thinking variants as the base model', () => {
    const provider = createAntigravityProvider()

    expect(provider.modelDisplayName('gemini-3.5-flash')).toBe('Gemini 3.5 Flash')
    expect(provider.modelDisplayName('gemini-3.5-flash-high')).toBe('Gemini 3.5 Flash')
    expect(provider.modelDisplayName('gemini-3.5-flash-medium')).toBe('Gemini 3.5 Flash')
    expect(provider.modelDisplayName('gemini-3.5-flash-low')).toBe('Gemini 3.5 Flash')
    expect(provider.modelDisplayName('Gemini 3.5 Flash (High)')).toBe('Gemini 3.5 Flash')
  })

  it('captures exact Antigravity CLI statusLine usage as fallback calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-statusline-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    try {
      const payload = {
        conversation_id: 'ce061468-2e2b-4c6f-bf4f-e072bd5fa986',
        session_id: 'session-1',
        cwd: '/workspace/project',
        model: {
          id: 'Gemini 3.5 Flash (High)',
          display_name: 'Gemini 3.5 Flash (High)',
        },
        context_window: {
          current_usage: {
            input_tokens: 28407,
            output_tokens: 137,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }

      expect(await recordAntigravityStatusLinePayload(payload)).toBe(true)
      expect(await recordAntigravityStatusLinePayload(payload)).toBe(true)

      const recorded = await readFile(getAntigravityStatusLineEventsPath(), 'utf-8')
      expect(recorded).not.toContain('/workspace/project')
      expect(JSON.parse(recorded.split(/\r?\n/)[0]!)).not.toHaveProperty('cwd')

      const source = {
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity',
      }

      const parser = createAntigravityProvider().createSessionParser(source, new Set())
      const calls = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        provider: 'antigravity',
        model: 'Gemini 3.5 Flash (High)',
        inputTokens: 28407,
        outputTokens: 137,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        sessionId: 'ce061468-2e2b-4c6f-bf4f-e072bd5fa986',
        project: 'antigravity-cli',
      })
      expect(calls[0]!.projectPath).toBeUndefined()
      expect(calls[0]!.costUSD).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips statusLine fallback calls when RPC cache already covered the conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-statusline-rpc-dedup-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    try {
      expect(await recordAntigravityStatusLinePayload({
        conversation_id: 'rpc-covered-conversation',
        session_id: 'session-1',
        model: 'Gemini 3.5 Flash (High)',
        context_window: {
          current_usage: {
            input_tokens: 1000,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })).toBe(true)

      const parser = createAntigravityProvider().createSessionParser({
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity',
      }, new Set(['antigravity:rpc-covered-conversation:0']))

      const calls = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips singleton statusLine snapshots and deltas monotonic usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-statusline-runs-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    const basePayload = {
      conversation_id: 'statusline-runs',
      session_id: 'session-1',
      model: 'Gemini 3.5 Flash (High)',
    }

    const withUsage = (
      input_tokens: number,
      output_tokens: number,
      cache_read_input_tokens = 0,
    ) => ({
      ...basePayload,
      context_window: {
        current_usage: {
          input_tokens,
          output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens,
        },
      },
    })

    try {
      expect(await recordAntigravityStatusLinePayload(withUsage(100, 10))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(200, 20))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(200, 20))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(withUsage(300, 30, 50))).toBe(true)

      const parser = createAntigravityProvider().createSessionParser({
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity',
      }, new Set())

      const calls = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toHaveLength(2)
      expect(calls.map(call => [call.inputTokens, call.outputTokens, call.cacheReadInputTokens])).toEqual([
        [200, 20, 0],
        [100, 10, 50],
      ])
      expect(calls.map(call => call.cachedInputTokens)).toEqual([0, 0])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats non-monotonic statusLine usage as a new request snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-statusline-reset-'))
    process.env['CODEBURN_CACHE_DIR'] = dir

    const payload = (
      input_tokens: number,
      output_tokens: number,
      cache_read_input_tokens = 0,
    ) => ({
      conversation_id: 'statusline-reset',
      session_id: 'session-1',
      model: 'Gemini 3.5 Flash (High)',
      context_window: {
        current_usage: {
          input_tokens,
          output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens,
        },
      },
    })

    try {
      expect(await recordAntigravityStatusLinePayload(payload(1000, 100))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(payload(1000, 100))).toBe(true)
      expect(await recordAntigravityStatusLinePayload(payload(200, 30, 500))).toBe(true)

      const parser = createAntigravityProvider().createSessionParser({
        path: getAntigravityStatusLineEventsPath(),
        project: 'antigravity-cli',
        provider: 'antigravity',
      }, new Set())

      const calls = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toHaveLength(2)
      expect(calls.map(call => [call.inputTokens, call.outputTokens, call.cacheReadInputTokens])).toEqual([
        [1000, 100, 0],
        [200, 30, 500],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('always reparses append-only statusLine sources but not unchanged cached cascades', () => {
    const statusLinePath = getAntigravityStatusLineEventsPath()

    expect(shouldReparseAntigravitySource(statusLinePath, 1)).toBe(true)
    expect(shouldReparseAntigravitySource('/tmp/antigravity/conversation.pb', 0)).toBe(true)
    expect(shouldReparseAntigravitySource('/tmp/antigravity/conversation.pb', 1)).toBe(false)
  })

  it('parses current Antigravity CLI SQLite conversations with non-zero token usage', async () => {
    if (!isSqliteAvailable()) return

    const tempHome = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-current-cli-'))
    const cacheDir = join(tempHome, 'cache')
    const previousCacheDir = process.env['CODEBURN_CACHE_DIR']
    process.env['CODEBURN_CACHE_DIR'] = cacheDir

    try {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      const logsDir = join(
        tempHome,
        '.gemini',
        'antigravity-cli',
        'brain',
        fixture.conversationId,
        '.system_generated',
        'logs',
      )

      await mkdir(conversationsDir, { recursive: true })
      await mkdir(logsDir, { recursive: true })
      await writeFile(
        join(logsDir, 'transcript.jsonl'),
        await readFile(
          new URL(
            '../fixtures/antigravity-cli-current/brain/fixture-current-cli/.system_generated/logs/transcript.jsonl',
            import.meta.url,
          ),
          'utf-8',
        ),
      )

      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const sources = await discoverAntigravitySessionSources([{
        dir: conversationsDir,
        project: 'antigravity-cli',
        extensions: ['.pb', '.db'],
      }])
      expect(sources).toEqual([{ path: dbPath, project: 'antigravity-cli', provider: 'antigravity' }])

      const calls = await collectAntigravityCalls(sources[0]!)

      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls[0]).toMatchObject({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-high',
        inputTokens: 30265,
        outputTokens: 71,
        reasoningTokens: 659,
        sessionId: fixture.conversationId,
        project: 'antigravity-cli',
      })
      expect(calls[0]!.projectPath).toBeUndefined()
      expect(calls[0]!.costUSD).toBeGreaterThan(0)
    } finally {
      if (previousCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  it('deduplicates current SQLite rows against RPC response ids with hyphens', async () => {
    if (!isSqliteAvailable()) return

    const tempHome = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-current-cli-dedup-'))
    const cacheDir = join(tempHome, 'cache')
    const previousCacheDir = process.env['CODEBURN_CACHE_DIR']
    process.env['CODEBURN_CACHE_DIR'] = cacheDir

    try {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')

      await mkdir(conversationsDir, { recursive: true })

      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const parser = createAntigravityProvider().createSessionParser({
        path: dbPath,
        project: 'antigravity-cli',
        provider: 'antigravity',
      }, new Set([`antigravity:${fixture.conversationId}:fixture-response-1`]))
      const calls = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls).toEqual([])
    } finally {
      if (previousCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  it('reads cache reads, thinking split and the placeholder model from standalone app gen_metadata', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-standalone-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-standalone/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture
      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      const sum = (pick: (call: ParsedProviderCall) => number) => calls.reduce((total, call) => total + pick(call), 0)

      expect(calls).toHaveLength(11)
      expect(new Set(calls.map(call => call.model))).toEqual(new Set(['gemini-3.1-pro-high']))
      expect(calls.every(call => call.costIsEstimated === true)).toBe(true)
      expect(sum(call => call.inputTokens)).toBe(56038)
      expect(sum(call => call.cacheReadInputTokens)).toBe(117202)
      expect(sum(call => call.reasoningTokens)).toBe(1106)
      expect(sum(call => call.outputTokens)).toBe(1158)
      expect(calls[0]!.cacheReadInputTokens).toBe(0)
      // gemini-3.1-pro-preview: $2/M input, $12/M output (thinking included), $0.20/M cache read.
      expect(sum(call => call.costUSD)).toBeCloseTo(56038 * 2e-6 + 2264 * 12e-6 + 117202 * 0.2e-6, 9)
    })
  })

  it('dates standalone rows without created_at from their first step', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-step-time-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-standalone/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture
      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, { ...fixture, rows: fixture.rows.slice(0, 1) })
      const { DatabaseSync: Database } = requireForTest('node:sqlite')
      const db = new Database(dbPath) as TestDb
      db.exec('CREATE TABLE steps (idx integer, metadata blob, PRIMARY KEY (idx))')
      // Row 0 references steps 1 and 2; step 1 metadata #1 = Timestamp{1791307489s, 891504000ns}.
      db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(1, Buffer.from('0a0c08e1dd94d60610808b8da903', 'hex'))
      db.close()

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.timestamp).toBe(new Date(1791307489891).toISOString())
    })
  })

  it('prices Gemini 3.1 Pro prompts from 200k tokens (input + cache read) at the long-context tier', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-tier-', async (tempHome) => {
      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, 'fixture-tier.db')
      createCurrentAntigravityCliDb(dbPath, {
        conversationId: 'fixture-tier',
        rows: [
          // input 150,000 + cache read 60,000, output 1,000 (400 thinking + 600 response)
          { idx: 0, hex: '0a6c18f807222c08f80710f0930918e80728e0d403301848900350d8045a14666978747572652d6c6f6e672d636f6e746578749a011267656d696e692d70726f2d64656661756c74a201230a0a6d6f64656c5f656e756d12154d4f44454c5f504c414345484f4c4445525f4d3136' },
          // input 139,999 + cache read 60,000: one token under the threshold
          { idx: 1, hex: '0a6a18f807222a08f80710dfc50818e80728e0d403301848900350d8045a12666978747572652d62656c6f772d746965729a011267656d696e692d70726f2d64656661756c74a201230a0a6d6f64656c5f656e756d12154d4f44454c5f504c414345484f4c4445525f4d3136' },
        ],
      })

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls).toHaveLength(2)
      expect(calls[0]!.costUSD).toBeCloseTo(150000 * 4e-6 + 1000 * 18e-6 + 60000 * 0.4e-6, 9)
      expect(calls[1]!.costUSD).toBeCloseTo(139999 * 2e-6 + 1000 * 12e-6 + 60000 * 0.2e-6, 9)
    })
  })

  it('serves .pb cascades from the previous results cache while the server is down', async () => {
    await withTempAntigravityHome('codeburn-antigravity-prev-cache-', async (tempHome) => {
      const cacheDir = join(tempHome, 'cache')
      // antigravity-cli: no CLI language server runs during tests, even where the app does.
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-cli', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      await mkdir(cacheDir, { recursive: true })
      const pbPath = join(conversationsDir, 'fixture-pb.pb')
      await writeFile(pbPath, 'opaque')
      const previousCall = {
        provider: 'antigravity', model: 'gemini-3.1-pro-high', inputTokens: 100, outputTokens: 10,
        cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 5,
        webSearchRequests: 0, costUSD: 0.00038, tools: [], bashCommands: [], timestamp: '2026-05-22T08:19:07.000Z',
        speed: 'standard', deduplicationKey: 'antigravity:fixture-pb:r1', userMessage: '', sessionId: 'fixture-pb',
      }
      const previousVersion = Number(antigravityCacheFileName().match(/\.v(\d+)\.json$/)![1]) - 1
      await writeFile(join(cacheDir, antigravityCacheFileName(previousVersion)), JSON.stringify({
        version: previousVersion,
        cascades: { 'fixture-pb': { mtimeMs: 1, sizeBytes: 6, calls: [previousCall] } },
      }))

      const calls = await collectAntigravityCalls({ path: pbPath, project: 'antigravity-cli', provider: 'antigravity' })
      expect(calls.map(call => call.deduplicationKey)).toEqual(['antigravity:fixture-pb:r1'])

      await flushAntigravityCache(undefined, cacheDir)
      const current = JSON.parse(await readFile(join(cacheDir, antigravityCacheFileName()), 'utf-8'))
      expect(current.cascades['fixture-pb'].mtimeMs).toBe(-1)
      expect(current.cascades['fixture-pb'].calls).toHaveLength(1)
      expect(shouldReparseAntigravitySource(pbPath, 1)).toBe(true)
    })
  })

  async function withTempAntigravityHome(prefix: string, fn: (tempHome: string) => Promise<void>): Promise<void> {
    const tempHome = await mkdtemp(join(tmpdir(), prefix))
    const previousCacheDir = process.env['CODEBURN_CACHE_DIR']
    process.env['CODEBURN_CACHE_DIR'] = join(tempHome, 'cache')
    try {
      await fn(tempHome)
    } finally {
      if (previousCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = previousCacheDir
      await rm(tempHome, { recursive: true, force: true })
    }
  }

  it('stamps file mtime as fallback timestamp for SQLite-parsed calls', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-timestamp-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture
      const conversationsDir = join(tempHome, '.gemini', 'antigravity-ide', 'conversations')

      await mkdir(conversationsDir, { recursive: true })

      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const beforeStat = await stat(dbPath)

      const parser = createAntigravityProvider().createSessionParser({
        path: dbPath,
        project: 'antigravity-ide',
        provider: 'antigravity',
      }, new Set())
      const calls: ParsedProviderCall[] = []
      for await (const call of parser.parse()) calls.push(call)

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.timestamp).not.toBe('')
        const callTime = new Date(call.timestamp).getTime()
        expect(Math.abs(callTime - beforeStat.mtimeMs)).toBeLessThan(5000)
      }
    })
  })

  it('decodes ChatStartMetadata.created_at and prefers it over the file mtime', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-createdat-', async (tempHome) => {
      // Encode a gen_metadata blob matching the real on-disk shape:
      //   GeneratorMetadata.chatModel(#1) {
      //     usage(#4) { input(#2), totalOutput(#3) }
      //     chatStartMetadata(#9) { created_at(#4): Timestamp { seconds(#1), nanos(#2) } }
      //   }
      const varint = (n: number): number[] => {
        const out: number[] = []
        let v = n
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
        out.push(v)
        return out
      }
      const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
      const varintField = (field: number, n: number): number[] => [...tag(field, 0), ...varint(n)]
      const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]

      const seconds = 1783326234
      const nanos = 724675400
      const timestamp = [...varintField(1, seconds), ...varintField(2, nanos)]
      const chatStartMetadata = lenField(4, timestamp)
      const usage = lenField(4, [...varintField(2, 100), ...varintField(3, 50)])
      const chatModel = [...usage, ...lenField(9, chatStartMetadata)]
      const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

      const conversationsDir = join(tempHome, '.gemini', 'antigravity-ide', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, 'created-at-session.db')
      createCurrentAntigravityCliDb(dbPath, { conversationId: 'created-at-session', rows: [{ idx: 0, hex }] })

      // Pin the file mtime to a different day so a wrong fallback is obvious.
      const mtime = new Date('2026-01-01T00:00:00.000Z')
      await utimes(dbPath, mtime, mtime)

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity-ide', provider: 'antigravity' })

      expect(calls.length).toBe(1)
      // The real created_at (July), not the January file mtime.
      expect(calls[0]!.timestamp).toBe('2026-07-06T08:23:54.724Z')
    })
  })

  it('classifies paths by their .gemini root, not by the profile directory name', () => {
    expect(antigravityAppDataDirFromSourcePath(
      '/Users/User/.gemini/antigravity-ide/conversations/abc.db',
    )).toBe('antigravity-ide')

    expect(antigravityAppDataDirFromSourcePath(
      '/Users/User/.gemini/antigravity-cli/conversations/abc.db',
    )).toBe('antigravity-cli')

    expect(antigravityAppDataDirFromSourcePath(
      '/Users/User/.gemini/antigravity/conversations/abc.db',
    )).toBe('antigravity')

    // A profile directory literally named "Antigravity IDE" must not override
    // the .gemini root: these are CLI and base-app paths, not IDE paths.
    expect(antigravityAppDataDirFromSourcePath(
      'C:\\Users\\Antigravity IDE\\.gemini\\antigravity-cli\\conversations\\abc.db',
    )).toBe('antigravity-cli')

    expect(antigravityAppDataDirFromSourcePath(
      'C:\\Users\\Antigravity IDE\\.gemini\\antigravity\\conversations\\abc.db',
    )).toBe('antigravity')
  })

  it('extracts tools, bash commands, MCP tools, and skills from SQLite steps table', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-steps-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture

      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      // Helper to encode synthetic protobuf tool metadata
      const varint = (n: number): number[] => {
        const out: number[] = []
        let v = n
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
        out.push(v)
        return out
      }
      const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
      const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]
      const strField = (field: number, str: string): number[] => lenField(field, Array.from(Buffer.from(str, 'utf-8')))

      const encodeToolStepMetadata = (toolName: string, argsJson: string): Buffer => {
        const toolCallSub = [
          ...strField(1, 'call_test_123'),
          ...strField(2, toolName),
          ...strField(3, argsJson),
        ]
        return Buffer.from(lenField(4, toolCallSub))
      }

      const withStepIndices = (fixtureHex: string, indices: number[]): Buffer => {
        const rest = Buffer.from(fixtureHex, 'hex').subarray(4)
        const packed = Buffer.from(indices.flatMap(n => varint(n)))
        const field2 = Buffer.from([...tag(2, 2), ...varint(packed.length), ...packed])
        return Buffer.concat([field2, rest])
      }

      const { DatabaseSync: Database } = requireForTest('node:sqlite')
      const db = new Database(dbPath) as TestDb
      try {
        db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
          withStepIndices(fixture.rows[0]!.hex, [1, 2, 3, 4, 5, 6, 7]),
        )
        db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)')
        const stmt = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)')
        // Turn 0 (starts with step_type 15)
        stmt.run(0, 15, null)
        stmt.run(1, 21, encodeToolStepMetadata('run_command', JSON.stringify({ CommandLine: 'git status' })))
        stmt.run(2, 38, encodeToolStepMetadata('call_mcp_tool', JSON.stringify({ ServerName: 'dart-mcp-server', ToolName: 'analyze_files' })))
        stmt.run(3, 8, encodeToolStepMetadata('view_file', JSON.stringify({ AbsolutePath: '/home/user/.agents/skills/graphify/SKILL.md' })))
        stmt.run(4, 127, encodeToolStepMetadata('invoke_subagent', JSON.stringify({ Subagents: [{ Role: 'Codebase Researcher' }] })))
        stmt.run(5, 25, encodeToolStepMetadata('find_by_name', JSON.stringify({ Pattern: '*.ts' })))
        stmt.run(6, 5, encodeToolStepMetadata('write_to_file', JSON.stringify({ TargetFile: '/path/file.txt' })))
        // send_message is assistant messaging, should be excluded from tools
        stmt.run(7, 132, encodeToolStepMetadata('send_message', JSON.stringify({ Message: 'All tasks completed' })))
      } finally {
        db.close()
      }

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls.length).toBeGreaterThan(0)
      const firstCall = calls[0]!

      expect(firstCall.tools).toEqual([
        'run_command',
        'mcp__dart-mcp-server__analyze_files',
        'view_file',
        'Agent',
        'find_by_name',
        'write_to_file',
      ])
      expect(firstCall.bashCommands).toEqual(['git'])
      expect(firstCall.skills).toEqual(['graphify'])
      expect(firstCall.subagentTypes).toEqual(['Codebase Researcher'])
    })
  })

  it('normalizes eager mcp_<server>_<tool> calls from steps table', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-eager-mcp-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture

      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      const varint = (n: number): number[] => {
        const out: number[] = []
        let v = n
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
        out.push(v)
        return out
      }
      const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
      const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]
      const strField = (field: number, str: string): number[] => lenField(field, Array.from(Buffer.from(str, 'utf-8')))

      const encodeToolStepMetadata = (toolName: string, argsJson?: string): Buffer => {
        const toolCallSub = [
          ...strField(1, 'call_test_123'),
          ...strField(2, toolName),
          ...(argsJson !== undefined ? strField(3, argsJson) : []),
        ]
        return Buffer.from(lenField(4, toolCallSub))
      }

      const withStepIndices = (fixtureHex: string, indices: number[]): Buffer => {
        const rest = Buffer.from(fixtureHex, 'hex').subarray(4)
        const packed = Buffer.from(indices.flatMap(n => varint(n)))
        const field2 = Buffer.from([...tag(2, 2), ...varint(packed.length), ...packed])
        return Buffer.concat([field2, rest])
      }

      createCurrentAntigravityCliDb(dbPath, fixture)

      const { DatabaseSync: Database } = requireForTest('node:sqlite')
      const db = new Database(dbPath) as TestDb
      try {
        db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
          withStepIndices(fixture.rows[0]!.hex, [1, 2]),
        )
        db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)')
        const stmt = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)')
        stmt.run(0, 15, null)
        stmt.run(1, 38, encodeToolStepMetadata('mcp_context7_resolve-library-id'))
        stmt.run(2, 38, encodeToolStepMetadata('call_mcp_tool', JSON.stringify({ ServerName: 'context7', ToolName: 'resolve-library-id' })))
      } finally {
        db.close()
      }

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]!.tools).toEqual([
        'mcp__context7__resolve-library-id',
        'mcp__context7__resolve-library-id',
      ])
    })
  })

  it('maps manage_task, search_web, read_url_content and invoke_subagent to canonical tools that classify', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-tool-map-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture

      const varint = (n: number): number[] => {
        const out: number[] = []
        let v = n
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
        out.push(v)
        return out
      }
      const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
      const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]
      const strField = (field: number, str: string): number[] => lenField(field, Array.from(Buffer.from(str, 'utf-8')))
      const encodeToolStepMetadata = (toolName: string, argsJson: string): Buffer =>
        Buffer.from(lenField(4, [...strField(1, 'call_test_123'), ...strField(2, toolName), ...strField(3, argsJson)]))
      const withStepIndices = (fixtureHex: string, indices: number[]): Buffer => {
        const rest = Buffer.from(fixtureHex, 'hex').subarray(4)
        const packed = Buffer.from(indices.flatMap(n => varint(n)))
        return Buffer.concat([Buffer.from([...tag(2, 2), ...varint(packed.length), ...packed]), rest])
      }

      const callWithTools = async (name: string, toolNames: string[]): Promise<ParsedProviderCall> => {
        const dir = join(tempHome, name)
        await mkdir(dir, { recursive: true })
        const dbPath = join(dir, `${fixture.conversationId}.db`)
        createCurrentAntigravityCliDb(dbPath, fixture)
        const { DatabaseSync: Database } = requireForTest('node:sqlite')
        const db = new Database(dbPath) as TestDb
        try {
          db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
            withStepIndices(fixture.rows[0]!.hex, toolNames.map((_, i) => i + 1)),
          )
          db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)')
          const stmt = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)')
          stmt.run(0, 15, null)
          toolNames.forEach((tool, i) => stmt.run(i + 1, 38, encodeToolStepMetadata(tool, '{}')))
        } finally {
          db.close()
        }
        const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
        expect(calls.length).toBeGreaterThan(0)
        return calls[0]!
      }

      const planning = await callWithTools('planning', ['manage_task'])
      expect(planning.tools).toEqual(['TodoWrite'])
      expect(classifyTurn(turnFromCall(planning)).category).toBe('planning')

      const exploration = await callWithTools('exploration', ['search_web', 'read_url_content'])
      expect(exploration.tools).toEqual(['WebSearch', 'WebFetch'])
      expect(classifyTurn(turnFromCall(exploration)).category).toBe('exploration')

      const delegation = await callWithTools('delegation', ['invoke_subagent', 'search_web'])
      expect(delegation.tools).toEqual(['Agent', 'WebSearch'])
      expect(classifyTurn(turnFromCall(delegation)).category).toBe('delegation')
    })
  })

  it('gracefully handles missing steps table in legacy DB', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-nosteps-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture

      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]!.tools).toEqual([])
      expect(calls[0]!.bashCommands).toEqual([])
    })
  })

  it('gracefully handles malformed tool arguments JSON', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-badjson-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture

      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const varint = (n: number): number[] => {
        const out: number[] = []
        let v = n
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
        out.push(v)
        return out
      }
      const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
      const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]
      const strField = (field: number, str: string): number[] => lenField(field, Array.from(Buffer.from(str, 'utf-8')))

      const withStepIndices = (fixtureHex: string, indices: number[]): Buffer => {
        const rest = Buffer.from(fixtureHex, 'hex').subarray(4)
        const packed = Buffer.from(indices.flatMap(n => varint(n)))
        const field2 = Buffer.from([...tag(2, 2), ...varint(packed.length), ...packed])
        return Buffer.concat([field2, rest])
      }

      const encodeToolStepMetadata = (toolName: string, argsRaw: string): Buffer => {
        const toolCallSub = [
          ...strField(1, 'call_test_bad'),
          ...strField(2, toolName),
          ...strField(3, argsRaw),
        ]
        return Buffer.from(lenField(4, toolCallSub))
      }

      const { DatabaseSync: Database } = requireForTest('node:sqlite')
      const db = new Database(dbPath) as TestDb
      try {
        db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
          withStepIndices(fixture.rows[0]!.hex, [1, 2]),
        )
        db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)')
        const stmt = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)')
        stmt.run(0, 15, null)
        stmt.run(1, 21, encodeToolStepMetadata('run_command', '{not valid json}'))
        stmt.run(2, 38, encodeToolStepMetadata('call_mcp_tool', 'broken json'))
      } finally {
        db.close()
      }

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls.length).toBeGreaterThan(0)
      // Tool name is preserved even when args fail JSON.parse
      expect(calls[0]!.tools).toEqual(['run_command', 'call_mcp_tool'])
      expect(calls[0]!.bashCommands).toEqual([])
    })
  })

  it('isolates tools strictly to their corresponding turn across multi-turn sessions', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-multiturn-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture

      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const varint = (n: number): number[] => {
        const out: number[] = []
        let v = n
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
        out.push(v)
        return out
      }
      const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
      const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]
      const strField = (field: number, str: string): number[] => lenField(field, Array.from(Buffer.from(str, 'utf-8')))

      const withStepIndices = (fixtureHex: string, indices: number[]): Buffer => {
        const rest = Buffer.from(fixtureHex, 'hex').subarray(4)
        const packed = Buffer.from(indices.flatMap(n => varint(n)))
        const field2 = Buffer.from([...tag(2, 2), ...varint(packed.length), ...packed])
        return Buffer.concat([field2, rest])
      }

      const encodeToolStepMetadata = (toolName: string, argsJson: string): Buffer => {
        const toolCallSub = [
          ...strField(1, 'call_test_turn0'),
          ...strField(2, toolName),
          ...strField(3, argsJson),
        ]
        return Buffer.from(lenField(4, toolCallSub))
      }

      const { DatabaseSync: Database } = requireForTest('node:sqlite')
      const db = new Database(dbPath) as TestDb
      try {
        // Update Turn 0 to point to steps 1 and 2
        db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
          withStepIndices(fixture.rows[0]!.hex, [1, 2]),
        )

        // Insert a second gen_metadata row with a distinct responseId pointing to step 4
        const firstRowData = withStepIndices(fixture.rows[0]!.hex, [4])
        // Replace fixture-response-1 with fixture-response-2 in binary
        const secondRowData = Buffer.from(firstRowData)
        const resp1Idx = secondRowData.indexOf(Buffer.from('fixture-response-1'))
        if (resp1Idx !== -1) {
          secondRowData[resp1Idx + 'fixture-response-'.length] = '2'.charCodeAt(0)
        }
        db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, secondRowData)

        db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)')
        const stmt = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)')
        // Turn 0: step_type 15 + step_type 21 (run_command) + step_type 8 (view_file)
        stmt.run(0, 15, null)
        stmt.run(1, 21, encodeToolStepMetadata('run_command', JSON.stringify({ CommandLine: 'npm test' })))
        stmt.run(2, 8, encodeToolStepMetadata('view_file', JSON.stringify({ AbsolutePath: '/foo/bar.ts' })))
        // Turn 1: step_type 15 + step_type 132 (send_message - excluded)
        stmt.run(3, 15, null)
        stmt.run(4, 132, encodeToolStepMetadata('send_message', JSON.stringify({ Message: 'Task finished' })))
      } finally {
        db.close()
      }

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls).toHaveLength(2)

      // Turn 0 has tools and bash command
      expect(calls[0]!.tools).toEqual(['run_command', 'view_file'])
      expect(calls[0]!.bashCommands).toEqual(['npm'])

      // Turn 1 has no tools (send_message skipped) and no bash commands (did not leak from Turn 0)
      expect(calls[1]!.tools).toEqual([])
      expect(calls[1]!.bashCommands).toEqual([])
    })
  })

  it('decodes multiple split field 2 packed varint chunks on a single turn', async () => {
    if (!isSqliteAvailable()) return

    await withTempAntigravityHome('codeburn-antigravity-split-chunks-', async (tempHome) => {
      const fixture = JSON.parse(await readFile(
        new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
        'utf-8',
      )) as CurrentCliFixture

      const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
      await mkdir(conversationsDir, { recursive: true })
      const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
      createCurrentAntigravityCliDb(dbPath, fixture)

      const varint = (n: number): number[] => {
        const out: number[] = []
        let v = n
        while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
        out.push(v)
        return out
      }
      const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
      const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]
      const strField = (field: number, str: string): number[] => lenField(field, Array.from(Buffer.from(str, 'utf-8')))

      const withSplitStepIndices = (fixtureHex: string, chunk1: number[], chunk2: number[]): Buffer => {
        const rest = Buffer.from(fixtureHex, 'hex').subarray(4)
        const packed1 = Buffer.from(chunk1.flatMap(n => varint(n)))
        const f2Chunk1 = Buffer.from([...tag(2, 2), ...varint(packed1.length), ...packed1])
        const packed2 = Buffer.from(chunk2.flatMap(n => varint(n)))
        const f2Chunk2 = Buffer.from([...tag(2, 2), ...varint(packed2.length), ...packed2])
        return Buffer.concat([f2Chunk1, f2Chunk2, rest])
      }

      const encodeToolStepMetadata = (toolName: string, argsJson: string): Buffer => {
        const toolCallSub = [
          ...strField(1, 'call_test_split'),
          ...strField(2, toolName),
          ...strField(3, argsJson),
        ]
        return Buffer.from(lenField(4, toolCallSub))
      }

      const { DatabaseSync: Database } = requireForTest('node:sqlite')
      const db = new Database(dbPath) as TestDb
      try {
        // Update Turn 0 to carry two distinct field 2 packed chunks: [1] and [2]
        db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
          withSplitStepIndices(fixture.rows[0]!.hex, [1], [2]),
        )

        db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, metadata blob)')
        const stmt = db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)')
        stmt.run(1, encodeToolStepMetadata('run_command', JSON.stringify({ CommandLine: 'git status' })))
        stmt.run(2, encodeToolStepMetadata('view_file', JSON.stringify({ AbsolutePath: '/foo/bar.ts' })))
      } finally {
        db.close()
      }

      const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.tools).toEqual(['run_command', 'view_file'])
      expect(calls[0]!.bashCommands).toEqual(['git'])
    })
  })

  it('stores only the basename for run_command, never the secret-bearing flags', async () => {
    if (!isSqliteAvailable()) return

      await withTempAntigravityHome('codeburn-antigravity-secret-', async (tempHome) => {
        const fixture = JSON.parse(await readFile(
          new URL('../fixtures/antigravity-cli-current/gen-metadata.json', import.meta.url),
          'utf-8',
        )) as CurrentCliFixture

        const conversationsDir = join(tempHome, '.gemini', 'antigravity', 'conversations')
        await mkdir(conversationsDir, { recursive: true })
        const dbPath = join(conversationsDir, `${fixture.conversationId}.db`)
        createCurrentAntigravityCliDb(dbPath, fixture)

        const varint = (n: number): number[] => {
          const out: number[] = []
          let v = n
          while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
          out.push(v)
          return out
        }
        const tag = (field: number, wire: number): number[] => varint(field * 8 + wire)
        const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes]
        const strField = (field: number, str: string): number[] => lenField(field, Array.from(Buffer.from(str, 'utf-8')))
        const encodeToolStepMetadata = (toolName: string, argsJson: string): Buffer => Buffer.from(lenField(4, [
          ...strField(1, 'call_secret'),
          ...strField(2, toolName),
          ...strField(3, argsJson),
        ]))
        const withStepIndices = (fixtureHex: string, indices: number[]): Buffer => {
          const rest = Buffer.from(fixtureHex, 'hex').subarray(4)
          const packed = Buffer.from(indices.flatMap(n => varint(n)))
          return Buffer.concat([Buffer.from([...tag(2, 2), ...varint(packed.length), ...packed]), rest])
        }

        const { DatabaseSync: Database } = requireForTest('node:sqlite')
        const db = new Database(dbPath) as TestDb
        try {
          db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 0').run(
            withStepIndices(fixture.rows[0]!.hex, [1]),
          )
          db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)')
          const stmt = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)')
          stmt.run(0, 15, null)
          stmt.run(1, 21, encodeToolStepMetadata('run_command', JSON.stringify({ CommandLine: 'curl --api-key=secret123 https://example.com' })))
        } finally {
          db.close()
        }

        const calls = await collectAntigravityCalls({ path: dbPath, project: 'antigravity', provider: 'antigravity' })
        expect(calls.length).toBeGreaterThan(0)
        // Tool breakdown still records the run_command call.
        expect(calls[0]!.tools).toEqual(['run_command'])
        // Command breakdown carries the basename only — no secret reaches disk.
        expect(calls[0]!.bashCommands).toEqual(['curl'])
        expect(JSON.stringify(calls[0]!)).not.toContain('secret123')
        expect(JSON.stringify(calls[0]!)).not.toContain('--api-key')
      })
    })
})

describe('normalizeAntigravityToolCall', () => {
  it('formats call_mcp_tool with PascalCase ServerName and ToolName as mcp__<server>__<tool>', () => {
    expect(normalizeAntigravityToolCall('call_mcp_tool', { ServerName: 'context7', ToolName: 'resolve-library-id' }))
      .toBe('mcp__context7__resolve-library-id')
  })

  it('formats call_mcp_tool with snake_case keys', () => {
    expect(normalizeAntigravityToolCall('call_mcp_tool', { server_name: 'context7', tool_name: 'resolve-library-id' }))
      .toBe('mcp__context7__resolve-library-id')
  })

  it('falls back to call_mcp_tool when args are missing or empty', () => {
    expect(normalizeAntigravityToolCall('call_mcp_tool', null)).toBe('call_mcp_tool')
    expect(normalizeAntigravityToolCall('call_mcp_tool', {})).toBe('call_mcp_tool')
    expect(normalizeAntigravityToolCall('call_mcp_tool', { ServerName: '' })).toBe('call_mcp_tool')
  })

  it('normalizes eager mcp_<server>_<tool> into mcp__<server>__<tool>', () => {
    expect(normalizeAntigravityToolCall('mcp_context7_resolve-library-id'))
      .toBe('mcp__context7__resolve-library-id')
    expect(normalizeAntigravityToolCall('mcp_dart-mcp-server_analyze_files'))
      .toBe('mcp__dart-mcp-server__analyze_files')
  })

  it('preserves already canonical mcp__<server>__<tool>', () => {
    expect(normalizeAntigravityToolCall('mcp__context7__resolve-library-id'))
      .toBe('mcp__context7__resolve-library-id')
  })

  it('leaves non-mcp tools unchanged', () => {
    expect(normalizeAntigravityToolCall('run_command')).toBe('run_command')
    expect(normalizeAntigravityToolCall('view_file')).toBe('view_file')
    expect(normalizeAntigravityToolCall('manage_task')).toBe('manage_task')
    expect(normalizeAntigravityToolCall('search_web')).toBe('search_web')
  })

  it('splits eager mcp names at the first underscore, misattributing servers with underscores', () => {
    expect(normalizeAntigravityToolCall('mcp_github_mcp_server_create_issue'))
      .toBe('mcp__github__mcp_server_create_issue')
  })

  it('leaves incomplete mcp prefixes unchanged', () => {
    expect(normalizeAntigravityToolCall('mcp_')).toBe('mcp_')
    expect(normalizeAntigravityToolCall('mcp_noservertool')).toBe('mcp_noservertool')
  })
  it('formats call_mcp_tool with camelCase keys', () => {
    expect(normalizeAntigravityToolCall('call_mcp_tool', { serverName: 'context7', toolName: 'resolve-library-id' }))
      .toBe('mcp__context7__resolve-library-id')
  })

  it('formats call_mcp_tool with short server/tool keys', () => {
    expect(normalizeAntigravityToolCall('call_mcp_tool', { server: 'context7', tool: 'resolve-library-id' }))
      .toBe('mcp__context7__resolve-library-id')
  })

  it('handles empty or falsy toolName safely', () => {
    expect(normalizeAntigravityToolCall('')).toBe('')
  })
})

describe('antigravity provider toolDisplayName', () => {
  it('normalizes eager and canonical MCP tools to canonical display names', () => {
    const provider = createAntigravityProvider()
    expect(provider.toolDisplayName('mcp_context7_resolve-library-id')).toBe('mcp__context7__resolve-library-id')
    expect(provider.toolDisplayName('mcp__context7__resolve-library-id')).toBe('mcp__context7__resolve-library-id')
    expect(provider.toolDisplayName('run_command')).toBe('run_command')
  })
})
