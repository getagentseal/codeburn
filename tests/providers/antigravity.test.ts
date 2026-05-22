import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
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
  parseAntigravityServerInfo,
  parseAntigravityServerInfoFromLine,
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
  })
})
