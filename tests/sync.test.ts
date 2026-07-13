import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'

import { parseDiscoveryDoc, DiscoveryError } from '../src/sync/discovery.js'
import {
  generatePkce,
  buildAuthUrl,
  resolveScopes,
  startCallbackServer,
  CALLBACK_PORTS,
} from '../src/sync/auth.js'

// ── Discovery Doc Parser ──────────────────────────────────────────────

describe('parseDiscoveryDoc', () => {
  it('parses valid v1 doc', () => {
    const doc = parseDiscoveryDoc({
      version: 1,
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXX',
      client_id: 'abc123',
      scopes: ['openid', 'codeburn:write'],
      traces_path: '/v1/traces',
      max_batch_size: 500,
    })
    expect(doc.version).toBe(1)
    expect(doc.issuer).toBe('https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXX')
    expect(doc.client_id).toBe('abc123')
    expect(doc.scopes).toEqual(['openid', 'codeburn:write'])
    expect(doc.traces_path).toBe('/v1/traces')
    expect(doc.max_batch_size).toBe(500)
  })

  it('rejects version > 1', () => {
    expect(() => parseDiscoveryDoc({ version: 2, issuer: 'https://idp.example', client_id: 'y' }))
      .toThrow('Please update codeburn')
  })

  it('rejects missing issuer', () => {
    expect(() => parseDiscoveryDoc({ version: 1, client_id: 'y' }))
      .toThrow('missing required field: issuer')
  })

  it('rejects missing client_id', () => {
    expect(() => parseDiscoveryDoc({ version: 1, issuer: 'https://idp.example' }))
      .toThrow('missing required field: client_id')
  })

  it('defaults traces_path to /v1/traces when absent', () => {
    const doc = parseDiscoveryDoc({ issuer: 'https://idp.example', client_id: 'y' })
    expect(doc.traces_path).toBe('/v1/traces')
  })

  it('defaults max_batch_size to 1000 when absent', () => {
    const doc = parseDiscoveryDoc({ issuer: 'https://idp.example', client_id: 'y' })
    expect(doc.max_batch_size).toBe(1000)
  })

  it('defaults scopes to ["openid"] when absent', () => {
    const doc = parseDiscoveryDoc({ issuer: 'https://idp.example', client_id: 'y' })
    expect(doc.scopes).toEqual(['openid'])
  })

  it('treats absent version as v1', () => {
    const doc = parseDiscoveryDoc({ issuer: 'https://idp.example', client_id: 'y' })
    expect(doc.version).toBe(1)
  })

  it('rejects non-https issuer (RFC 8252 §8.3)', () => {
    expect(() => parseDiscoveryDoc({ version: 1, issuer: 'http://idp.example', client_id: 'y' }))
      .toThrow(/must use https/)
  })

  it('rejects non-object input', () => {
    expect(() => parseDiscoveryDoc(null)).toThrow('must be a JSON object')
    expect(() => parseDiscoveryDoc('string')).toThrow('must be a JSON object')
    expect(() => parseDiscoveryDoc([1, 2])).toThrow('must be a JSON object')
  })
})

// ── PKCE ──────────────────────────────────────────────────────────────

