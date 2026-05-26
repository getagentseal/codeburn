import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ClaudeCredentialError,
  disconnectClaude,
  freshClaudeAccessToken,
  getCurrentClaudeRecord,
  parseCredentialsBlob,
  rebootstrapClaudeCredentials,
  refreshClaudeAccessTokenAfter401,
  resetClaudeCredentialHooks,
  sanitizeClaudeBlob,
  setClaudeCredentialHooks,
} from '../src/claude-credentials.js'

let tmp: string
const originalCacheDir = process.env['CODEBURN_CACHE_DIR']

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'codeburn-claude-creds-'))
  process.env['CODEBURN_CACHE_DIR'] = tmp
  resetClaudeCredentialHooks()
})

afterEach(async () => {
  resetClaudeCredentialHooks()
  if (originalCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCacheDir
  await rm(tmp, { recursive: true, force: true })
})

describe('sanitizeClaudeBlob', () => {
  it('removes carriage returns and pretty-print indentation between fields', () => {
    const raw = '{\r\n  "claudeAiOauth": {\r\n    "accessToken": "abc"\r\n  }\r\n}'
    const cleaned = sanitizeClaudeBlob(raw)
    expect(cleaned).toBe('{"claudeAiOauth": {"accessToken": "abc"}}')
  })

  it('strips mid-token line wraps that Claude Code emits for long values', () => {
    const raw = '{"claudeAiOauth":{"accessToken":"AAAA\n      BBBB\n      CCCC"}}'
    const parsed = parseCredentialsBlob(raw)
    expect(parsed.accessToken).toBe('AAAABBBBCCCC')
  })
})

describe('parseCredentialsBlob', () => {
  it('parses access token, refresh token, expiresAt and rateLimitTier', () => {
    const record = parseCredentialsBlob(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: 1_700_000_000_000,
        rateLimitTier: 'max_20x',
      },
    }))
    expect(record.accessToken).toBe('tok')
    expect(record.refreshToken).toBe('ref')
    expect(record.expiresAt?.getTime()).toBe(1_700_000_000_000)
    expect(record.rateLimitTier).toBe('max_20x')
  })

  it('throws decode_failed when accessToken is missing', () => {
    try {
      parseCredentialsBlob(JSON.stringify({ claudeAiOauth: { refreshToken: 'ref' } }))
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCredentialError)
      expect((err as ClaudeCredentialError).code).toBe('decode_failed')
    }
  })

  it('throws decode_failed on malformed JSON', () => {
    try {
      parseCredentialsBlob('{not json')
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as ClaudeCredentialError).code).toBe('decode_failed')
    }
  })

  it('treats missing refresh token and tier as null', () => {
    const record = parseCredentialsBlob(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok' },
    }))
    expect(record.refreshToken).toBeNull()
    expect(record.rateLimitTier).toBeNull()
    expect(record.expiresAt).toBeNull()
  })
})

describe('getCurrentClaudeRecord', () => {
  it('returns null when neither file nor keychain has credentials', async () => {
    setClaudeCredentialHooks({
      readClaudeFile: async () => null,
      readMacKeychain: async () => null,
    })
    const record = await getCurrentClaudeRecord()
    expect(record).toBeNull()
  })

  it('bootstraps from the Claude file and writes our cache', async () => {
    setClaudeCredentialHooks({
      readClaudeFile: async () => JSON.stringify({
        claudeAiOauth: { accessToken: 'src-token', refreshToken: 'ref', rateLimitTier: 'pro' },
      }),
    })
    const record = await getCurrentClaudeRecord()
    expect(record?.accessToken).toBe('src-token')
    const cached = await readFile(join(tmp, 'claude-credentials.v1.json'), 'utf-8')
    expect(JSON.parse(cached).accessToken).toBe('src-token')
  })

  it('prefers our cache over re-reading the Claude source', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'cached',
      refreshToken: 'ref',
      expiresAt: null,
      rateLimitTier: null,
    }))
    let fileReads = 0
    setClaudeCredentialHooks({
      readClaudeFile: async () => {
        fileReads++
        return JSON.stringify({ claudeAiOauth: { accessToken: 'source' } })
      },
    })
    const record = await getCurrentClaudeRecord()
    expect(record?.accessToken).toBe('cached')
    expect(fileReads).toBe(0)
  })
})

describe('freshClaudeAccessToken', () => {
  it('returns the current token when not near expiry', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'still-good',
      refreshToken: 'ref',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      rateLimitTier: null,
    }))
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => {
        throw new Error('should not refresh')
      },
    })
    expect(await freshClaudeAccessToken()).toBe('still-good')
  })

  it('refreshes proactively when within the margin and persists the new token', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'expiring',
      refreshToken: 'ref',
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      rateLimitTier: 'max_20x',
    }))
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: 'new-token', refresh_token: 'new-ref', expires_in: 3600 }),
      }),
    })
    const token = await freshClaudeAccessToken()
    expect(token).toBe('new-token')
    const cached = JSON.parse(await readFile(join(tmp, 'claude-credentials.v1.json'), 'utf-8'))
    expect(cached.accessToken).toBe('new-token')
    expect(cached.refreshToken).toBe('new-ref')
    expect(cached.rateLimitTier).toBe('max_20x')
  })

  it('throws no_refresh_token when refresh is required but unavailable', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'expiring',
      refreshToken: null,
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      rateLimitTier: null,
    }))
    try {
      await freshClaudeAccessToken()
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCredentialError)
      expect((err as ClaudeCredentialError).code).toBe('no_refresh_token')
    }
  })
})

