import { join } from 'path'
import { homedir } from 'os'

import { extractBashCommands } from '../bash-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import { blobToText, getSqliteLoadError, isBlockedDatabaseError, isSqliteAvailable, isSqliteBusyError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type { ProbeRoot, ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'
import { isPermissionError, safeNumber } from '../parser.js'

const WARP_GROUP_CONTAINER = '2BBY89MBSN.dev.warp'
const WARP_STABLE_BUNDLE_ID = 'dev.warp.Warp-Stable'
const WARP_PREVIEW_BUNDLE_ID = 'dev.warp.Warp-Preview'
const PRIMARY_AGENT_CATEGORY = 'primary_agent'
// Warp bills agent usage in credits, not tokens. Warp's published pricing sets
// the base rate at 1,500 credits for $20 (the Build/Business monthly allotment,
// described on warp.dev/pricing as "$20 of included agent usage at API rates"),
// i.e. $0.013333 per credit. Warp's authoritative per-account rate lives
// server-side in `payg_cost_per_thousand_credits_cents` / `AddonCreditsOption`
// (github.com/warpdotdev/warp, crates/graphql/src/api/billing.rs) and is NOT
// shipped as a client constant, so the published allotment rate is the best
// public evidence available.
// ponytail: fixed public rate; the real per-account PAYG rate varies with
// volume discounts. CONFIRM against Warp's current published pricing.
const CREDIT_USD_RATE = 20 / 1500 // $0.013333 per credit ($13.33 / 1000 credits)
const modelAliases: Record<string, string> = {
  'Claude Sonnet 4.6': 'claude-sonnet-4-6',
  'Claude Sonnet 4.5': 'claude-sonnet-4-5',
  'Claude Haiku 4.5': 'claude-haiku-4-5',
  'Claude Opus 4.6': 'claude-opus-4-6',
  'GPT-5.3 Codex (low reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (medium reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (high reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (extra high reasoning)': 'gpt-5.3-codex',
  'auto-efficient': 'warp-auto-efficient',
  'auto-powerful': 'warp-auto-powerful',
}

type WarpConversationRow = {
  conversation_id: string
  conversation_data: string
  last_modified_at: string | null
}

type WarpQueryRow = {
  exchange_id: string
  conversation_id: string
  start_ts: string
  input: string
  working_directory: string | null
  output_status: string
  model_id: string
  planning_model_id: string
  coding_model_id: string
}

type WarpBlockRow = {
  block_id: string
  start_ts: string | null
  stylized_command: Uint8Array | string | null
}

type WarpTokenUsageEntry = {
  model_id?: string
  warp_tokens?: number
  byok_tokens?: number
  warp_token_usage_by_category?: Record<string, unknown>
  byok_token_usage_by_category?: Record<string, unknown>
}

// Warp's ChargedUsageTotals (crates/persistence/src/model.rs): per-category
// dollar breakdown Warp actually charged. total_cost_in_cents() sums these six
// *_cost_in_cents fields.
type WarpChargedUsageTotals = {
  input_cost_in_cents?: number
  output_cost_in_cents?: number
  input_cache_read_cost_in_cents?: number
  input_cache_write_cost_in_cents?: number
  platform_cost_in_cents?: number
  web_search_cost_in_cents?: number
}

type WarpConversationData = {
  conversation_usage_metadata?: {
    token_usage?: WarpTokenUsageEntry[]
    // Server-authoritative cumulative provider cost, in US cents. Absent (not 0)
    // when the server never provided it.
    total_provider_cost_in_cents?: number
    // Cumulative per-category charged usage across the conversation, in cents.
    total_charged_usage?: WarpChargedUsageTotals
    // Credits Warp deducted for the conversation (always populated today).
    credits_spent?: number
  }
}

type WarpCost = { usd: number; estimated: boolean }

type ParsedExchange = WarpQueryRow & {
  startMs: number
}

type ExchangeToolInfo = {
  tools: string[]
  bashCommands: string[]
}

