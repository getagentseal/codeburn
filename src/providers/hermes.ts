import { readdir, stat } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { readGitOriginUrl } from '../git-origin.js'
import { calculateCost, getShortModelName, routeFromProviderField } from '../models.js'
import { isUserHomeRoot } from '../path-privacy.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, isSqliteBusyError, type SqliteDatabase } from '../sqlite.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import type { ToolCall } from '../types.js'
import {
  getHermesCursor,
  hermesBaselineKey,
  hermesLedgerNow,
  hermesObservationKey,
  listHermesCursorSessionIds,
  loadHermesSessionLedger,
  recordHermesSnapshot,
  zeroHermesTokens,
  isHermesLedgerPublicationError,
  type HermesCostBasis,
  type HermesObservation,
  type HermesTokenTotals,
} from '../hermes-session-ledger.js'

type HermesSessionRow = {
  id: string
  source: string | null
  model: string | null
  cwd: string | null
  git_repo_root: string | null
  billing_provider: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  cost_status: string | null
  cost_source: string | null
  api_call_count: number | null
  tool_call_count: number | null
  started_at: number | null
  ended_at: number | null
  title: string | null
}

type HermesMessageRow = {
  id: number | null
  role: string
  content: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number | null
}

type HermesToolCall = {
  function?: {
    name?: string
    arguments?: string
  }
}

type ProfileDb = {
  dbPath: string
  profile: string
}

type TableInfoRow = {
  name: string
}

type TableColumn = keyof HermesSessionRow | keyof HermesMessageRow

const toolNameMap: Record<string, string> = {
  terminal: 'Bash',
  execute_code: 'CodeExecution',
  read_file: 'Read',
  search_files: 'Grep',
  write_file: 'Write',
  patch: 'Edit',
  browser_navigate: 'Browser',
  browser_click: 'Browser',
  browser_type: 'Browser',
  browser_press: 'Browser',
  browser_scroll: 'Browser',
  browser_snapshot: 'Browser',
  browser_vision: 'Vision',
  browser_console: 'Browser',
  browser_get_images: 'Browser',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
  delegate_task: 'Agent',
  vision_analyze: 'Vision',
  process: 'Bash',
  todo: 'TodoWrite',
  skill_view: 'Skill',
  skill_manage: 'Skill',
  skills_list: 'Skill',
  memory: 'Memory',
  session_search: 'SessionSearch',
}

function getHermesHome(override?: string): string {
  return override ?? process.env['HERMES_HOME'] ?? join(homedir(), '.hermes')
}

function displayProjectForProfile(profile: string): string {
  return profile === 'default' ? 'hermes' : sanitizeProject(profile)
}

