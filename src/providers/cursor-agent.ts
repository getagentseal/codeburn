import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'

import { calculateCost, getShortModelName } from '../models.js'
import { blobToText, openDatabase, type SqliteDatabase } from '../sqlite.js'
import { normalizeContentBlocks } from '../content-utils.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type {
  Provider,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
  ProbeRoot,
} from './types.js'

type ConversationSummary = {
  conversationId: string
  model: string | null
  title: string | null
  updatedAt: string | null
}

type AssistantTurn = {
  body: string
  reasoning: string
  tools: string[]
}

type ParsedTurn = {
  userMessage: string
  userTextFull: string
  // The user text was already billed on an earlier assistant message of the
  // same agentic loop; this turn only carries it for display.
  carried: boolean
  assistant: AssistantTurn
}

const CURSOR_AGENT_COST_MODEL = 'claude-sonnet-4-5'
const MAX_USER_TEXT_LENGTH = 500
const DIGITS_ONLY = /^\d+$/
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER_MARKER = /^\s*user:\s*/i
const ASSISTANT_MARKER = /^\s*A:\s*/
const THINKING_MARKER = /^\s*\[Thinking\]\s*/
const TOOL_CALL_MARKER = /^\s*\[Tool call\]\s*(.+?)\s*$/i
const TOOL_RESULT_MARKER = /^\s*\[Tool result\]\b/i
const USER_QUERY_OPEN = '<user_query>'
const USER_QUERY_CLOSE = '</user_query>'
const warnedUnrecognizedTranscripts = new Set<string>()
const STORE_DB_NAME = 'store.db'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// Cursor stamps each prompt with the local wall-clock minute and its offset:
// `<timestamp>Thursday, Sep 3, 2026, 6:52 AM (UTC-7)</timestamp>`.
const PROMPT_TIMESTAMP = /<timestamp>[A-Za-z]+, ([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC(?:([+-]\d{1,2})(?::(\d{2}))?)?\)<\/timestamp>/
// Root conversation-state blob (protobuf): field 1 repeats the message blob
// ids in order, field 9 is the workspace URI, field 26 a millisecond stamp.
const ROOT_MESSAGE_FIELD = 1
const ROOT_WORKSPACE_FIELD = 9
const ROOT_TIMESTAMP_FIELD = 26
const CONVERSATION_SUMMARY_QUERY = `
  SELECT conversationId, model, title, updatedAt
  FROM conversation_summaries
  WHERE conversationId = ?
`

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  default: 'Auto (Sonnet est.)',
}

function getCursorAgentBaseDir(baseDirOverride?: string): string {
  if (baseDirOverride) return baseDirOverride
  // Windows paths unverified; tracked as Open Question 3 in issue #55.
  return join(homedir(), '.cursor')
}

function getProjectsDir(baseDir: string): string {
  return join(baseDir, 'projects')
}

function getChatsDir(baseDir: string): string {
  return join(baseDir, 'chats')
}

function getAttributionDbPath(baseDir: string): string {
  return join(baseDir, 'ai-tracking', 'ai-code-tracking.db')
}

function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0
  return estimateTokensFromChars(charCount)
}

function parseToolName(raw: string): string {
  const clean = raw.trim()
  if (clean.length === 0) return 'unknown'
  return clean.toLowerCase().replace(/\s+/g, '-')
}

function normalizeTimestamp(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    if (DIGITS_ONLY.test(trimmed)) {
      const num = Number(trimmed)
      if (!Number.isNaN(num)) {
        const ms = num < 1e12 ? num * 1000 : num
        return new Date(ms).toISOString()
      }
    }
    const parsed = new Date(trimmed)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    return null
  }

  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

function prettifyProjectId(raw: string): string {
  if (!raw) return raw

  if (DIGITS_ONLY.test(raw)) {
    const num = Number(raw)
    if (!Number.isNaN(num) && raw.length >= 13) {
      const iso = new Date(num).toISOString()
      return `cursor-agent:${iso}`
    }
  }

  const withoutPrefix = raw.replace(/^-Users-/, '')
  const parts = withoutPrefix.split('-').filter(Boolean)
  if (parts.length > 0) return parts[parts.length - 1]!

  return raw
}

function resolveModel(raw: string | null | undefined): string {
  if (!raw || raw === 'default') return 'cursor-agent-auto'
  return raw
}

function costModel(model: string): string {
  return model === 'cursor-agent-auto' ? CURSOR_AGENT_COST_MODEL : model
}

