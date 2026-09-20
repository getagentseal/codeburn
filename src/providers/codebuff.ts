import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import type { DedupSet } from '../session-cache.js'

// Codebuff (formerly Manicode) uses a credit-based billing system. The local
// chat-messages.json doesn't record per-call token counts the way Claude Code
// or Codex do -- only `credits` on completed assistant messages. We convert
// credits to USD using Codebuff's retail pay-as-you-go rate so the cost shows
// up in the dashboard even when tokens are absent. The rate intentionally
// rounds up to the public PAYG tier ($0.01 / credit) so we never understate
// spend; users on a subscription plan get a conservative upper bound.
const USD_PER_CREDIT = 0.01

// Codebuff's chat history lives under `~/.config/manicode/` (the legacy
// product name is still on disk). Development and staging channels use
// `manicode-dev` and `manicode-staging` -- we walk all three when present.
const CHANNELS = ['manicode', 'manicode-dev', 'manicode-staging'] as const

const modelDisplayNames: Record<string, string> = {
  codebuff: 'Codebuff',
  'codebuff-base': 'Codebuff Base',
  'codebuff-base2': 'Codebuff Base 2',
  'codebuff-lite': 'Codebuff Lite',
  'codebuff-max': 'Codebuff Max',
}

// Codebuff's native tool names map to codeburn's canonical tool set so
// classifier heuristics (edit/read/bash/etc.) behave consistently with the
// other providers.
const toolNameMap: Record<string, string> = {
  read_files: 'Read',
  read_file: 'Read',
  code_search: 'Grep',
  glob: 'Glob',
  find_files: 'Glob',
  str_replace: 'Edit',
  edit_file: 'Edit',
  write_file: 'Write',
  run_terminal_command: 'Bash',
  terminal: 'Bash',
  spawn_agents: 'Agent',
  spawn_agent: 'Agent',
  write_todos: 'TodoWrite',
  create_plan: 'TodoWrite',
  browser_logs: 'WebFetch',
  web_search: 'WebSearch',
  fetch_url: 'WebFetch',
}

// Tool names we ignore for classification -- they're not useful signals for
// distinguishing "coding" vs "exploration" vs "planning" work.
const IGNORED_TOOLS = new Set(['suggest_followups', 'end_turn'])

type CodebuffUsage = {
  inputTokens?: number
  input_tokens?: number
  promptTokens?: number
  prompt_tokens?: number
  outputTokens?: number
  output_tokens?: number
  completionTokens?: number
  completion_tokens?: number
  cacheCreationInputTokens?: number
  cache_creation_input_tokens?: number
  cacheReadInputTokens?: number
  cache_read_input_tokens?: number
  promptTokensDetails?: { cachedTokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
}

type CodebuffBlock = {
  type?: string
  content?: string
  toolName?: string
  input?: Record<string, unknown>
  output?: string
  agentName?: string
  agentType?: string
  status?: string
  blocks?: CodebuffBlock[]
}

type CodebuffHistoryMessage = {
  role?: string
  providerOptions?: {
    codebuff?: { model?: string; usage?: CodebuffUsage }
    usage?: CodebuffUsage
  }
}

type CodebuffMetadata = {
  model?: string
  modelId?: string
  timestamp?: string | number
  usage?: CodebuffUsage
  codebuff?: { model?: string; usage?: CodebuffUsage }
  runState?: {
    cwd?: string
    sessionState?: {
      cwd?: string
      projectContext?: { cwd?: string }
      fileContext?: { cwd?: string }
      mainAgentState?: {
        agentType?: string
        messageHistory?: CodebuffHistoryMessage[]
      }
    }
  }
}

type CodebuffChatMessage = {
  id?: string
  variant?: string
  role?: string
  content?: string
  timestamp?: string | number
  credits?: number
  blocks?: CodebuffBlock[]
  metadata?: CodebuffMetadata
}

// Shared by discoverSessions and probeRoots. Factory / CODEBUFF_DATA_DIR win
// as a single root; otherwise discovery walks every CHANNEL before existence
// filtering. Empty / blank factory is unset (same as #938 truthiness).
export function getCodebuffRootSet(override?: string): string[] {
  if (override && override.trim()) return [override]
  const envPath = process.env['CODEBUFF_DATA_DIR']
  if (envPath && envPath.trim()) return [envPath]
  const configDir = join(homedir(), '.config')
  return CHANNELS.map(channel => join(configDir, channel))
}

function pickNumber(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function normalizeUsage(u: CodebuffUsage | undefined): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    input: pickNumber(u.inputTokens, u.input_tokens, u.promptTokens, u.prompt_tokens) ?? 0,
    output: pickNumber(u.outputTokens, u.output_tokens, u.completionTokens, u.completion_tokens) ?? 0,
    cacheRead:
      pickNumber(
        u.cacheReadInputTokens,
        u.cache_read_input_tokens,
        u.promptTokensDetails?.cachedTokens,
        u.prompt_tokens_details?.cached_tokens,
      ) ?? 0,
    cacheWrite: pickNumber(u.cacheCreationInputTokens, u.cache_creation_input_tokens) ?? 0,
  }
}

