import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { calculateCost } from '../models.js'
import {
  isSqliteAvailable,
  getSqliteLoadError,
  openDatabase,
  isSqliteBusyError,
} from '../sqlite.js'
import type { SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall, ProbeRoot } from './types.js'

const PROVIDER_NAME = 'kinetaios'

// KinetAios pins its Electron userData dir name to "KinetAios" regardless of
// productName, so the default locations are stable across builds.
function defaultDbPath(): string {
  const home = homedir()
  const base = process.platform === 'win32'
    ? join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'KinetAios')
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'KinetAios')
      : join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'KinetAios')
  return join(base, 'history.db')
}

function getDbPath(): string {
  return process.env['CODEBURN_KINETAIOS_DB']?.trim() || defaultDbPath()
}

type CostLogRow = {
  id: string
  conv_id: string | null
  engine: string | null
  amount: number | null
  tokens: number
  ts: number
  tokens_in: number | null
  tokens_out: number | null
  // LEFT JOIN projections — a conversation row can be deleted independently.
  model: string | null
  cwd: string | null
}

function hasSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM cost_log LIMIT 1')
    return true
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

// KinetAios v3.6.x wrote only a whole-turn total; v3.7+ splits input/output.
// Rows with both splits at 0 and a positive total are legacy: attribute the
// whole total to input (each turn resends the growing transcript, so input
// dominates and is the honest default for pricing).
function splitTokens(row: CostLogRow): { input: number; output: number } {
  const input = row.tokens_in ?? 0
  const output = row.tokens_out ?? 0
  if (input === 0 && output === 0 && row.tokens > 0) {
    return { input: row.tokens, output: 0 }
  }
  return { input, output }
}

// Project name from the conversation's cwd, mirroring the shared sanitize():
// "/Users/x/kinet/KinetAiosWin" -> "Users-x-kinet-KinetAiosWin".
function projectFor(cwd: string | null, fallback: string): string {
  if (cwd && cwd.trim()) return cwd.replace(/^\//, '').replace(/\/$/, '').replace(/\//g, '-')
  return fallback
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open KinetAios database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!hasSchema(db)) return

        // One call per cost_log row. cost_log is append-only per completed LLM
        // turn and `id` is its primary key, so `<provider>:<db>:<id>` is a
        // stable dedup key across scans. Ordered by ts for determinism.
        const rows = db.query<CostLogRow>(
          `SELECT l.id, l.conv_id, l.engine, l.amount, l.tokens, l.ts, l.tokens_in, l.tokens_out,
                  c.model AS model, c.cwd AS cwd
           FROM cost_log l
           LEFT JOIN conversations c ON c.id = l.conv_id
           ORDER BY l.ts ASC`,
        )

        for (const row of rows) {
          const dedupKey = `${PROVIDER_NAME}:${sessionId}:${row.id}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const ms = row.ts < 1e12 ? row.ts * 1000 : row.ts
          const ts = new Date(ms)
          if (isNaN(ts.getTime())) continue

          const { input, output } = splitTokens(row)
          const model = (typeof row.model === 'string' && row.model) ? row.model : 'kinetaios-auto'

          // KinetAios records what the turn actually cost in USD (priced from
          // its own per-profile rate table). Absent or <= 0 falls back to the
          // bundled pricing table and stays re-priceable.
          const costFromProvider = row.amount ?? 0
          const isReported = costFromProvider > 0
          const costUSD = isReported
            ? costFromProvider
            : calculateCost(model, input, output, 0, 0, 0)

          const project = projectFor(
            (typeof row.cwd === 'string' && row.cwd) ? row.cwd : null,
            `KinetAios-${sessionId.slice(0, 8)}`,
          )
          void project

          yield {
            provider: PROVIDER_NAME,
            model,
            inputTokens: input,
            outputTokens: output,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            ...(isReported ? { costFromBilling: true } : {}),
            tools: [],
            bashCommands: [],
            timestamp: ts.toISOString(),
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: '',
            sessionId,
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createKinetAiosProvider(overridePath?: string): Provider {
  return {
    name: PROVIDER_NAME,
    displayName: 'KinetAios',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      const dbPath = overridePath || getDbPath()
      return [{ path: dbPath, label: 'sqlite' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dbPath = overridePath || getDbPath()
      if (!existsSync(dbPath)) return []
      try {
        statSync(dbPath)
      } catch {
        return []
      }
      // The db IS the session: path carries `:<db>` so the parser can split
      // db file from session id, matching the shared SQLite parser convention.
      return [{ path: `${dbPath}:kinetaios`, project: 'KinetAios', provider: PROVIDER_NAME }]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const kinetaios = createKinetAiosProvider()
