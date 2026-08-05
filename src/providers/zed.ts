import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import zlib from 'zlib'

import { calculateCost } from '../models.js'
import { getSqliteLoadError, isSqliteAvailable, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'

// Zed's built-in agent stores one row per thread in a single SQLite database;
// the `data` blob is zstd-compressed JSON carrying `request_token_usage`
// (per-request Anthropic-shaped token counts) and the thread's model.
// Format documented in issue #480.

// zstd landed in node:zlib in 22.15 / 23.8; the package floor is 22.13, so the
// provider degrades with a notice instead of assuming the export exists.
const zstdDecompress = (zlib as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync

function getZedThreadsDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Local', 'Zed', 'threads', 'threads.db')
  }
  return join(homedir(), '.local', 'share', 'zed', 'threads', 'threads.db')
}

const THREADS_QUERY = `
  SELECT id, summary, updated_at, data_type, data
  FROM threads
  ORDER BY updated_at ASC
`

// Newer Zed adds `folder_paths` (newline-separated absolute workspace roots,
// lexicographically sorted) via ALTER TABLE, so databases written by older
// versions do not have the column. Query it only when the schema has it.
const THREADS_QUERY_WITH_FOLDER_PATHS = `
  SELECT id, summary, updated_at, data_type, data, folder_paths
  FROM threads
  ORDER BY updated_at ASC
`

type ThreadRow = {
  id: string
  summary: string | null
  updated_at: string | null
  data_type: string | null
  data: Uint8Array | null
  folder_paths: unknown
}

type TokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type ThreadJson = {
  model?: { provider?: string; model?: string }
  request_token_usage?: Record<string, TokenUsage>
  cumulative_token_usage?: TokenUsage
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function usageIsEmpty(usage: TokenUsage): boolean {
  return (
    num(usage.input_tokens) === 0 &&
    num(usage.output_tokens) === 0 &&
    num(usage.cache_creation_input_tokens) === 0 &&
    num(usage.cache_read_input_tokens) === 0
  )
}

// A thread carries the workspace folder roots it was created against as a
// newline-separated list. The display label is intentionally kept separate
// from the stable path-set key because basenames are not unique.
type ThreadProject = {
  project: string
  projectPath?: string
}

function pathComponents(path: string): string[] {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return []
  const components = normalized.split('/').filter(Boolean)
  const last = components.length - 1
  if (last >= 0 && components[last]!.endsWith('.git')) {
    components[last] = components[last]!.slice(0, -'.git'.length)
  }
  return components.filter(Boolean)
}

function pathDisplaySuffix(path: string, detail: number): string {
  return pathComponents(path).slice(-(detail + 1)).join('/')
}

function displayNames(paths: string[]): string[] {
  const names = paths.map(path => pathDisplaySuffix(path, 0))
  const counts = new Map<string, number>()
  for (const name of names) {
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  return paths.map((path, index) => {
    const name = names[index] ?? ''
    if (!name || counts.get(name) === 1) return name

    const components = pathComponents(path)
    for (let detail = 1; detail < components.length; detail++) {
      const candidate = pathDisplaySuffix(path, detail)
      const conflicts = paths.some((otherPath, otherIndex) => {
        if (otherIndex === index) return false
        const otherName = names[otherIndex] ?? ''
        return otherName === name && pathDisplaySuffix(otherPath, detail) === candidate
      })
      if (!conflicts) return candidate
    }
    return pathDisplaySuffix(path, components.length - 1) || name
  })
}

function resolveThreadProject(folderPaths: unknown): ThreadProject | undefined {
  if (typeof folderPaths !== 'string') return undefined
  const paths = folderPaths.split('\n').map(p => p.trim()).filter(Boolean)
  if (paths.length === 0) return undefined

  const names = displayNames(paths).filter(Boolean)
  return {
    project: names.length > 0 ? names.join(', ') : 'Empty Workspace',
    ...(paths.length === 1 ? { projectPath: paths[0]! } : {}),
  }
}

function hasFolderPathsColumn(db: SqliteDatabase): boolean {
  try {
    const columns = db.query<{ name: string }>('PRAGMA table_info(threads)')
    return columns.some(c => c.name === 'folder_paths')
  } catch {
    return false
  }
}

function buildCall(opts: {
  threadId: string
  requestKey: string
  usage: TokenUsage
  model: string
  timestamp: string
  userMessage: string
  project?: string
  projectPath?: string
}): ParsedProviderCall {
  const input = num(opts.usage.input_tokens)
  const output = num(opts.usage.output_tokens)
  const cacheWrite = num(opts.usage.cache_creation_input_tokens)
  const cacheRead = num(opts.usage.cache_read_input_tokens)
  return {
    provider: 'zed',
    model: opts.model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    cachedInputTokens: cacheRead,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: calculateCost(opts.model, input, output, cacheWrite, cacheRead, 0),
    tools: [],
    bashCommands: [],
    timestamp: opts.timestamp,
    speed: 'standard',
    deduplicationKey: `zed:${opts.threadId}:${opts.requestKey}`,
    userMessage: opts.userMessage,
    sessionId: opts.threadId,
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
  }
}

function parseThreads(db: SqliteDatabase, seenKeys: Set<string>): ParsedProviderCall[] {
  const calls: ParsedProviderCall[] = []
  let skipped = 0
  const withFolderPaths = hasFolderPathsColumn(db)

  let rows: ThreadRow[]
  try {
    rows = db.query<ThreadRow>(withFolderPaths ? THREADS_QUERY_WITH_FOLDER_PATHS : THREADS_QUERY)
  } catch {
    return calls
  }

  for (const row of rows) {
    try {
      // Zed's DataType enum is "zstd" (current save path) or "json" (legacy
      // uncompressed rows); anything else is unknown.
      if (!row.id || !row.data || (row.data_type !== 'zstd' && row.data_type !== 'json')) {
        if (row.data != null) skipped++
        continue
      }
      const parsedAt = new Date(row.updated_at ?? '')
      if (Number.isNaN(parsedAt.getTime())) continue
      const timestamp = parsedAt.toISOString()

      const jsonText = row.data_type === 'zstd'
        ? zstdDecompress!(Buffer.from(row.data)).toString('utf-8')
        : Buffer.from(row.data).toString('utf-8')
      const thread = JSON.parse(jsonText) as ThreadJson
      const model = thread.model?.model || 'unknown'
      const userMessage = row.summary ?? ''

      const requests = Object.entries(thread.request_token_usage ?? {}).filter(([, usage]) => usage != null && !usageIsEmpty(usage))
      // The per-request map is keyed by user message and does not cover every
      // request (verified on a real thread: cumulative was ~3x the map sum),
      // so a remainder entry tops the thread up to the exact cumulative
      // counter. Threads with an empty map degrade to one cumulative call.
      const entries: Array<[string, TokenUsage]> = [...requests]
      const cumulative = thread.cumulative_token_usage
      if (cumulative && !usageIsEmpty(cumulative)) {
        let sumIn = 0, sumOut = 0, sumWrite = 0, sumRead = 0
        for (const [, usage] of requests) {
          sumIn += num(usage.input_tokens)
          sumOut += num(usage.output_tokens)
          sumWrite += num(usage.cache_creation_input_tokens)
          sumRead += num(usage.cache_read_input_tokens)
        }
        const remainder: TokenUsage = {
          input_tokens: Math.max(0, num(cumulative.input_tokens) - sumIn),
          output_tokens: Math.max(0, num(cumulative.output_tokens) - sumOut),
          cache_creation_input_tokens: Math.max(0, num(cumulative.cache_creation_input_tokens) - sumWrite),
          cache_read_input_tokens: Math.max(0, num(cumulative.cache_read_input_tokens) - sumRead),
        }
        if (!usageIsEmpty(remainder)) entries.push(['cumulative-remainder', remainder])
      }

      const project = resolveThreadProject(withFolderPaths ? row.folder_paths : null)

      for (const [requestKey, usage] of entries) {
        const call = buildCall({
          threadId: row.id,
          requestKey,
          usage,
          model,
          timestamp,
          userMessage,
          ...(project ?? {}),
        })
        if (seenKeys.has(call.deduplicationKey)) continue
        seenKeys.add(call.deduplicationKey)
        calls.push(call)
      }
    } catch {
      skipped++
    }
  }

  if (skipped > 0) {
    process.stderr.write(`codeburn: skipped ${skipped} unreadable Zed threads\n`)
  }
  return calls
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }
      if (!zstdDecompress) {
        process.stderr.write('codeburn: Zed threads need Node >= 22.15 (zstd support); skipping Zed usage.\n')
        return
      }

      let db: SqliteDatabase
      try {
        db = openDatabase(source.path)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Zed database: ${err instanceof Error ? err.message : err}\n`)
        return
      }
      try {
        for (const call of parseThreads(db, seenKeys)) {
          yield call
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createZedProvider(dbPathOverride?: string): Provider {
  return {
    name: 'zed',
    displayName: 'Zed',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const dbPath = dbPathOverride ?? getZedThreadsDbPath()
      if (!existsSync(dbPath)) return []
      return [{ path: dbPath, project: 'zed', provider: 'zed' }]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const zed = createZedProvider()
