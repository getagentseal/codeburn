import { mkdtemp, rm } from 'fs/promises'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWarpProvider } from '../../src/providers/warp.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

type QueryFixture = {
  exchangeId: string
  conversationId: string
  startTs: string
  input: string
  outputStatus?: string
  modelId?: string
  workingDirectory?: string | null
}

type BlockFixture = {
  blockId: string
  conversationId: string
  startTs: string
  completedTs: string
  exitCode: number
  command: string
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'warp-provider-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function createWarpDb(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'warp.sqlite')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      conversation_data TEXT NOT NULL,
      last_modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      start_ts DATETIME NOT NULL,
      input TEXT NOT NULL,
      working_directory TEXT,
      output_status TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      planning_model_id TEXT NOT NULL DEFAULT '',
      coding_model_id TEXT NOT NULL DEFAULT ''
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pane_leaf_uuid BLOB NOT NULL,
      stylized_command BLOB NOT NULL,
      stylized_output BLOB NOT NULL,
      pwd TEXT,
      git_branch TEXT,
      virtual_env TEXT,
      conda_env TEXT,
      exit_code INTEGER NOT NULL,
      did_execute BOOLEAN NOT NULL,
      completed_ts DATETIME,
      start_ts DATETIME,
      ps1 TEXT,
      honor_ps1 BOOLEAN NOT NULL DEFAULT 0,
      shell TEXT,
      user TEXT,
      host TEXT,
      is_background BOOLEAN NOT NULL DEFAULT 0,
      rprompt TEXT,
      prompt_snapshot TEXT,
      block_id TEXT NOT NULL DEFAULT '',
      ai_metadata TEXT,
      is_local BOOLEAN,
      agent_view_visibility TEXT,
      git_branch_name TEXT
    )
  `)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function insertConversation(
  db: TestDb,
  conversationId: string,
  conversationData: unknown,
  lastModifiedAt = '2026-05-18 10:10:00',
): void {
  db.prepare(
    'INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?, ?, ?)',
  ).run(conversationId, JSON.stringify(conversationData), lastModifiedAt)
}

function insertQuery(db: TestDb, q: QueryFixture): void {
  db.prepare(
    `INSERT INTO ai_queries (
      exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id, planning_model_id, coding_model_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '')`,
  ).run(
    q.exchangeId,
    q.conversationId,
    q.startTs,
    q.input,
    q.workingDirectory ?? null,
    q.outputStatus ?? '"Completed"',
    q.modelId ?? 'auto-efficient',
  )
}

function insertBlock(db: TestDb, b: BlockFixture): void {
  db.prepare(
    `INSERT INTO blocks (
      pane_leaf_uuid, stylized_command, stylized_output, exit_code, did_execute,
      completed_ts, start_ts, block_id, ai_metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Buffer.from([0]),
    b.command,
    '',
    b.exitCode,
    1,
    b.completedTs,
    b.startTs,
    b.blockId,
    JSON.stringify({
      requested_command_action_id: `call-${b.blockId}`,
      conversation_id: b.conversationId,
    }),
  )
}