function transcriptStem(transcriptPath: string): string {
  const name = basename(transcriptPath)
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length)
  if (name.endsWith('.txt')) return name.slice(0, -'.txt'.length)
  return name
}

function toConversationId(transcriptPath: string): string {
  const filename = transcriptStem(transcriptPath)
  if (filename.length === 36 && UUID_LIKE.test(filename)) return filename
  return createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16)
}

async function appendTranscriptSources(
  scanDir: string,
  projectId: string,
  sources: SessionSource[],
): Promise<void> {
  const transcriptEntries = await readdir(scanDir, { withFileTypes: true })
  for (const transcript of transcriptEntries) {
    // Legacy format: .txt files directly in the scan dir
    if (transcript.isFile() && transcript.name.endsWith('.txt')) {
      sources.push({
        path: join(scanDir, transcript.name),
        project: projectId,
        provider: 'cursor-agent',
      })
      continue
    }

    // Composer 2 format: UUID subdirectories with .jsonl files
    if (transcript.isDirectory() && UUID_LIKE.test(transcript.name)) {
      const subdir = join(scanDir, transcript.name)
      const subEntries = await readdir(subdir, { withFileTypes: true }).catch(() => [])
      const transcriptFilesByStem = new Map<string, { jsonl?: string; txt?: string }>()

      for (const sub of subEntries) {
        if (sub.isFile() && (sub.name.endsWith('.jsonl') || sub.name.endsWith('.txt'))) {
          const stem = transcriptStem(sub.name)
          const existing = transcriptFilesByStem.get(stem) ?? {}
          if (sub.name.endsWith('.jsonl')) {
            transcriptFilesByStem.set(stem, { ...existing, jsonl: sub.name })
          } else {
            transcriptFilesByStem.set(stem, { ...existing, txt: sub.name })
          }
          continue
        }

        // Subagent transcripts inside a subagents/ directory
        if (sub.isDirectory() && sub.name === 'subagents') {
          const subagentEntries = await readdir(join(subdir, sub.name), { withFileTypes: true }).catch(() => [])
          for (const sa of subagentEntries) {
            if (!sa.isFile()) continue
            if (!sa.name.endsWith('.jsonl') && !sa.name.endsWith('.txt')) continue
            sources.push({
              path: join(subdir, sub.name, sa.name),
              project: projectId,
              provider: 'cursor-agent',
            })
          }
        }
      }

      for (const files of transcriptFilesByStem.values()) {
        const selectedName = files.jsonl ?? files.txt
        if (selectedName) {
          sources.push({
            path: join(subdir, selectedName),
            project: projectId,
            provider: 'cursor-agent',
          })
        }
      }
    }
  }
}

function extractUserQuery(userBlock: string, maxLength: number = MAX_USER_TEXT_LENGTH): string {
  const chunks: string[] = []
  let cursor = 0

  while (cursor < userBlock.length) {
    const openIndex = userBlock.indexOf(USER_QUERY_OPEN, cursor)
    if (openIndex === -1) break
    const start = openIndex + USER_QUERY_OPEN.length
    const closeIndex = userBlock.indexOf(USER_QUERY_CLOSE, start)
    if (closeIndex === -1) {
      chunks.push(userBlock.slice(start).trim())
      break
    }
    chunks.push(userBlock.slice(start, closeIndex).trim())
    cursor = closeIndex + USER_QUERY_CLOSE.length
  }

  const combined = chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return combined.slice(0, maxLength)
}

function parseJsonlTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length === 0) return { turns: [], recognized: false }
  const turns: ParsedTurn[] = []
  let lastUserDisplay = ''
  let lastUserFull = ''
  let seenUser = false
  let userBilled = false
  let recognized = false

  for (const line of lines) {
    let entry: { role?: string; type?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    // A turn that errored or was aborted before any assistant message leaves
    // only a `turn_ended` line (or a user line and nothing else); that is a
    // Cursor transcript with nothing to bill, not an unknown format.
    if (entry.type === 'turn_ended') recognized = true

    if (entry.role === 'user') {
      recognized = true
      const texts = normalizeContentBlocks(entry.message?.content)
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
      const combined = texts.join(' ')
      const full = extractUserQuery(combined, Number.POSITIVE_INFINITY) || combined
      lastUserFull = full
      lastUserDisplay = full.slice(0, MAX_USER_TEXT_LENGTH)
      seenUser = true
      userBilled = false
      continue
    }

    if (entry.role === 'assistant' && seenUser) {
      const content = normalizeContentBlocks(entry.message?.content)
      const bodyParts: string[] = []
      const tools: string[] = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          bodyParts.push(block.text)
        } else if (block.type === 'tool_use' && block.name) {
          tools.push(`cursor:${block.name.toLowerCase()}`)
          if (block.input !== undefined) {
            try {
              bodyParts.push(JSON.stringify(block.input))
            } catch {
              // Unserializable tool input contributes its name only (above).
            }
          }
        }
      }

      turns.push({
        userMessage: lastUserDisplay,
        userTextFull: lastUserFull,
        carried: userBilled,
        assistant: {
          body: bodyParts.join('\n').trim(),
          reasoning: '',
          tools,
        },
      })
      userBilled = true
    }
  }

  return { turns, recognized: recognized || turns.length > 0 }
}

function parseTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/)
  let recognized = false

  const pendingUsers: string[] = []
  let lastUserMessage: string | null = null
  const turns: ParsedTurn[] = []

  let active: 'none' | 'user' | 'assistant' = 'none'
  let userLines: string[] = []
  let assistantLines: string[] = []

  const flushUser = () => {
    if (userLines.length === 0) return
    const userQuery = extractUserQuery(userLines.join('\n'), Number.POSITIVE_INFINITY)
    if (userQuery.length > 0) pendingUsers.push(userQuery)
    userLines = []
  }

  const flushAssistant = () => {
    if (assistantLines.length === 0) return

    let output = ''
    let reasoning = ''
    const toolsByTurn = new Map<string, true>()

    for (const line of assistantLines) {
      if (TOOL_RESULT_MARKER.test(line)) continue

      const thinkingMatch = line.match(THINKING_MARKER)
      if (thinkingMatch) {
        const body = line.replace(THINKING_MARKER, '').trim()
        if (body.length > 0) reasoning += `${body}\n`
        continue
      }

      const toolMatch = line.match(TOOL_CALL_MARKER)
      if (toolMatch) {
        const parsedTool = parseToolName(toolMatch[1] ?? '')
        const toolKey = `cursor:${parsedTool}`
        toolsByTurn.set(toolKey, true)
        continue
      }

      output += `${line}\n`
    }

    const carried = pendingUsers.length === 0
    const userMessage = carried ? lastUserMessage : pendingUsers.shift()!
    if (userMessage !== null) {
      lastUserMessage = userMessage
      const tools = Array.from(toolsByTurn.keys())
      turns.push({
        userMessage: userMessage.slice(0, MAX_USER_TEXT_LENGTH),
        userTextFull: userMessage,
        carried,
        assistant: {
          body: output.trim(),
          reasoning: reasoning.trim(),
          tools,
        },
      })
    }

    assistantLines = []
  }

  for (const line of lines) {
    if (USER_MARKER.test(line)) {
      recognized = true
      if (active === 'user') flushUser()
      if (active === 'assistant') flushAssistant()
      active = 'user'
      userLines = [line.replace(USER_MARKER, '')]
      continue
    }

    if (ASSISTANT_MARKER.test(line)) {
      recognized = true
      if (active === 'user') flushUser()
      if (active === 'assistant') flushAssistant()
      active = 'assistant'
      assistantLines = [line.replace(ASSISTANT_MARKER, '')]
      continue
    }

    if (active === 'user') {
      userLines.push(line)
      continue
    }

    if (active === 'assistant') {
      assistantLines.push(line)
    }
  }

  if (active === 'user') flushUser()
  if (active === 'assistant') flushAssistant()

  return { turns, recognized }
}

function parsePromptTimestamp(text: string): string | null {
  const m = PROMPT_TIMESTAMP.exec(text)
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!)
  if (month < 0) return null
  const hour = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0)
  const sign = m[7]?.startsWith('-') ? -1 : 1
  const offsetMinutes = sign * (Math.abs(Number(m[7] ?? 0)) * 60 + Number(m[8] ?? 0))
  const ms = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offsetMinutes * 60_000
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

type ProtoField = { field: number; value: number | Uint8Array }

function readVarint(buf: Uint8Array, pos: number): [number, number] | null {
  let result = 0
  let scale = 1
  while (pos < buf.length) {
    const byte = buf[pos++]!
    result += (byte & 0x7f) * scale
    if (byte < 0x80) return [result, pos]
    scale *= 128
    if (scale > 2 ** 63) return null
  }
  return null
}

