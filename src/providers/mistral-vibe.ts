import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile, readSessionLines } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import { safeNumber } from '../parser.js'

const METADATA_FILENAME = 'meta.json'
const MESSAGES_FILENAME = 'messages.jsonl'
const DEFAULT_MODEL = 'mistral-medium-3.5'

const modelDisplayNames: Record<string, string> = {
  'mistral-medium-3.5': 'Mistral Medium 3.5',
  'mistral-vibe-cli-latest': 'Mistral Vibe CLI',
  'devstral-small': 'Devstral Small',
  'devstral-small-latest': 'Devstral Small',
  devstral: 'Devstral',
  local: 'Local',
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  search_replace: 'Edit',
  grep: 'Grep',
  task: 'Agent',
  todo: 'TodoWrite',
  skill: 'Skill',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  ask_user_question: 'AskUser',
  exit_plan_mode: 'ExitPlanMode',
}

type VibeStats = {
  session_prompt_tokens?: number
  session_completion_tokens?: number
  session_cost?: number
  input_price_per_million?: number
  output_price_per_million?: number
  tokens_per_second?: number
}

type VibeModelConfig = {
  name?: string
  alias?: string
  input_price?: number
  output_price?: number
}

type VibeMetadata = {
  session_id?: string
  start_time?: string
  end_time?: string | null
  environment?: {
    working_directory?: string | null
  }
  stats?: VibeStats
  config?: {
    active_model?: string
    models?: VibeModelConfig[]
  }
  title?: string | null
}

type VibeToolCall = {
  function?: {
    name?: string
    arguments?: string | Record<string, unknown> | null
  }
}

type VibeMessage = {
  role?: string
  content?: unknown
  message_id?: string
  timestamp?: string
  tool_calls?: VibeToolCall[] | null
}

function getMistralVibeSessionsDir(override?: string): string {
  if (override) return override
  const configuredHome = process.env['VIBE_HOME']
  const vibeHome = configuredHome ? expandHome(configuredHome) : join(homedir(), '.vibe')
  return join(vibeHome, 'logs', 'session')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function isFile(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null)
  return Boolean(s?.isFile())
}

async function isDirectory(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null)
  return Boolean(s?.isDirectory())
}

async function hasSessionFiles(dir: string): Promise<boolean> {
  const [hasMetadata, hasMessages] = await Promise.all([
    isFile(join(dir, METADATA_FILENAME)),
    isFile(join(dir, MESSAGES_FILENAME)),
  ])
  return hasMetadata && hasMessages
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  const raw = await readSessionFile(path)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as T : null
  } catch {
    return null
  }
}

async function discoverSessionDirs(root: string): Promise<string[]> {
  const sessionDirs: string[] = []

  let entries: string[]
  try {
    entries = (await readdir(root)).sort()
  } catch {
    return sessionDirs
  }

  for (const entry of entries) {
    const dir = join(root, entry)
    if (!await isDirectory(dir)) continue

    if (await hasSessionFiles(dir)) {
      sessionDirs.push(dir)
    }

    const agentsDir = join(dir, 'agents')
    if (!await isDirectory(agentsDir)) continue

    let agentEntries: string[]
    try {
      agentEntries = (await readdir(agentsDir)).sort()
    } catch {
      continue
    }

    for (const agentEntry of agentEntries) {
      const agentDir = join(agentsDir, agentEntry)
      if (await isDirectory(agentDir) && await hasSessionFiles(agentDir)) {
        sessionDirs.push(agentDir)
      }
    }
  }

  return sessionDirs
}

function activeModelConfig(metadata: VibeMetadata): VibeModelConfig | null {
  const activeModel = metadata.config?.active_model
  const models = metadata.config?.models
  if (!activeModel || !Array.isArray(models)) return null
  return models.find(m => m.alias === activeModel || m.name === activeModel) ?? null
}

function resolveModel(metadata: VibeMetadata): string {
  const activeModel = metadata.config?.active_model
  if (activeModel) return activeModel
  const configured = activeModelConfig(metadata)
  return configured?.alias ?? configured?.name ?? DEFAULT_MODEL
}

