import { stat } from 'fs/promises'
import { homedir } from 'os'
import { join, sep } from 'path'

import { calculateCost, getShortModelName } from '../models.js'
import { isSqliteAvailable, openDatabase } from '../sqlite.js'
import type { DateRange } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall, ProbeRoot } from './types.js'

// CC Switch (com.ccswitch.desktop) aggregates usage in ~/.cc-switch/cc-switch.db.
// Its proxy_request_logs table mixes two origins:
//
//   * local sessions — imported from session files under this machine's home
//     directory, already counted by the claude/codex/pi providers;
//   * remote sessions — synced from another machine via the app's WebDAV
//     profile; their session files live under a home dir that is not ours
//     (e.g. C:\Users\MYM\...) and are invisible to local discovery.
//
// Only the remote half is emitted here, keyed by joining each row's
// session_id to the synced-file registry (session_log_sync): a session file
// under our home dir means the usage is local and skipped. Rows with no
// session_id at all come from the app's built-in proxy (data_source 'proxy')
// — by definition forwarded traffic, so they are kept too.
//
// CODEBURN_CC_SWITCH_DIR overrides the data dir (tests, relocated installs);
// it is declared in PROVIDER_ENV_VARS so the cache fingerprint moves (#920).

const ENV_DIR = 'CODEBURN_CC_SWITCH_DIR'

function dataDir(): string {
  return process.env[ENV_DIR] ?? join(homedir(), '.cc-switch')
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

type SyncedFileRow = { file_path: string | null }

type ProxyLogRow = {
  request_id: string
  session_id: string | null
  app_type: string | null
  model: string | null
  request_model: string | null
  pricing_model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  created_at: number | null
  data_source: string | null
}

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

// session_id joins use the file's basename: claude/pi files are <uuid>.jsonl
// directly; codex rollouts carry the uuid at the tail of a longer name.
function sessionIdKeys(filePath: string): string[] {
  const base = filePath.split(/[\\/]/).pop()!.replace(/\.jsonl$/i, '')
  const tail = base.match(UUID_TAIL)?.[1]
  return tail && tail !== base ? [base, tail] : [base]
}

function isUnderHome(filePath: string, home: string): boolean {
  const normalize = (p: string) => p.replace(/\//g, sep).replace(/[\\/]+$/, '').toLowerCase()
  const path = normalize(filePath)
  const root = normalize(home)
  return path === root || path.startsWith(root + sep)
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
      let db: ReturnType<typeof openDatabase> | null = null
      try {
        db = openDatabase(source.path)

        const localIds = new Set<string>()
        const home = homedir()
        for (const row of db.query<SyncedFileRow>('SELECT file_path FROM session_log_sync')) {
          if (!row.file_path || !isUnderHome(row.file_path, home)) continue
          for (const key of sessionIdKeys(row.file_path)) localIds.add(key)
        }

        const rows = db.query<ProxyLogRow>(
          `SELECT request_id, session_id, app_type, model, request_model, pricing_model,
                  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                  created_at, data_source
           FROM proxy_request_logs
           WHERE input_tokens > 0 OR output_tokens > 0
              OR cache_read_tokens > 0 OR cache_creation_tokens > 0`,
        )
        for (const row of rows) {
          const sessionId = row.session_id ?? ''
          const remote = sessionId ? !localIds.has(sessionId) : row.data_source === 'proxy'
          if (!remote) continue
          const epochMs = (row.created_at ?? 0) * 1000
          if (epochMs === 0 || !inRange(epochMs, dateRange)) continue

          const deduplicationKey = `cc-switch:${row.request_id}`
          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          const appType = row.app_type ?? 'unknown'
          const model = row.model ?? row.request_model ?? 'unknown'
          const inputTokens = row.input_tokens ?? 0
          const outputTokens = row.output_tokens ?? 0
          const cacheCreationTokens = row.cache_creation_tokens ?? 0
          const cacheReadTokens = row.cache_read_tokens ?? 0

          yield {
            provider: source.provider,
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheCreationTokens,
            cacheReadInputTokens: cacheReadTokens,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD: calculateCost(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, 0),
            tools: [],
            bashCommands: [],
            timestamp: new Date(epochMs).toISOString(),
            speed: 'standard',
            deduplicationKey,
            userMessage: '',
            sessionId: sessionId || row.request_id,
            project: `cc-switch remote: ${appType}`,
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

export function createCcSwitchProvider(dir?: string): Provider {
  // Resolved lazily: the exported provider is built at import time, but the env
  // override must be honored at discovery time (its value is fingerprinted).
  const root = () => dir ?? dataDir()

  return {
    name: 'cc-switch',
    displayName: 'CC Switch',
    // The app owns this DB and can rebuild or prune it; pruned rows must keep
    // contributing from cache.
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
      const dbPath = join(root(), 'cc-switch.db')
      if (!(await isFile(dbPath))) return []
      return [{ path: dbPath, project: 'CC Switch', provider: 'cc-switch' }]
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

export const ccSwitch = createCcSwitchProvider()
