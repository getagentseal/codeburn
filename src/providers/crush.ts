import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { homedir, platform } from 'os'

import { calculateCost } from '../models.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

/// Crush stores per-project SQLite databases discovered through a JSON registry.
/// We only read both. Schema source: charmbracelet/crush
/// internal/db/migrations/20250424200609_initial.sql, verified against v0.66.1.
/// The schema *comments* in that file claim millisecond timestamps, but every
/// INSERT/UPDATE in internal/db/sql/{sessions,messages}.sql uses
/// strftime('%s', 'now') which returns Unix seconds. We treat values as seconds.

type ProjectEntry = {
  path: string
  data_dir: string
}

type SessionRow = {
  id: string
  prompt_tokens: number | null
  completion_tokens: number | null
  cost: number | null
  created_at: number | null
  updated_at: number | null
  message_count: number | null
}

function getRegistryPath(): string {
  const explicit = process.env['CRUSH_GLOBAL_DATA']
  if (explicit) return join(explicit, 'projects.json')

  if (platform() === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'crush', 'projects.json')
  }

  const xdg = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(xdg, 'crush', 'projects.json')
}

async function loadRegistry(path: string): Promise<ProjectEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  // Crush writes projects.json as an object keyed by project id. Older builds
  // (and tokscale's sample fixtures) emit an array. Accept both shapes.
  let entries: unknown[]
  if (Array.isArray(parsed)) {
    entries = parsed
  } else if (parsed && typeof parsed === 'object') {
    entries = Object.values(parsed)
  } else {
    return []
  }
  const out: ProjectEntry[] = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const obj = e as Record<string, unknown>
    if (typeof obj['path'] !== 'string' || typeof obj['data_dir'] !== 'string') continue
    out.push({ path: obj['path'], data_dir: obj['data_dir'] })
  }
  return out
}

function resolveDbPath(entry: ProjectEntry): string {
  // data_dir defaults to ".crush" relative to the project path. Absolute paths
  // are honored if a user has overridden the layout.
  return join(resolve(entry.path, entry.data_dir), 'crush.db')
}

function sanitizeProject(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-')
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM sessions LIMIT 1')
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM messages LIMIT 1')
    return true
  } catch {
    return false
  }
}

function epochSecondsToIso(epochSeconds: number | null): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) {
    return new Date(0).toISOString()
  }
  return new Date(epochSeconds * 1000).toISOString()
}

function dominantModel(db: SqliteDatabase, sessionId: string): string {
  try {
    const rows = db.query<{ model: string | null }>(
      `SELECT model FROM messages
       WHERE session_id = ? AND model IS NOT NULL AND model <> ''
       GROUP BY model
       ORDER BY COUNT(*) DESC
       LIMIT 1`,
      [sessionId],
    )
    if (rows.length === 0) return 'unknown'
    return rows[0]!.model ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      // Source paths are encoded as `<dbPath>:<sessionId>`. Split from the
      // right because dbPath may contain a colon on Windows (drive letter).
      const segments = source.path.split(':')
      const sessionId = segments[segments.length - 1]!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(
          `codeburn: cannot open Crush database: ${err instanceof Error ? err.message : err}\n`,
        )
        return
      }

      try {
        if (!validateSchema(db)) return

        const rows = db.query<SessionRow>(
          `SELECT id, prompt_tokens, completion_tokens, cost, created_at, updated_at, message_count
           FROM sessions
           WHERE id = ? AND parent_session_id IS NULL`,
          [sessionId],
        )
        if (rows.length === 0) return
        const session = rows[0]!

        const inputTokens = session.prompt_tokens ?? 0
        const outputTokens = session.completion_tokens ?? 0
        const cost = session.cost ?? 0
        if (inputTokens === 0 && outputTokens === 0 && cost === 0) return

        const dedupKey = `crush:${sessionId}`
        if (seenKeys.has(dedupKey)) return
        seenKeys.add(dedupKey)

        const model = dominantModel(db, sessionId)
        // Crush already records cost in dollars; trust it. Fall back to
        // pricing-table calculation only when the row is missing a cost.
        const costUSD = cost > 0
          ? cost
          : calculateCost(model, inputTokens, outputTokens, 0, 0, 0)

        yield {
          provider: 'crush',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools: [],
          bashCommands: [],
          timestamp: epochSecondsToIso(session.updated_at ?? session.created_at),
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: '',
          sessionId,
        }
      } finally {
        db.close()
      }
    },
  }
}

async function discoverFromDb(dbPath: string, project: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }
  try {
    if (!validateSchema(db)) return []
    const rows = db.query<{ id: string }>(
      `SELECT id FROM sessions
       WHERE parent_session_id IS NULL
         AND (cost > 0 OR prompt_tokens > 0 OR completion_tokens > 0)
       ORDER BY created_at DESC`,
    )
    return rows.map(row => ({
      path: `${dbPath}:${row.id}`,
      project,
      provider: 'crush',
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function createCrushProvider(): Provider {
  return {
    name: 'crush',
    displayName: 'Crush',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: getRegistryPath(), label: 'registry' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const registry = await loadRegistry(getRegistryPath())
      const sources: SessionSource[] = []
      for (const entry of registry) {
        const dbPath = resolveDbPath(entry)
        const project = sanitizeProject(entry.path)
        const found = await discoverFromDb(dbPath, project)
        sources.push(...found)
      }
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const crush = createCrushProvider()
