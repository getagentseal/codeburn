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

  // Billing rungs (a) and (c) plus the token floor for the conversation that
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
