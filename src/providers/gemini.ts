import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import { calculateCost } from '../models.js'

function getGeminiDir(): string {
  return join(homedir(), '.gemini')
}

type GeminiSession = {
  sessionId: string
  messages: Array<{
    id: string
    timestamp: string
    type: 'user' | 'gemini'
    content: string | Array<{ text?: string }>
    tokens?: {
      input: number
      output: number
      cached: number
      thoughts: number
      tool: number
      total: number
    }
    model?: string
    toolCalls?: Array<{ name: string }>
  }>
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      let content: string
      try {
        content = await readFile(source.path, 'utf-8')
      } catch {
        return
      }

      let session: GeminiSession
      try {
        session = JSON.parse(content)
      } catch {
        return
      }

      let lastUserMessage = ''
      for (const msg of session.messages) {
        if (msg.type === 'user') {
          lastUserMessage = typeof msg.content === 'string' 
            ? msg.content 
            : msg.content.map(c => c.text || '').join(' ')
          continue
        }

        if (msg.type === 'gemini' && msg.tokens) {
          const messageId = msg.id || 'unknown'
          const dedupKey = `gemini:${session.sessionId}:${messageId}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const inputTokens = Math.max(0, msg.tokens.input - msg.tokens.cached)
          const outputTokens = msg.tokens.output
          const reasoningTokens = msg.tokens.thoughts || 0
          const cachedInputTokens = msg.tokens.cached || 0
          const model = msg.model || 'gemini-3-flash'

          const costUSD = calculateCost(
            model,
            inputTokens,
            outputTokens + reasoningTokens,
            0,
            cachedInputTokens,
            0
          )

          yield {
            provider: 'gemini',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cachedInputTokens,
            cachedInputTokens,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            tools: (msg.toolCalls || []).map(tc => tc.name),
            timestamp: msg.timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: lastUserMessage,
            sessionId: session.sessionId
          }
        }
      }
    }
  }
}

export const gemini: Provider = {
  name: 'gemini',
  displayName: 'Gemini',

  modelDisplayName(model: string): string {
    return model
      .replace(/-preview$/, '')
      .replace(/^gemini-/, 'Gemini ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase())
      .replace(/Gemini /i, 'Gemini ')
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  async discoverSessions(): Promise<SessionSource[]> {
    const geminiDir = getGeminiDir()
    const projectsFile = join(geminiDir, 'projects.json')
    const sources: SessionSource[] = []

    let projectsData: { projects: Record<string, string> }
    try {
      const content = await readFile(projectsFile, 'utf-8')
      projectsData = JSON.parse(content)
    } catch {
      return sources
    }

    for (const [projectPath, projectName] of Object.entries(projectsData.projects)) {
      const chatsDir = join(geminiDir, 'tmp', projectName, 'chats')
      try {
        const files = await readdir(chatsDir)
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = join(chatsDir, file)
            const s = await stat(filePath).catch(() => null)
            if (s?.isFile()) {
              sources.push({
                path: filePath,
                project: projectName,
                provider: 'gemini'
              })
            }
          }
        }
      } catch {}
    }

    return sources
  },

  createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
    return createParser(source, seenKeys)
  }
}
