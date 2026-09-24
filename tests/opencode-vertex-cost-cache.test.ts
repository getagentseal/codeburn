// #1547: OpenCode 2.x turns routed through Google Vertex (`google-vertex`,
// `google-vertex-anthropic`) record `{"id":"claude-sonnet-5@default", ...}`.
// They must price from tokens like the direct ids, land on a "(Vertex)" row,
// and a turn CodeBurn cannot price must keep the cost OpenCode recorded through
// the session cache, cold and warm, until a catalog row or override prices it.

import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { isSqliteAvailable } from '../src/sqlite.js'
import { modelRowKey, setPriceOverrides } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

const root = join(tmpdir(), `opencode-vertex-cost-${process.pid}-${Date.now()}`)
const DATA_DIR = join(root, 'opencode')
const CACHE_DIR = join(root, 'cache')

// Bundled snapshot rates. Sonnet 5: 2 / 10 / cache write 2.5 / cache read 0.2
// per million; Haiku 4.5: 1 / 5; Gemini 2.5 Pro (<=200k): 1.25 / 10.
const SONNET = 1000 * 2e-6 + 200 * 10e-6 + 10_000 * 0.2e-6 + 500 * 2.5e-6
const HAIKU = 2000 * 1e-6 + 100 * 5e-6
const GEMINI = 1000 * 1.25e-6 + 100 * 10e-6
const RECORDED = 0.37
const tokens = (input: number, output: number, read = 0, write = 0) => ({ input, output, reasoning: 0, cache: { read, write } })

function writeDb(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(join(DATA_DIR, 'opencode.db'))
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  const t0 = Date.UTC(2026, 8, 23, 10, 0, 0)
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('ses_vertex', 'p', 's', '/home/user/proj', 't', '2.0.16', ?, ?)`).run(t0, t0)
  const msg = (id: string, seq: number, model: { id: string; providerID: string }, cost: number, tok: ReturnType<typeof tokens>) =>
    db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, 'ses_vertex', 'assistant', ?, ?, ?, ?)`)
      .run(id, seq, t0 + seq * 1000, t0 + seq * 1000, JSON.stringify({ model, cost, tokens: tok, content: [{ type: 'text', text: 'ok' }] }))
  // Recorded costs on priceable ids are ignored: tokens-first.
  msg('m1', 1, { id: 'claude-sonnet-5@default', providerID: 'google-vertex-anthropic' }, 0.99, tokens(1000, 200, 10_000, 500))
  msg('m2', 2, { id: 'claude-haiku-4-5@default', providerID: 'google-vertex-anthropic' }, 0.99, tokens(2000, 100))
  msg('m3', 3, { id: 'gemini-2.5-pro', providerID: 'google-vertex' }, 0.99, tokens(1000, 100))
  msg('m4', 4, { id: 'vertex-private-model-x@default', providerID: 'google-vertex' }, RECORDED, tokens(1000, 100))
  db.close()
}

async function costByRow(): Promise<Record<string, number>> {
  const rows: Record<string, number> = {}
  for (const project of await parseAllSessions(undefined, 'opencode')) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          const key = modelRowKey(call.model, call.route)
          rows[key] = (rows[key] ?? 0) + call.costUSD
        }
      }
    }
  }
  return rows
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  process.env['OPENCODE_DATA_DIR'] = DATA_DIR
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  mkdirSync(CACHE_DIR, { recursive: true })
  writeDb()
})

afterEach(() => setPriceOverrides({}))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it.skipIf(!isSqliteAvailable())('prices Vertex ids from tokens on a Vertex row and keeps an unpriceable recorded cost cold and warm', async () => {
  clearSessionCache()
  const cold = await costByRow()
  clearSessionCache()
  const warm = await costByRow()

  expect(Object.keys(cold).sort()).toEqual(['Gemini 2.5 Pro (Vertex)', 'Haiku 4.5 (Vertex)', 'Sonnet 5 (Vertex)', 'vertex-private-model-x (Vertex)'])
  expect(cold['Sonnet 5 (Vertex)']).toBeCloseTo(SONNET, 12)
  expect(cold['Haiku 4.5 (Vertex)']).toBeCloseTo(HAIKU, 12)
  expect(cold['Gemini 2.5 Pro (Vertex)']).toBeCloseTo(GEMINI, 12)
  expect(cold['vertex-private-model-x (Vertex)']).toBeCloseTo(RECORDED, 12)
  expect(warm).toEqual(cold)
})

it.skipIf(!isSqliteAvailable())('lets a later price override win over the recorded cost on a warm cache', async () => {
  clearSessionCache()
  await costByRow()
  setPriceOverrides({ 'vertex-private-model-x': { input: 1, output: 2 } })
  clearSessionCache()
  const warm = await costByRow()
  expect(warm['vertex-private-model-x (Vertex)']).toBeCloseTo(1000 * 1e-6 + 100 * 2e-6, 12)
})
