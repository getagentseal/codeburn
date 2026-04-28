import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
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

  const geminiMessages = data.messages.filter(m => m.type === 'gemini' && m.tokens && m.model)
  if (geminiMessages.length === 0) return results

  const dedupKey = `gemini:${data.sessionId}`
  if (seenKeys.has(dedupKey)) return results
  seenKeys.add(dedupKey)

  let totalInput = 0
  let totalOutput = 0
  let totalCached = 0
  let totalThoughts = 0
  const allTools: string[] = []
  const bashCommands: string[] = []
  let model = ''

  for (const msg of geminiMessages) {
    const t = msg.tokens!
    totalInput += t.input ?? 0
    totalOutput += (t.output ?? 0) + (t.thoughts ?? 0)
    totalCached += t.cached ?? 0
    totalThoughts += t.thoughts ?? 0
    if (msg.model && !model) model = msg.model

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const mapped = toolNameMap[tc.displayName ?? ''] ?? toolNameMap[tc.name] ?? tc.displayName ?? tc.name
        allTools.push(mapped)
        if (mapped === 'Bash' && tc.args && typeof tc.args.command === 'string') {
          const cmd = tc.args.command.split(/\s+/)[0] ?? ''
          if (cmd) bashCommands.push(cmd)
        }
      }
    }
  }

  if (totalInput === 0 && totalOutput === 0) return results

  // Gemini's `input` count includes `cached` tokens as a subset, so fresh input
  // must subtract cached to avoid double-charging at both rates.
  const freshInput = totalInput - totalCached

  let userMessage = ''
  const firstUser = data.messages.find(m => m.type === 'user')
  if (firstUser) {
    if (Array.isArray(firstUser.content)) {
      userMessage = firstUser.content.map(c => c.text).join(' ').slice(0, 500)
    } else if (typeof firstUser.content === 'string') {
      userMessage = firstUser.content.slice(0, 500)
    }
  }

  const tsDate = new Date(data.startTime)
  if (isNaN(tsDate.getTime()) || tsDate.getTime() < 1_000_000_000_000) return results

  const costUSD = calculateCost(model, freshInput, totalOutput, 0, totalCached, 0)

  results.push({
    provider: 'gemini',
    model,
    inputTokens: freshInput,
    outputTokens: totalOutput,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: totalCached,
    cachedInputTokens: totalCached,
    reasoningTokens: totalThoughts,
    webSearchRequests: 0,
    costUSD,
    tools: [...new Set(allTools)],
    bashCommands: [...new Set(bashCommands)],
    timestamp: tsDate.toISOString(),
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage,
    sessionId: data.sessionId,
  })

  return results
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      let raw: string
      try {
        raw = await readFile(source.path, 'utf-8')
      } catch {
        return
      }

      let data: GeminiSession
      try {
        data = JSON.parse(raw)
      } catch {
        return
      }

      if (!data.messages || !data.sessionId) return

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
