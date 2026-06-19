import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { ParsedProviderCall } from './types.js'

// The message/part shape shared by OpenCode-style stores (OpenCode SQLite, the
// OpenCode file-based JSON layout, and Kilo Code). Token-bearing assistant
// messages carry either the normalized `tokens` object or a raw `usage` block.
export type MessageData = {
  role: string
  modelID?: string
  model?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export type PartData = {
  type: string
  text?: string
  tool?: string
  state?: { input?: { command?: string } }
}

const toolNameMap: Record<string, string> = {
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
  skill: 'Skill',
  patch: 'Patch',
}

export function normalizeToolName(rawTool?: string): string {
  if (!rawTool) return ''
  if (rawTool.startsWith('mcp__')) return rawTool
  const builtIn = toolNameMap[rawTool]
  if (builtIn) return builtIn
  const serverSeparator = rawTool.indexOf('_')
  if (serverSeparator > 0 && serverSeparator < rawTool.length - 1) {
    const server = rawTool.slice(0, serverSeparator)
    const tool = rawTool.slice(serverSeparator + 1)
    return `mcp__${server}__${tool}`
  }
  return rawTool
}

export function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

export function parseTimestamp(raw: number): string {
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

// Build a ParsedProviderCall from one assistant message and its parts. Returns
// null when the message has no tokens, no cost, and no substantive parts (an
// empty or errored turn worth skipping). Shared by the SQLite and file-based
// OpenCode parsers so both attribute tokens, tools, and cost identically.
export function buildAssistantCall(opts: {
  providerName: string
  dedupKey: string
  sessionId: string
  data: MessageData
  parts: PartData[]
  timeCreatedMs: number
  userMessage: string
}): ParsedProviderCall | null {
  const { data, parts } = opts

  const tokens = {
    input: data.tokens?.input ?? data.usage?.input_tokens ?? 0,
    output: data.tokens?.output ?? data.usage?.output_tokens ?? 0,
    reasoning: data.tokens?.reasoning ?? 0,
    cacheRead: data.tokens?.cache?.read ?? data.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: data.tokens?.cache?.write ?? data.usage?.cache_creation_input_tokens ?? 0,
  }

  const toolParts = parts.filter((p) => (p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call') && normalizeToolName(p.tool))
  const hasTextOutput = parts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
  const hasToolOrTextParts = hasTextOutput || toolParts.length > 0
  const hasAnySubstantiveParts = parts.some((p) =>
    p.type === 'text' || p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call' ||
    p.type === 'tool-result' || p.type === 'tool_result' || p.type === 'reasoning' || p.type === 'file'
  )
  const hasActivity = hasToolOrTextParts || hasAnySubstantiveParts

  const allZero =
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.reasoning === 0 &&
    tokens.cacheRead === 0 &&
    tokens.cacheWrite === 0
  if (allZero && (data.cost ?? 0) === 0 && !hasActivity) return null

  const tools = toolParts
    .map((p) => normalizeToolName(p.tool))
    .filter(Boolean)

  const bashCommands = toolParts
    .filter((p) => p.tool === 'bash' && typeof p.state?.input?.command === 'string')
    .flatMap((p) => extractBashCommands(p.state!.input!.command!))

  const model = data.modelID ?? data.model ?? 'unknown'
  let costUSD = calculateCost(
    model,
    tokens.input,
    tokens.output + tokens.reasoning,
    tokens.cacheWrite,
    tokens.cacheRead,
    0,
  )

  if (costUSD === 0 && typeof data.cost === 'number' && data.cost > 0) {
    costUSD = data.cost
  }

  return {
    provider: opts.providerName,
    model,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationInputTokens: tokens.cacheWrite,
    cacheReadInputTokens: tokens.cacheRead,
    cachedInputTokens: tokens.cacheRead,
    reasoningTokens: tokens.reasoning,
    webSearchRequests: 0,
    costUSD,
    tools,
    bashCommands,
    timestamp: parseTimestamp(opts.timeCreatedMs),
    speed: 'standard',
    deduplicationKey: opts.dedupKey,
    userMessage: opts.userMessage,
    sessionId: opts.sessionId,
  }
}