function readProtoFields(buf: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = []
  let pos = 0
  while (pos < buf.length) {
    const key = readVarint(buf, pos)
    if (!key) return null
    pos = key[1]
    const field = Math.floor(key[0] / 8)
    const wire = key[0] % 8
    if (wire === 0) {
      const v = readVarint(buf, pos)
      if (!v) return null
      fields.push({ field, value: v[0] })
      pos = v[1]
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      if (!len || len[1] + len[0] > buf.length) return null
      fields.push({ field, value: buf.subarray(len[1], len[1] + len[0]) })
      pos = len[1] + len[0]
    } else if (wire === 1) {
      pos += 8
    } else if (wire === 5) {
      pos += 4
    } else {
      return null
    }
  }
  return pos === buf.length ? fields : null
}

type StoreMessage = {
  role?: string
  content?: unknown
}

type StoreContentBlock = {
  type?: string
  text?: string
  toolName?: string
  args?: unknown
}

type StoreTurn = ParsedTurn & { timestamp: string }

type StoreSession = {
  agentId: string
  workspacePath: string | null
  turns: StoreTurn[]
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf-8')
  return null
}

// Every conversation-state root still in the store, oldest first, merged into
// one message order. The latest root alone drops what Cursor summarized away
// on a long session; older roots still hold those messages.
function readStoreMessages(db: SqliteDatabase): { messages: StoreMessage[]; workspaceUri: string | null } {
  const rows = db.query<{ id: string; data: unknown }>('SELECT id, data FROM blobs ORDER BY rowid')
  const jsonBlobs = new Map<string, Uint8Array>()
  const others: Uint8Array[] = []
  for (const row of rows) {
    const data = toBytes(row.data)
    if (!data || typeof row.id !== 'string') continue
    if (data[0] === 0x7b) jsonBlobs.set(row.id, data)
    else others.push(data)
  }

  const order: string[] = []
  const seen = new Set<string>()
  let workspaceUri: string | null = null
  for (const data of others) {
    const fields = readProtoFields(data)
    if (!fields || !fields.some(f => f.field === ROOT_TIMESTAMP_FIELD && typeof f.value === 'number')) continue
    const ids: string[] = []
    for (const f of fields) {
      if (f.field !== ROOT_MESSAGE_FIELD || typeof f.value === 'number' || f.value.length !== 32) continue
      ids.push(Buffer.from(f.value).toString('hex'))
    }
    if (ids.length === 0 || !ids.every(id => jsonBlobs.has(id))) continue
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
    }
    const ws = fields.find(f => f.field === ROOT_WORKSPACE_FIELD && typeof f.value !== 'number')
    if (ws) workspaceUri = blobToText(ws.value as Uint8Array)
  }

  const messages: StoreMessage[] = []
  for (const id of order) {
    try {
      messages.push(JSON.parse(blobToText(jsonBlobs.get(id)!)) as StoreMessage)
    } catch {
      // A blob that is not a message contributes nothing.
    }
  }
  return { messages, workspaceUri }
}

