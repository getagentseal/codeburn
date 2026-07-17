import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { calculateCost } from '../models.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import { blobToText, isSqliteAvailable, openDatabase } from '../sqlite.js'
import type { SqliteDatabase } from '../sqlite.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

const METRICS_FILE_RE = /^metrics-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

const modelDisplayNames: Record<string, string> = {
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

const toolNameMap: Record<string, string> = {
  readFile: 'Read',
  read_file: 'Read',
  writeFile: 'Edit',
  write_file: 'Edit',
  editFile: 'Edit',
  edit_file: 'Edit',
  runCommand: 'Bash',
  run_command: 'Bash',
  executeBash: 'Bash',
  shell: 'Bash',
  grep: 'Grep',
  searchFiles: 'Grep',
  search_files: 'Grep',
}

type ProfileBase = {
  path: string
  profile: string
}

type MetricsRecord = {
  record: Record<string, unknown>
}

type SessionMetadata = {
  id: string
  title: string
  agentMode: string
  createdAt?: number
  deleted: boolean
  firstUserMessage: string
  inputChars: number
  outputChars: number
  tools: string[]
}

type DatabaseSnapshot = {
  sessions: Map<string, SessionMetadata>
  canEstimate: boolean
}

type SqliteMasterRow = {
  name?: unknown
}

type TableInfoRow = {
  name?: unknown
}

type SessionRow = Record<string, unknown> & {
  id?: unknown
  title?: unknown
  agent_mode?: unknown
  created_at?: unknown
  deleted_at?: unknown
}

type MessageRow = Record<string, unknown> & {
  session_id?: unknown
  role?: unknown
  content?: unknown
  tool_names?: unknown
}

function quickworkHome(): string {
  return resolve(process.env['QUICKWORK_HOME'] || join(homedir(), '.quickwork'))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

async function resolveProfileBases(): Promise<ProfileBase[]> {
  const root = quickworkHome()
  try {
    const parsed = asRecord(JSON.parse(await readFile(join(root, 'profiles.json'), 'utf8')))
    const entries = parsed?.['entries']
    if (Array.isArray(entries)) {
      const bases: ProfileBase[] = []
      const seenPaths = new Set<string>()
      for (const rawEntry of entries) {
        const entry = asRecord(rawEntry)
        const profile = stringValue(entry?.['id'])
        const dataPath = stringValue(entry?.['data_path'])
        if (!profile || !dataPath) continue
        const basePath = isAbsolute(dataPath) ? resolve(dataPath) : resolve(root, dataPath)
        if (seenPaths.has(basePath)) continue
        seenPaths.add(basePath)
        bases.push({ path: basePath, profile })
      }
      if (bases.length > 0) {
        const legacyDbPath = join(root, 'sessions', 'sessions.db')
        if (!seenPaths.has(root) && await isFile(legacyDbPath)) {
          bases.push({ path: root, profile: 'default' })
        }
        return bases
      }
    }
  } catch {
    // Missing, unreadable, or malformed profiles.json is the legacy root layout.
  }
  return [{ path: root, profile: 'default' }]
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function metricsFiles(basePath: string): Promise<string[]> {
  const metricsDir = join(basePath, 'metrics')
  try {
    const entries = await readdir(metricsDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && METRICS_FILE_RE.test(entry.name))
      .map(entry => join(metricsDir, entry.name))
      .sort()
  } catch {
    return []
  }
}

async function discoverSources(): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  for (const base of await resolveProfileBases()) {
    for (const metricsPath of await metricsFiles(base.path)) {
      sources.push({
        path: metricsPath,
        project: base.profile,
        provider: 'quickdesk',
        sourceId: 'metrics',
        sourcePath: base.path,
      })
    }
    const dbPath = join(base.path, 'sessions', 'sessions.db')
    if (await isFile(dbPath)) {
      sources.push({
        path: dbPath,
        project: base.profile,
        provider: 'quickdesk',
        sourceId: 'sessions-db',
        sourcePath: base.path,
      })
    }
  }
  return sources
}

function tableNames(db: SqliteDatabase): Set<string> {
  const rows = db.query<SqliteMasterRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'session_messages')",
  )
  return new Set(rows.map(row => stringValue(row.name)).filter(Boolean))
}

function tableColumns(db: SqliteDatabase, table: 'sessions' | 'session_messages'): Set<string> {
  const rows = db.query<TableInfoRow>(`PRAGMA table_info(${table})`)
  return new Set(rows.map(row => stringValue(row.name)).filter(Boolean))
}

function selectColumn(columns: Set<string>, name: string, fallback = 'NULL'): string {
  return columns.has(name) ? name : `${fallback} AS ${name}`
}

function toolNames(value: unknown): string[] {
  const text = value instanceof Uint8Array ? blobToText(value) : stringValue(value)
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) {
      return parsed.flatMap(entry => {
        if (typeof entry === 'string') return entry.trim() ? [entry.trim()] : []
        const record = asRecord(entry)
        const name = stringValue(record?.['name']) || stringValue(record?.['tool_name']) || stringValue(record?.['toolName'])
        return name ? [name] : []
      })
    }
  } catch {
    // Older stores may use a comma-separated tool_names value instead of JSON.
  }
  return text.split(',').map(name => name.trim()).filter(Boolean)
}

