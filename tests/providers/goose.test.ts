import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createGooseProvider } from '../../src/providers/goose.js'
import { isSqliteAvailable } from '../../src/sqlite.js'

const requireForTest = createRequire(import.meta.url)

let root: string
const originalRoot = process.env.GOOSE_PATH_ROOT
const originalTz = process.env.TZ

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-goose-'))
  process.env.GOOSE_PATH_ROOT = root
  process.env.TZ = 'America/Los_Angeles'
})

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.GOOSE_PATH_ROOT
  else process.env.GOOSE_PATH_ROOT = originalRoot
  process.env.TZ = originalTz
  await rm(root, { recursive: true, force: true })
})

const sqliteDescribe = isSqliteAvailable() ? describe : describe.skip

sqliteDescribe('Goose timestamps', () => {
  it('reads SQLite CURRENT_TIMESTAMP text as UTC, not local time', async () => {
    const dbPath = join(root, 'data', 'sessions', 'sessions.db')
    await mkdir(dirname(dbPath), { recursive: true })
    const { DatabaseSync } = requireForTest('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
    }
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, created_at TIMESTAMP, updated_at TIMESTAMP,
        accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, provider_name TEXT, model_config_json TEXT);
      CREATE TABLE messages (session_id TEXT, message_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);
      INSERT INTO sessions VALUES ('s1', 't', '/w', '2026-10-01 23:30:00', '2026-10-01 23:30:00', 100, 20, 'openai', '{"model_name":"gpt-5.4"}');
    `)
    db.close()

    const provider = createGooseProvider()
    const timestamps: string[] = []
    for (const source of await provider.discoverSessions()) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) timestamps.push(call.timestamp)
    }

    expect(timestamps).toEqual(['2026-10-01T23:30:00.000Z'])
  })
})
