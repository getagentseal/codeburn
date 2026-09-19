import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { DatabaseSync } from 'node:sqlite'

import { createNewApiProvider } from '../../src/providers/new-api.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'newapi-test-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tmpDir, { recursive: true, force: true })
})

function writeDb() {
  const db = new DatabaseSync(join(tmpDir, 'one-api.db'))
  db.exec(`
    CREATE TABLE logs (
      id integer PRIMARY KEY, user_id integer, created_at integer, type integer,
      content text, username text DEFAULT '', token_name text DEFAULT '',
      model_name text DEFAULT '', quota integer DEFAULT 0,
      prompt_tokens integer DEFAULT 0, completion_tokens integer DEFAULT 0,
      use_time integer DEFAULT 0, is_stream numeric, channel_id integer,
      channel_name text, token_id integer DEFAULT 0, "group" text,
      ip text DEFAULT '', request_id varchar(64) DEFAULT '', other text
    );
  `)
  const ins = db.prepare(
    `INSERT INTO logs (id, user_id, created_at, type, username, token_name, token_id, model_name,
                       prompt_tokens, completion_tokens, quota, other)
     VALUES (?, 1, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // Owner's own tokens: excluded once configured.
  ins.run(1, 1789565214, 'mym', 'farm-master', 1, 'swe-2-medium', 1000, 50, 100, null)
  ins.run(2, 1789565215, 'mym', 'farm-master', 1, 'swe-2-medium', 2000, 60, 100, null)
  // A friend's token: counted.
  ins.run(3, 1789565216, 'friend', 'friend-key', 2, 'hy4-preview', 5000, 200, 300,
    JSON.stringify({ cache_tokens: 1200 }))
  // Non-consume type: skipped regardless.
  db.prepare(`INSERT INTO logs (id, created_at, type, username, prompt_tokens, completion_tokens, quota)
              VALUES (4, 1789565217, 3, 'mym', 999, 999, 0)`).run()
  // Zero-usage consume row: skipped.
  ins.run(5, 1789565218, 'friend', 'friend-key', 2, 'hy4-preview', 0, 0, 0, null)
  db.close()
}

async function collect(provider: ReturnType<typeof createNewApiProvider>) {
  const calls: ParsedProviderCall[] = []
  for (const source of await provider.discoverSessions()) {
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe('new-api provider', () => {
  it('discovers nothing when the db path is unset or absent', async () => {
    expect(await createNewApiProvider(join(tmpDir, 'nope.db')).discoverSessions()).toEqual([])
    expect(await createNewApiProvider().discoverSessions()).toEqual([])
  })

  it('accepts either the db file or its directory', async () => {
    writeDb()
    expect(await createNewApiProvider(join(tmpDir, 'one-api.db')).discoverSessions()).toHaveLength(1)
    expect(await createNewApiProvider(tmpDir).discoverSessions()).toHaveLength(1)
  })

  it('emits every consume row when no exclusion is configured', async () => {
    writeDb()
    const calls = await collect(createNewApiProvider(tmpDir))
    expect(calls.map(c => c.deduplicationKey).sort()).toEqual(['new-api:1', 'new-api:2', 'new-api:3'])
  })

  it('skips the operator’s tokens and usernames from env lists', async () => {
    writeDb()
    vi.stubEnv('CODEBURN_NEWAPI_LOCAL_USERS', 'mym')
    vi.stubEnv('CODEBURN_NEWAPI_LOCAL_TOKENS', 'friend-key')
    const calls = await collect(createNewApiProvider(tmpDir))
    expect(calls).toHaveLength(0)
  })

  it('keeps remote rows when only the owner is excluded', async () => {
    writeDb()
    vi.stubEnv('CODEBURN_NEWAPI_LOCAL_USERS', 'mym')
    const calls = await collect(createNewApiProvider(tmpDir))
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('hy4-preview')
    expect(call.inputTokens).toBe(5000)
    expect(call.cacheReadInputTokens).toBe(1200)
    expect(call.sessionId).toBe('token:friend-key')
    expect(call.project).toBe('new-api remote: friend-key')
    expect(call.timestamp).toBe(new Date(1789565216 * 1000).toISOString())
  })

  it('matches token exclusions by token_id too', async () => {
    writeDb()
    vi.stubEnv('CODEBURN_NEWAPI_LOCAL_TOKENS', '2')
    const calls = await collect(createNewApiProvider(tmpDir))
    expect(calls.map(c => c.deduplicationKey).sort()).toEqual(['new-api:1', 'new-api:2'])
  })

  it('reports probeRoots and display names', async () => {
    const provider = createNewApiProvider(tmpDir)
    expect(provider.name).toBe('new-api')
    expect(provider.durableSources).toBe(true)
    const roots = await provider.probeRoots!()
    expect(roots).toHaveLength(1)
  })
})
