import { stat } from 'fs/promises'
import { homedir, networkInterfaces } from 'os'
import { join } from 'path'

import { calculateCost, getShortModelName } from '../models.js'
import { isSqliteAvailable, openDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall, ProbeRoot } from './types.js'

// Antigravity Tools (com.lbjlaq.antigravity-tools) is a desktop relay that
// serves the machine's Antigravity quota as an OpenAI-compatible API on a
// LAN/tunnel endpoint. Requests arriving from OTHER machines never touch a
// local session file, so the only record of them is inside the app's own
// SQLite stores under ~/.antigravity_tools:
//
//   user_tokens.db  token_usage_logs — requests authenticated with an issued
//                   "user token" (the app's 用户 Token feature). Every row is
//                   remote by definition: local callers use the admin key.
//   proxy_logs.db   request_logs     — the 流量日志 table; `client_ip` is set
//                   only for requests that arrived over the network, so
//                   non-loopback rows are the non-token remote traffic.
//
// token_stats.db is deliberately NOT read: it aggregates local and remote
// requests indistinguishably, and the local half is already counted by the
// providers that own the originating session files.
//
// client_ip is the only identity signal in request_logs (request bodies are
// not persisted). The operator's own calls can arrive through the public
// tunnel entrypoint — from the machine's home public IP, which is not a
// local interface address. CODEBURN_ANTIGRAVITY_TOOLS_LOCAL_IPS lists such
// addresses (comma-separated) so they are treated as local and skipped;
// their usage is already counted from the local session files.
//
// When every legitimate remote user holds an issued user token, request_logs
// carries only the operator's own hairpin traffic and unauthenticated noise.
// CODEBURN_ANTIGRAVITY_TOOLS_TOKENS_ONLY=1 then skips the proxy-logs source
// entirely — no IP list to maintain as the home address rotates.
//
// CODEBURN_ANTIGRAVITY_TOOLS_DIR overrides the data dir (tests, relocated
// installs); all three vars are declared in PROVIDER_ENV_VARS so the cache
// fingerprint moves with them (#920).

const ENV_DIR = 'CODEBURN_ANTIGRAVITY_TOOLS_DIR'
const ENV_LOCAL_IPS = 'CODEBURN_ANTIGRAVITY_TOOLS_LOCAL_IPS'
const ENV_TOKENS_ONLY = 'CODEBURN_ANTIGRAVITY_TOOLS_TOKENS_ONLY'

function tokensOnly(): boolean {
  const raw = process.env[ENV_TOKENS_ONLY]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function dataDir(): string {
  return process.env[ENV_DIR] ?? join(homedir(), '.antigravity_tools')
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

// Loopback, every address assigned to this machine's interfaces, and the
// operator-listed public addresses (own traffic hairpinning back through the
// tunnel): a request logged with one of these arrived from this machine.
function localAddresses(): Set<string> {
  const local = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info?.address) local.add(info.address)
    }
  }
  for (const ip of (process.env[ENV_LOCAL_IPS] ?? '').split(',')) {
    const trimmed = ip.trim()
    if (trimmed) local.add(trimmed)
  }
  return local
}

type TokenUsageRow = {
  id: string
  ip_address: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  request_time: number | null
  username: string | null
}

type RequestLogRow = {
  id: string
  timestamp: number | null
  model: string | null
  mapped_model: string | null
  client_ip: string | null
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
}

function inRange(epochMs: number, dateRange?: DateRange): boolean {
  if (!dateRange) return true
  return epochMs >= dateRange.start.getTime() && epochMs <= dateRange.end.getTime()
}

function baseCall(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  epochMs: number,
  deduplicationKey: string,
  sessionId: string,
  project: string,
): ParsedProviderCall {
  return {
    provider,
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
    sessionId,
    project,
  }
}

function createUserTokensParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) return
      let db: ReturnType<typeof openDatabase> | null = null
      try {
        db = openDatabase(source.path)
        // Older app versions predate the 用户 Token tables; treat a missing
        // table as "no remote traffic" rather than an error.
        const rows = db.query<TokenUsageRow>(
          `SELECT l.id, l.ip_address, l.model, l.input_tokens, l.output_tokens, l.request_time, t.username
           FROM token_usage_logs l
           LEFT JOIN user_tokens t ON t.id = l.token_id
           WHERE l.input_tokens > 0 OR l.output_tokens > 0`,
        )
        for (const row of rows) {
          const inputTokens = row.input_tokens ?? 0
          const outputTokens = row.output_tokens ?? 0
          const epochMs = (row.request_time ?? 0) * 1000
          if (epochMs === 0 || !inRange(epochMs, dateRange)) continue

          const deduplicationKey = `antigravity-tools:tok:${row.id}`
          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          const who = row.username ?? 'unknown'
          yield baseCall(
            source.provider,
            row.model ?? 'unknown',
            inputTokens,
            outputTokens,
            0,
            epochMs,
            deduplicationKey,
            `token:${who}`,
            `antigravity-tools remote: ${who}`,
          )
        }
      } catch {
        // Missing/locked/corrupt db or absent tables — nothing to report.
      } finally {
        db?.close()
      }
    },
  }
}

function createProxyLogsParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) return
      const local = localAddresses()
      let db: ReturnType<typeof openDatabase> | null = null
      try {
        db = openDatabase(source.path)
        const rows = db.query<RequestLogRow>(
          `SELECT id, timestamp, model, mapped_model, client_ip, input_tokens, output_tokens, cached_tokens
           FROM request_logs
           WHERE client_ip IS NOT NULL
             AND (input_tokens > 0 OR output_tokens > 0 OR cached_tokens > 0)`,
        )
        for (const row of rows) {
          const clientIp = row.client_ip
          if (!clientIp || local.has(clientIp)) continue
          const epochMs = row.timestamp ?? 0
          if (epochMs === 0 || !inRange(epochMs, dateRange)) continue

          const deduplicationKey = `antigravity-tools:req:${row.id}`
          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          // mapped_model is the upstream model actually served; the requested
          // alias (claude-*, gpt-*) is only the app's routing name.
          const model = row.mapped_model ?? row.model ?? 'unknown'
          yield baseCall(
            source.provider,
            model,
            row.input_tokens ?? 0,
            row.output_tokens ?? 0,
            row.cached_tokens ?? 0,
            epochMs,
            deduplicationKey,
            `ip:${clientIp}`,
            `antigravity-tools remote: ${clientIp}`,
          )
        }
      } catch {
        // Same tolerance as the token-logs source.
      } finally {
        db?.close()
      }
    },
  }
}

export function createAntigravityToolsProvider(dir?: string): Provider {
  // Resolved lazily: the exported provider is built at import time, but the env
  // override must be honored at discovery time (its value is fingerprinted).
  const root = () => dir ?? dataDir()

  return {
    name: 'antigravity-tools',
    displayName: 'Antigravity Tools',
    // The app owns these DBs and prunes them (log_retention); pruned rows must
    // keep contributing from cache.
    durableSources: true,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: root(), label: 'data dir' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      const userTokens = join(root(), 'user_tokens.db')
      const proxyLogs = join(root(), 'proxy_logs.db')
      if (await isFile(userTokens)) {
        sources.push({ path: userTokens, project: 'Antigravity Tools', provider: 'antigravity-tools', sourceId: 'user-tokens' })
      }
      if (!tokensOnly() && await isFile(proxyLogs)) {
        sources.push({ path: proxyLogs, project: 'Antigravity Tools', provider: 'antigravity-tools', sourceId: 'proxy-logs' })
      }
      return sources
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      dateRange?: DateRange,
    ): SessionParser {
      return source.sourceId === 'proxy-logs'
        ? createProxyLogsParser(source, seenKeys, dateRange)
        : createUserTokensParser(source, seenKeys, dateRange)
    },
  }
}

export const antigravityTools = createAntigravityToolsProvider()