function readStoreSession(dbPath: string, fallbackTimestamp: string): StoreSession | null {
  let db: SqliteDatabase | null = null
  try {
    db = openDatabase(dbPath)
    const metaRow = db.query<{ value: unknown }>(`SELECT value FROM meta WHERE key = '0'`)[0]
    if (!metaRow || typeof metaRow.value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(metaRow.value)) return null
    const meta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf-8')) as { agentId?: unknown; createdAt?: unknown }
    const agentId = meta.agentId
    if (typeof agentId !== 'string' || agentId !== basename(dirname(dbPath))) return null

    const { messages, workspaceUri } = readStoreMessages(db)
    let timestamp = typeof meta.createdAt === 'number' ? normalizeTimestamp(meta.createdAt) ?? fallbackTimestamp : fallbackTimestamp
    let lastUserFull = ''
    let userBilled = true
    const turns: StoreTurn[] = []

    for (const message of messages) {
      const blocks = (typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content) ? message.content : []) as StoreContentBlock[]

      if (message.role === 'user') {
        const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join(' ')
        const query = extractUserQuery(text, Number.POSITIVE_INFINITY)
        // Cursor-injected context (<user_info>, conversation summaries) is
        // not a prompt and never appears in the exported transcript.
        if (!query) continue
        lastUserFull = query
        userBilled = false
        timestamp = parsePromptTimestamp(text) ?? timestamp
        continue
      }

      if (message.role !== 'assistant') continue
      const bodyParts: string[] = []
      const reasoningParts: string[] = []
      const tools: string[] = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          bodyParts.push(block.text)
        } else if (block.type === 'reasoning') {
          if (block.text) reasoningParts.push(block.text)
        } else if (block.type === 'tool-call' && block.toolName) {
          tools.push(`cursor:${block.toolName.toLowerCase()}`)
          if (block.args !== undefined) {
            try {
              bodyParts.push(JSON.stringify(block.args))
            } catch {
              // Unserializable tool input contributes its name only (above).
            }
          }
        }
      }
      const body = bodyParts.join('\n').trim()
      const reasoning = reasoningParts.join('\n').trim()
      // Empty placeholders (an aborted or errored step) never reach the transcript.
      if (!body && !reasoning && tools.length === 0) continue

      turns.push({
        userMessage: lastUserFull.slice(0, MAX_USER_TEXT_LENGTH),
        userTextFull: lastUserFull,
        carried: userBilled,
        assistant: { body, reasoning, tools },
        timestamp,
      })
      userBilled = true
    }

    let workspacePath: string | null = null
    if (workspaceUri?.startsWith('file://')) {
      try {
        // Not fileURLToPath: on Windows it rejects a drive-less file URI, and
        // only the dash-joined project name is needed here.
        workspacePath = decodeURIComponent(new URL(workspaceUri).pathname)
      } catch {
        workspacePath = null
      }
    }
    return { agentId, workspacePath, turns }
  } finally {
    db?.close()
  }
}

function createStoreParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const fallbackTimestamp = (await stat(source.path)).mtime.toISOString()
      let session: StoreSession | null
      try {
        session = readStoreSession(source.path, fallbackTimestamp)
      } catch {
        session = null
      }
      if (!session) {
        if (!warnedUnrecognizedTranscripts.has(source.path)) {
          warnedUnrecognizedTranscripts.add(source.path)
          process.stderr.write(`codeburn: skipped ${basename(dirname(source.path))}/${STORE_DB_NAME}: unrecognized cursor-agent store\n`)
        }
        return
      }

      // Same derivation as the dash-joined projects/ directory name transcripts use.
      const project = session.workspacePath
        ? prettifyProjectId(session.workspacePath.replace(/[^A-Za-z0-9]+/g, '-'))
        : undefined

      for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex++) {
        const turn = session.turns[turnIndex]!
        const deduplicationKey = `cursor-agent:${session.agentId}:${turnIndex}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        // Priced like transcripts, so a session keeps one price whichever file
        // it is read from (Cursor writes the transcript when the session ends).
        const model = 'cursor-agent-auto'
        const inputTokens = turn.carried ? 0 : estimateTokens(turn.userTextFull.length)
        const outputTokens = estimateTokens(turn.assistant.body.length)
        const reasoningTokens = estimateTokens(turn.assistant.reasoning.length)

        yield {
          provider: 'cursor-agent',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens,
          webSearchRequests: 0,
          costUSD: calculateCost(costModel(model), inputTokens, outputTokens + reasoningTokens, 0, 0, 0),
          costIsEstimated: true,
          tools: turn.assistant.tools,
          bashCommands: [],
          timestamp: turn.timestamp,
          speed: 'standard',
          deduplicationKey,
          userMessage: turn.userMessage,
          sessionId: session.agentId,
          ...(project ? { project } : {}),
        }
      }
    },
  }
}

// Store-only sessions: a session whose transcript was exported is read from the
// transcript alone, so the two can never both count.
async function appendStoreSources(
  chatsDir: string,
  transcriptIds: Set<string>,
  sources: SessionSource[],
): Promise<void> {
  const hashDirs = await readdir(chatsDir, { withFileTypes: true }).catch(() => [])
  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) continue
    const agentDirs = await readdir(join(chatsDir, hashDir.name), { withFileTypes: true }).catch(() => [])
    for (const agentDir of agentDirs) {
      if (!agentDir.isDirectory() || !UUID_LIKE.test(agentDir.name) || transcriptIds.has(agentDir.name)) continue
      const path = join(chatsDir, hashDir.name, agentDir.name, STORE_DB_NAME)
      if (!existsSync(path)) continue
      sources.push({ path, project: 'cursor-agent', provider: 'cursor-agent' })
    }
  }
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dbPath: string,
  summariesByConversationId: Map<string, ConversationSummary>,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const conversationId = toConversationId(source.path)

      let summary = summariesByConversationId.get(conversationId)
      let db: SqliteDatabase | null = null

      try {
        if (!summary) {
          if (existsSync(dbPath)) {
            try {
              db = openDatabase(dbPath)
              const rows = db.query<{
                conversationId: string
                model: string | null
                title: string | null
                updatedAt: string | number | null
              }>(CONVERSATION_SUMMARY_QUERY, [conversationId])

              if (rows.length > 0) {
                const row = rows[0]!
                summary = {
                  conversationId: row.conversationId,
                  model: row.model,
                  title: row.title,
                  updatedAt: normalizeTimestamp(row.updatedAt),
                }
                summariesByConversationId.set(conversationId, summary)
              }
            } catch {
              summary = undefined
            }
          }
        }

        const transcript = await readFile(source.path, 'utf-8')
        const isJsonl = source.path.endsWith('.jsonl')
        const parsed = isJsonl ? parseJsonlTranscript(transcript) : parseTranscript(transcript)

        if (!parsed.recognized) {
          if (!warnedUnrecognizedTranscripts.has(source.path)) {
            warnedUnrecognizedTranscripts.add(source.path)
            process.stderr.write(`codeburn: skipped ${basename(source.path)}: unrecognized cursor-agent transcript format\n`)
          }
          return
        }

        let timestamp = summary?.updatedAt ?? null
        if (!timestamp) {
          const fileStat = await stat(source.path)
          timestamp = fileStat.mtime.toISOString()
        }

        const model = resolveModel(summary?.model ?? null)

        for (let turnIndex = 0; turnIndex < parsed.turns.length; turnIndex++) {
          const turn = parsed.turns[turnIndex]!
          const inputTokens = turn.carried ? 0 : estimateTokens(turn.userTextFull.length)
          const outputTokens = estimateTokens(turn.assistant.body.length)
          const reasoningTokens = estimateTokens(turn.assistant.reasoning.length)
          const deduplicationKey = `cursor-agent:${conversationId}:${turnIndex}`

          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          const costUSD = calculateCost(
            costModel(model),
            inputTokens,
            outputTokens + reasoningTokens,
            0,
            0,
            0,
          )

          yield {
            provider: 'cursor-agent',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            tools: turn.assistant.tools,
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey,
            userMessage: turn.userMessage,
            sessionId: conversationId,
          }
        }
      } finally {
        db?.close()
      }
    },
  }
}

export function createCursorAgentProvider(baseDirOverride?: string): Provider {
  const baseDir = getCursorAgentBaseDir(baseDirOverride)
  const projectsDir = getProjectsDir(baseDir)
  const chatsDir = getChatsDir(baseDir)
  const dbPath = getAttributionDbPath(baseDir)
  const summariesByConversationId = new Map<string, ConversationSummary>()

  return {
    name: 'cursor-agent',
    displayName: 'Cursor Agent',

    modelDisplayName(model: string): string {
      if (model === 'cursor-agent-auto') return 'Cursor (auto)'
      const label = modelDisplayNames[model] ?? getShortModelName(model)
      return `${label} (est.)`
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [
        { path: projectsDir, label: 'projects' },
        { path: chatsDir, label: 'chats' },
        { path: dbPath, label: 'db' },
      ]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const projectEntries = existsSync(projectsDir) ? await readdir(projectsDir, { withFileTypes: true }) : []
      const sources: SessionSource[] = []

      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue

        const projectId = prettifyProjectId(entry.name)
        const projectDir = join(projectsDir, entry.name)
        if (entry.name === 'agent-transcripts') {
          await appendTranscriptSources(projectDir, projectId, sources)
          continue
        }

        const transcriptDir = join(projectDir, 'agent-transcripts')
        if (!existsSync(transcriptDir)) continue
        await appendTranscriptSources(transcriptDir, projectId, sources)
      }

      const transcriptIds = new Set(sources.map(s => toConversationId(s.path)))
      await appendStoreSources(chatsDir, transcriptIds, sources)
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      if (basename(source.path) === STORE_DB_NAME) return createStoreParser(source, seenKeys)
      return createParser(source, seenKeys, dbPath, summariesByConversationId)
    },
  }
}

export const cursor_agent = createCursorAgentProvider()