describe('generatePkce', () => {
  it('generates code_verifier of valid length (43+ chars)', () => {
    const { code_verifier } = generatePkce()
    expect(code_verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('generates different values each time', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.code_verifier).not.toBe(b.code_verifier)
  })

  it('code_challenge is base64url of SHA-256(verifier)', () => {
    const { code_verifier, code_challenge } = generatePkce()
    const { createHash } = require('crypto')
    const expected = createHash('sha256').update(code_verifier).digest('base64url')
    expect(code_challenge).toBe(expected)
  })

  it('uses S256 method', () => {
    const { code_challenge_method } = generatePkce()
    expect(code_challenge_method).toBe('S256')
  })
})

// ── Auth URL ──────────────────────────────────────────────────────────

describe('buildAuthUrl', () => {
  const baseParams = {
    authorization_endpoint: 'https://idp.example.com/oauth2/authorize',
    client_id: 'test-client',
    redirect_uri: 'http://127.0.0.1:19876/callback',
    scopes: ['openid', 'codeburn:write'],
    state: 'random-state-value',
    pkce: generatePkce(),
  }

  it('includes all required parameters', () => {
    const url = new URL(buildAuthUrl(baseParams))
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('test-client')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:19876/callback')
    expect(url.searchParams.get('state')).toBe('random-state-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('joins scopes with space', () => {
    const url = new URL(buildAuthUrl(baseParams))
    expect(url.searchParams.get('scope')).toBe('openid codeburn:write')
  })

  it('uses 127.0.0.1 literal (not localhost)', () => {
    const url = buildAuthUrl(baseParams)
    expect(url).toContain('127.0.0.1')
    expect(url).not.toContain('localhost')
  })
})

// ── Scope Resolution ──────────────────────────────────────────────────

describe('resolveScopes', () => {
  it('appends offline_access when IdP supports it', () => {
    const result = resolveScopes(['openid'], ['openid', 'offline_access', 'profile'])
    expect(result).toContain('offline_access')
  })

  it('does not append offline_access when IdP does not support it', () => {
    const result = resolveScopes(['openid'], ['openid', 'profile'])
    expect(result).not.toContain('offline_access')
  })

  it('does not duplicate offline_access if already requested', () => {
    const result = resolveScopes(['openid', 'offline_access'], ['openid', 'offline_access'])
    expect(result.filter(s => s === 'offline_access')).toHaveLength(1)
  })

  it('passes through scopes unchanged when IdP scopes unknown', () => {
    const result = resolveScopes(['openid', 'codeburn:write'], undefined)
    expect(result).toEqual(['openid', 'codeburn:write'])
  })
})

// ── Callback Server ──────────────────────────────────────────────────

describe('startCallbackServer', () => {
  it('accepts valid callback with matching state', async () => {
    const state = 'test-state-123'
    const { promise, ready } = startCallbackServer(state, 5000, [0])

    // Wait for server to bind
    const port = await ready

    // Simulate IdP callback
    await fetch(`http://127.0.0.1:${port}/callback?code=auth-code-xyz&state=${state}`)

    const result = await promise
    expect(result.code).toBe('auth-code-xyz')
  }, 10000)

  it('rejects callback with wrong state', async () => {
    const state = 'correct-state'
    const { promise, ready } = startCallbackServer(state, 5000, [0])
    const port = await ready

    // Send with wrong state — server stays running
    const resp = await fetch(`http://127.0.0.1:${port}/callback?code=xxx&state=wrong-state`)
    expect(resp.status).toBe(400)

    // Now send correct one
    await fetch(`http://127.0.0.1:${port}/callback?code=real-code&state=${state}`)
    const result = await promise
    expect(result.code).toBe('real-code')
  }, 10000)

  it('times out after configured duration', async () => {
    const { promise } = startCallbackServer('state', 300, [0]) // 300ms timeout

    await expect(promise).rejects.toThrow('timed out')
  }, 5000)
})

// ── Config ────────────────────────────────────────────────────────────

describe('syncConfig', () => {
  let tmpDir: string
  const originalHome = process.env.HOME

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-sync-config-'))
    process.env.HOME = tmpDir
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads config', async () => {
    // Dynamically import to pick up new HOME
    const { writeSyncConfig, readSyncConfig } = await import('../src/sync/config.js')

    writeSyncConfig({
      baseUrl: 'https://metrics.test.com',
      clientId: 'test-client',
      tracesPath: '/v1/traces',
      issuer: 'https://idp.test.com',
    })

    const config = readSyncConfig()
    expect(config).not.toBeNull()
    expect(config!.baseUrl).toBe('https://metrics.test.com')
    expect(config!.clientId).toBe('test-client')
  })

  it('returns null when no config exists', async () => {
    const { readSyncConfig } = await import('../src/sync/config.js')
    const config = readSyncConfig()
    expect(config).toBeNull()
  })

  it('config file does not contain tokens', async () => {
    const { writeSyncConfig } = await import('../src/sync/config.js')

    writeSyncConfig({
      baseUrl: 'https://metrics.test.com',
      clientId: 'client',
      tracesPath: '/v1/traces',
      issuer: 'https://idp.test.com',
    })

    const raw = await readFile(join(tmpDir, '.config', 'codeburn', 'sync.json'), 'utf-8')
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('password')
  })
})
