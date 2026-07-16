import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'

const METADATA_PREFIX_BYTES = 64 * 1024

type CodeWhaleCost = {
  session_cost_usd?: number
  subagent_cost_usd?: number
}

type CodeWhaleMetadata = {
  id: string
  created_at?: string
  updated_at?: string
  total_tokens?: number
  model?: string
  model_provider?: string
  workspace?: string
  cost?: CodeWhaleCost
}

type CodeWhaleContentBlock = {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

type CodeWhaleMessage = {
  role?: string
  content?: string | CodeWhaleContentBlock[]
}

type CodeWhaleSession = {
  metadata?: unknown
  messages?: unknown
}

const toolNameMap: Record<string, string> = {
  exec_shell: 'Bash',
  exec_shell_wait: 'Bash',
  exec_shell_interact: 'Bash',
  exec_shell_cancel: 'Bash',
  task_shell_start: 'Bash',
  task_shell_wait: 'Bash',
  terminal_run: 'Bash',
  terminal_send: 'Bash',
  terminal_wait: 'Bash',
  terminal_cancel: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  fim_edit: 'Edit',
  apply_patch: 'Edit',
  list_dir: 'Glob',
  grep_files: 'Grep',
  web_search: 'WebSearch',
  fetch_url: 'WebFetch',
  'web.run': 'WebSearch',
  agent: 'Agent',
  'agents/list': 'Agent',
  'agents/message': 'Agent',
  'agents/followup': 'Agent',
  'agents/interrupt': 'Agent',
  'agents/wait': 'Agent',
  todo_write: 'TodoWrite',
  todo_add: 'TodoWrite',
  todo_update: 'TodoWrite',
  todo_list: 'TodoWrite',
  checklist_write: 'TodoWrite',
  checklist_add: 'TodoWrite',
  checklist_update: 'TodoWrite',
  checklist_list: 'TodoWrite',
  update_plan: 'TodoWrite',
  load_skill: 'Skill',
  request_user_input: 'AskUser',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function safeTokenCount(value: unknown): number {
  return Math.floor(Math.min(safeNonNegativeNumber(value), Number.MAX_SAFE_INTEGER))
}

function parseMetadata(value: unknown): CodeWhaleMetadata | null {
  if (!isRecord(value)) return null
  const id = nonEmptyString(value['id'])
  if (!id) return null

  return {
    id,
    created_at: nonEmptyString(value['created_at']),
    updated_at: nonEmptyString(value['updated_at']),
    total_tokens: safeTokenCount(value['total_tokens']),
    model: nonEmptyString(value['model']),
    model_provider: nonEmptyString(value['model_provider']),
    workspace: nonEmptyString(value['workspace']),
    cost: isRecord(value['cost']) ? value['cost'] as CodeWhaleCost : undefined,
  }
}

function findStringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x5c) {
      i++
    } else if (source.charCodeAt(i) === 0x22) {
      return i
    }
  }
  return -1
}

function findObjectEnd(source: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < source.length; i++) {
    const ch = source.charCodeAt(i)
    if (inString) {
      if (ch === 0x5c) i++
      else if (ch === 0x22) inString = false
      continue
    }
    if (ch === 0x22) inString = true
    else if (ch === 0x7b) depth++
    else if (ch === 0x7d && --depth === 0) return i
  }
  return -1
}

// CodeWhale itself reads only the first 64 KiB when listing sessions. Mirror
// that fast path so discovery does not parse every multi-megabyte transcript.
function extractTopLevelMetadata(source: string): CodeWhaleMetadata | null {
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i)
    if (ch === 0x7b) {
      depth++
      continue
    }
    if (ch === 0x7d) {
      depth--
      continue
    }
    if (ch !== 0x22) continue

    const end = findStringEnd(source, i)
    if (end === -1) return null
    if (depth !== 1) {
      i = end
      continue
    }

    let key: unknown
    try {
      key = JSON.parse(source.slice(i, end + 1))
    } catch {
      return null
    }
    i = end
    if (key !== 'metadata') continue

    let cursor = end + 1
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] !== ':') continue
    cursor++
    while (cursor < source.length && /\s/.test(source[cursor]!)) cursor++
    if (source[cursor] !== '{') return null

    const objectEnd = findObjectEnd(source, cursor)
    if (objectEnd === -1) return null
    try {
      return parseMetadata(JSON.parse(source.slice(cursor, objectEnd + 1)))
    } catch {
      return null
    }
  }
  return null
}