function coerceTimestamp(value: string | number | undefined): string {
  if (value == null) return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : ''
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

function parseChatIdToIso(chatId: string): string {
  const iso = chatId.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3')
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function extractCwd(meta: CodebuffMetadata | undefined): string | null {
  const rs = meta?.runState
  if (!rs) return null
  return (
    rs.sessionState?.projectContext?.cwd ??
    rs.sessionState?.fileContext?.cwd ??
    rs.sessionState?.cwd ??
    rs.cwd ??
    null
  )
}

function extractAgentType(meta: CodebuffMetadata | undefined): string | null {
  return meta?.runState?.sessionState?.mainAgentState?.agentType ?? null
}

function collectBlockTools(blocks: CodebuffBlock[] | undefined, acc: { tools: string[]; bash: string[] }): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool' && typeof block.toolName === 'string') {
      const raw = block.toolName
      if (!IGNORED_TOOLS.has(raw)) {
        acc.tools.push(toolNameMap[raw] ?? raw)
      }
      if ((raw === 'run_terminal_command' || raw === 'terminal') && block.input) {
        const cmd = block.input['command']
        if (typeof cmd === 'string') {
          acc.bash.push(...extractBashCommands(cmd))
        }
      }
    }
    if (block.type === 'agent' && Array.isArray(block.blocks)) {
      collectBlockTools(block.blocks, acc)
    }
  }
}

function resolveModel(meta: CodebuffMetadata | undefined, stashedModel: string | null): string {
  const direct = meta?.model ?? meta?.modelId ?? meta?.codebuff?.model
  if (direct) return direct
  if (stashedModel) return stashedModel
  const agentType = extractAgentType(meta)
  if (agentType) return `codebuff-${agentType}`
  return 'codebuff'
}

