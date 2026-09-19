import { stat } from 'fs/promises'
import { dirname } from 'path'

import { calculateCost, getShortModelName } from '../models.js'
import { isSqliteAvailable, openDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall, ProbeRoot } from './types.js'

// new-api (QuantumNous) is a unified LLM gateway; ApiProxyFarm fronts it with
// farm.exe so every client — local or remote — relays through one service.
// Its SQLite store logs every consume row to the `logs` table (type = 2),
// which makes it the single aggregation point for the whole farm.
//
// Local-vs-remote cannot be told by IP: the owner's own agents can arrive
// through the public entrypoint too. The discriminator is identity:
//   * CODEBURN_NEWAPI_LOCAL_TOKENS — comma-separated token names or ids owned
//     by the operator; their rows are skipped because the same usage already
//     lands in local session files counted by other providers.
//   * CODEBURN_NEWAPI_LOCAL_USERS  — comma-separated new-api usernames treated
//     as the operator (covers every token that account issues, present and
//     future).
// Everything else counts as remote traffic.
//
// CODEBURN_NEWAPI_DB points at one-api.db (a directory also works — the file
// name is appended). MySQL/PostgreSQL installs (SQL_DSN) are out of scope.
// All three vars are fingerprinted in PROVIDER_ENV_VARS (#920).

const ENV_DB = 'CODEBURN_NEWAPI_DB'
const ENV_LOCAL_TOKENS = 'CODEBURN_NEWAPI_LOCAL_TOKENS'
const ENV_LOCAL_USERS = 'CODEBURN_NEWAPI_LOCAL_USERS'

function dbPath(): string | null {
  return process.env[ENV_DB]?.trim() || null
}

function csv(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

async function resolveDbFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (info.isFile()) return path
    if (info.isDirectory()) {
      const candidate = `${path.replace(/[\\/]+$/, '')}/one-api.db`
      try {
        if ((await stat(candidate)).isFile()) return candidate
      } catch { /* fall through */ }
    }
  } catch { /* not there */ }
  return null
}

type LogRow = {
  id: number
  created_at: number | null
  username: string | null
  token_name: string | null
  token_id: number | null
  model_name: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  other: string | null
}

function cacheTokensOf(other: string | null): number {
  if (!other) return 0
  try {
    const parsed = JSON.parse(other) as { cache_tokens?: unknown }
    return typeof parsed.cache_tokens === 'number' ? parsed.cache_tokens : 0
  } catch {
    return 0
  }
}

function inRange(epochMs: number, dateRange?: DateRange): boolean {
  if (!dateRange) return true
  return epochMs >= dateRange.start.getTime() && epochMs <= dateRange.end.getTime()
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) return
      const localTokens = csv(process.env[ENV_LOCAL_TOKENS])
      const localUsers = csv(process.env[ENV_LOCAL_USERS])
      let db: ReturnType<typeof openDatabase> | null = null
      try {
        db = openDatabase(source.path)
        const rows = db.query<LogRow>(
          `SELECT id, created_at, username, token_name, token_id, model_name,
                  prompt_tokens, completion_tokens, other
           FROM logs
           WHERE type = 2
             AND (prompt_tokens > 0 OR completion_tokens > 0 OR quota > 0)`,
        )
        for (const row of rows) {
          const tokenName = row.token_name ?? ''
          const username = row.username ?? ''
          if (localUsers.has(username)) continue
          if (localTokens.has(tokenName) || localTokens.has(String(row.token_id ?? ''))) continue

          const epochMs = (row.created_at ?? 0) * 1000
          if (epochMs === 0 || !inRange(epochMs, dateRange)) continue

          const deduplicationKey = `new-api:${row.id}`
          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          const model = row.model_name ?? 'unknown'
          const inputTokens = row.prompt_tokens ?? 0
          const outputTokens = row.completion_tokens ?? 0
          const cacheReadTokens = cacheTokensOf(row.other)
          const who = tokenName || (row.token_id ? `token-${row.token_id}` : username || 'unknown')

          yield {
            provider: source.provider,
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cacheReadTokens,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD: calculateCost(model, inputTokens, outputTokens, 0, cacheReadTokens, 0),
            tools: [],
            bashCommands: [],
            timestamp: new Date(epochMs).toISOString(),
            speed: 'standard',
            deduplicationKey,
            userMessage: '',
            sessionId: `token:${who}`,
            project: `new-api remote: ${who}`,
          }
        }
      } catch {
        // Missing/locked/corrupt db or an older schema — nothing to report.
      } finally {
        db?.close()
      }
    },
  }
}

export function createNewApiProvider(dbFile?: string): Provider {
  // Resolved lazily: the exported provider is built at import time, but env
  // overrides must be honored at discovery time (they are fingerprinted).
  const file = async () => {
    const configured = dbFile ?? dbPath()
    return configured ? resolveDbFile(configured) : null
  }

  return {
    name: 'new-api',
    displayName: 'new-api',
    // The gateway owns this DB and can clean or rotate the logs table; pruned
    // rows must keep contributing from cache.
    durableSources: true,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      const resolved = await file()
      return [{ path: resolved ? dirname(resolved) : (dbFile ?? dbPath() ?? ''), label: 'one-api.db' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const resolved = await file()
      if (!resolved) return []
      return [{ path: resolved, project: 'new-api', provider: 'new-api' }]
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      dateRange?: DateRange,
    ): SessionParser {
      return createParser(source, seenKeys, dateRange)
    },
  }
}

export const newApi = createNewApiProvider()