function stripCodeRegions(text: string): string {
  const out: string[] = []
  let fence: { marker: string; length: number } | null = null
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\s+$/, '')
    const open = trimmed.match(/^(\s*)([`~]{3,})(.*)$/)
    if (!fence) {
      if (open && !open[3].includes(open[2][0]!)) {
        fence = { marker: open[2][0]!, length: open[2].length }
        out.push(' ')
        continue
      }
      if (/^[ \t]{4,}\S/.test(line)) {
        out.push(' ')
        continue
      }
      out.push(line.replace(/`[^`]*`/g, ' '))
      continue
    }
    const close = trimmed.match(/^(\s*)([`~]{3,})\s*$/)
    if (close && close[2][0] === fence.marker && close[2].length >= fence.length) {
      fence = null
    }
    out.push(' ')
  }
  return out.join('\n')
}

function githubOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const gh = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (!gh) return null
  return { owner: gh[1].toLowerCase(), repo: gh[2].replace(/\.git$/i, '').toLowerCase() }
}

// Memoized per repo root: every session in the same repo would otherwise
// re-read .git/config. Process-lifetime only, so a remote URL change needs a
// restart (a resident `serve` child included).
const originIdentityByRoot = new Map<string, { owner: string; repo: string } | null>()

function githubOwnerRepoFromRoot(repoRoot: string): { owner: string; repo: string } | null {
  const memo = originIdentityByRoot.get(repoRoot)
  if (memo !== undefined) return memo
  const identity = readGithubOwnerRepoFromRoot(repoRoot)
  originIdentityByRoot.set(repoRoot, identity)
  return identity
}

function readGithubOwnerRepoFromRoot(repoRoot: string): { owner: string; repo: string } | null {
  const url = readGitOriginUrl(repoRoot)
  return url ? githubOwnerRepoFromUrl(url) : null
}

function extractGithubPullUrls(
  texts: Array<string | null | undefined>,
  identity: { owner: string; repo: string } | null,
): string[] {
  if (!identity) return []
  const found = new Set<string>()
  const re = /https:\/\/github\.com\/[^/\s"'<>]+\/[^/\s"'<>]+\/pull\/\d+/gi
  for (const text of texts) {
    if (!text) continue
    const searchable = stripCodeRegions(text)
    for (const match of searchable.matchAll(re)) {
      try {
        const url = new URL(match[0])
        if (url.protocol !== 'https:') continue
        const pathMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+$/)
        if (!pathMatch) continue
        if (pathMatch[1].toLowerCase() !== identity.owner) continue
        if (pathMatch[2].toLowerCase() !== identity.repo) continue
        found.add(`${url.origin}${url.pathname}`)
      } catch {
        // skip malformed
      }
    }
  }
  return [...found].sort()
}

function statSyncSafe(path: string): 'file' | 'dir' | null {
  try {
    const st = statSync(path)
    if (st.isFile()) return 'file'
    if (st.isDirectory()) return 'dir'
    return null
  } catch {
    return null
  }
}

function sanitizeProject(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'hermes'
  return trimmed.replace(/^[/\\]+/, '').replace(/[:/\\]/g, '-')
}

function parseProfileName(dbPath: string, hermesHome: string): string {
  const profilesDir = join(hermesHome, 'profiles')
  const dir = dirname(dbPath)
  if (dirname(dir) === profilesDir) return basename(dir)
  return 'default'
}

async function findStateDbs(hermesHome: string): Promise<ProfileDb[]> {
  const dbs: ProfileDb[] = []
  const rootDb = join(hermesHome, 'state.db')
  const rootStat = await stat(rootDb).catch(() => null)
  if (rootStat?.isFile()) dbs.push({ dbPath: rootDb, profile: 'default' })

  const profilesDir = join(hermesHome, 'profiles')
  const profiles = await readdir(profilesDir, { withFileTypes: true }).catch(() => [])
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const dbPath = join(profilesDir, entry.name, 'state.db')
    const s = await stat(dbPath).catch(() => null)
    if (s?.isFile()) dbs.push({ dbPath, profile: entry.name })
  }
  return dbs
}

function encodeSourcePath(dbPath: string, sessionId: string): string {
  return `${dbPath}#hermes-session=${encodeURIComponent(sessionId)}`
}

function decodeSourcePath(path: string): { dbPath: string; sessionId: string } | null {
  const marker = '#hermes-session='
  const idx = path.lastIndexOf(marker)
  if (idx === -1) return null
  return {
    dbPath: path.slice(0, idx),
    sessionId: decodeURIComponent(path.slice(idx + marker.length)),
  }
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query('SELECT session_id, role, content, tool_calls FROM messages LIMIT 1')
    const columns = getSessionColumns(db)
    return columns.has('id') && columns.has('input_tokens') && columns.has('output_tokens')
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    return false
  }
}

function getSessionColumns(db: SqliteDatabase): Set<string> {
  return new Set(db.query<TableInfoRow>('PRAGMA table_info(sessions)').map(row => row.name))
}

function numberColumn(columns: Set<string>, name: TableColumn): string {
  return columns.has(name) ? `coalesce(${name}, 0) AS ${name}` : `0 AS ${name}`
}

function nullableColumn(columns: Set<string>, name: TableColumn): string {
  return columns.has(name) ? name : `NULL AS ${name}`
}

function getMessageColumns(db: SqliteDatabase): Set<string> {
  return new Set(db.query<TableInfoRow>('PRAGMA table_info(messages)').map(row => row.name))
}

function usageExpression(columns: Set<string>): string {
  const usageColumns: Array<keyof HermesSessionRow> = [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
  ]
  const parts = usageColumns
    .filter(name => columns.has(name))
    .map(name => `coalesce(${name}, 0)`)
  return parts.length > 0 ? parts.join(' + ') : '0'
}

function parseTimestamp(raw: number | null): string {
  if (raw == null) return ''
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function firstUserMessage(messages: HermesMessageRow[]): string {
  const msg = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0)
  return Array.from(msg?.content ?? '').slice(0, 500).join('')
}

function mapToolName(raw: string): string {
  // Composio MCP tools are matched first — the generic mcp_ prefix on line
  // below would also match composio names, so order matters here.
  if (raw.startsWith('mcp_composio_')) return 'MCP'
  if (raw.startsWith('mcp_') || raw.startsWith('mcp__')) return raw
  if (raw.startsWith('browser_')) return 'Browser'
  return toolNameMap[raw] ?? raw
}

function parseToolCalls(raw: string | null): HermesToolCall[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as HermesToolCall[] : []
  } catch {
    return []
  }
}

function collectTools(messages: HermesMessageRow[]): { tools: string[]; toolSequence: ToolCall[][]; bashCommands: string[] } {
  const tools: string[] = []
  const toolSequence: ToolCall[][] = []
  const bashCommands: string[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const currentTurnTools: ToolCall[] = []
      for (const call of parseToolCalls(msg.tool_calls)) {
        const rawName = call.function?.name ?? ''
        if (!rawName) continue
        const mapped = mapToolName(rawName)
        tools.push(mapped)
        const toolCall: ToolCall = { tool: mapped }
        const rawArgs = call.function?.arguments
        if (rawArgs) {
          try {
            const args = JSON.parse(rawArgs) as Record<string, unknown>
            const file = args['path'] ?? args['file_path']
            if (typeof file === 'string') toolCall.file = file
            const command = args['command']
            if (typeof command === 'string') {
              toolCall.command = command
              bashCommands.push(command)
            }
          } catch {
            // Ignore malformed arguments from historical sessions.
          }
        }
        currentTurnTools.push(toolCall)
      }
      if (currentTurnTools.length > 0) {
        toolSequence.push(currentTurnTools)
      }
    } else if (msg.role === 'tool' && msg.tool_name) {
      tools.push(mapToolName(msg.tool_name))
    }
  }

  return {
    tools: [...new Set(tools)],
    toolSequence: toolSequence.length > 0 ? toolSequence : [],
    bashCommands,
  }
}