function calculateSessionCost(metadata: VibeMetadata, model: string, inputTokens: number, outputTokens: number): number {
  const stats = metadata.stats ?? {}
  const sessionCost = safeNumber(stats.session_cost)
  if (sessionCost > 0) return sessionCost

  const configured = activeModelConfig(metadata)
  const inputPrice = safeNumber(stats.input_price_per_million) || safeNumber(configured?.input_price)
  const outputPrice = safeNumber(stats.output_price_per_million) || safeNumber(configured?.output_price)

  if (inputPrice > 0 || outputPrice > 0) {
    return (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice
  }

  return calculateCost(model, inputTokens, outputTokens, 0, 0, 0)
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function parseToolArguments(raw: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function extractMessageTools(message: VibeMessage): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []

  if (message.role !== 'assistant') return { tools, bashCommands }

  for (const toolCall of message.tool_calls ?? []) {
    const rawName = toolCall.function?.name
    if (!rawName) continue

    const mappedName = toolNameMap[rawName] ?? rawName
    tools.push(mappedName)

    if (mappedName !== 'Bash') continue
    const args = parseToolArguments(toolCall.function?.arguments)
    const command = args['command']
    if (typeof command === 'string') {
      bashCommands.push(...extractBashCommands(command))
    }
  }

  return {
    tools: [...new Set(tools)],
    bashCommands: [...new Set(bashCommands)],
  }
}

function extractTools(messages: VibeMessage[]): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []

  for (const message of messages) {
    const extracted = extractMessageTools(message)
    tools.push(...extracted.tools)
    bashCommands.push(...extracted.bashCommands)
  }

  return {
    tools: [...new Set(tools)],
    bashCommands: [...new Set(bashCommands)],
  }
}

async function readMessages(path: string): Promise<VibeMessage[]> {
  const messages: VibeMessage[] = []
  for await (const line of readSessionLines(path)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object') messages.push(parsed as VibeMessage)
    } catch {
      continue
    }
  }
  return messages
}

function firstUserMessage(messages: VibeMessage[], fallback?: string | null): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = normalizeContent(message.content).trim()
    if (text) return text.slice(0, 500)
  }
  return (fallback ?? '').slice(0, 500)
}

function allocateInteger(total: number, index: number, count: number): number {
  if (count <= 1) return total
  const base = Math.floor(total / count)
  const remainder = total % count
  return base + (index < remainder ? 1 : 0)
}

function allocateCost(total: number, count: number): number {
  return count <= 1 ? total : total / count
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const metadataPath = join(source.path, METADATA_FILENAME)
      const messagesPath = join(source.path, MESSAGES_FILENAME)
      const metadata = await readJsonFile<VibeMetadata>(metadataPath)
      if (!metadata) return

      const stats = metadata.stats ?? {}
      const inputTokens = safeNumber(stats.session_prompt_tokens)
      const outputTokens = safeNumber(stats.session_completion_tokens)
      if (inputTokens === 0 && outputTokens === 0) return

      const sessionId = metadata.session_id || basename(source.path)
      const messages = await readMessages(messagesPath)
      const model = resolveModel(metadata)
      const costUSD = calculateSessionCost(metadata, model, inputTokens, outputTokens)
      const assistantMessages = messages.filter(m => m.role === 'assistant')
      const fallbackTimestamp = metadata.end_time ?? metadata.start_time ?? ''

      if (assistantMessages.length === 0) {
        const deduplicationKey = `mistral-vibe:${sessionId}`
        if (seenKeys.has(deduplicationKey)) return
        seenKeys.add(deduplicationKey)
        const { tools, bashCommands } = extractTools(messages)

        yield {
          provider: 'mistral-vibe',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools,
          bashCommands,
          timestamp: fallbackTimestamp,
          speed: 'standard',
          deduplicationKey,
          userMessage: firstUserMessage(messages, metadata.title),
          sessionId,
        }
        return
      }

      let currentUserMessage = (metadata.title ?? '').slice(0, 500)
      let turnOrdinal = 0
      let currentTurnId = `${sessionId}:prelude`
      let assistantOrdinal = 0

      for (const message of messages) {
        if (message.role === 'user') {
          const text = normalizeContent(message.content).trim()
          if (text) currentUserMessage = text.slice(0, 500)
          currentTurnId = `${sessionId}:turn-${turnOrdinal++}`
          continue
        }

        if (message.role !== 'assistant') continue

        const messageKey = message.message_id || `idx-${assistantOrdinal}`
        const deduplicationKey = `mistral-vibe:${sessionId}:${messageKey}`
        const allocationIndex = assistantOrdinal
        assistantOrdinal++

        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        const { tools, bashCommands } = extractMessageTools(message)

        yield {
          provider: 'mistral-vibe',
          model,
          inputTokens: allocateInteger(inputTokens, allocationIndex, assistantMessages.length),
          outputTokens: allocateInteger(outputTokens, allocationIndex, assistantMessages.length),
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD: allocateCost(costUSD, assistantMessages.length),
          tools,
          bashCommands,
          timestamp: message.timestamp ?? fallbackTimestamp,
          speed: 'standard',
          deduplicationKey,
          turnId: currentTurnId,
          userMessage: currentUserMessage,
          sessionId,
        }
      }
    },
  }
}

export function createMistralVibeProvider(sessionsDir?: string): Provider {
  const dir = getMistralVibeSessionsDir(sessionsDir)

  return {
    name: 'mistral-vibe',
    displayName: 'Mistral Vibe',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dirs = await discoverSessionDirs(dir)
      const sources: SessionSource[] = []

      for (const sessionDir of dirs) {
        const metadata = await readJsonFile<VibeMetadata>(join(sessionDir, METADATA_FILENAME))
        if (!metadata) continue
        const cwd = metadata.environment?.working_directory
        sources.push({
          path: sessionDir,
          project: cwd ? basename(cwd) : basename(sessionDir),
          provider: 'mistral-vibe',
        })
      }

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const mistralVibe = createMistralVibeProvider()
