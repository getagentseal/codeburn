import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'o4-mini': 'o4-mini',
  'o3': 'o3',
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  create_file: 'Write',
  delete_file: 'Delete',
  search_files: 'Grep',
  find_files: 'Glob',
  list_directory: 'LS',
  web_search: 'WebSearch',
  fetch_webpage: 'WebFetch',
  github_repo: 'GitHub',
}

// Pre-sorted by key length descending so longer/more-specific keys match first
const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

// Fields marked optional document the on-disk schema; they are not read by the parser
type ToolRequest = {
  name?: string
  toolCallId?: string
  type?: string
}

type ModelChangeData = {
  newModel: string
  previousModel?: string
}

type UserMessageData = {
  content: string
  interactionId?: string
}

type AssistantMessageData = {
  messageId: string
  outputTokens: number
  interactionId?: string
  toolRequests?: ToolRequest[]
}

type CopilotEvent =
  | { type: 'session.model_change'; timestamp?: string; data: ModelChangeData }
  | { type: 'user.message'; timestamp?: string; data: UserMessageData }
  | { type: 'assistant.message'; timestamp?: string; data: AssistantMessageData }

function getCopilotSessionStateDir(override?: string): string {
  return override ?? join(homedir(), '.copilot', 'session-state')
}

function parseCwd(yaml: string): string | null {
  const match = yaml.match(/^cwd:\s*(.+)$/m)
  if (!match?.[1]) return null
  const raw = match[1]
    .replace(/\s*#.*$/, '')    // strip trailing comment
    .replace(/^['"]|['"]$/g, '') // strip surrounding quotes
    .trim()
  return raw || null
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (content === null) return
      const sessionId = basename(dirname(source.path))
      const lines = content.split('\n').filter(l => l.trim())
      let currentModel = ''
      let pendingUserMessage = ''

      for (const line of lines) {
        let event: CopilotEvent
        try {
          event = JSON.parse(line) as CopilotEvent
        } catch {
          continue
        }

        if (event.type === 'session.model_change') {
          currentModel = event.data.newModel ?? currentModel
          continue
        }

        if (event.type === 'user.message') {
          pendingUserMessage = event.data.content ?? ''
          continue
        }

        if (event.type === 'assistant.message') {
          const { messageId, outputTokens, toolRequests = [] } = event.data
          if (outputTokens === 0) continue
          // Skip if no model has been identified yet - avoids silent misattribution
          if (!currentModel) continue

          const dedupKey = `copilot:${sessionId}:${messageId}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const tools = toolRequests
            .map(t => t.name ?? '')
            .filter(Boolean)
            .map(n => toolNameMap[n] ?? n)

          // Copilot only logs outputTokens; inputTokens are not available in session logs.
          // Cost will be lower than actual API cost.
          const costUSD = calculateCost(currentModel, 0, outputTokens, 0, 0, 0)

          yield {
            provider: 'copilot',
            model: currentModel,
            inputTokens: 0,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            tools,
            bashCommands: [],
            timestamp: event.timestamp ?? '',
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: pendingUserMessage,
            sessionId,
          }

          pendingUserMessage = ''
        }
      }
    },
  }
}

async function discoverSessionsInDir(sessionStateDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(sessionStateDir)
  } catch {
    return sources
  }

  for (const sessionId of sessionDirs) {
    const eventsPath = join(sessionStateDir, sessionId, 'events.jsonl')
    const s = await stat(eventsPath).catch(() => null)
    if (!s?.isFile()) continue

    let project = sessionId
    const yaml = await readSessionFile(join(sessionStateDir, sessionId, 'workspace.yaml'))
    if (yaml !== null) {
      const cwd = parseCwd(yaml)
      if (cwd) project = basename(cwd)
    }

    sources.push({ path: eventsPath, project, provider: 'copilot' })
  }

  return sources
}

export function createCopilotProvider(sessionStateDir?: string): Provider {
  const dir = getCopilotSessionStateDir(sessionStateDir)

  return {
    name: 'copilot',
    displayName: 'Copilot',

    modelDisplayName(model: string): string {
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const copilot = createCopilotProvider()