function isRealWorkspace(cwd: string | null | undefined): cwd is string {
  if (!cwd?.trim()) return false
  const trimmed = cwd.trim()
  // A state.db is only ever read from this machine's own Hermes home
  // (`HERMES_HOME` or `~/.hermes`), so the shapes it can hold are the host's.
  // A Windows host also takes a POSIX-rooted path, which its own tooling
  // produces (WSL, MSYS); a POSIX host takes only a POSIX-rooted path, so a
  // literal `C:\...` string stays the non-workspace it has always been there.
  // Slash-UNC (//server/share) stays out: it is not a local workspace.
  const isAbsolute = process.platform === 'win32'
    ? /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\[^\\/]+\\/.test(trimmed)
      || (trimmed.startsWith('/') && !trimmed.startsWith('//'))
    : trimmed.startsWith('/') && !trimmed.startsWith('//')
  if (!isAbsolute) return false
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '/' || normalized === homedir() || normalized === homedir().replace(/\\/g, '/') || isUserHomeRoot(normalized)) return false
  if (/\.app\/Contents\//.test(normalized)) return false
  return true
}

function resolveHermesWorkspace(
  row: HermesSessionRow,
  messages: HermesMessageRow[],
): { project: string; projectPath?: string; workingDirectory?: string; provider: 'hermes' } {
  const provider = 'hermes' as const
  const repo = row.git_repo_root?.trim()
  if (isRealWorkspace(repo)) {
    return { project: sanitizeProject(basename(repo)), projectPath: repo, workingDirectory: repo, provider }
  }
  const cwd = row.cwd?.trim()
  if (isRealWorkspace(cwd)) {
    return { project: sanitizeProject(cwd), projectPath: cwd, workingDirectory: cwd, provider }
  }
  const inferred = inferProject(messages, '')
  if (isRealWorkspace(inferred.projectPath)) {
    // Prompt-derived paths remain local display/grouping labels only.
    return { project: inferred.project, provider }
  }
  return { project: provider, provider }
}

function tokenSum(tokens: HermesTokenTotals): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.reasoningTokens
}

