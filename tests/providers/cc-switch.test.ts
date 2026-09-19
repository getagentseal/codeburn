import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'

import { createCcSwitchProvider } from '../../src/providers/cc-switch.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ccswitch-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const LOCAL_SESSION = '4ff179eb-736c-4444-80a6-2d4ca34cd54e'
const REMOTE_SESSION = '96549aa1-2af8-461d-a1a6-adff74aae2e2'

function writeDb() {
  const db = new DatabaseSync(join(tmpDir, 'cc-switch.db'))
  db.exec(`
    CREATE TABLE session_log_sync (
      file_path TEXT PRIMARY KEY, last_modified INTEGER NOT NULL,
      last_line_offset INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER NOT NULL
    );
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL,
      model TEXT NOT NULL, request_model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL, status_code INTEGER NOT NULL, session_id TEXT,
      data_source TEXT NOT NULL DEFAULT 'proxy', pricing_model TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  const localFile = join(homedir(), '.claude', 'projects', 'proj', `${LOCAL_SESSION}.jsonl`)
  const remoteFile = `C:\\Users\\OTHER\\.claude\\projects\\proj\\${REMOTE_SESSION}.jsonl`
  db.prepare(`INSERT INTO session_log_sync (file_path, last_modified, last_synced_at) VALUES (?, 0, 0)`).run(localFile)
  db.prepare(`INSERT INTO session_log_sync (file_path, last_modified, last_synced_at) VALUES (?, 0, 0)`).run(remoteFile)

  const ins = db.prepare(
    `INSERT INTO proxy_request_logs
       (request_id, provider_id, app_type, model, request_model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, latency_ms, status_code, session_id, data_source, created_at)
     VALUES (?, 'p', 'claude', ?, ?, ?, ?, ?, ?, 0, 200, ?, ?, ?)`,
  )
  // Local session row: skipped (its file is under homedir).
  ins.run('l1', 'claude-opus-5', 'claude-opus-5', 1000, 50, 0, 0, LOCAL_SESSION, 'session_log', 1789568700)
  // Remote session row: emitted.
  ins.run('r1', 'claude-opus-5', 'claude-opus-5', 28284, 28, 768, 0, REMOTE_SESSION, 'session_log', 1789568701)
  // Unknown session id: emitted (a local row nearly always has a synced file).
  ins.run('u1', 'kimi-for-coding', 'kimi-for-coding', 500, 10, 0, 0, 'no-such-file-session', 'pi_session', 1789568702)
  // Built-in proxy row without a session id: emitted (forwarded traffic).
  ins.run('p1', 'gpt-5.6-sol', 'gpt-5.6-sol', 300, 20, 0, 0, null, 'proxy', 1789568703)
  // Zero-token row: skipped.
  ins.run('z1', 'claude-opus-5', 'claude-opus-5', 0, 0, 0, 0, REMOTE_SESSION, 'session_log', 1789568704)
  db.close()
}

async function collect(provider: ReturnType<typeof createCcSwitchProvider>) {
  const calls: ParsedProviderCall[] = []
  for (const source of await provider.discoverSessions()) {
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe('cc-switch provider', () => {
  it('discovers nothing when the db is absent', async () => {
    expect(await createCcSwitchProvider(join(tmpDir, 'nope')).discoverSessions()).toEqual([])
  })

  it('emits only remote and proxy traffic, never local sessions', async () => {
    writeDb()
    const calls = await collect(createCcSwitchProvider(tmpDir))
    const keys = calls.map(c => c.deduplicationKey).sort()
    expect(keys).toEqual(['cc-switch:p1', 'cc-switch:r1', 'cc-switch:u1'])

    const remote = calls.find(c => c.deduplicationKey === 'cc-switch:r1')!
    expect(remote.model).toBe('claude-opus-5')
    expect(remote.inputTokens).toBe(28284)
    expect(remote.cacheReadInputTokens).toBe(768)
    expect(remote.sessionId).toBe(REMOTE_SESSION)
    expect(remote.project).toBe('cc-switch remote: claude')
    expect(remote.timestamp).toBe(new Date(1789568701 * 1000).toISOString())
  })

  it('deduplicates across repeated parses', async () => {
    writeDb()
    const provider = createCcSwitchProvider(tmpDir)
    const [source] = await provider.discoverSessions()
    const seen = new Set<string>()
    const first = []
    for await (const c of provider.createSessionParser(source!, seen).parse()) first.push(c)
    const second = []
    for await (const c of provider.createSessionParser(source!, seen).parse()) second.push(c)
    expect(first.length).toBeGreaterThan(0)
    expect(second).toHaveLength(0)
  })

  it('reports probeRoots and display names', async () => {
    const provider = createCcSwitchProvider(tmpDir)
    expect(provider.name).toBe('cc-switch')
    expect(provider.displayName).toBe('CC Switch')
    expect(provider.durableSources).toBe(true)
    const roots = await provider.probeRoots!()
    expect(roots).toEqual([{ path: tmpDir, label: 'data dir' }])
  })
})