async function readSessionMetadata(filePath: string): Promise<CodeWhaleMetadata | null> {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return null

  try {
    try {
      const prefix = Buffer.alloc(METADATA_PREFIX_BYTES)
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
      const metadata = extractTopLevelMetadata(prefix.subarray(0, bytesRead).toString('utf-8'))
      if (metadata) return metadata
    } catch {
      return null
    }
  } finally {
    await handle.close().catch(() => {})
  }

  const raw = await readSessionFile(filePath)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as CodeWhaleSession
    return parseMetadata(parsed.metadata)
  } catch {
    return null
  }
}

function defaultSessionDirs(): string[] {
  const configuredHome = process.env['CODEWHALE_HOME']?.trim()
  if (configuredHome) return [join(configuredHome, 'sessions')]
  return [
    join(homedir(), '.codewhale', 'sessions'),
    join(homedir(), '.deepseek', 'sessions'),
  ]
}

function projectName(workspace: string | undefined): string {
  if (!workspace) return 'CodeWhale'
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? 'CodeWhale'
}

async function discoverInDir(dir: string): Promise<Array<{ source: SessionSource; id: string }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const results: Array<{ source: SessionSource; id: string }> = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(dir, entry.name)
    const metadata = await readSessionMetadata(path)
    if (!metadata) continue
    results.push({
      id: metadata.id,
      source: {
        path,
        project: projectName(metadata.workspace),
        provider: 'codewhale',
      },
    })
  }

  return results
}

function normalizeTimestamp(value: string | undefined): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function firstUserMessage(messages: CodeWhaleMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
          .filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
          .join(' ')
        : ''
    if (text.trim()) return Array.from(text.trim()).slice(0, 500).join('')
  }
  return ''
}

function mapToolName(rawName: string): string {
  if (rawName.startsWith('mcp__')) return rawName
  if (rawName.startsWith('agents/')) return 'Agent'
  return Object.prototype.hasOwnProperty.call(toolNameMap, rawName)
    ? toolNameMap[rawName]!
    : rawName
}

function toolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(input[key])
    if (value) return value
  }
  return undefined
}

function collectTools(messages: CodeWhaleMessage[]): {
  tools: string[]
  bashCommands: string[]
  toolSequence: ToolCall[][]
  skills: string[]
  subagentTypes: string[]
  webSearchRequests: number
} {
  const tools: string[] = []
  const bashCommands: string[] = []
  const toolSequence: ToolCall[][] = []
  const skills: string[] = []
  const subagentTypes: string[] = []
  let webSearchRequests = 0

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const turnTools: ToolCall[] = []

    for (const block of message.content) {
      if (block?.type !== 'tool_use' && block?.type !== 'server_tool_use') continue
      const rawName = nonEmptyString(block.name)
      if (!rawName) continue
      const mapped = mapToolName(rawName)
      const input = toolInput(block.input)
      const toolCall: ToolCall = { tool: mapped }

      const file = firstString(input, ['file_path', 'path', 'target_file', 'file'])
      if (file) toolCall.file = file
      const command = firstString(input, ['command', 'cmd'])
      if (command) toolCall.command = command

      if (mapped === 'Bash' && command) {
        bashCommands.push(...extractBashCommands(command))
      }
      if (mapped === 'Skill') {
        const skill = firstString(input, ['name', 'skill', 'skill_name'])
        if (skill) skills.push(skill)
      }
      if (mapped === 'Agent') {
        const subagentType = firstString(input, ['type', 'agent_type', 'profile'])
        if (subagentType) subagentTypes.push(subagentType)
      }
      if (mapped === 'WebSearch') webSearchRequests++

      tools.push(mapped)
      turnTools.push(toolCall)
    }

    if (turnTools.length > 0) toolSequence.push(turnTools)
  }

  return { tools, bashCommands, toolSequence, skills, subagentTypes, webSearchRequests }
}