function sanitizeProject(path: string): string {
  return path.replace(/^\/+/, '').replace(/\//g, '-')
}

function warpDbPath(bundleId: string): string {
  return join(
    homedir(),
    'Library',
    'Group Containers',
    WARP_GROUP_CONTAINER,
    'Library',
    'Application Support',
    bundleId,
    'warp.sqlite',
  )
}

function getDbCandidates(dbPathOverride?: string): string[] {
  if (dbPathOverride) return [dbPathOverride]
  if (process.env['WARP_DB_PATH']) return [process.env['WARP_DB_PATH']]
  return [warpDbPath(WARP_STABLE_BUNDLE_ID), warpDbPath(WARP_PREVIEW_BUNDLE_ID)]
}

function normalizeModel(rawModel: string): string {
  const model = rawModel.trim()
  if (!model) return model
  return modelAliases[model] ?? model
}

function modelDisplayName(model: string): string {
  if (model === 'warp-auto-efficient') return 'Warp Auto (efficient)'
  if (model === 'warp-auto-powerful') return 'Warp Auto (powerful)'
  return getShortModelName(model)
}

function parseTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withT = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const lastPlus = withT.lastIndexOf('+')
  const lastMinus = withT.lastIndexOf('-')
  const hasOffset = lastPlus > 9 || lastMinus > 9
  const hasTimezone = withT.endsWith('Z') || hasOffset
  const normalized = hasTimezone ? withT : `${withT}Z`
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

function parseJsonString(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw
  }
}

function isFinalStatus(rawStatus: string): boolean {
  const status = parseJsonString(rawStatus)
  return status === 'Completed' || status === 'Cancelled' || status === 'Failed'
}

function extractCategoryTokens(categories: Record<string, unknown> | undefined, key: string): number {
  if (!categories) return 0
  return safeNumber(categories[key])
}

function extractTokenBudget(rawConversationData: string): { tokenBudget: number; dominantModel: string } {
  let conversationData: WarpConversationData
  try {
    conversationData = JSON.parse(rawConversationData) as WarpConversationData
  } catch {
    return { tokenBudget: 0, dominantModel: '' }
  }

  const entries = conversationData.conversation_usage_metadata?.token_usage ?? []
  let primaryTotal = 0
  let fallbackTotal = 0
  let dominantPrimaryTokens = 0
  let dominantFallbackTokens = 0
  let dominantModel = ''

  for (const entry of entries) {
    const primaryTokens =
      extractCategoryTokens(entry.warp_token_usage_by_category, PRIMARY_AGENT_CATEGORY) +
      extractCategoryTokens(entry.byok_token_usage_by_category, PRIMARY_AGENT_CATEGORY)
    const entryTotal = safeNumber(entry.warp_tokens) + safeNumber(entry.byok_tokens)

    primaryTotal += primaryTokens
    fallbackTotal += entryTotal

    if (primaryTokens > dominantPrimaryTokens) {
      dominantPrimaryTokens = primaryTokens
      dominantModel = typeof entry.model_id === 'string' ? entry.model_id : dominantModel
    }

    if (dominantPrimaryTokens === 0 && entryTotal > dominantFallbackTokens) {
      dominantFallbackTokens = entryTotal
      dominantModel = typeof entry.model_id === 'string' ? entry.model_id : dominantModel
    }
  }

  const tokenBudget = primaryTotal > 0 ? primaryTotal : fallbackTotal
  return { tokenBudget: Math.max(0, Math.round(tokenBudget)), dominantModel: normalizeModel(dominantModel) }
}

