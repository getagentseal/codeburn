import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { openDatabase, type SqliteDatabase } from '../sqlite.js'
import { normalizeContentBlocks } from '../content-utils.js'
import type {
  Provider,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
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
  assistant: AssistantTurn
}

const CURSOR_AGENT_COST_MODEL = 'claude-sonnet-4-5'
const CHARS_PER_TOKEN = 4
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

function getAttributionDbPath(baseDir: string): string {
  return join(baseDir, 'ai-tracking', 'ai-code-tracking.db')
}

function estimateTokens(charCount: number): number {
  if (charCount <= 0) return 0
  return Math.ceil(charCount / CHARS_PER_TOKEN)
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

function extractUserQuery(userBlock: string): string {
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
  return combined.slice(0, MAX_USER_TEXT_LENGTH)
}

function parseJsonlTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length === 0) return { turns: [], recognized: false }

  const turns: ParsedTurn[] = []
  let currentUserMessage = ''

  for (const line of lines) {
    let entry: { role?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.role === 'user') {
      const texts = normalizeContentBlocks(entry.message?.content)
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
      const combined = texts.join(' ')
      currentUserMessage = extractUserQuery(combined) || combined.slice(0, MAX_USER_TEXT_LENGTH)
      continue
    }

    if (entry.role === 'assistant' && currentUserMessage) {
      const content = normalizeContentBlocks(entry.message?.content)
      const bodyParts: string[] = []
      const tools: string[] = []

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          bodyParts.push(block.text)
        } else if (block.type === 'tool_use' && block.name) {
          tools.push(`cursor:${block.name.toLowerCase()}`)
        }
      }

      turns.push({
        userMessage: currentUserMessage,
        assistant: {
          body: bodyParts.join('\n').trim(),
          reasoning: '',
          tools,
        },
      })
      currentUserMessage = ''
    }
  }

  return { turns, recognized: turns.length > 0 }
}

function parseTranscript(raw: string): { turns: ParsedTurn[]; recognized: boolean } {
  const lines = raw.split(/\r?\n/)
  let recognized = false

  const pendingUsers: string[] = []
  const turns: ParsedTurn[] = []

  let active: 'none' | 'user' | 'assistant' = 'none'
  let userLines: string[] = []
  let assistantLines: string[] = []

  const flushUser = () => {
    if (userLines.length === 0) return
    const userQuery = extractUserQuery(userLines.join('\n'))
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

    if (pendingUsers.length > 0) {
      const userMessage = pendingUsers.shift()!
      const tools = Array.from(toolsByTurn.keys())
      turns.push({
        userMessage,
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
          const inputTokens = estimateTokens(turn.userMessage.length)
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
  const dbPath = getAttributionDbPath(baseDir)
  const summariesByConversationId = new Map<string, ConversationSummary>()

  return {
    name: 'cursor-agent',
    displayName: 'Cursor Agent',

    modelDisplayName(model: string): string {
      if (model === 'cursor-agent-auto') return 'Cursor (auto)'
      const label = modelDisplayNames[model] ?? model
      return `${label} (est.)`
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!existsSync(projectsDir)) return []

      const projectEntries = await readdir(projectsDir, { withFileTypes: true })
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

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys, dbPath, summariesByConversationId)
    },
  }
}

export const cursor_agent = createCursorAgentProvider()