function resolveHermesCost(
  row: HermesSessionRow | undefined,
  model: string,
  tokens: HermesTokenTotals,
): { costUSD: number; costIsEstimated: boolean; costBasis: HermesCostBasis } {
  const calculatedCost = calculateCost(
    model,
    tokens.inputTokens,
    tokens.outputTokens + tokens.reasoningTokens,
    tokens.cacheWriteTokens,
    tokens.cacheReadTokens,
    0,
  )
  // actual is a recorded invoice amount; explicit $0 still counts as recorded.
  if (row && row.actual_cost_usd != null) {
    return { costUSD: row.actual_cost_usd, costIsEstimated: false, costBasis: 'actual' }
  }
  const costStatus = row?.cost_status?.trim().toLowerCase()
  const costSource = row?.cost_source?.trim().toLowerCase()
  // Included subscription usage is real activity but not metered API spend.
  // Its recorded zero must win over API-equivalent token pricing.
  if (costStatus === 'included') {
    return { costUSD: 0, costIsEstimated: false, costBasis: 'included' }
  }
  // An explicit Hermes estimate is authoritative even when it is zero (for
  // example, a provider's free tier). Preserve that provenance in the UI.
  if (costStatus === 'estimated' && row?.estimated_cost_usd != null) {
    return { costUSD: row.estimated_cost_usd, costIsEstimated: true, costBasis: 'estimated' }
  }
  // Only rows predating BOTH provenance fields use the legacy positive-estimate
  // fallback. A provenance-aware `unknown` row can retain a partial estimate
  // from earlier priced calls; treating that as the session total undercounts.
  if (!costStatus && !costSource && row && row.estimated_cost_usd != null && row.estimated_cost_usd > 0) {
    return { costUSD: row.estimated_cost_usd, costIsEstimated: true, costBasis: 'estimated' }
  }
  return { costUSD: calculatedCost, costIsEstimated: true, costBasis: 'calculated' }
}

function observationToCall(
  observation: HermesObservation,
  args: {
    profile: string
    sessionId: string
    model: string
    tools: string[]
    bashCommands: string[]
    toolSequence: ToolCall[][]
    userMessage: string
    project: string
    projectPath?: string
    workingDirectory?: string
    prLinks?: string[]
    costIsEstimated: boolean
    /// Route id from the session's `billing_provider` column, when it names a
    /// non-direct door (see routeFromProviderField). Undefined for direct or
    /// unknown, and for the vanished-DB cursor path, whose row is gone.
    route?: string
  },
): ParsedProviderCall {
  const later = observation.index > 0
  return {
    provider: 'hermes',
    model: args.model,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    cacheCreationInputTokens: observation.cacheWriteTokens,
    cacheReadInputTokens: observation.cacheReadTokens,
    cachedInputTokens: observation.cacheReadTokens,
    reasoningTokens: observation.reasoningTokens,
    webSearchRequests: 0,
    costUSD: observation.costUSD,
    // Later observations keep the stored basis. Included and actual are
    // recorded facts; estimated and calculated remain estimates.
    costIsEstimated: later
      ? observation.costBasis === 'calculated' || observation.costBasis === 'estimated'
      : args.costIsEstimated,
    tools: later ? [] : args.tools,
    bashCommands: later ? [] : args.bashCommands,
    timestamp: observation.timestamp,
    speed: 'standard',
    deduplicationKey: later
      ? hermesObservationKey(args.profile, args.sessionId, observation.index)
      : hermesBaselineKey(args.profile, args.sessionId),
    turnId: later ? `${args.sessionId}:obs:${observation.index}` : `${args.sessionId}:session`,
    toolSequence: later || args.toolSequence.length === 0 ? undefined : args.toolSequence,
    userMessage: later ? '' : args.userMessage,
    sessionId: args.sessionId,
    project: args.project,
    projectPath: args.projectPath,
    workingDirectory: args.workingDirectory,
    ...(later || !args.prLinks?.length ? {} : { prLinks: args.prLinks }),
    ...(later ? { supplementaryAccounting: true } : {}),
    ...(args.route ? { route: args.route } : {}),
  }
}

function inferProject(messages: HermesMessageRow[], fallback: string): { project: string; projectPath?: string } {
  const cwdPattern = /^Current working directory:\s*([a-zA-Z]:\\[^\r\n`"]+|\/[^\r\n`"\\]+)/m
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'system') continue
    const match = cwdPattern.exec(msg.content ?? '')
    if (match?.[1]) {
      const projectPath = match[1].trim()
      return { project: sanitizeProject(projectPath), projectPath }
    }
  }
  return { project: fallback }
}