async function collectCalls(
  dbPath: string,
  conversationId: string,
  seenKeys = new Set<string>(),
): Promise<ParsedProviderCall[]> {
  const provider = createWarpProvider(dbPath)
  const source = {
    path: `${dbPath}:${conversationId}`,
    project: 'warp',
    provider: 'warp',
  }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('warp provider', () => {
  it('discovers sessions and sanitizes project names from working_directory', async () => {
    const dbPath = createWarpDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertConversation(db, 'conv-1', { conversation_usage_metadata: { token_usage: [] } })
      insertQuery(db, {
        exchangeId: 'ex-1',
        conversationId: 'conv-1',
        startTs: '2026-05-18 10:00:00.000000',
        input: '[]',
        workingDirectory: '/Users/test/project-a',
      })
    })

    const provider = createWarpProvider(dbPath)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('warp')
    expect(sessions[0]!.path).toBe(`${dbPath}:conv-1`)
    expect(sessions[0]!.project).toBe('Users-test-project-a')
  })

  it('parses one call per completed exchange and estimates tokens from primary-agent totals', async () => {
    const dbPath = createWarpDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertConversation(db, 'conv-1', {
        conversation_usage_metadata: {
          token_usage: [
            {
              model_id: 'GPT-5.3 Codex (medium reasoning)',
              warp_tokens: 300,
              byok_tokens: 0,
              warp_token_usage_by_category: { primary_agent: 300 },
              byok_token_usage_by_category: {},
            },
            {
              model_id: 'Claude Haiku 4.5',
              warp_tokens: 90,
              byok_tokens: 0,
              warp_token_usage_by_category: { full_terminal_use: 90 },
              byok_token_usage_by_category: {},
            },
          ],
        },
      })
      insertQuery(db, {
        exchangeId: 'ex-1',
        conversationId: 'conv-1',
        startTs: '2026-05-18 10:00:00.000000',
        input: JSON.stringify([{ Query: { text: 'short prompt' } }]),
        modelId: 'auto-efficient',
        workingDirectory: '/Users/test/project-a',
      })
      insertQuery(db, {
        exchangeId: 'ex-2',
        conversationId: 'conv-1',
        startTs: '2026-05-18 10:03:00.000000',
        input: JSON.stringify([{ Query: { text: 'longer prompt with substantially more detail for weighting' } }]),
        modelId: 'auto-efficient',
        workingDirectory: '/Users/test/project-a',
      })
    })

    const calls = await collectCalls(dbPath, 'conv-1')
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.deduplicationKey)).toEqual([
      'warp:conv-1:ex-1',
      'warp:conv-1:ex-2',
    ])
    expect(calls.map(call => call.userMessage)).toEqual([
      'short prompt',
      'longer prompt with substantially more detail for weighting',
    ])
    expect(calls.every(call => call.model === 'gpt-5.3-codex')).toBe(true)
    expect(calls.every(call => call.costIsEstimated === true)).toBe(true)
    expect(calls.reduce((sum, call) => sum + call.inputTokens, 0)).toBe(300)
    expect(calls[1]!.inputTokens).toBeGreaterThan(calls[0]!.inputTokens)
    expect(calls[0]!.projectPath).toBe('/Users/test/project-a')
    expect(calls[0]!.project).toBe('Users-test-project-a')
  })

  it('attributes command blocks to the nearest preceding exchange and extracts Bash commands', async () => {
    const dbPath = createWarpDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertConversation(db, 'conv-2', {
        conversation_usage_metadata: {
          token_usage: [
            {
              model_id: 'GPT-5.3 Codex (medium reasoning)',
              warp_tokens: 120,
              byok_tokens: 0,
              warp_token_usage_by_category: { primary_agent: 120 },
              byok_token_usage_by_category: {},
            },
          ],
        },
      })
      insertQuery(db, {
        exchangeId: 'ex-a',
        conversationId: 'conv-2',
        startTs: '2026-05-18 11:00:00.000000',
        input: JSON.stringify([{ Query: { text: 'run tests' } }]),
      })
      insertQuery(db, {
        exchangeId: 'ex-b',
        conversationId: 'conv-2',
        startTs: '2026-05-18 11:05:00.000000',
        input: JSON.stringify([{ Query: { text: 'summarize results' } }]),
      })
      insertBlock(db, {
        blockId: 'block-1',
        conversationId: 'conv-2',
        startTs: '2026-05-18 11:01:00.000000',
        completedTs: '2026-05-18 11:01:04.000000',
        exitCode: 0,
        command: 'npm test && git status',
      })
    })

    const calls = await collectCalls(dbPath, 'conv-2')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.tools).toEqual(['Bash'])
    expect(calls[0]!.bashCommands).toEqual(['npm', 'git'])
    expect(calls[1]!.tools).toEqual([])
    expect(calls[1]!.bashCommands).toEqual([])
  })

  it('skips pending or invalid exchanges and does not poison seenKeys for skipped rows', async () => {
    const dbPath = createWarpDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertConversation(db, 'conv-3', {
        conversation_usage_metadata: {
          token_usage: [
            {
              model_id: 'GPT-5.3 Codex (medium reasoning)',
              warp_tokens: 42,
              byok_tokens: 0,
              warp_token_usage_by_category: { primary_agent: 42 },
              byok_token_usage_by_category: {},
            },
          ],
        },
      })
      insertQuery(db, {
        exchangeId: 'ex-skip-seen',
        conversationId: 'conv-3',
        startTs: '2026-05-18 12:00:00.000000',
        input: JSON.stringify([{ Query: { text: 'already seen' } }]),
      })
      insertQuery(db, {
        exchangeId: 'ex-pending',
        conversationId: 'conv-3',
        startTs: '2026-05-18 12:01:00.000000',
        input: JSON.stringify([{ Query: { text: 'still running' } }]),
        outputStatus: '"Pending"',
      })
      insertQuery(db, {
        exchangeId: 'ex-invalid-ts',
        conversationId: 'conv-3',
        startTs: 'not-a-timestamp',
        input: JSON.stringify([{ Query: { text: 'bad timestamp' } }]),
      })
    })

    const seen = new Set<string>(['warp:conv-3:ex-skip-seen'])
    const calls = await collectCalls(dbPath, 'conv-3', seen)
    expect(calls).toEqual([])
    expect(seen.has('warp:conv-3:ex-invalid-ts')).toBe(false)
    expect(seen.has('warp:conv-3:ex-pending')).toBe(false)
  })

  // $0.013333 per credit: 1,500 credits for $20 (warp.dev/pricing Build/Business
  // allotment). Mirror src/providers/warp.ts CREDIT_USD_RATE.
  const CREDIT_USD_RATE = 20 / 1500

  it('prices conversation from credits_spent, not the token estimate', async () => {
    const dbPath = createWarpDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertConversation(db, 'conv-credits', {
        conversation_usage_metadata: {
          credits_spent: 1.44165,
          token_usage: [
            {
              model_id: 'Claude Haiku 4.5',
              warp_tokens: 51385,
              byok_tokens: 0,
              warp_token_usage_by_category: { primary_agent: 51385 },
              byok_token_usage_by_category: {},
            },
          ],
        },
      })
      insertQuery(db, {
        exchangeId: 'ex-1',
        conversationId: 'conv-credits',
        startTs: '2026-05-18 10:00:00.000000',
        input: JSON.stringify([{ Query: { text: 'do the thing' } }]),
      })
    })

    const calls = await collectCalls(dbPath, 'conv-credits')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('claude-haiku-4-5')
    const totalCost = calls.reduce((sum, call) => sum + call.costUSD, 0)
    // credits × rate ≈ $0.01922, well below the ~$0.0514 token-input floor.
    expect(totalCost).toBeCloseTo(1.44165 * CREDIT_USD_RATE, 6)
    expect(totalCost).toBeLessThan(0.03)
    expect(calls[0]!.costIsEstimated).toBe(true)
    // Tokens still reported as-is for display.
    expect(calls[0]!.inputTokens).toBe(51385)
  })

  it('prefers server-authoritative total_provider_cost_in_cents over credits', async () => {
    const dbPath = createWarpDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertConversation(db, 'conv-provider', {
        conversation_usage_metadata: {
          total_provider_cost_in_cents: 2.5,
          credits_spent: 1.44165,
          token_usage: [
            {
              model_id: 'Claude Haiku 4.5',
              warp_tokens: 51385,
              byok_tokens: 0,
              warp_token_usage_by_category: { primary_agent: 51385 },
              byok_token_usage_by_category: {},
            },
          ],
        },
      })
      insertQuery(db, {
        exchangeId: 'ex-1',
        conversationId: 'conv-provider',
        startTs: '2026-05-18 10:00:00.000000',
        input: JSON.stringify([{ Query: { text: 'do the thing' } }]),
      })
    })

    const calls = await collectCalls(dbPath, 'conv-provider')
    expect(calls).toHaveLength(1)
    const totalCost = calls.reduce((sum, call) => sum + call.costUSD, 0)
    expect(totalCost).toBeCloseTo(0.025, 6)
    expect(calls[0]!.costIsEstimated).toBe(false)
  })

  it('sums total_charged_usage cents when provider cost is absent', async () => {
    const dbPath = createWarpDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertConversation(db, 'conv-charged', {
        conversation_usage_metadata: {
          credits_spent: 1.44165,
          total_charged_usage: {
            input_cost_in_cents: 1.0,
            output_cost_in_cents: 2.0,
            input_cache_read_cost_in_cents: 0.5,
            platform_cost_in_cents: 0.5,
            web_search_cost_in_cents: 1.0,
          },
          token_usage: [
            {
              model_id: 'Claude Haiku 4.5',
              warp_tokens: 51385,
              byok_tokens: 0,
              warp_token_usage_by_category: { primary_agent: 51385 },
              byok_token_usage_by_category: {},
            },
          ],
        },
      })
      insertQuery(db, {
        exchangeId: 'ex-1',
        conversationId: 'conv-charged',
        startTs: '2026-05-18 10:00:00.000000',
        input: JSON.stringify([{ Query: { text: 'do the thing' } }]),
      })
    })

    const calls = await collectCalls(dbPath, 'conv-charged')
    expect(calls).toHaveLength(1)
    const totalCost = calls.reduce((sum, call) => sum + call.costUSD, 0)
    // (1 + 2 + 0.5 + 0.5 + 1) cents = 5 cents = $0.05.
    expect(totalCost).toBeCloseTo(0.05, 6)
    expect(calls[0]!.costIsEstimated).toBe(false)
  })
})