// Warp records what it actually charged in the same blob as the token counts.
// Prefer those real dollars over the token-floor estimate. Ladder, most to
// least authoritative:
//   (a) total_provider_cost_in_cents  — server-authoritative USD  (exact)
//   (b) sum of total_charged_usage    — server per-category USD   (exact)
//   (c) credits_spent × CREDIT_USD_RATE — credits at published rate (heuristic)
//   (d) null → caller falls back to the token × LiteLLM estimate  (floor)
// A value of 0/absent at a rung is treated as "not recorded here" and defers to
// the next rung, so a zero never masks a real cost recorded elsewhere.
function conversationCostUsd(rawConversationData: string): WarpCost | null {
  let meta: WarpConversationData['conversation_usage_metadata']
  try {
    meta = (JSON.parse(rawConversationData) as WarpConversationData).conversation_usage_metadata
  } catch {
    return null
  }
  if (!meta) return null

  const providerCents = safeNumber(meta.total_provider_cost_in_cents)
  if (providerCents > 0) return { usd: providerCents / 100, estimated: false }

  const charged = meta.total_charged_usage
  if (charged) {
    const cents =
      safeNumber(charged.input_cost_in_cents) +
      safeNumber(charged.output_cost_in_cents) +
      safeNumber(charged.input_cache_read_cost_in_cents) +
      safeNumber(charged.input_cache_write_cost_in_cents) +
      safeNumber(charged.platform_cost_in_cents) +
      safeNumber(charged.web_search_cost_in_cents)
    if (cents > 0) return { usd: cents / 100, estimated: false }
  }

  const credits = safeNumber(meta.credits_spent)
  if (credits > 0) return { usd: credits * CREDIT_USD_RATE, estimated: true }

  return null
}

// Split a conversation-level USD total across exchanges by the same char-based
// weights used to split tokens, so per-exchange cost tracks per-exchange size.
function allocateCost(weights: number[], totalUsd: number): number[] {
  if (weights.length === 0) return []
  if (!(totalUsd > 0)) return weights.map(() => 0)
  const normalized = weights.map(w => Math.max(0, w))
  const totalWeight = normalized.reduce((sum, w) => sum + w, 0)
  if (totalWeight === 0) return normalized.map(() => totalUsd / normalized.length)
  return normalized.map(w => (totalUsd * w) / totalWeight)
}

function extractUserMessage(rawInput: string): string {
  try {
    const parsed = JSON.parse(rawInput) as unknown
    if (!Array.isArray(parsed)) return ''
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const query = (item as { Query?: { text?: unknown } }).Query
      if (!query || typeof query !== 'object') continue
      if (typeof query.text === 'string' && query.text.trim()) return query.text
    }
    return ''
  } catch {
    return ''
  }
}

function estimateWeight(rawInput: string): number {
  const userMessage = extractUserMessage(rawInput)
  const source = userMessage || rawInput
  const tokens = estimateTokensFromChars(source.length)
  return Math.max(1, tokens)
}

function allocateTokens(weights: number[], tokenBudget: number): number[] {
  if (weights.length === 0) return []
  const normalizedWeights = weights.map(w => Math.max(0, Math.round(w)))
  const totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0)
  const budget = Math.max(0, Math.round(tokenBudget))

  if (budget === 0) return normalizedWeights.map(() => 0)
  if (totalWeight === 0) {
    const even = Math.floor(budget / normalizedWeights.length)
    const allocated = normalizedWeights.map(() => even)
    let remainder = budget - even * normalizedWeights.length
    let index = 0
    while (remainder > 0) {
      allocated[index] = (allocated[index] ?? 0) + 1
      remainder--
      index = (index + 1) % normalizedWeights.length
    }
    return allocated
  }

  const rawAllocation = normalizedWeights.map(weight => (budget * weight) / totalWeight)
  const allocated = rawAllocation.map(value => Math.floor(value))
  let remainder = budget - allocated.reduce((sum, value) => sum + value, 0)

  const byLargestFraction = rawAllocation
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)

  let pointer = 0
  while (remainder > 0 && byLargestFraction.length > 0) {
    const index = byLargestFraction[pointer]!.index
    allocated[index] = (allocated[index] ?? 0) + 1
    remainder--
    pointer = (pointer + 1) % byLargestFraction.length
  }

  return allocated
}

function resolveModelForExchange(exchange: WarpQueryRow, dominantModel: string): string {
  const candidate =
    exchange.model_id.trim() ||
    exchange.coding_model_id.trim() ||
    exchange.planning_model_id.trim() ||
    dominantModel ||
    'warp-auto-efficient'
  const normalized = normalizeModel(candidate)
  if ((normalized === 'warp-auto-efficient' || normalized === 'warp-auto-powerful') && dominantModel) {
    return dominantModel
  }
  return normalized
}

