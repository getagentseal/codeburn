import { describe, expect, it } from 'vitest'

import {
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

  it('ignores process args without antigravity markers or valid ports', () => {
    expect(parseAntigravityServerInfoFromLine('language_server --extension_server_port 62300 --extension_server_csrf_token token')).toBeNull()
    expect(parseAntigravityServerInfoFromLine('antigravity language_server --extension_server_port 99999 --extension_server_csrf_token token')).toBeNull()
    expect(parseAntigravityServerInfoFromLine('antigravity language_server --extension_server_port=--extension_server_csrf_token --extension_server_csrf_token token')).toBeNull()
    expect(parseAntigravityServerInfoFromLine('antigravity language_server --extension_server_port 62300 --extension_server_csrf_token short')).toBeNull()
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
    const metadata = [{ chatModel: { model: 'gemini-3-pro', usage: { model: 'gemini-3-pro', inputTokens: '10', outputTokens: '4', apiProvider: 'google' } } }]

    expect(extractAntigravityGeneratorMetadata({ response: { generatorMetadata: metadata } })).toEqual(metadata)
    expect(extractAntigravityGeneratorMetadata({ generatorMetadata: metadata })).toEqual(metadata)
    expect(extractAntigravityGeneratorMetadata({ response: { generatorMetadata: null } })).toEqual([])
    expect(extractAntigravityGeneratorMetadata(null)).toEqual([])
  })
})
