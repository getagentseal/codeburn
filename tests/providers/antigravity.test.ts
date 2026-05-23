import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

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
} from '../../src/providers/antigravity.js'

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
    expect(extractAntigravityModelMap(null)).toEqual({})
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
    const oldCacheDir = process.env['CODEBURN_CACHE_DIR']
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
      if (oldCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips statusLine fallback calls when RPC cache already covered the conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-statusline-rpc-dedup-'))
    const oldCacheDir = process.env['CODEBURN_CACHE_DIR']
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
      if (oldCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips singleton statusLine snapshots and deltas monotonic usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-statusline-runs-'))
    const oldCacheDir = process.env['CODEBURN_CACHE_DIR']
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
      if (oldCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats non-monotonic statusLine usage as a new request snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-antigravity-statusline-reset-'))
    const oldCacheDir = process.env['CODEBURN_CACHE_DIR']
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
      if (oldCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('always reparses append-only statusLine sources but not unchanged cached cascades', () => {
    const statusLinePath = getAntigravityStatusLineEventsPath()

    expect(shouldReparseAntigravitySource(statusLinePath, 1)).toBe(true)
    expect(shouldReparseAntigravitySource('/tmp/antigravity/conversation.pb', 0)).toBe(true)
    expect(shouldReparseAntigravitySource('/tmp/antigravity/conversation.pb', 1)).toBe(false)
  })
})
