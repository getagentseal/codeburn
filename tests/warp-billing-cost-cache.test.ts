// Warp's cost ladder (src/providers/warp.ts conversationCostUsd) derives real
// dollars from Warp's own billing blob. Warp was absent from the reported-cost
// pass-through in parser.ts providerCallToCachedCall, and since every non-
// Claude/Codex provider's parsed calls reach a report ONLY through
// CachedCall -> cachedCallToApiCall, that dropped the billing figure on the
// cold run too, not just the warm one: every read re-priced Warp from the
// token floor against the aliased LiteLLM model.
//
// Own file because the warp provider resolves its database path from env at
// parse time and these runs must never touch the real group container.

import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { createRequire } from 'node:module'

import { isSqliteAvailable } from '../src/sqlite.js'

const requireForTest = createRequire(import.meta.url)

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/warp-billing-cost-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  return root
})

const CACHE_DIR = join(testRoot, 'cache')
const DB_PATH = join(testRoot, 'warp', 'warp.sqlite')

// 50,000 input tokens of claude-haiku-4-5 at $1/M = $0.05: the token floor
// every conversation below would be priced at without its billing blob.
const TOKEN_FLOOR = 0.05
const CREDIT_USD_RATE = 20 / 1500
const CREDITS = 30
const CREDIT_COST = CREDITS * CREDIT_USD_RATE // $0.40
const PROVIDER_COST = 0.77 // 77 cents, server-authoritative

function tokenUsage() {
  return [{
    model_id: 'Claude Haiku 4.5',
    warp_tokens: 50000,
    byok_tokens: 0,
    warp_token_usage_by_category: { primary_agent: 50000 },
    byok_token_usage_by_category: {},
  }]
}