function usageFromHistory(meta: CodebuffMetadata | undefined): {
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  const hist = meta?.runState?.sessionState?.mainAgentState?.messageHistory
  if (!Array.isArray(hist)) return { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (let i = hist.length - 1; i >= 0; i--) {
    const entry = hist[i]
    if (!entry || entry.role !== 'assistant' || !entry.providerOptions) continue
    const u = normalizeUsage(entry.providerOptions.usage ?? entry.providerOptions.codebuff?.usage)
    if (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0) {
      return { model: entry.providerOptions.codebuff?.model ?? null, ...u }
    }
  }
  return { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function discoverChannel(root: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const projectsDir = join(root, 'projects')

  let projectNames: string[]
  try {
    projectNames = await readdir(projectsDir)
  } catch {
    return sources
  }

  for (const projectName of projectNames) {
    const chatsDir = join(projectsDir, projectName, 'chats')
    let chatIds: string[]
    try {
      chatIds = await readdir(chatsDir)
    } catch {
      continue
    }

    for (const chatId of chatIds) {
      const chatDir = join(chatsDir, chatId)
      const dirStat = await stat(chatDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      const messagesPath = join(chatDir, 'chat-messages.json')
      const messagesStat = await stat(messagesPath).catch(() => null)
      if (!messagesStat?.isFile()) continue

      // Resolve the real cwd from run-state.json so sessions group by the
      // originating project directory instead of the sanitized chat folder
      // name (which is often the same for many users).
      const runState = await readJson<CodebuffMetadata['runState']>(
        join(chatDir, 'run-state.json'),
      )
      const cwd = extractCwd({ runState: runState ?? undefined })
      const project = cwd ? basename(cwd) : projectName

      sources.push({ path: chatDir, project, provider: 'codebuff' })
    }
  }

  return sources
}

async function discoverSessionsInRoots(roots: string[]): Promise<SessionSource[]> {
  const results: SessionSource[] = []
  for (const root of roots) {
    results.push(...await discoverChannel(root))
  }
  return results
}

// Downstream aggregation groups sessions by `(provider, sessionId, project)`
// (see src/parser.ts). Codebuff chat folders are ISO timestamps, which means
// the same `chatId` can legitimately appear under each channel root
// (`manicode`, `manicode-dev`, `manicode-staging`) and even resolve to the
// same project cwd. To keep those sessions distinct we include the channel
// identity in the sessionId. The channel is derived from the fixed path
// structure Codebuff writes on disk: `<channelRoot>/projects/<project>/chats/<chatId>`.
// Returns null when the path doesn't match that shape so the caller can fall
// back to a plain chatId.
//
// We use '/' as the channel/chatId separator rather than ':' because
// src/parser.ts builds its session key as `${provider}:${sessionId}:${project}`
// and reconstructs the sessionId with `key.split(':')[1]` -- any colon inside
// sessionId would get truncated to just the channel name downstream.
function extractChannelFromChatDir(chatDir: string): string | null {
  const chatsDir = dirname(chatDir)
  if (basename(chatsDir) !== 'chats') return null
  const projectDir = dirname(chatsDir)
  const projectsDir = dirname(projectDir)
  if (basename(projectsDir) !== 'projects') return null
  const channel = basename(dirname(projectsDir))
  return channel ? channel : null
}

function createParser(source: SessionSource, seenKeys: DedupSet): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const chatDir = source.path
      const chatId = basename(chatDir)
      const channel = extractChannelFromChatDir(chatDir)
      const sessionId = channel ? `${channel}/${chatId}` : chatId
      const fallbackTs = parseChatIdToIso(chatId)

      const messages = await readJson<CodebuffChatMessage[]>(
        join(chatDir, 'chat-messages.json'),
      )
      if (!Array.isArray(messages)) return

      let pendingUserMessage = ''

      for (const [idx, msg] of messages.entries()) {
        if (!msg || typeof msg !== 'object') continue

        const variant = msg.variant ?? msg.role
        if (variant === 'user') {
          if (typeof msg.content === 'string' && msg.content.length > 0) {
            pendingUserMessage = msg.content
          }
          continue
        }

        if (variant !== 'ai' && variant !== 'agent' && variant !== 'assistant') continue

        const credits = typeof msg.credits === 'number' && Number.isFinite(msg.credits) ? msg.credits : 0
        const directUsage = normalizeUsage(msg.metadata?.usage ?? msg.metadata?.codebuff?.usage)
        const stashedUsage = usageFromHistory(msg.metadata)

        const hasDirect =
          directUsage.input > 0 ||
          directUsage.output > 0 ||
          directUsage.cacheRead > 0 ||
          directUsage.cacheWrite > 0
        const usage = hasDirect ? directUsage : stashedUsage
        const stashedModel = stashedUsage.model

        // Skip messages with neither credits nor tokens -- they're typically
        // in-progress mode dividers or empty framing blocks.
        if (credits === 0 && usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) {
          continue
        }

        const model = resolveModel(msg.metadata, stashedModel)
        const timestamp = coerceTimestamp(msg.timestamp ?? msg.metadata?.timestamp) || fallbackTs

        const dedupId = msg.id ?? String(idx)
        const dedupKey = `codebuff:${chatDir}:${dedupId}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const acc = { tools: [] as string[], bash: [] as string[] }
        collectBlockTools(msg.blocks, acc)

        // Prefer calculated cost from tokens when available (multi-provider
        // models routed through Codebuff still show up in LiteLLM); otherwise
        // fall back to the credit-based approximation.
        let costUSD = calculateCost(model, usage.input, usage.output, usage.cacheWrite, usage.cacheRead, 0)
        if (costUSD === 0 && credits > 0) {
          costUSD = credits * USD_PER_CREDIT
        }

        yield {
          provider: 'codebuff',
          model,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheCreationInputTokens: usage.cacheWrite,
          cacheReadInputTokens: usage.cacheRead,
          cachedInputTokens: usage.cacheRead,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools: acc.tools,
          bashCommands: acc.bash,
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

export function createCodebuffProvider(baseDir?: string): Provider {
  const roots = getCodebuffRootSet(baseDir)

  return {
    name: 'codebuff',
    displayName: 'Codebuff',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return roots.map(path => ({ path, label: 'chats' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInRoots(roots)
    },

    createSessionParser(source: SessionSource, seenKeys: DedupSet): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const codebuff = createCodebuffProvider()
