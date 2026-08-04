import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const toolNameMap: Record<string, string> = {
  read_file: 'Read',
  write_to_file: 'Write',
  edit_file: 'Edit',
  execute_command: 'Bash',
  search_files: 'Grep',
  list_files: 'LS',
  list_directory: 'LS',
  browser_action: 'WebFetch',
  web_search: 'WebSearch',
  ask_followup_question: 'AskUser',
  attempt_completion: 'Complete',
}

type QwenPart = {
  text?: string
  thought?: boolean
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: unknown
}

type QwenEntry = {
  uuid: string
  sessionId: string
  timestamp: string
  type: string
  subtype?: string
  cwd?: string
  model?: string
  message?: {
    role: string
    parts: QwenPart[]
  }
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    thoughtsTokenCount: number
    totalTokenCount: number
    cachedContentTokenCount: number
  }
}

function getQwenProjectsDir(): string {
  return process.env['QWEN_DATA_DIR'] ?? join(homedir(), '.qwen', 'projects')
}

function projectNameFromDirName(dirName: string): string {
  const parts = dirName.replace(/^-/, '').split('-')
  return parts[parts.length - 1] || dirName
}

function extractTools(parts: QwenPart[]): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []

  for (const part of parts) {
    if (part.functionCall?.name) {
      const mapped = toolNameMap[part.functionCall.name] ?? part.functionCall.name
      tools.push(mapped)
      if (mapped === 'Bash' && part.functionCall.args && typeof part.functionCall.args['command'] === 'string') {
        bashCommands.push(...extractBashCommands(part.functionCall.args['command'] as string))
      }
    }
  }

  return { tools, bashCommands }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      const lines = raw.split('\n').filter(l => l.trim())
      let pendingUserMessage = ''

      for (const line of lines) {
        let entry: QwenEntry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }

        if (entry.type === 'user' && entry.message) {
          const texts = (entry.message.parts ?? [])
            .filter(p => p.text && !p.thought)
            .map(p => p.text!)
          if (texts.length > 0) {
            pendingUserMessage = texts.join(' ').slice(0, 500)
          }
          continue
        }

        if (entry.type !== 'assistant' || !entry.usageMetadata) continue

        const usage = entry.usageMetadata
        if (usage.promptTokenCount === 0 && usage.candidatesTokenCount === 0) continue

        const dedupKey = `qwen:${entry.sessionId}:${entry.uuid}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const model = entry.model || 'qwen-auto'
        const { tools, bashCommands } = extractTools(entry.message?.parts ?? [])

        const inputTokens = usage.promptTokenCount
        const outputTokens = usage.candidatesTokenCount
        const reasoningTokens = usage.thoughtsTokenCount ?? 0
        const cachedTokens = usage.cachedContentTokenCount ?? 0

        const costUSD = calculateCost(model, inputTokens, outputTokens + reasoningTokens, 0, cachedTokens, 0)

        yield {
          provider: 'qwen',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: cachedTokens,
          cachedInputTokens: cachedTokens,
          reasoningTokens,
          webSearchRequests: 0,
          costUSD,
          tools: [...new Set(tools)],
          bashCommands: [...new Set(bashCommands)],
          timestamp: entry.timestamp || '',
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: pendingUserMessage,
          sessionId: entry.sessionId,
        }

        pendingUserMessage = ''
      }
    },
  }
}

export function createQwenProvider(overrideDir?: string): Provider {
  const projectsDir = overrideDir ?? getQwenProjectsDir()

  return {
    name: 'qwen',
    displayName: 'Qwen',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: projectsDir, label: 'projects' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []

      let projectDirs: string[]
      try {
        projectDirs = await readdir(projectsDir)
      } catch {
        return sources
      }

      for (const projDir of projectDirs) {
        const chatsDir = join(projectsDir, projDir, 'chats')
        const project = projectNameFromDirName(projDir)

        let chatFiles: string[]
        try {
          chatFiles = await readdir(chatsDir)
        } catch {
          continue
        }

        for (const file of chatFiles) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = join(chatsDir, file)
          const s = await stat(filePath).catch(() => null)
          if (!s?.isFile()) continue
          sources.push({ path: filePath, project, provider: 'qwen' })
        }
      }

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const qwen = createQwenProvider()
