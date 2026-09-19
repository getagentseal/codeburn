import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { DatabaseSync } from 'node:sqlite'

import { createAntigravityToolsProvider } from '../../src/providers/antigravity-tools.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agtools-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function writeUserTokensDb() {
  const db = new DatabaseSync(join(tmpDir, 'user_tokens.db'))
  db.exec(`
    CREATE TABLE user_tokens (
      id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, username TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1, total_requests INTEGER NOT NULL DEFAULT 0,
      total_tokens_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE token_usage_logs (
      id TEXT PRIMARY KEY, token_id TEXT NOT NULL, ip_address TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, request_time INTEGER NOT NULL,
      status INTEGER
    );
  `)
  db.prepare(`INSERT INTO user_tokens (id, token, username) VALUES ('t1', 'sk-x', 'remote-pal')`).run()
  db.prepare(
    `INSERT INTO token_usage_logs (id, token_id, ip_address, model, input_tokens, output_tokens, request_time, status)
     VALUES ('u1', 't1', '150.109.246.26', 'gemini-3.8-flash-high', 9004, 781, 1789282873, 200)`,
  ).run()
  db.prepare(
    `INSERT INTO token_usage_logs (id, token_id, ip_address, model, input_tokens, output_tokens, request_time, status)
     VALUES ('u0', 't1', '150.109.246.26', 'gemini-3.8-flash-high', 0, 0, 1789282873, 200)`,
  ).run()
  db.close()
}

function writeProxyLogsDb() {
  const db = new DatabaseSync(join(tmpDir, 'proxy_logs.db'))
  db.exec(`
    CREATE TABLE request_logs (
      id TEXT PRIMARY KEY, timestamp INTEGER, method TEXT, url TEXT, status INTEGER,
      duration INTEGER, model TEXT, error TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cached_tokens INTEGER, account_email TEXT, mapped_model TEXT, protocol TEXT,
      client_ip TEXT, username TEXT
    );
  `)
  // Remote client: counted.
  db.prepare(
    `INSERT INTO request_logs (id, timestamp, model, mapped_model, client_ip, input_tokens, output_tokens, cached_tokens, status)
     VALUES ('r1', 1789216089428, 'claude-opus-4-6-thinking', 'gemini-3.8-flash-high', '122.228.178.130', 83255, 76, 79900, 200)`,
  ).run()
  // Local request (no client_ip): skipped.
  db.prepare(
    `INSERT INTO request_logs (id, timestamp, model, mapped_model, client_ip, input_tokens, output_tokens, status)
     VALUES ('r2', 1789216089428, 'gemini-3.8-flash-high', 'gemini-3.8-flash-high', NULL, 50000, 50, 200)`,
  ).run()
  // Loopback client: skipped.
  db.prepare(
    `INSERT INTO request_logs (id, timestamp, model, mapped_model, client_ip, input_tokens, output_tokens, status)
     VALUES ('r3', 1789216089428, 'gemini-3.8-flash-high', 'gemini-3.8-flash-high', '127.0.0.1', 50000, 50, 200)`,
  ).run()
  db.close()
}

async function collect(provider: ReturnType<typeof createAntigravityToolsProvider>) {
  const calls: ParsedProviderCall[] = []
  for (const source of await provider.discoverSessions()) {
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe('antigravity-tools provider', () => {
  it('discovers nothing when the data dir is absent', async () => {
    const provider = createAntigravityToolsProvider(join(tmpDir, 'nope'))
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('discovers one source per present db', async () => {
    writeUserTokensDb()
    writeProxyLogsDb()
    const sources = await createAntigravityToolsProvider(tmpDir).discoverSessions()
    expect(sources).toHaveLength(2)
    expect(sources.map(s => s.sourceId).sort()).toEqual(['proxy-logs', 'user-tokens'])
  })

  it('emits every token-usage row as remote traffic', async () => {
    writeUserTokensDb()
    const calls = await collect(createAntigravityToolsProvider(tmpDir))
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('antigravity-tools')
    expect(call.model).toBe('gemini-3.8-flash-high')
    expect(call.inputTokens).toBe(9004)
    expect(call.outputTokens).toBe(781)
    expect(call.sessionId).toBe('token:remote-pal')
    expect(call.project).toBe('antigravity-tools remote: remote-pal')
    expect(call.timestamp).toBe(new Date(1789282873 * 1000).toISOString())
    expect(call.deduplicationKey).toBe('antigravity-tools:tok:u1')
  })

  it('emits only non-loopback client_ip rows from proxy logs and prices the mapped model', async () => {
    writeProxyLogsDb()
    const calls = await collect(createAntigravityToolsProvider(tmpDir))
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.deduplicationKey).toBe('antigravity-tools:req:r1')
    expect(call.model).toBe('gemini-3.8-flash-high')
    expect(call.cacheReadInputTokens).toBe(79900)
    expect(call.sessionId).toBe('ip:122.228.178.130')
  })

  it('treats IPs in CODEBURN_ANTIGRAVITY_TOOLS_LOCAL_IPS as local', async () => {
    writeProxyLogsDb()
    const prev = process.env.CODEBURN_ANTIGRAVITY_TOOLS_LOCAL_IPS
    process.env.CODEBURN_ANTIGRAVITY_TOOLS_LOCAL_IPS = ' 122.228.178.130 , 203.0.113.9 '
    try {
      expect(await collect(createAntigravityToolsProvider(tmpDir))).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.CODEBURN_ANTIGRAVITY_TOOLS_LOCAL_IPS
      else process.env.CODEBURN_ANTIGRAVITY_TOOLS_LOCAL_IPS = prev
    }
  })

  it('skips the proxy-logs source entirely when CODEBURN_ANTIGRAVITY_TOOLS_TOKENS_ONLY is set', async () => {
    writeUserTokensDb()
    writeProxyLogsDb()
    const prev = process.env.CODEBURN_ANTIGRAVITY_TOOLS_TOKENS_ONLY
    process.env.CODEBURN_ANTIGRAVITY_TOOLS_TOKENS_ONLY = '1'
    try {
      const provider = createAntigravityToolsProvider(tmpDir)
      const sources = await provider.discoverSessions()
      expect(sources.map(s => s.sourceId)).toEqual(['user-tokens'])
      const calls = await collect(provider)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.project).toBe('antigravity-tools remote: remote-pal')
    } finally {
      if (prev === undefined) delete process.env.CODEBURN_ANTIGRAVITY_TOOLS_TOKENS_ONLY
      else process.env.CODEBURN_ANTIGRAVITY_TOOLS_TOKENS_ONLY = prev
    }
  })

  it('deduplicates across repeated parses', async () => {
    writeUserTokensDb()
    const provider = createAntigravityToolsProvider(tmpDir)
    const seen = new Set<string>()
    const [source] = await provider.discoverSessions()
    const first = []
    for await (const c of provider.createSessionParser(source!, seen).parse()) first.push(c)
    const second = []
    for await (const c of provider.createSessionParser(source!, seen).parse()) second.push(c)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('reports probeRoots and display names', async () => {
    const provider = createAntigravityToolsProvider(tmpDir)
    expect(provider.name).toBe('antigravity-tools')
    expect(provider.displayName).toBe('Antigravity Tools')
    expect(provider.durableSources).toBe(true)
    const roots = await provider.probeRoots!()
    expect(roots).toEqual([{ path: tmpDir, label: 'data dir' }])
    expect(provider.modelDisplayName('gemini-3.8-flash-high')).toBeTruthy()
  })
})
