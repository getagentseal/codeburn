import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'node:crypto'
import zlib from 'zlib'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { getSqliteLoadError, isSqliteAvailable, isSqliteBusyError, openDatabase, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall, ProbeRoot } from './types.js'

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  exec: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  dispatch_agent: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  patch: 'Patch',
}

type OpenClawUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens?: number
  cost?: {
    total?: number
  }
}

type OpenClawEntry = {
  type: string
  customType?: string
  id?: string
  timestamp?: string
  provider?: string
  modelId?: string
  data?: {
    provider?: string
    modelId?: string
  }
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }>
    model?: string
    provider?: string
    usage?: OpenClawUsage
  }
}

type SessionIndex = Record<string, {
  sessionId: string
  sessionFile?: string
}>

type OpenClawCall = {
  model: string
  usage: OpenClawUsage
  tools: string[]
  bashCommands: string[]
  timestamp: string
  /** SQLite row created_at (ms); retry timestamp before the store-wide fallback. */
  createdAtMs?: number
  userMessage: string
  dedupId: string
}

// The event envelopes are identical across storage eras: the 2026-09-01
// migration copied each JSONL line verbatim into transcript_events.event_json,
// so both parsers run the same reducer below and only the row source differs.
type EventState = {
  sessionId: string
  sessionTimestamp: string
  currentModel: string
  pendingUserMessage: string
  calls: OpenClawCall[]
  /** Occurrence index per id-less payload hash; identical id-less events must stay distinct. */
  idLessCounts: Map<string, number>
}

function newState(): EventState {
  return { sessionId: '', sessionTimestamp: '', currentModel: '', pendingUserMessage: '', calls: [], idLessCounts: new Map() }
}

function consumeEvent(state: EventState, entry: OpenClawEntry, rowCreatedAtMs?: number): void {
  if (entry.type === 'session') {
    state.sessionId = entry.id ?? state.sessionId
    state.sessionTimestamp = entry.timestamp ?? ''
    return
  }

  if (entry.type === 'model_change') {
    state.currentModel = entry.modelId ?? state.currentModel
    return
  }

  if (entry.type === 'custom' && entry.customType === 'model-snapshot') {
    state.currentModel = entry.data?.modelId ?? state.currentModel
    return
  }

  if (entry.type !== 'message' || !entry.message) return

  const msg = entry.message
  if (msg.role === 'user') {
    if (!state.pendingUserMessage && Array.isArray(msg.content)) {
      const textBlock = msg.content.find(c => c.type === 'text' && c.text)
      state.pendingUserMessage = (textBlock?.text ?? '').slice(0, 500)
    }
    return
  }

  if (msg.role !== 'assistant') return

  const model = msg.model ?? state.currentModel
  if (msg.usage) {
    const { tools, bashCommands } = extractTools(msg.content)
    // A SQLite row whose envelope carries no timestamp falls back to the row's
    // created_at before the store-wide fallback in finalizeCalls.
    let timestamp = entry.timestamp ?? state.sessionTimestamp
    if (!timestamp && rowCreatedAtMs !== undefined) timestamp = new Date(rowCreatedAtMs).toISOString()
    // An id-less envelope gets a payload hash plus its occurrence index within
    // the session. Both eras preserve event order, so the same id-less event
    // hashes and counts to the same key in either storage era — a session
    // re-parsed from the other era still collapses to one — while repeats
    // within a session no longer drop real calls as duplicates.
    let dedupId = entry.id
    if (!dedupId) {
      const hash = createHash('sha256').update(JSON.stringify([
        model,
        entry.timestamp ?? state.sessionTimestamp,
        msg.usage.input,
        msg.usage.output,
        msg.usage.cacheRead,
        msg.usage.cacheWrite,
        msg.usage.cost?.total ?? 0,
        tools,
        bashCommands,
      ])).digest('hex').slice(0, 16)
      const n = state.idLessCounts.get(hash) ?? 0
      state.idLessCounts.set(hash, n + 1)
      dedupId = `h:${hash}:${n}`
    }
    state.calls.push({
      model,
      usage: msg.usage,
      tools,
      bashCommands,
      timestamp,
      ...(rowCreatedAtMs !== undefined ? { createdAtMs: rowCreatedAtMs } : {}),
      userMessage: state.pendingUserMessage,
      dedupId,
    })
    state.pendingUserMessage = ''
  }
}