function reportedCost(cost: CodeWhaleCost | undefined): { value: number; exact: boolean } {
  if (!cost || typeof cost !== 'object') return { value: 0, exact: false }
  const hasSessionCost = Object.prototype.hasOwnProperty.call(cost, 'session_cost_usd')
  const hasSubagentCost = Object.prototype.hasOwnProperty.call(cost, 'subagent_cost_usd')
  if (!hasSessionCost && !hasSubagentCost) return { value: 0, exact: false }
  return {
    value: safeNonNegativeNumber(cost.session_cost_usd) + safeNonNegativeNumber(cost.subagent_cost_usd),
    exact: true,
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      let metadata: CodeWhaleMetadata | null = null
      let messages: CodeWhaleMessage[] = []

      if (raw !== null) {
        try {
          const saved = JSON.parse(raw) as CodeWhaleSession
          metadata = parseMetadata(saved.metadata)
          messages = Array.isArray(saved.messages)
            ? saved.messages.filter(isRecord) as CodeWhaleMessage[]
            : []
        } catch {
          // A truncated transcript can still have complete, authoritative
          // aggregate metadata at the front of the file.
        }
      }
      metadata ??= await readSessionMetadata(source.path)
      if (!metadata) return
      const totalTokens = safeTokenCount(metadata.total_tokens)
      const model = metadata.model ?? metadata.model_provider ?? 'unknown'
      const localCost = reportedCost(metadata.cost)
      const costUSD = localCost.exact
        ? localCost.value
        : calculateCost(model, totalTokens, 0, 0, 0, 0)
      if (totalTokens === 0 && costUSD === 0) return

      const deduplicationKey = `codewhale:${metadata.id}`
      if (seenKeys.has(deduplicationKey)) return
      seenKeys.add(deduplicationKey)

      let timestamp = normalizeTimestamp(metadata.updated_at) || normalizeTimestamp(metadata.created_at)
      if (!timestamp) {
        const fileStat = await stat(source.path).catch(() => null)
        timestamp = fileStat?.mtime.toISOString() ?? ''
      }

      const { tools, bashCommands, toolSequence, skills, subagentTypes, webSearchRequests } = collectTools(messages)
      const workspace = metadata.workspace

      yield {
        provider: 'codewhale',
        model,
        // CodeWhale persists only one aggregate token counter. Preserve it
        // losslessly in the input column instead of inventing a split.
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests,
        costUSD,
        costIsEstimated: !localCost.exact,
        tools,
        bashCommands,
        skills,
        subagentTypes,
        timestamp,
        speed: 'standard',
        deduplicationKey,
        turnId: `${metadata.id}:session`,
        toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
        userMessage: firstUserMessage(messages),
        sessionId: metadata.id,
        project: projectName(workspace),
        projectPath: workspace,
      }
    },
  }
}

export function createCodeWhaleProvider(overrideDirs?: string | string[]): Provider {
  const configuredDirs = overrideDirs === undefined
    ? undefined
    : Array.isArray(overrideDirs) ? overrideDirs : [overrideDirs]

  return {
    name: 'codewhale',
    displayName: 'CodeWhale',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const seenSessionIds = new Set<string>()
      const sources: SessionSource[] = []

      // Primary comes before legacy so an id already migrated by CodeWhale is
      // not counted twice and the primary copy wins without modifying either.
      for (const dir of configuredDirs ?? defaultSessionDirs()) {
        for (const candidate of await discoverInDir(dir)) {
          if (seenSessionIds.has(candidate.id)) continue
          seenSessionIds.add(candidate.id)
          sources.push(candidate.source)
        }
      }
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const codewhale = createCodeWhaleProvider()