function writeWarpDb(startTs: string): void {
  const { DatabaseSync } = requireForTest('node:sqlite')
  const db = new DatabaseSync(DB_PATH)
  db.exec(`CREATE TABLE agent_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, conversation_data TEXT NOT NULL, last_modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  db.exec(`CREATE TABLE ai_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id TEXT NOT NULL, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL, working_directory TEXT, output_status TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', planning_model_id TEXT NOT NULL DEFAULT '', coding_model_id TEXT NOT NULL DEFAULT '')`)
  db.exec(`CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, pane_leaf_uuid BLOB NOT NULL, stylized_command BLOB NOT NULL, stylized_output BLOB NOT NULL, exit_code INTEGER NOT NULL, did_execute BOOLEAN NOT NULL, completed_ts DATETIME, start_ts DATETIME, block_id TEXT NOT NULL DEFAULT '', ai_metadata TEXT)`)

  const conversations: [string, unknown][] = [
    ['conv-credits', { credits_spent: CREDITS, token_usage: tokenUsage() }],
    ['conv-provider', { total_provider_cost_in_cents: 77, credits_spent: 0, token_usage: tokenUsage() }],
    ['conv-floor', { token_usage: tokenUsage() }],
  ]
  for (const [id, meta] of conversations) {
    db.prepare('INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?,?,?)')
      .run(id, JSON.stringify({ conversation_usage_metadata: meta }), startTs)
    db.prepare(`INSERT INTO ai_queries (exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id, planning_model_id, coding_model_id) VALUES (?,?,?,?,?,?,?,'','')`)
      .run(`ex-${id}`, id, startTs, JSON.stringify([{ Query: { text: 'do the thing' } }]), '/tmp/warpproj', '"Completed"', 'auto-efficient')
  }
  db.close()
}

beforeEach(async () => {
  process.env['HOME'] = join(testRoot, 'home')
  process.env['USERPROFILE'] = join(testRoot, 'home')
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  process.env['WARP_DB_PATH'] = DB_PATH
  await rm(join(testRoot, 'warp'), { recursive: true, force: true })
  await rm(CACHE_DIR, { recursive: true, force: true })
  await mkdir(join(testRoot, 'warp'), { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
})

afterAll(async () => {
  delete process.env['WARP_DB_PATH']
  await rm(testRoot, { recursive: true, force: true })
})

const itUnlessNoSqlite = isSqliteAvailable() ? it : it.skip

itUnlessNoSqlite('prices a billing-backed Warp conversation the same cold and warm', async () => {
  writeWarpDb('2026-08-16 10:00:00.000000')

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')

  clearSessionCache()
  const cold = await parseAllSessions(undefined, 'warp')
  const coldCost = cold.reduce((sum, p) => sum + p.totalCostUSD, 0)

  // Drop the in-memory cache only: the shard on disk now serves the unchanged
  // database, so this run's cost comes out of cachedCallToApiCall.
  clearSessionCache()
  const warm = await parseAllSessions(undefined, 'warp')
  const warmCost = warm.reduce((sum, p) => sum + p.totalCostUSD, 0)

  // Billing rungs (a) and (d) plus the token floor for the conversation that
  // has no billing blob. Before the fix both runs reported 3 x TOKEN_FLOOR.
  expect(coldCost).toBeCloseTo(CREDIT_COST + PROVIDER_COST + TOKEN_FLOOR, 10)
  expect(warmCost).toBeCloseTo(coldCost, 10)
  expect(coldCost).not.toBeCloseTo(3 * TOKEN_FLOOR, 4)
})

itUnlessNoSqlite('persists only the billing-derived cost, leaving the token floor re-priceable', async () => {
  writeWarpDb('2026-08-16 10:00:00.000000')

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
  const { loadCache } = await import('../src/session-cache.js')

  clearSessionCache()
  await parseAllSessions(undefined, 'warp')

  const cache = await loadCache()
  const costByKey = new Map<string, number | undefined>()
  for (const file of Object.values(cache.providers['warp']?.files ?? {})) {
    for (const turn of file.turns) {
      for (const call of turn.calls) costByKey.set(call.deduplicationKey, call.costUSD)
    }
  }

  // Cost stored => frozen at the billed amount, never re-priced from tokens.
  expect(costByKey.get('warp:conv-credits:ex-conv-credits')).toBeCloseTo(CREDIT_COST, 10)
  expect(costByKey.get('warp:conv-provider:ex-conv-provider')).toBeCloseTo(PROVIDER_COST, 10)
  // No cost stored => cachedCallToApiCall re-prices it from the cached tokens
  // on every read, so a LiteLLM price update still reaches this call.
  expect(costByKey.has('warp:conv-floor:ex-conv-floor')).toBe(true)
  expect(costByKey.get('warp:conv-floor:ex-conv-floor')).toBeUndefined()
})

itUnlessNoSqlite('puts a conversation\'s later spend on the new exchange, not back on earlier days', async () => {
  const { DatabaseSync } = requireForTest('node:sqlite')
  const db = new DatabaseSync(DB_PATH)
  db.exec(`CREATE TABLE agent_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, conversation_data TEXT NOT NULL, last_modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  db.exec(`CREATE TABLE ai_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id TEXT NOT NULL, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL, working_directory TEXT, output_status TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', planning_model_id TEXT NOT NULL DEFAULT '', coding_model_id TEXT NOT NULL DEFAULT '')`)
  db.exec(`CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, pane_leaf_uuid BLOB NOT NULL, stylized_command BLOB NOT NULL, stylized_output BLOB NOT NULL, exit_code INTEGER NOT NULL, did_execute BOOLEAN NOT NULL, completed_ts DATETIME, start_ts DATETIME, block_id TEXT NOT NULL DEFAULT '', ai_metadata TEXT)`)
  const conversation = (credits: number) => JSON.stringify({ conversation_usage_metadata: { credits_spent: credits, token_usage: tokenUsage() } })
  const exchange = (id: string, startTs: string, text: string) => db.prepare(`INSERT INTO ai_queries (exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id) VALUES (?,?,?,?,?,?,?)`)
    .run(id, 'conv', startTs, JSON.stringify([{ Query: { text } }]), '/tmp/warpproj', '"Completed"', 'auto-efficient')
  db.prepare('INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?,?,?)').run('conv', conversation(750), '2026-08-16 10:00:00')
  exchange('a', '2026-08-16 10:00:00.000000', 'x'.repeat(400))
  exchange('b', '2026-08-16 11:00:00.000000', 'x'.repeat(400))

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
  const { loadCache } = await import('../src/session-cache.js')
  const cachedCosts = async () => {
    const out = new Map<string, number | undefined>()
    for (const file of Object.values((await loadCache()).providers['warp']?.files ?? {})) {
      for (const turn of file.turns) for (const call of turn.calls) out.set(call.deduplicationKey, call.costUSD)
    }
    return out
  }
  clearSessionCache()
  await parseAllSessions(undefined, 'warp')
  const day1 = await cachedCosts()

  // Next day: a short prompt that costs 375 more credits.
  db.prepare('UPDATE agent_conversations SET conversation_data = ? WHERE conversation_id = ?').run(conversation(1125), 'conv')
  exchange('c', '2026-08-17 10:00:00.000000', 'x'.repeat(40))
  db.close()
  clearSessionCache()
  await parseAllSessions(undefined, 'warp')
  const day2 = await cachedCosts()

  expect(day2.get('warp:conv:a')).toBeCloseTo(day1.get('warp:conv:a')!, 10)
  expect(day2.get('warp:conv:b')).toBeCloseTo(day1.get('warp:conv:b')!, 10)
  expect(day2.get('warp:conv:c')).toBeCloseTo(375 * CREDIT_USD_RATE, 10)
})

itUnlessNoSqlite('keeps each conversation\'s growth on its own new exchanges', async () => {
  const { DatabaseSync } = requireForTest('node:sqlite')
  const db = new DatabaseSync(DB_PATH)
  db.exec(`CREATE TABLE agent_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, conversation_data TEXT NOT NULL, last_modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  db.exec(`CREATE TABLE ai_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id TEXT NOT NULL, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL, working_directory TEXT, output_status TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', planning_model_id TEXT NOT NULL DEFAULT '', coding_model_id TEXT NOT NULL DEFAULT '')`)
  db.exec(`CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, pane_leaf_uuid BLOB NOT NULL, stylized_command BLOB NOT NULL, stylized_output BLOB NOT NULL, exit_code INTEGER NOT NULL, did_execute BOOLEAN NOT NULL, completed_ts DATETIME, start_ts DATETIME, block_id TEXT NOT NULL DEFAULT '', ai_metadata TEXT)`)
  const data = (credits: number) => JSON.stringify({ conversation_usage_metadata: { credits_spent: credits, token_usage: tokenUsage() } })
  const setCredits = (id: string, credits: number) => db.prepare('UPDATE agent_conversations SET conversation_data = ? WHERE conversation_id = ?').run(data(credits), id)
  const exchange = (conv: string, id: string, startTs: string) => db.prepare(`INSERT INTO ai_queries (exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id) VALUES (?,?,?,?,?,?,?)`)
    .run(id, conv, startTs, JSON.stringify([{ Query: { text: 'x'.repeat(400) } }]), '/tmp/warpproj', '"Completed"', 'auto-efficient')
  for (const conv of ['grows', 'flat']) {
    db.prepare('INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?,?,?)').run(conv, data(750), '2026-08-16 10:00:00')
    exchange(conv, `${conv}-a`, '2026-08-16 10:00:00.000000')
  }

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
  const { loadCache } = await import('../src/session-cache.js')
  const cachedCosts = async () => {
    const out = new Map<string, number | undefined>()
    for (const file of Object.values((await loadCache()).providers['warp']?.files ?? {})) {
      for (const turn of file.turns) for (const call of turn.calls) out.set(call.deduplicationKey, call.costUSD)
    }
    return out
  }
  clearSessionCache()
  await parseAllSessions(undefined, 'warp')

  // Both gain an exchange the next day; only 'grows' gained billed credits.
  setCredits('grows', 1125)
  exchange('grows', 'grows-b', '2026-08-17 10:00:00.000000')
  exchange('flat', 'flat-b', '2026-08-17 10:00:00.000000')
  db.close()
  clearSessionCache()
  await parseAllSessions(undefined, 'warp')
  const costs = await cachedCosts()

  expect(costs.get('warp:grows:grows-a')).toBeCloseTo(750 * CREDIT_USD_RATE, 10)
  expect(costs.get('warp:grows:grows-b')).toBeCloseTo(375 * CREDIT_USD_RATE, 10)
  expect(costs.get('warp:flat:flat-a')).toBeCloseTo(750 * CREDIT_USD_RATE, 10)
  expect(costs.get('warp:flat:flat-b')).toBeCloseTo(0, 10)
})

for (const [label, credits] of [['an unchanged total', 225], ['a smaller total', 150]] as const) {
  itUnlessNoSqlite(`splits ${label} fresh when a cached exchange disappears`, async () => {
    const { DatabaseSync } = requireForTest('node:sqlite')
    const db = new DatabaseSync(DB_PATH)
    db.exec(`CREATE TABLE agent_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, conversation_data TEXT NOT NULL, last_modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    db.exec(`CREATE TABLE ai_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id TEXT NOT NULL, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL, working_directory TEXT, output_status TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', planning_model_id TEXT NOT NULL DEFAULT '', coding_model_id TEXT NOT NULL DEFAULT '')`)
    db.exec(`CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, pane_leaf_uuid BLOB NOT NULL, stylized_command BLOB NOT NULL, stylized_output BLOB NOT NULL, exit_code INTEGER NOT NULL, did_execute BOOLEAN NOT NULL, completed_ts DATETIME, start_ts DATETIME, block_id TEXT NOT NULL DEFAULT '', ai_metadata TEXT)`)
    const data = (c: number) => JSON.stringify({ conversation_usage_metadata: { credits_spent: c, token_usage: tokenUsage() } })
    db.prepare('INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?,?,?)').run('conv', data(225), '2026-08-16 10:00:00')
    for (const id of ['a', 'b', 'c']) {
      db.prepare(`INSERT INTO ai_queries (exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id) VALUES (?,?,?,?,?,?,?)`)
        .run(id, 'conv', `2026-08-16 1${['a', 'b', 'c'].indexOf(id)}:00:00.000000`, JSON.stringify([{ Query: { text: 'x'.repeat(400) } }]), '/tmp/warpproj', '"Completed"', 'auto-efficient')
    }

    const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
    const { loadCache } = await import('../src/session-cache.js')
    const cachedCosts = async () => {
      const out = new Map<string, number | undefined>()
      for (const file of Object.values((await loadCache()).providers['warp']?.files ?? {})) {
        for (const turn of file.turns) for (const call of turn.calls) out.set(call.deduplicationKey, call.costUSD)
      }
      return out
    }
    clearSessionCache()
    await parseAllSessions(undefined, 'warp')
    expect((await cachedCosts()).get('warp:conv:a')).toBeCloseTo(75 * CREDIT_USD_RATE, 10)

    db.prepare("DELETE FROM ai_queries WHERE exchange_id = 'c'").run()
    db.prepare('UPDATE agent_conversations SET conversation_data = ? WHERE conversation_id = ?').run(data(credits), 'conv')
    db.close()
    clearSessionCache()
    await parseAllSessions(undefined, 'warp')
    const costs = await cachedCosts()
    expect(costs.get('warp:conv:a')).toBeCloseTo((credits / 2) * CREDIT_USD_RATE, 10)
    expect(costs.get('warp:conv:b')).toBeCloseTo((credits / 2) * CREDIT_USD_RATE, 10)
    expect(costs.has('warp:conv:c')).toBe(false)
  })
}

itUnlessNoSqlite('allocates two conversations in one database independently', async () => {
  const { DatabaseSync } = requireForTest('node:sqlite')
  const db = new DatabaseSync(DB_PATH)
  db.exec(`CREATE TABLE agent_conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, conversation_data TEXT NOT NULL, last_modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  db.exec(`CREATE TABLE ai_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id TEXT NOT NULL, conversation_id TEXT NOT NULL, start_ts DATETIME NOT NULL, input TEXT NOT NULL, working_directory TEXT, output_status TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', planning_model_id TEXT NOT NULL DEFAULT '', coding_model_id TEXT NOT NULL DEFAULT '')`)
  db.exec(`CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, pane_leaf_uuid BLOB NOT NULL, stylized_command BLOB NOT NULL, stylized_output BLOB NOT NULL, exit_code INTEGER NOT NULL, did_execute BOOLEAN NOT NULL, completed_ts DATETIME, start_ts DATETIME, block_id TEXT NOT NULL DEFAULT '', ai_metadata TEXT)`)
  const usd = (dollars: number) => JSON.stringify({ conversation_usage_metadata: { credits_spent: dollars / CREDIT_USD_RATE, token_usage: tokenUsage() } })
  const exchange = (conv: string, id: string, startTs: string) => db.prepare(`INSERT INTO ai_queries (exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id) VALUES (?,?,?,?,?,?,?)`)
    .run(id, conv, startTs, JSON.stringify([{ Query: { text: 'x'.repeat(400) } }]), '/tmp/warpproj', '"Completed"', 'auto-efficient')
  for (const conv of ['A', 'B']) {
    db.prepare('INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?,?,?)').run(conv, usd(7.5), '2026-08-16 10:00:00')
    exchange(conv, `${conv}1`, '2026-08-16 10:00:00.000000')
  }

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
  const { loadCache } = await import('../src/session-cache.js')
  clearSessionCache()
  await parseAllSessions(undefined, 'warp')

  // A gains $3.75 and an exchange; B gains an exchange that spent nothing.
  db.prepare('UPDATE agent_conversations SET conversation_data = ? WHERE conversation_id = ?').run(usd(11.25), 'A')
  exchange('A', 'A2', '2026-08-17 10:00:00.000000')
  exchange('B', 'B2', '2026-08-17 10:00:00.000000')
  db.close()
  clearSessionCache()
  await parseAllSessions(undefined, 'warp')

  const files = (await loadCache()).providers['warp']!.files
  expect(Object.keys(files).sort()).toEqual([`${DB_PATH}:A`, `${DB_PATH}:B`])
  const costs = new Map(Object.values(files).flatMap(f => f.turns.flatMap(t => t.calls)).map(c => [c.deduplicationKey, c.costUSD]))
  expect(costs.get('warp:A:A1')).toBeCloseTo(7.5, 10)
  expect(costs.get('warp:A:A2')).toBeCloseTo(3.75, 10)
  expect(costs.get('warp:B:B1')).toBeCloseTo(7.5, 10)
  expect(costs.get('warp:B:B2')).toBeCloseTo(0, 10)
})