function uniqueMappedTools(values: string[]): string[] {
  return [...new Set(values.map(value => toolNameMap[value] ?? value).filter(Boolean))]
}

function timestampSeconds(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function unixSecondsIso(value: number): string | null {
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function loadDatabaseSnapshot(basePath: string): DatabaseSnapshot {
  const empty: DatabaseSnapshot = { sessions: new Map(), canEstimate: false }
  if (!isSqliteAvailable()) return empty

  let db: SqliteDatabase
  try {
    db = openDatabase(join(basePath, 'sessions', 'sessions.db'))
  } catch {
    return empty
  }

  try {
    const tables = tableNames(db)
    if (!tables.has('sessions')) return empty

    const sessionColumns = tableColumns(db, 'sessions')
    if (!sessionColumns.has('id')) return empty
    const deletionKnown = sessionColumns.has('deleted_at')
    const sessionRows = db.query<SessionRow>(
      `SELECT id,
              ${selectColumn(sessionColumns, 'title')},
              ${selectColumn(sessionColumns, 'agent_mode')},
              ${selectColumn(sessionColumns, 'created_at')},
              ${selectColumn(sessionColumns, 'deleted_at')}
       FROM sessions`,
    )

    const sessions = new Map<string, SessionMetadata>()
    for (const row of sessionRows) {
      const id = stringValue(row.id)
      if (!id) continue
      sessions.set(id, {
        id,
        title: stringValue(row.title),
        agentMode: stringValue(row.agent_mode),
        createdAt: timestampSeconds(row.created_at),
        deleted: deletionKnown && row.deleted_at !== null && row.deleted_at !== undefined,
        firstUserMessage: '',
        inputChars: 0,
        outputChars: 0,
        tools: [],
      })
    }

    if (!tables.has('session_messages')) {
      return { sessions, canEstimate: false }
    }

    const messageColumns = tableColumns(db, 'session_messages')
    if (!messageColumns.has('session_id') || !messageColumns.has('role') || !messageColumns.has('content')) {
      return { sessions, canEstimate: false }
    }

    try {
      const orderBy = messageColumns.has('timestamp') ? 'ORDER BY timestamp ASC' : ''
      const rows = db.query<MessageRow>(
        `SELECT session_id,
                role,
                CAST(content AS BLOB) AS content,
                ${messageColumns.has('tool_names') ? 'CAST(tool_names AS BLOB) AS tool_names' : 'NULL AS tool_names'}
         FROM session_messages
         ${orderBy}`,
      )
      for (const row of rows) {
        const sessionId = stringValue(row.session_id)
        const session = sessions.get(sessionId)
        if (!session) continue
        const role = stringValue(row.role).toLowerCase()
        const content = row.content instanceof Uint8Array ? blobToText(row.content) : stringValue(row.content)
        if (role === 'assistant') session.outputChars += content.length
        else session.inputChars += content.length
        if (role === 'user' && !session.firstUserMessage && content.trim()) {
          session.firstUserMessage = content.trim()
        }
        session.tools.push(...toolNames(row.tool_names))
      }
    } catch {
      return { sessions, canEstimate: false }
    }
    for (const session of sessions.values()) session.tools = uniqueMappedTools(session.tools)

    return { sessions, canEstimate: true }
  } catch {
    return empty
  } finally {
    db.close()
  }
}

async function readMetricsRecords(path: string): Promise<MetricsRecord[]> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    return []
  }

  const records: MetricsRecord[] = []
  const lines = contents.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line) continue
    try {
      const record = asRecord(JSON.parse(line))
      if (record) records.push({ record })
    } catch {
      // A partially-written or malformed JSONL line must not hide later records.
    }
  }
  return records
}

function usageRecord(record: Record<string, unknown>): boolean {
  return Boolean(stringValue(record['Model']))
    && nonNegativeNumber(record['InputTokens']) !== undefined
    && nonNegativeNumber(record['OutputTokens']) !== undefined
}

function sessionId(record: Record<string, unknown>): string {
  return stringValue(record['session_id'])
}

function toolsKey(record: Record<string, unknown>): string {
  return sessionId(record)
}

function collectMetricTools(records: MetricsRecord[]): Map<string, string[]> {
  const tools = new Map<string, string[]>()
  for (const { record } of records) {
    const key = toolsKey(record)
    const tool = stringValue(record['ToolName'])
    if (!key || !tool) continue
    const current = tools.get(key) ?? []
    current.push(toolNameMap[tool] ?? tool)
    tools.set(key, current)
  }
  for (const [key, values] of tools) tools.set(key, [...new Set(values)])
  return tools
}

function fallbackTimestamp(path: string): string | null {
  const match = METRICS_FILE_RE.exec(basename(path))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString()
}