async function discoverFromDb(dbPath: string, profile: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const columns = getSessionColumns(db)
    const usage = usageExpression(columns)
    const orderBy = columns.has('started_at') ? 'started_at DESC' : 'id DESC'
    const rows = db.query<HermesSessionRow>(
      `SELECT id,
              ${nullableColumn(columns, 'title')},
              ${numberColumn(columns, 'input_tokens')},
              ${numberColumn(columns, 'output_tokens')},
              ${numberColumn(columns, 'cache_read_tokens')},
              ${numberColumn(columns, 'cache_write_tokens')},
              ${numberColumn(columns, 'reasoning_tokens')}
       FROM sessions
       WHERE ${usage} > 0
       ORDER BY ${orderBy}
       LIMIT 10000`,
    )

    const sources = rows.map(row => ({
      path: encodeSourcePath(dbPath, row.id),
      project: displayProjectForProfile(profile),
      provider: 'hermes' as const,
    }))
    // After the >0 filter, reconcile every already-ledgered identity against
    // this state.db so an all-zero (or missing) row still reaches the cursor.
    // Without this, 150→0 is invisible and the later 40 is treated as a shrink.
    const discoveredIds = new Set(rows.map(row => row.id))
    const ledger = loadHermesSessionLedger()
    for (const sessionId of listHermesCursorSessionIds(ledger, profile)) {
      if (discoveredIds.has(sessionId)) continue
      sources.push({
        path: encodeSourcePath(dbPath, sessionId),
        project: displayProjectForProfile(profile),
        provider: 'hermes',
      })
    }
    return sources
  } catch (err) {
    if (isSqliteBusyError(err)) throw err
    process.stderr.write(`codeburn: error querying Hermes database: ${err instanceof Error ? err.message : err}\n`)
    return []
  } finally {
    db.close()
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>, hermesHome: string): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const decoded = decodeSourcePath(source.path)
      if (!decoded) return
      const profile = parseProfileName(decoded.dbPath, hermesHome)

      let db: SqliteDatabase
      try {
        db = openDatabase(decoded.dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Hermes database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      let result: {
        calls: ParsedProviderCall[]
      } | undefined
      try {
        if (!validateSchema(db)) return
        const columns = getSessionColumns(db)
        const rows = db.query<HermesSessionRow>(
          `SELECT id,
                  ${nullableColumn(columns, 'source')},
                  ${nullableColumn(columns, 'model')},
                  ${nullableColumn(columns, 'cwd')},
                  ${nullableColumn(columns, 'git_repo_root')},
                  ${nullableColumn(columns, 'billing_provider')},
                  ${numberColumn(columns, 'input_tokens')},
                  ${numberColumn(columns, 'output_tokens')},
                  ${numberColumn(columns, 'cache_read_tokens')},
                  ${numberColumn(columns, 'cache_write_tokens')},
                  ${numberColumn(columns, 'reasoning_tokens')},
                  ${nullableColumn(columns, 'estimated_cost_usd')},
                  ${nullableColumn(columns, 'actual_cost_usd')},
                  ${nullableColumn(columns, 'cost_status')},
                  ${nullableColumn(columns, 'cost_source')},
                  ${numberColumn(columns, 'api_call_count')},
                  ${numberColumn(columns, 'tool_call_count')},
                  ${nullableColumn(columns, 'started_at')},
                  ${nullableColumn(columns, 'ended_at')},
                  ${nullableColumn(columns, 'title')}
           FROM sessions
           WHERE id = ?`,
          [decoded.sessionId],
        )
        const row = rows[0]
        const ledger = loadHermesSessionLedger()
        const existingCursor = getHermesCursor(ledger, profile, decoded.sessionId)
        if (!row) {
          if (!existingCursor) return
          const baselineKey = hermesBaselineKey(profile, decoded.sessionId)
          if (seenKeys.has(baselineKey)) return
          seenKeys.add(baselineKey)
          const cursor = await recordHermesSnapshot({
            profile,
            sessionId: decoded.sessionId,
            startedAt: existingCursor.observations[0]?.timestamp || hermesLedgerNow().toISOString(),
            observedAt: hermesLedgerNow().toISOString(),
            tokens: zeroHermesTokens(),
            costUSD: 0,
            costBasis: 'calculated',
          })
          for (const observation of cursor.observations) {
            if (observation.index > 0) seenKeys.add(hermesObservationKey(profile, decoded.sessionId, observation.index))
          }
          result = {
            calls: cursor.observations.map(observation => observationToCall(observation, {
              profile,
              sessionId: decoded.sessionId,
              model: 'unknown',
              tools: [],
              bashCommands: [],
              toolSequence: [],
              userMessage: '',
              project: displayProjectForProfile(profile),
              costIsEstimated: false,
            })),
          }
        } else {

        const messageColumns = getMessageColumns(db)
        const orderColumns = ['timestamp', 'id'].filter(name => messageColumns.has(name))
        const orderBy = orderColumns.length > 0 ? `ORDER BY ${orderColumns.join(' ASC, ')} ASC` : ''
        const messages = db.query<HermesMessageRow>(
          `SELECT ${numberColumn(messageColumns, 'id')},
                  role,
                  content,
                  tool_calls,
                  ${nullableColumn(messageColumns, 'tool_name')},
                  ${nullableColumn(messageColumns, 'timestamp')}
           FROM messages
           WHERE session_id = ?
           ${orderBy}`,
          [decoded.sessionId],
        )

        const inputTokens = row.input_tokens ?? 0
        const outputTokens = row.output_tokens ?? 0
        const cacheReadTokens = row.cache_read_tokens ?? 0
        const cacheWriteTokens = row.cache_write_tokens ?? 0
        const reasoningTokens = row.reasoning_tokens ?? 0
        const tokens: HermesTokenTotals = {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
        }
        if (tokenSum(tokens) === 0 && !existingCursor) return

        const model = row.model ?? 'unknown'
        const { tools, toolSequence, bashCommands } = collectTools(messages)
        const workspace = resolveHermesWorkspace(row, messages)
        const timestamp = parseTimestamp(row.started_at)
        const baselineKey = hermesBaselineKey(profile, row.id)
        if (seenKeys.has(baselineKey)) return
        seenKeys.add(baselineKey)

        const identity = workspace.projectPath
          ? githubOwnerRepoFromRoot(workspace.projectPath)
          : null
        const prLinks = extractGithubPullUrls(
          messages
            .filter(msg => msg.role === 'assistant' || msg.role === 'user')
            .map(msg => msg.content),
          identity,
        )

        const cost = resolveHermesCost(row, model, tokens)
        const cursor = await recordHermesSnapshot({
          profile,
          sessionId: row.id,
          startedAt: timestamp || hermesLedgerNow().toISOString(),
          observedAt: hermesLedgerNow().toISOString(),
          tokens,
          costUSD: cost.costUSD,
          costBasis: cost.costBasis,
        })
        for (const observation of cursor.observations) {
          if (observation.index > 0) seenKeys.add(hermesObservationKey(profile, row.id, observation.index))
        }
        result = {
          calls: cursor.observations.map(observation => observationToCall(observation, {
            profile,
            sessionId: row.id,
            model,
            tools,
            bashCommands,
            toolSequence,
            userMessage: firstUserMessage(messages),
            project: workspace.project,
            projectPath: workspace.projectPath,
            workingDirectory: workspace.workingDirectory,
            prLinks,
            costIsEstimated: cost.costIsEstimated,
            route: routeFromProviderField(row.billing_provider)?.id,
          })),
        }
        }
      } catch (err) {
        // A transient lock on the live state.db, or a ledger publication
        // failure, must propagate so the caller retries — not get swallowed
        // into an empty (negatively cached) result.
        if (isSqliteBusyError(err) || isHermesLedgerPublicationError(err)) throw err
        const detail = err instanceof Error ? err.message : err
        process.stderr.write(`codeburn: error querying Hermes database: ${detail}\n`)
        return
      } finally {
        db.close()
      }

      if (result) {
        for (const call of result.calls) yield call
      }
    },
  }
}

export function createHermesProvider(hermesHomeOverride?: string): Provider {
  const hermesHome = getHermesHome(hermesHomeOverride)
  return {
    name: 'hermes',
    displayName: 'Hermes Agent',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: hermesHome, label: 'home' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      const dbs = await findStateDbs(hermesHome)
      const sessions: SessionSource[] = []
      for (const { dbPath, profile } of dbs) {
        sessions.push(...await discoverFromDb(dbPath, profile))
      }
      return sessions
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys, hermesHome)
    },
  }
}

export const hermes = createHermesProvider()