function assignCommandBlocksToExchanges(
  blocks: WarpBlockRow[],
  exchanges: ParsedExchange[],
): Map<string, ExchangeToolInfo> {
  const toolsByExchange = new Map<string, ExchangeToolInfo>()

  function getOrCreate(exchangeId: string): ExchangeToolInfo {
    const existing = toolsByExchange.get(exchangeId)
    if (existing) return existing
    const created: ExchangeToolInfo = { tools: [], bashCommands: [] }
    toolsByExchange.set(exchangeId, created)
    return created
  }

  for (const block of blocks) {
    const blockStartMs = parseTimestamp(block.start_ts)
    if (blockStartMs === null) continue

    let targetExchange: ParsedExchange | null = null
    for (const exchange of exchanges) {
      if (exchange.startMs > blockStartMs) break
      targetExchange = exchange
    }
    if (!targetExchange) continue

    const info = getOrCreate(targetExchange.exchange_id)
    if (!info.tools.includes('Bash')) info.tools.push('Bash')

    const commandText = blobToText(block.stylized_command)
    for (const command of extractBashCommands(commandText)) {
      if (!info.bashCommands.includes(command)) info.bashCommands.push(command)
    }
  }

  return toolsByExchange
}

function decodeSourcePath(path: string): { dbPath: string; conversationId: string } {
  const splitIndex = path.lastIndexOf(':')
  if (splitIndex <= 0) return { dbPath: path, conversationId: '' }
  return {
    dbPath: path.slice(0, splitIndex),
    conversationId: path.slice(splitIndex + 1),
  }
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM agent_conversations LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM ai_queries LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM blocks LIMIT 1')
    return true
  } catch {
    return false
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const { dbPath, conversationId } = decodeSourcePath(source.path)
      if (!conversationId) return

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        // A busy/locked hit on Warp's continuously-written DB must reach the
        // caller, not read as an empty session that seals the period.
        if (isSqliteBusyError(err)) throw err
        process.stderr.write(`codeburn: cannot open Warp database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!validateSchema(db)) return

        const conversations = db.query<WarpConversationRow>(
          `SELECT conversation_id, conversation_data, last_modified_at
           FROM agent_conversations
           WHERE conversation_id = ?
           LIMIT 1`,
          [conversationId],
        )
        if (conversations.length === 0) return

        const exchanges = db.query<WarpQueryRow>(
          `SELECT exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id, planning_model_id, coding_model_id
           FROM ai_queries
           WHERE conversation_id = ?
           ORDER BY start_ts ASC`,
          [conversationId],
        )

        const parsedExchanges: ParsedExchange[] = []
        for (const exchange of exchanges) {
          if (!isFinalStatus(exchange.output_status)) continue
          const startMs = parseTimestamp(exchange.start_ts)
          if (startMs === null) continue
          parsedExchanges.push({ ...exchange, startMs })
        }
        if (parsedExchanges.length === 0) return

        const blocks = db.query<WarpBlockRow>(
          `SELECT block_id, start_ts, CAST(stylized_command AS BLOB) AS stylized_command
           FROM blocks
           WHERE ai_metadata IS NOT NULL
             AND ai_metadata <> ''
             AND json_extract(ai_metadata, '$.conversation_id') = ?
           ORDER BY start_ts ASC`,
          [conversationId],
        )

        const { tokenBudget, dominantModel } = extractTokenBudget(conversations[0]!.conversation_data)
        const weights = parsedExchanges.map(exchange => estimateWeight(exchange.input))
        const fallbackBudget = weights.reduce((sum, weight) => sum + weight, 0)
        const allocatedTokens = allocateTokens(weights, tokenBudget > 0 ? tokenBudget : fallbackBudget)
        const conversationCost = conversationCostUsd(conversations[0]!.conversation_data)
        const allocatedCosts = conversationCost ? allocateCost(weights, conversationCost.usd) : null
        const toolsByExchange = assignCommandBlocksToExchanges(blocks, parsedExchanges)

        for (let index = 0; index < parsedExchanges.length; index++) {
          const exchange = parsedExchanges[index]!
          const deduplicationKey = `warp:${conversationId}:${exchange.exchange_id}`
          if (seenKeys.has(deduplicationKey)) continue

          const timestamp = new Date(exchange.startMs).toISOString()
          const model = resolveModelForExchange(exchange, dominantModel)
          const inputTokens = allocatedTokens[index] ?? 0
          const exchangeTools = toolsByExchange.get(exchange.exchange_id) ?? { tools: [], bashCommands: [] }
          const userMessage = extractUserMessage(exchange.input).slice(0, 500)
          const projectPath = exchange.working_directory?.trim() || undefined
          const project = projectPath ? sanitizeProject(projectPath) : source.project

          seenKeys.add(deduplicationKey)
          yield {
            provider: 'warp',
            model,
            inputTokens,
            // Warp exposes only conversation-level usage totals in these tables,
            // so we cannot reliably split per-exchange input vs output tokens.
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD: allocatedCosts ? (allocatedCosts[index] ?? 0) : calculateCost(model, inputTokens, 0, 0, 0, 0),
            costIsEstimated: conversationCost ? conversationCost.estimated : true,
            // Rungs (a)-(c) are Warp's own billing record; keep them through
            // the cache. Rung (d) is the token floor, which stays re-priceable.
            ...(conversationCost ? { costFromBilling: true } : {}),
            tools: exchangeTools.tools,
            bashCommands: exchangeTools.bashCommands,
            timestamp,
            speed: 'standard',
            deduplicationKey,
            userMessage,
            sessionId: conversationId,
            project,
            projectPath,
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch (err) {
    // A blocked, busy, or permission-denied database means "unknown", not "no
    // sessions": let it reach the registry so the run is marked degraded
    // instead of silently empty. A plain EACCES/EPERM (e.g. a WARP_DB_PATH
    // override the OS won't let us read) is recoverable once access is granted.
    if (isBlockedDatabaseError(err) || isSqliteBusyError(err) || isPermissionError(err)) throw err
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const rows = db.query<{ conversation_id: string; working_directory: string | null }>(
      `SELECT c.conversation_id AS conversation_id,
              (
                SELECT q.working_directory
                FROM ai_queries q
                WHERE q.conversation_id = c.conversation_id
                  AND q.working_directory IS NOT NULL
                  AND q.working_directory <> ''
                ORDER BY q.start_ts DESC
                LIMIT 1
              ) AS working_directory
       FROM agent_conversations c
       WHERE EXISTS (
         SELECT 1 FROM ai_queries q
         WHERE q.conversation_id = c.conversation_id
       )
       ORDER BY c.last_modified_at DESC`,
    )

    return rows.map(row => {
      const projectPath = row.working_directory?.trim() ?? ''
      return {
        path: `${dbPath}:${row.conversation_id}`,
        project: projectPath ? sanitizeProject(projectPath) : 'warp',
        provider: 'warp',
      }
    })
  } catch (err) {
    // Warp writes this DB constantly, so a SQLITE_BUSY/LOCKED here is the likely
    // spot: escalate rather than seal an empty discovery.
    if (isSqliteBusyError(err)) throw err
    return []
  } finally {
    db.close()
  }
}

export function createWarpProvider(dbPathOverride?: string): Provider {
  return {
    name: 'warp',
    displayName: 'Warp',

    modelDisplayName(model: string): string {
      return modelDisplayName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool === 'run_command' ? 'Bash' : rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return getDbCandidates(dbPathOverride).map(path => ({ path, label: 'db' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const sessions: SessionSource[] = []
      for (const candidate of getDbCandidates(dbPathOverride)) {
        const found = await discoverFromDb(candidate)
        sessions.push(...found)
      }
      return sessions
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const warp = createWarpProvider()