function metricsTimestamp(record: Record<string, unknown>, path: string): string | null {
  const aws = asRecord(record['_aws'])
  const timestampMs = finiteNumber(aws?.['Timestamp'])
  if (timestampMs !== undefined) {
    const date = new Date(timestampMs)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallbackTimestamp(path)
}

async function metricSessionIds(basePath: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const path of await metricsFiles(basePath)) {
    for (const { record } of await readMetricsRecords(path)) {
      if (!usageRecord(record)) continue
      const id = sessionId(record)
      if (id) ids.add(id)
    }
  }
  return ids
}

async function allMetricSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const base of await resolveProfileBases()) {
    for (const id of await metricSessionIds(base.path)) ids.add(id)
  }
  return ids
}

function basePathFor(source: SessionSource): string {
  if (source.sourcePath) return source.sourcePath
  return resolve(source.path, '..', '..')
}

function commonCallFields(source: SessionSource, basePath: string) {
  return {
    provider: 'quickdesk',
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    bashCommands: [] as string[],
    speed: 'standard' as const,
    project: source.project,
    projectPath: basePath,
  }
}

function createMetricsParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const records = await readMetricsRecords(source.path)
      const basePath = basePathFor(source)
      const linkedTools = collectMetricTools(records)
      const snapshot = loadDatabaseSnapshot(basePath)
      const fileId = basename(source.path)

      for (const { record } of records) {
        if (!usageRecord(record)) continue
        const model = stringValue(record['Model'])
        const inputTokens = nonNegativeNumber(record['InputTokens'])!
        const outputTokens = nonNegativeNumber(record['OutputTokens'])!
        const timestamp = metricsTimestamp(record, source.path)
        if (!timestamp) continue

        const linkedSessionId = sessionId(record)
        const metadata = linkedSessionId ? snapshot.sessions.get(linkedSessionId) : undefined
        if (metadata?.deleted) continue

        const fallbackId = `${source.project}:${fileId}`
        const deduplicationKey = `quickdesk:${linkedSessionId || fallbackId}:${timestamp}:${model}:${inputTokens}:${outputTokens}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        const recordedCost = nonNegativeNumber(record['CostUSD'])
        const costIsEstimated = recordedCost === undefined
        const metricTools = linkedTools.get(toolsKey(record)) ?? []
        const tools = uniqueMappedTools([...metricTools, ...(metadata?.tools ?? [])])

        yield {
          ...commonCallFields(source, basePath),
          model,
          inputTokens,
          outputTokens,
          costUSD: recordedCost ?? calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
          costIsEstimated,
          tools,
          timestamp,
          deduplicationKey,
          userMessage: metadata?.firstUserMessage ?? '',
          sessionId: linkedSessionId || fileId,
        }
      }
    },
  }
}

function createDatabaseParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const basePath = basePathFor(source)
      const snapshot = loadDatabaseSnapshot(basePath)
      if (!snapshot.canEstimate) return
      const meteredSessions = await allMetricSessionIds()

      for (const metadata of snapshot.sessions.values()) {
        if (metadata.deleted || meteredSessions.has(metadata.id) || metadata.createdAt === undefined) continue
        const createdAtSeconds = metadata.createdAt > 1_000_000_000_000
          ? metadata.createdAt / 1000
          : metadata.createdAt
        const timestamp = unixSecondsIso(createdAtSeconds)
        if (!timestamp) continue
        const inputTokens = estimateTokensFromChars(metadata.inputChars)
        const outputTokens = estimateTokensFromChars(metadata.outputChars)
        if (inputTokens + outputTokens === 0) continue

        const deduplicationKey = `quickdesk-est:${metadata.id}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)
        const model = 'quickdesk-auto'

        yield {
          ...commonCallFields(source, basePath),
          model,
          inputTokens,
          outputTokens,
          costUSD: calculateCost(model, inputTokens, outputTokens, 0, 0, 0),
          costIsEstimated: true,
          tools: metadata.tools,
          timestamp,
          deduplicationKey,
          userMessage: metadata.firstUserMessage,
          sessionId: metadata.id,
        }
      }
    },
  }
}

export const quickdesk: Provider = {
  name: 'quickdesk',
  displayName: 'Quick Desktop',
  durableSources: true,

  modelDisplayName(model: string): string {
    if (model === 'quickdesk-auto') return 'Quick Desktop (auto)'
    return modelDisplayNames[model] ?? model
  },

  toolDisplayName(rawTool: string): string {
    return toolNameMap[rawTool] ?? rawTool
  },

  async probeRoots(): Promise<ProbeRoot[]> {
    return (await resolveProfileBases()).map(base => ({ path: base.path, label: base.profile }))
  },

  async discoverSessions(): Promise<SessionSource[]> {
    return discoverSources()
  },

  createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
    return source.sourceId === 'sessions-db' || basename(source.path) === 'sessions.db'
      ? createDatabaseParser(source, seenKeys)
      : createMetricsParser(source, seenKeys)
  },
}
