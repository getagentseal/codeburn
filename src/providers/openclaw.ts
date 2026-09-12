import { readdir, readFile } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall, ProbeRoot } from './types.js'

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  exec: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  dispatch_agent: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  patch: 'Patch',
}

type OpenClawUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens?: number
  cost?: {
    total?: number
  }
}

type OpenClawEntry = {
  type: string
  customType?: string
  id?: string
  timestamp?: string
  provider?: string
  modelId?: string
  data?: {
    provider?: string
    modelId?: string
  }
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }>
    model?: string
    provider?: string
    usage?: OpenClawUsage
  }
}

type SessionIndex = Record<string, {
  sessionId: string
  sessionFile?: string
}>

function getOpenClawDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.openclaw', 'agents'),
    join(home, '.clawdbot', 'agents'),
    join(home, '.moltbot', 'agents'),
    join(home, '.moldbot', 'agents'),
  ]
}

function extractTools(content: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }> | undefined): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []
  if (!content) return { tools, bashCommands }

  for (const block of content) {
    if ((block.type === 'tool_use' || block.type === 'toolCall') && block.name) {
      const mapped = toolNameMap[block.name] ?? block.name
      tools.push(mapped)
      if (mapped === 'Bash' && block.arguments && typeof block.arguments.command === 'string') {
        bashCommands.push(...extractBashCommands(block.arguments.command))
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
      let sessionId = ''
      let sessionTimestamp = ''
      let currentModel = ''

      const calls: {
        model: string
        usage: OpenClawUsage
        tools: string[]
        bashCommands: string[]
        timestamp: string
        userMessage: string
        dedupId: string
      }[] = []

      let pendingUserMessage = ''

      for (const line of lines) {
        let entry: OpenClawEntry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }

        if (entry.type === 'session') {
          sessionId = entry.id ?? basename(source.path, '.jsonl')
          sessionTimestamp = entry.timestamp ?? ''
          continue
        }

        if (entry.type === 'model_change') {
          currentModel = entry.modelId ?? currentModel
          continue
        }

        if (entry.type === 'custom' && entry.customType === 'model-snapshot') {
          currentModel = entry.data?.modelId ?? currentModel
          continue
        }

        if (entry.type !== 'message' || !entry.message) continue

        const msg = entry.message
        if (msg.role === 'user') {
          if (!pendingUserMessage && Array.isArray(msg.content)) {
            const textBlock = msg.content.find(c => c.type === 'text' && c.text)
            pendingUserMessage = (textBlock?.text ?? '').slice(0, 500)
          }
          continue
        }

        if (msg.role !== 'assistant') continue

        const model = msg.model ?? currentModel
        if (msg.usage) {
          const { tools, bashCommands } = extractTools(msg.content)
          calls.push({
            model,
            usage: msg.usage,
            tools,
            bashCommands,
            timestamp: entry.timestamp ?? sessionTimestamp,
            userMessage: pendingUserMessage,
            dedupId: entry.id ?? '',
          })
          pendingUserMessage = ''
        }
      }

      if (!sessionId) sessionId = basename(source.path, '.jsonl')

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]
        const dedupKey = `openclaw:${sessionId}:${call.dedupId || i}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const u = call.usage
        const costFromProvider = u.cost?.total ?? 0
        const costUSD = costFromProvider > 0
          ? costFromProvider
          : calculateCost(call.model, u.input, u.output, u.cacheWrite, u.cacheRead, 0)

        const ts = new Date(call.timestamp)
        if (isNaN(ts.getTime()) || ts.getTime() < 1_000_000_000_000) continue

        yield {
          provider: 'openclaw',
          model: call.model || 'openclaw-auto',
          inputTokens: u.input,
          outputTokens: u.output,
          cacheCreationInputTokens: u.cacheWrite,
          cacheReadInputTokens: u.cacheRead,
          cachedInputTokens: u.cacheRead,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools: [...new Set(call.tools)],
          bashCommands: [...new Set(call.bashCommands)],
          timestamp: ts.toISOString(),
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: call.userMessage,
          sessionId,
        }
      }
    },
  }
}

async function discoverInDir(agentsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let agentDirs: string[]
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true })
    agentDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return sources
  }

  for (const agent of agentDirs) {
    const sessionsDir = join(agentsDir, agent, 'sessions')

    let indexData: SessionIndex = {}
    try {
      const indexRaw = await readFile(join(sessionsDir, 'sessions.json'), 'utf-8')
      indexData = JSON.parse(indexRaw)
    } catch { /* no index, fall back to directory scan */ }

    const seenFiles = new Set<string>()

    for (const entry of Object.values(indexData)) {
      if (entry.sessionFile) {
        seenFiles.add(entry.sessionFile)
        sources.push({ path: entry.sessionFile, project: agent, provider: 'openclaw' })
      } else if (entry.sessionId) {
        const filePath = join(sessionsDir, `${entry.sessionId}.jsonl`)
        seenFiles.add(filePath)
        sources.push({ path: filePath, project: agent, provider: 'openclaw' })
      }
    }

    try {
      const files = await readdir(sessionsDir)
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const filePath = join(sessionsDir, f)
        if (seenFiles.has(filePath)) continue
        sources.push({ path: filePath, project: agent, provider: 'openclaw' })
      }
    } catch { /* directory may not exist */ }
  }

  return sources
}

export function createOpenClawProvider(overrideDir?: string): Provider {
  return {
    name: 'openclaw',
    displayName: 'OpenClaw',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      // #899: empty agents root that exists must be distinguishable from missing install.
      const roots = overrideDir ? [overrideDir] : getOpenClawDirs()
      return roots.map(path => ({ path, label: 'agents' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (overrideDir) return discoverInDir(overrideDir)
      const all: SessionSource[] = []
      for (const dir of getOpenClawDirs()) {
        const sessions = await discoverInDir(dir)
        all.push(...sessions)
      }
      return all
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const openclaw = createOpenClawProvider()
