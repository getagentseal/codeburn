import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

/// Nous Research Hermes Agent (desktop + CLI) records per-session usage in a
/// single global SQLite database at ~/.hermes/state.db. Each row in the
/// `sessions` table is one session with aggregated token counts and, when the
/// agent could price it, a dollar cost. We read it directly. Schema verified
/// against state.db on 2026-06-21.
///
/// Unlike ZCode (which folds cached tokens into input_tokens, OpenAI-style),
/// Hermes stores fresh input and cache reads in separate columns
/// (Anthropic-style), so no input normalization is needed. Timestamps are Unix
/// seconds with fractional millisecond precision (REAL), unlike ZCode's epoch
/// milliseconds.

type SessionRow = {
  id: string
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  cost_status: string | null
  started_at: number | null
  ended_at: number | null
  cwd: string | null
}

type DiscoverRow = {
  id: string
}

const ELIGIBLE_SESSION_WHERE = `
  input_tokens > 0 OR output_tokens > 0
  OR cache_read_tokens > 0 OR cache_write_tokens > 0
  OR reasoning_tokens > 0
  OR estimated_cost_usd > 0 OR actual_cost_usd > 0
`

function getDbPath(override?: string): string {
  return override ?? join(homedir(), '.hermes', 'state.db')
}

function sanitizeProject(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

function epochSecondsToIso(epochSeconds: number | null): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return new Date(0).toISOString()
  }
  // Hermes stores REAL Unix seconds (e.g. 1782064165.92); Date takes ms.
  return new Date(epochSeconds * 1000).toISOString()
}

function positiveNumber(value: number | null): boolean {
  return value != null && Number.isFinite(value) && value > 0
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM sessions LIMIT 1')
    return true
  } catch {
    return false
  }
}

type ResolvedCost = { costUSD: number; estimated: boolean }

/// Honor the agent's own cost figures when they are present and meaningful,
/// falling back to codeburn's pricing table only when the agent could not price
/// the session itself (cost_status = 'unknown' carries a 0.0 sentinel, not a
/// real estimate).
function resolveCost(
  row: SessionRow,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  reasoningTokens: number,
): ResolvedCost {
  // 1. A real, measured cost (cost_status typically 'actual'/'measured').
  //    Honor it whenever a positive actual_cost_usd is present, regardless of
  //    the exact status string, so a future 'billed'/'known' status is covered.
  const actual = row.actual_cost_usd
  if (actual != null && Number.isFinite(actual) && actual > 0) {
    return { costUSD: actual, estimated: false }
  }

  // 2. The agent's own estimate (cost_status = 'estimated', cost_source carries
  //    the pricing snapshot). Honor it only when the status says so AND a real
  //    (positive) value exists.
  const estimated = row.estimated_cost_usd
  if (
    row.cost_status === 'estimated' &&
    estimated != null &&
    Number.isFinite(estimated) &&
    estimated > 0
  ) {
    return { costUSD: estimated, estimated: true }
  }

  // 3. No usable stored cost: price via codeburn's model pricing table.
  return {
    costUSD: calculateCost(
      model,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      0,
      'standard',
      0,
      reasoningTokens,
    ),
    estimated: true,
  }
}

function discover(dbPath: string): SessionSource[] {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }
  try {
    if (!validateSchema(db)) return []
    const rows = db.query<DiscoverRow>(
      `SELECT id FROM sessions
       WHERE ${ELIGIBLE_SESSION_WHERE}
       LIMIT 1`,
    )
    if (rows.length === 0) return []
    return [{
      path: dbPath,
      project: 'hermes',
      provider: 'hermes',
    }]
  } catch {
    return []
  } finally {
    db.close()
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      let db: SqliteDatabase
      try {
        db = openDatabase(source.path)
      } catch (err) {
        process.stderr.write(
          `codeburn: cannot open Hermes database: ${err instanceof Error ? err.message : err}\n`,
        )
        return
      }

      try {
        if (!validateSchema(db)) return

        const rows = db.query<SessionRow>(
          `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status,
                  started_at, ended_at, cwd
           FROM sessions
           WHERE ${ELIGIBLE_SESSION_WHERE}
           ORDER BY COALESCE(ended_at, started_at, 0), id`,
        )
        if (rows.length === 0) return

        for (const row of rows) {
          const inputTokens = row.input_tokens ?? 0
          const outputTokens = row.output_tokens ?? 0
          const cacheReadTokens = row.cache_read_tokens ?? 0
          const cacheWriteTokens = row.cache_write_tokens ?? 0
          const reasoningTokens = row.reasoning_tokens ?? 0

          // Skip sessions with no usage and no cost.
          if (
            inputTokens === 0 &&
            outputTokens === 0 &&
            cacheReadTokens === 0 &&
            cacheWriteTokens === 0 &&
            reasoningTokens === 0 &&
            !positiveNumber(row.estimated_cost_usd) &&
            !positiveNumber(row.actual_cost_usd)
          ) {
            continue
          }

          const dedupKey = `hermes:${row.id}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const model = row.model ?? 'unknown'
          const { costUSD, estimated } = resolveCost(
            row,
            model,
            inputTokens,
            outputTokens,
            cacheWriteTokens,
            cacheReadTokens,
            reasoningTokens,
          )

          yield {
            provider: 'hermes',
            model,
            inputTokens,
            outputTokens,
            // Hermes stores cache writes (Anthropic cache creation) and cache
            // reads in dedicated columns; input_tokens is already fresh input.
            cacheCreationInputTokens: cacheWriteTokens,
            cacheReadInputTokens: cacheReadTokens,
            cachedInputTokens: 0,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            costIsEstimated: estimated,
            tools: [],
            bashCommands: [],
            timestamp: epochSecondsToIso(row.ended_at ?? row.started_at),
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: '',
            sessionId: row.id,
            project: row.cwd ? sanitizeProject(row.cwd) : 'hermes',
            projectPath: row.cwd ?? undefined,
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createHermesProvider(dbPathOverride?: string): Provider {
  const dbPath = getDbPath(dbPathOverride)
  return {
    name: 'hermes',
    displayName: 'Hermes',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      return discover(dbPath)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const hermes = createHermesProvider()
