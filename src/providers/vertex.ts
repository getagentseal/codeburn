import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

/**
 * Google Vertex AI / gcloud CLI provider.
 * Tracks usage from Google Cloud's Vertex AI Gemini sessions.
 *
 * Discovers sessions from:
 * - ~/.config/google-cloud-sdk/ai/sessions/ (gcloud ai CLI)
 * - ~/.vertex-ai/sessions/ (Vertex AI agent SDK)
 * - ~/.config/gemini-code-assist/sessions/ (Gemini Code Assist)
 */

const SESSION_DIRS = [
  join(homedir(), '.config', 'google-cloud-sdk', 'ai', 'sessions'),
  join(homedir(), '.vertex-ai', 'sessions'),
  join(homedir(), '.config', 'gemini-code-assist', 'sessions'),
]

const modelDisplayNames: Record<string, string> = {
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-exp': 'Gemini Experimental',
}

const toolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  create_file: 'Write',
  list_dir: 'LS',
  search_files: 'Grep',
  run_command: 'Bash',
  web_search: 'WebSearch',
  code_execution: 'CodeExec',
}

type VertexMessage = {
  role: 'user' | 'model'
  parts: Array<{
    text?: string
    functionCall?: { name: string; args?: Record<string, unknown> }
    functionResponse?: { name: string }
  }>
}

type VertexUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
}

type VertexSession = {
  sessionId?: string
  projectId?: string
  model?: string
  createTime?: string
  messages?: VertexMessage[]
  usageMetadata?: VertexUsageMetadata[]
}

function parseVertexSession(data: VertexSession, filePath: string, seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  const sessionId = data.sessionId ?? basename(filePath, '.json')
  const model = data.model ?? 'gemini-unknown'

  if (!data.messages || data.messages.length === 0) return results

  let lastUserMessage = ''
  let turnIndex = 0

  for (const msg of data.messages) {
    if (msg.role === 'user') {
      lastUserMessage = msg.parts
        .filter(p => p.text)
        .map(p => p.text!)
        .join(' ')
        .slice(0, 500)
      continue
    }

    if (msg.role === 'model') {
      turnIndex++
      const dedupKey = `vertex:${sessionId}:${turnIndex}`
      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      const tools: string[] = []
      let outputText = ''

      for (const part of msg.parts) {
        if (part.functionCall) {
          const toolName = toolNameMap[part.functionCall.name] ?? part.functionCall.name
          tools.push(toolName)
        }
        if (part.text) {
          outputText += part.text
        }
      }

      const usage = data.usageMetadata?.[turnIndex - 1]
      const inputTokens = usage?.promptTokenCount ?? 0
      const outputTokens = usage?.candidatesTokenCount ?? Math.ceil(outputText.length / 4)
      const cachedTokens = usage?.cachedContentTokenCount ?? 0

      if (outputTokens === 0 && tools.length === 0) continue

      const costUSD = calculateCost(model, inputTokens, outputTokens, cachedTokens, 0, 0)

      results.push({
        provider: 'vertex',
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: cachedTokens,
        cachedInputTokens: cachedTokens,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD,
        tools: [...new Set(tools)],
        bashCommands: [],
        timestamp: data.createTime ?? '',
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: lastUserMessage,
        sessionId,
      })

      lastUserMessage = ''
    }
  }

  return results
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      let data: VertexSession | null = null
      try {
        data = JSON.parse(raw) as VertexSession
      } catch {
        // Try JSONL format
        const lines = raw.split('\n').filter(l => l.trim())
        if (lines.length > 0) {
          try {
            const messages: VertexMessage[] = []
            let sessionId: string | undefined
            let model: string | undefined
            let createTime: string | undefined
            for (const line of lines) {
              const obj = JSON.parse(line) as Record<string, unknown>
              if (obj['sessionId']) {
                sessionId = obj['sessionId'] as string
                model = obj['model'] as string | undefined
                createTime = obj['createTime'] as string | undefined
              } else if (obj['role']) {
                messages.push(obj as unknown as VertexMessage)
              }
            }
            if (messages.length > 0) {
              data = { sessionId, model, createTime, messages }
            }
          } catch {
            return
          }
        }
      }

      if (!data?.messages) return

      const calls = parseVertexSession(data, source.path, seenKeys)
      for (const call of calls) {
        yield call
      }
    },
  }
}

async function discoverVertexSessions(): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  for (const baseDir of SESSION_DIRS) {
    let entries: string[]
    try {
      entries = await readdir(baseDir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const filePath = join(baseDir, entry)
      if (!entry.endsWith('.json') && !entry.endsWith('.jsonl')) continue
      const s = await stat(filePath).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({
        path: filePath,
        project: basename(entry, entry.endsWith('.jsonl') ? '.jsonl' : '.json'),
        provider: 'vertex',
      })
    }
  }

  return sources
}

export function createVertexProvider(): Provider {
  return {
    name: 'vertex',
    displayName: 'Vertex AI',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverVertexSessions()
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const vertex = createVertexProvider()