describe('refreshClaudeAccessTokenAfter401', () => {
  it('persists rotated refresh token', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'old',
      refreshToken: 'old-ref',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      rateLimitTier: null,
    }))
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => ({
        status: 200,
        body: JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 1800 }),
      }),
    })
    const token = await refreshClaudeAccessTokenAfter401()
    expect(token).toBe('fresh')
    const cached = JSON.parse(await readFile(join(tmp, 'claude-credentials.v1.json'), 'utf-8'))
    expect(cached.refreshToken).toBe('rotated')
  })

  it('classifies invalid_grant from the OAuth server as terminal', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'old',
      refreshToken: 'old-ref',
      expiresAt: null,
      rateLimitTier: null,
    }))
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => ({
        status: 400,
        body: '{"error":"invalid_grant"}',
      }),
    })
    try {
      await refreshClaudeAccessTokenAfter401()
      expect.fail('should have thrown')
    } catch (err) {
      const e = err as ClaudeCredentialError
      expect(e.code).toBe('refresh_http')
      expect(e.isTerminal).toBe(true)
    }
  })
})

describe('isTerminal classification', () => {
  it('treats 429 from the OAuth server as transient, not terminal', () => {
    const err = new ClaudeCredentialError('refresh_http', 'rate limited', { httpStatus: 429, httpBody: '' })
    expect(err.isTerminal).toBe(false)
  })

  it('treats 408 from the OAuth server as transient', () => {
    const err = new ClaudeCredentialError('refresh_http', 'timeout', { httpStatus: 408, httpBody: '' })
    expect(err.isTerminal).toBe(false)
  })

  it('treats no_refresh_token as terminal', () => {
    expect(new ClaudeCredentialError('no_refresh_token', 'x').isTerminal).toBe(true)
  })

  it('treats no_source as terminal', () => {
    expect(new ClaudeCredentialError('no_source', 'x').isTerminal).toBe(true)
  })
})

describe('freshClaudeAccessToken transient fallback', () => {
  it('returns the current token when a proactive refresh fails transiently', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'expiring-but-valid',
      refreshToken: 'ref',
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      rateLimitTier: null,
    }))
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => ({ status: 429, body: '' }),
    })
    const token = await freshClaudeAccessToken()
    expect(token).toBe('expiring-but-valid')
  })

  it('propagates a terminal proactive refresh failure', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'old',
      refreshToken: 'ref',
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      rateLimitTier: null,
    }))
    setClaudeCredentialHooks({
      refreshTokenHTTP: async () => ({ status: 400, body: '{"error":"invalid_grant"}' }),
    })
    await expect(freshClaudeAccessToken()).rejects.toBeInstanceOf(ClaudeCredentialError)
  })
})

// Concurrent refresh detection is exercised indirectly via the rebootstrap
// and refresh-after-401 paths; simulating the exact in-process race
// deterministically requires intercepting the gap between getCurrentClaudeRecord
// and refreshAndPersist, which is not currently exposed.

describe('rebootstrapClaudeCredentials', () => {
  it('drops our cache and re-reads the Claude source', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'cached',
      refreshToken: 'cached-ref',
      expiresAt: null,
      rateLimitTier: null,
    }))
    setClaudeCredentialHooks({
      readClaudeFile: async () => JSON.stringify({
        claudeAiOauth: { accessToken: 'fresh-from-source', refreshToken: 'fresh-ref' },
      }),
    })
    const record = await rebootstrapClaudeCredentials()
    expect(record?.accessToken).toBe('fresh-from-source')
    const cached = JSON.parse(await readFile(join(tmp, 'claude-credentials.v1.json'), 'utf-8'))
    expect(cached.accessToken).toBe('fresh-from-source')
  })

  it('returns null when no source is available either', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'cached',
      refreshToken: 'cached-ref',
      expiresAt: null,
      rateLimitTier: null,
    }))
    setClaudeCredentialHooks({
      readClaudeFile: async () => null,
      readMacKeychain: async () => null,
    })
    const record = await rebootstrapClaudeCredentials()
    expect(record).toBeNull()
  })
})

describe('disconnectClaude', () => {
  it('drops our cache file without touching the Claude source', async () => {
    await writeFile(join(tmp, 'claude-credentials.v1.json'), JSON.stringify({
      accessToken: 'a',
      refreshToken: 'b',
      expiresAt: null,
      rateLimitTier: null,
    }))
    await disconnectClaude()
    setClaudeCredentialHooks({
      readClaudeFile: async () => null,
      readMacKeychain: async () => null,
    })
    expect(await getCurrentClaudeRecord()).toBeNull()
  })
})
