import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const toolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  create_file: 'Write',
  delete_file: 'Delete',
  list_dir: 'LS',
  grep_search: 'Grep',
  search_files: 'Grep',
  find_files: 'Glob',
  run_command: 'Bash',
  web_search: 'WebSearch',
  ReadFile: 'Read',
  WriteFile: 'Write',
  EditFile: 'Edit',
  ListDir: 'LS',
  SearchText: 'Grep',
  Shell: 'Bash',
}

type GeminiTokens = {
  input?: number
  output?: number
  cached?: number
  thoughts?: number
  tool?: number
  total?: number
}

type GeminiToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
  status?: string
  displayName?: string
}

type GeminiMessage = {
  id: string
  timestamp: string
  type: 'user' | 'gemini' | 'info'
  content: string | Array<{ text: string }>
  tokens?: GeminiTokens
  model?: string
  toolCalls?: GeminiToolCall[]
  thoughts?: unknown[]
}

type GeminiSession = {
  sessionId: string
  projectHash?: string
  startTime: string
  lastUpdated?: string
  messages: GeminiMessage[]
  kind?: string
}

function parseSession(data: GeminiSession, seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []

  let lastUserMessage = ''
  let turnOrdinal = 0
  let currentTurnId = `${data.sessionId}:prelude`
  let geminiOrdinal = 0

  for (const msg of data.messages) {
    if (msg.type === 'user') {
      if (Array.isArray(msg.content)) {
        lastUserMessage = msg.content.map(c => c.text).join(' ').slice(0, 500)
      } else if (typeof msg.content === 'string') {
        lastUserMessage = msg.content.slice(0, 500)
      }
      currentTurnId = `${data.sessionId}:turn-${turnOrdinal++}`
      continue
    }

    if (msg.type !== 'gemini' || !msg.tokens || !msg.model) continue

    const t = msg.tokens
    const totalInput = t.input ?? 0
    const totalOutput = t.output ?? 0
    const totalCached = t.cached ?? 0
    const totalThoughts = t.thoughts ?? 0
    if (totalInput === 0 && totalOutput === 0 && totalCached === 0 && totalThoughts === 0) continue

    const messageKey = msg.id || `idx-${geminiOrdinal}`
    geminiOrdinal++
    const dedupKey = `gemini:${data.sessionId}:${messageKey}`
    if (seenKeys.has(dedupKey)) continue

    const tools: string[] = []
    const bashCommands: string[] = []

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const mapped = toolNameMap[tc.displayName ?? ''] ?? toolNameMap[tc.name] ?? tc.displayName ?? tc.name
        tools.push(mapped)
        if (mapped === 'Bash' && tc.args && typeof tc.args.command === 'string') {
          bashCommands.push(...extractBashCommands(tc.args.command))
        }
      }
    }

    // Gemini's `input` count includes `cached` tokens as a subset, so fresh
    // input must subtract cached to avoid double-charging at both rates.
    const freshInput = Math.max(0, totalInput - totalCached)

    const tsDate = new Date(msg.timestamp || data.startTime)
    if (isNaN(tsDate.getTime()) || tsDate.getTime() < 1_000_000_000_000) continue

    seenKeys.add(dedupKey)

    // Gemini bills thoughts at the output token rate; calculateCost does not
    // accept a reasoning parameter, so fold thoughts into the output count for
    // pricing while keeping outputTokens / reasoningTokens reported separately.
    const costUSD = calculateCost(msg.model, freshInput, totalOutput + totalThoughts, 0, totalCached, 0)

    results.push({
      provider: 'gemini',
      model: msg.model,
      inputTokens: freshInput,
      outputTokens: totalOutput,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: totalCached,
      cachedInputTokens: totalCached,
      reasoningTokens: totalThoughts,
      webSearchRequests: 0,
      costUSD,
      tools: [...new Set(tools)],
      bashCommands: [...new Set(bashCommands)],
      timestamp: tsDate.toISOString(),
      speed: 'standard',
      deduplicationKey: dedupKey,
      turnId: currentTurnId,
      userMessage: lastUserMessage,
      sessionId: data.sessionId,
    })
  }

  return results
}

function parseJsonl(raw: string): GeminiSession | null {
  const lines = raw.split('\n').filter(l => l.trim())
  if (lines.length === 0) return null

  let sessionId = ''
  let startTime = ''
  let projectHash: string | undefined
  let lastUpdated: string | undefined
  let kind: string | undefined
  const messages: GeminiMessage[] = []

  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj['$set'] !== undefined) continue
    if (obj['sessionId'] && obj['startTime'] && !sessionId) {
      sessionId = obj['sessionId'] as string
      startTime = obj['startTime'] as string
      projectHash = obj['projectHash'] as string | undefined
      lastUpdated = obj['lastUpdated'] as string | undefined
      kind = obj['kind'] as string | undefined
    } else if (obj['id'] && obj['type']) {
      messages.push(obj as unknown as GeminiMessage)
    }
  }

  if (!sessionId) return null
  return { sessionId, projectHash, startTime, lastUpdated, kind, messages }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      let data: GeminiSession | null = null

      // Try single JSON first (Gemini CLI <=0.38), then JSONL (>=0.39)
      try {
        const parsed = JSON.parse(raw)
        if (parsed.messages && parsed.sessionId) {
          data = parsed
        }
      } catch { /* not single JSON */ }

      if (!data) {
        data = parseJsonl(raw)
      }

      if (!data?.messages || !data.sessionId) return

      const calls = parseSession(data, seenKeys)
      for (const call of calls) {
        yield call
      }
    },
  }
}

function getGeminiTmpDir(): string {
  return join(homedir(), '.gemini', 'tmp')
}

async function discoverSessions(): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const tmpDir = getGeminiTmpDir()

  let projectDirs: string[]
  try {
    const entries = await readdir(tmpDir, { withFileTypes: true })
    projectDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return sources
  }

  for (const project of projectDirs) {
    const chatsDir = join(tmpDir, project, 'chats')
    let files: string[]
    try {
      const entries = await readdir(chatsDir)
      files = entries.filter(f => f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl')))
    } catch {
      continue
    }

    for (const file of files) {
      const filePath = join(chatsDir, file)
      const s = await stat(filePath).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({ path: filePath, project, provider: 'gemini' })
    }
  }

  return sources
}

export function createGeminiProvider(): Provider {
  return {
    name: 'gemini',
    displayName: 'Gemini',

    modelDisplayName(model: string): string {
      if (model === 'gemini-auto') return 'Gemini (auto)'
      const display: Record<string, string> = {
        'gemini-3-flash-preview': 'Gemini 3 Flash',
        'gemini-3.5-flash': 'Gemini 3.5 Flash',
        'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
        'gemini-2.5-pro': 'Gemini 2.5 Pro',
        'gemini-2.5-flash': 'Gemini 2.5 Flash',
        'gemini-2.0-flash': 'Gemini 2.0 Flash',
      }
      return display[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions()
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const gemini = createGeminiProvider()
