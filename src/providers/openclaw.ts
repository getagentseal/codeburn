import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'qwen3.5:35b-a3b': 'Qwen 3.5 35B (local)',
  'gpt-5.4': 'GPT-5.4',
  'moonshotai/kimi-k2.5': 'Kimi K2.5',
}

const toolNameMap: Record<string, string> = {
  exec: 'Bash',
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
}

const BASH_TOOL_NAMES = new Set(['exec', 'bash'])

type OpenClawContent = {
  type?: string
  text?: string
  name?: string
  arguments?: Record<string, unknown>
}

type OpenClawEntry = {
  type: string
  id?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: OpenClawContent[]
    model?: string
    api?: string
    provider?: string
    usage?: {
      input?: number
      output?: number
      cacheRead?: number
      cacheWrite?: number
      cost?: { total?: number }
    }
  }
}

function getOpenClawAgentsDir(override?: string): string {
  return override ?? process.env['OPENCLAW_AGENTS_DIR'] ?? join(homedir(), '.openclaw', 'agents')
}

function isLocalModel(model: string, api?: string): boolean {
  if (api === 'ollama') return true
  return model.toLowerCase().includes('qwen')
}

async function discoverSessionsInDir(agentsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let agents: string[]
  try {
    agents = await readdir(agentsDir)
  } catch {
    return sources
  }

  for (const agent of agents) {
    const sessionsDir = join(agentsDir, agent, 'sessions')
    const dirStat = await stat(sessionsDir).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    let files: string[]
    try {
      files = await readdir(sessionsDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.includes('.jsonl')) continue
      const filePath = join(sessionsDir, file)
      const fileStat = await stat(filePath).catch(() => null)
      if (!fileStat?.isFile()) continue

      sources.push({ path: filePath, project: agent, provider: 'openclaw' })
    }
  }

  return sources
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (content === null) return
      const lines = content.split('\n').filter(l => l.trim())
      let sessionId = basename(source.path, '.jsonl')
      let pendingUserMessage = ''

      for (const line of lines) {
        let entry: OpenClawEntry
        try {
          entry = JSON.parse(line) as OpenClawEntry
        } catch {
          continue
        }

        if (entry.type === 'session') {
          sessionId = entry.id ?? sessionId
          continue
        }

        if (entry.type !== 'message') continue

        const msg = entry.message
        if (!msg) continue

        if (msg.role === 'user') {
          const texts = (msg.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .filter(Boolean)
          if (texts.length > 0) pendingUserMessage = texts.join(' ')
          continue
        }

        if (msg.role !== 'assistant' || !msg.usage) continue

        const input = msg.usage.input ?? 0
        const output = msg.usage.output ?? 0
        const cacheRead = msg.usage.cacheRead ?? 0
        const cacheWrite = msg.usage.cacheWrite ?? 0

        if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue

        const model = msg.model ?? 'unknown'
        const messageId = entry.id ?? entry.timestamp ?? ''
        const dedupKey = `openclaw:${sessionId}:${messageId}`

        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const toolCalls = (msg.content ?? []).filter(c => c.type === 'toolCall' && c.name)
        const tools = toolCalls.map(c => toolNameMap[c.name!] ?? c.name!)
        const bashCommands = toolCalls
          .filter(c => BASH_TOOL_NAMES.has(c.name!))
          .flatMap(c => {
            const cmd = c.arguments?.['command']
            return typeof cmd === 'string' ? extractBashCommands(cmd) : []
          })

        // Local Ollama models are free; never attribute cost to them even if
        // LiteLLM happens to match the name or the session recorded a nonzero value.
        let costUSD = 0
        if (!isLocalModel(model, msg.api)) {
          costUSD = calculateCost(model, input, output, cacheWrite, cacheRead, 0)
          if (costUSD === 0) {
            const embedded = msg.usage.cost?.total
            if (typeof embedded === 'number' && embedded > 0) costUSD = embedded
          }
        }

        const timestamp = entry.timestamp ?? ''

        yield {
          provider: 'openclaw',
          model,
          inputTokens: input,
          outputTokens: output,
          cacheCreationInputTokens: cacheWrite,
          cacheReadInputTokens: cacheRead,
          cachedInputTokens: cacheRead,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools,
          bashCommands,
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: pendingUserMessage,
          sessionId,
        }

        pendingUserMessage = ''
      }
    },
  }
}

export function createOpenClawProvider(agentsDir?: string): Provider {
  const dir = getOpenClawAgentsDir(agentsDir)

  return {
    name: 'openclaw',
    displayName: 'OpenClaw',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
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

export const openclaw = createOpenClawProvider()