async function* finalizeCalls(
  state: EventState,
  defaultSessionId: string,
  fallbackTs: Date,
  seenKeys: Set<string>,
): AsyncGenerator<ParsedProviderCall> {
  const sessionId = state.sessionId || defaultSessionId

  for (let i = 0; i < state.calls.length; i++) {
    const call = state.calls[i]
    const dedupKey = `openclaw:${sessionId}:${call.dedupId || i}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const u = call.usage
    // OpenClaw writes what the call actually cost, per message (never a
    // running session total), in USD. Absent or 0 means "not recorded":
    // those fall back to token pricing and must stay re-priceable.
    const costFromProvider = u.cost?.total ?? 0
    const isReported = costFromProvider > 0
    const costUSD = isReported
      ? costFromProvider
      : calculateCost(call.model, u.input, u.output, u.cacheWrite, u.cacheRead, 0)

    let ts = new Date(call.timestamp)
    // A present-but-unparseable envelope timestamp must not land the call on
    // the store's mtime ("now" on a live gateway): retry the row's created_at
    // before the store-wide fallback.
    if (isNaN(ts.getTime()) || ts.getTime() < 1_000_000_000_000) {
      ts = call.createdAtMs !== undefined ? new Date(call.createdAtMs) : fallbackTs
    }
    if (isNaN(ts.getTime()) || ts.getTime() < 1_000_000_000_000) ts = fallbackTs
    if (isNaN(ts.getTime()) || ts.getTime() < 1_000_000_000_000) continue

    yield {
      provider: 'openclaw',
      model: call.model || 'openclaw-auto',
      inputTokens: u.input,
      outputTokens: u.output,
      cacheCreationInputTokens: u.cacheWrite,
      cacheReadInputTokens: u.cacheRead,
      cachedInputTokens: u.cacheRead,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD,
      ...(isReported ? { costFromBilling: true } : {}),
      tools: [...new Set(call.tools)],
      bashCommands: [...new Set(call.bashCommands)],
      timestamp: ts.toISOString(),
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: call.userMessage,
      sessionId,
    }
  }
}

function normalizeHomeDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed !== 'undefined' && trimmed !== 'null' ? trimmed : undefined
}

function getOpenClawDirs(): string[] {
  let osHome = normalizeHomeDir(process.env['HOME']) ?? normalizeHomeDir(process.env['USERPROFILE'])
  // OpenClaw also supports Termux when neither conventional home variable is
  // set. A generic PREFIX alone is not enough to select this fallback.
  if (!osHome) {
    const prefix = normalizeHomeDir(process.env['PREFIX'])
    if (prefix && normalizeHomeDir(process.env['ANDROID_DATA'])
      && /(?:^|\/)com\.termux\/files\/usr\/?$/.test(prefix.replace(/\\/g, '/'))) {
      osHome = resolve(prefix, '..', 'home')
    }
  }
  if (!osHome) {
    try {
      osHome = normalizeHomeDir(homedir())
    } catch {
      // OpenClaw's required-home resolver falls back to cwd when the OS
      // lookup cannot provide a home. Apply the same rule without aborting.
    }
  }
  const expandHome = (path: string, home: string): string => resolve(path.replace(/^~(?=$|[\\/])/, () => home))
  // OpenClaw resolves state overrides against its effective home. Trim before
  // expanding so a quoted "~/state" works just like its own path resolver.
  const configuredHome = normalizeHomeDir(process.env['OPENCLAW_HOME'])
  let effectiveHome = configuredHome ?? osHome
  if (configuredHome && /^~(?=$|[\\/])/.test(configuredHome)) {
    // An unresolved tilde override has no effective home. OpenClaw falls back
    // to cwd itself, rather than expanding the remaining suffix under cwd.
    effectiveHome = osHome ? expandHome(configuredHome, osHome) : undefined
  }
  const home = resolve(effectiveHome ?? process.cwd())
  const stateDir = process.env['OPENCLAW_STATE_DIR']?.trim()
  const roots = [
    ...(stateDir ? [join(expandHome(stateDir, home), 'agents')] : []),
    join(home, '.openclaw', 'agents'),
    join(home, '.clawdbot', 'agents'),
    join(home, '.moltbot', 'agents'),
    join(home, '.moldbot', 'agents'),
  ]
  // Keep the historical roots for pre-migration sessions, but scan an override
  // pointing at one of those roots only once (including case aliases on Windows).
  const unique = new Map<string, string>()
  for (const root of roots) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (!unique.has(key)) unique.set(key, root)
  }
  return [...unique.values()]
}

function extractTools(content: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }> | undefined): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []
  if (!content) return { tools, bashCommands }

  for (const block of content) {
    if ((block.type === 'tool_use' || block.type === 'toolCall') && block.name) {
      const mapped = toolNameMap[block.name] ?? block.name
      tools.push(mapped)
      if (mapped === 'Bash' && block.arguments && typeof block.arguments.command === 'string') {
        bashCommands.push(...extractBashCommands(block.arguments.command))
      }
    }
  }
  return { tools, bashCommands }
}

function createJsonlParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      const state = newState()

      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let entry: OpenClawEntry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        consumeEvent(state, entry)
      }

      // Fallback for a call whose own timestamp is missing/unparseable: the
      // file's mtime keeps the call inside the session's window instead of
      // dropping real spend (matches openclaude.ts/codewhale.ts).
      const fileStat = await stat(source.path).catch(() => null)
      const fileMtime = fileStat ? fileStat.mtime : new Date(NaN)

      yield* finalizeCalls(state, basename(source.path, '.jsonl'), fileMtime, seenKeys)
    },
  }
}

/// agent-schema 23 (in flight upstream) lets a transcript row store its event
/// as a zstd BLOB instead of event_json TEXT. zstd landed in node:zlib in
/// 22.15 / 23.8 while the package floor is lower, so the export is optional
/// and rows that cannot be decoded are skipped with one notice per run.
const zstdDecompressSync = (zlib as unknown as { zstdDecompressSync?: (buf: Uint8Array, opts?: { maxOutputLength?: number }) => Buffer }).zstdDecompressSync

// The schema CHECK bounds a compressed payload and its decoded form at 4 MiB;
// decode with headroom rather than an unbounded buffer.
const MAX_EVENT_DECODED_BYTES = 8 * 1024 * 1024

const sqliteNoticeSent = new Set<string>()
function sqliteNotice(message: string): void {
  if (sqliteNoticeSent.has(message)) return
  sqliteNoticeSent.add(message)
  process.stderr.write(message)
}

type TranscriptRow = {
  seq: number | bigint
  event_json: string | null
  event_zstd?: Uint8Array | null
  created_at: number | bigint
}

function transcriptHasZstdColumn(db: SqliteDatabase): boolean {
  try {
    const columns = db.query<{ name: unknown }>('PRAGMA table_info(transcript_events)')
    return columns.some(c => c.name === 'event_zstd')
  } catch {
    return false
  }
}

function decodeEventPayload(row: TranscriptRow, dbPath: string): string | null {
  if (typeof row.event_json === 'string') return row.event_json
  if (row.event_zstd == null || !(row.event_zstd instanceof Uint8Array)) return null
  if (!zstdDecompressSync) {
    sqliteNotice(
      `codeburn: openclaw: ${dbPath} stores compressed transcript rows; counting them needs Node 22.15+ (node:zlib zstd)\n`,
    )
    return null
  }
  try {
    return zstdDecompressSync(row.event_zstd, { maxOutputLength: MAX_EVENT_DECODED_BYTES }).toString('utf-8')
  } catch {
    // A torn row understates usage silently unless we say so; one notice per
    // store keeps it visible without per-row spam.
    sqliteNotice(`codeburn: openclaw: ${dbPath} has compressed transcript rows that fail to decode; skipping them\n`)
    return null
  }
}

/// Source paths carry the session id after the database path (forge.ts
/// convention), so each SQLite session parses — and dedups — on its own.
function splitSqliteSource(path: string): { dbPath: string; sessionId: string } | null {
  const idx = path.lastIndexOf(':')
  if (idx < 0) return null
  return { dbPath: path.slice(0, idx), sessionId: path.slice(idx + 1) }
}

// Keyset batches keep peak memory to one batch of envelopes, not the whole
// session, for agents whose transcript DB reaches gigabytes (#1504 class).
const TRANSCRIPT_BATCH_ROWS = 2000

function createSqliteParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const split = splitSqliteSource(source.path)
      if (!split) return

      let db: SqliteDatabase
      try {
        db = openDatabase(split.dbPath)
      } catch {
        return
      }

      const state = newState()
      try {
        const zstdColumn = transcriptHasZstdColumn(db) ? ', event_zstd' : ''
        let lastSeq = -1
        for (;;) {
          const rows = db.query<TranscriptRow>(
            `SELECT seq, event_json${zstdColumn}, created_at
             FROM transcript_events
             WHERE session_id = ? AND seq > ?
             ORDER BY seq
             LIMIT ?`,
            [split.sessionId, lastSeq, TRANSCRIPT_BATCH_ROWS],
          )
          for (const row of rows) {
            lastSeq = Number(row.seq)
            const payload = decodeEventPayload(row, split.dbPath)
            if (payload === null) continue
            let entry: OpenClawEntry
            try {
              entry = JSON.parse(payload)
            } catch {
              continue
            }
            consumeEvent(state, entry, Number(row.created_at))
          }
          if (rows.length < TRANSCRIPT_BATCH_ROWS) break
        }
      } finally {
        db.close()
      }

      // Same fallback policy as the JSONL side, but against the store: a call
      // with no usable timestamp rides the database file's mtime.
      const fileStat = await stat(split.dbPath).catch(() => null)
      const fileMtime = fileStat ? fileStat.mtime : new Date(NaN)

      yield* finalizeCalls(state, split.sessionId, fileMtime, seenKeys)
    },
  }
}

async function discoverSqliteSessions(agentsDir: string, agent: string): Promise<{ sources: SessionSource[]; sessionIds: Set<string> }> {
  const dbPath = join(agentsDir, agent, 'agent', 'openclaw-agent.sqlite')

  const dbStat = await stat(dbPath).catch(() => null)
  if (!dbStat) return { sources: [], sessionIds: new Set() }

  if (!isSqliteAvailable()) {
    sqliteNotice(getSqliteLoadError() + '\n')
    return { sources: [], sessionIds: new Set() }
  }

  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch (err) {
    // A locked store proves nothing about absence: reading it as "no sessions"
    // would let that run look complete-but-empty while the legacy JSONL of
    // already-migrated sessions comes back. BUSY propagates like hermes.ts.
    if (isSqliteBusyError(err)) throw err
    return { sources: [], sessionIds: new Set() }
  }

  try {
    const rows = db.query<{ session_id: unknown }>(
      'SELECT session_id FROM transcript_events GROUP BY session_id ORDER BY session_id',
    )
    const sources: SessionSource[] = []
    const sessionIds = new Set<string>()
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || !row.session_id) continue
      sessionIds.add(row.session_id)
      sources.push({ path: `${dbPath}:${row.session_id}`, project: agent, provider: 'openclaw' })
    }
    return { sources, sessionIds }
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    // Not an agent-schema store (no transcript_events) or unreadable: the
    // JSONL discovery still covers pre-migration layouts.
    return { sources: [], sessionIds: new Set() }
  } finally {
    db.close()
  }
}

async function discoverInDir(agentsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let agentDirs: string[]
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true })
    agentDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return sources
  }

  for (const agent of agentDirs) {
    const sessionsDir = join(agentsDir, agent, 'sessions')

    let indexData: SessionIndex = {}
    try {
      const indexRaw = await readFile(join(sessionsDir, 'sessions.json'), 'utf-8')
      indexData = JSON.parse(indexRaw)
    } catch { /* no index, fall back to directory scan */ }

    const seenFiles = new Set<string>()
    const jsonlSources: Array<{ source: SessionSource; sessionId: string }> = []

    for (const entry of Object.values(indexData)) {
      if (entry.sessionFile) {
        seenFiles.add(entry.sessionFile)
        jsonlSources.push({ source: { path: entry.sessionFile, project: agent, provider: 'openclaw' }, sessionId: entry.sessionId })
      } else if (entry.sessionId) {
        const filePath = join(sessionsDir, `${entry.sessionId}.jsonl`)
        seenFiles.add(filePath)
        jsonlSources.push({ source: { path: filePath, project: agent, provider: 'openclaw' }, sessionId: entry.sessionId })
      }
    }

    try {
      const files = await readdir(sessionsDir)
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const filePath = join(sessionsDir, f)
        if (seenFiles.has(filePath)) continue
        jsonlSources.push({ source: { path: filePath, project: agent, provider: 'openclaw' }, sessionId: basename(f, '.jsonl') })
      }
    } catch { /* directory may not exist */ }

    // Post-2026-09-01 the transcript lives in the per-agent SQLite store and
    // the .jsonl files are archived or renamed *.jsonl.deleted.<ts> (#1259).
    const sqlite = await discoverSqliteSessions(agentsDir, agent)
    // Once a session was imported, the store is authoritative and a legacy
    // file still on disk (partial migration, restored backup) must not shadow
    // it. Keeping both live is not an alternative: the parse-time dedup seeds
    // from the legacy file's cached turns, so the store's first parse would
    // bake a suppressed result into its session-cache entry, and once the
    // legacy file is archived and its cache entry evicted, the imported
    // history would be gone from every report until the store changed.
    for (const { source, sessionId } of jsonlSources) {
      if (sqlite.sessionIds.has(sessionId)) continue
      sources.push(source)
    }
    sources.push(...sqlite.sources)
  }

  return sources
}

export function createOpenClawProvider(overrideDir?: string): Provider {
  return {
    name: 'openclaw',
    displayName: 'OpenClaw',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      // #899: empty agents root that exists must be distinguishable from missing install.
      const roots = overrideDir ? [overrideDir] : getOpenClawDirs()
      return roots.map(path => ({ path, label: 'agents' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (overrideDir) return discoverInDir(overrideDir)
      const all: SessionSource[] = []
      for (const dir of getOpenClawDirs()) {
        const sessions = await discoverInDir(dir)
        all.push(...sessions)
      }
      return all
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return source.path.endsWith('.jsonl')
        ? createJsonlParser(source, seenKeys)
        : createSqliteParser(source, seenKeys)
    },
  }
}

export const openclaw = createOpenClawProvider()
