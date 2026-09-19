// WorkBuddy and WorkBuddy AI providers
//
// Transcripts are JSONL files located at:
//   ~/.workbuddy/projects/<project-slug>/<uuid>.jsonl
//   ~/.workbuddy-ai/projects/<project-slug>/<uuid>.jsonl
//
// Each project folder contains session .jsonl files and auxiliary files like
// `<uuid>.file-rollback.ndjson` and `<uuid>.meta.json`.
//
// The transcript lines include:
//   - message (role: 'user' | 'assistant')
//   - function_call (tool invocation, often has providerData with rawUsage)
//   - function_call_result
//   - reasoning
//   - ai-title / custom-title
//
// Only lines carrying providerData.rawUsage (or direct usage) are counted as usage calls.
// All tool names are normalized to canonical codeburn vocabulary.

import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000

export interface WorkBuddyConfig {
  name: 'workbuddy' | 'workbuddyai'
  displayName: string
  envVar: string
  defaultDirName: string
}

export const WORKBUDDY_CONFIG: WorkBuddyConfig = {
  name: 'workbuddy',
  displayName: 'WorkBuddy',
  envVar: 'WORKBUDDY_HOME',
  defaultDirName: '.workbuddy',
}

export const WORKBUDDYAI_CONFIG: WorkBuddyConfig = {
  name: 'workbuddyai',
  displayName: 'WorkBuddy AI',
  envVar: 'WORKBUDDY_AI_HOME',
  defaultDirName: '.workbuddy-ai',
}

export function getWorkBuddyHome(config: WorkBuddyConfig): string {
  const envPath = config.name === 'workbuddy'
    ? process.env.WORKBUDDY_HOME
    : process.env.WORKBUDDY_AI_HOME
  if (envPath && envPath.trim().length > 0) return envPath.trim()
  return join(homedir(), config.defaultDirName)
}

export function getWorkBuddyProjectsDirs(config: WorkBuddyConfig, homeOverride?: string): string[] {
  if (homeOverride) return [join(homeOverride, 'projects')]
  const primary = join(getWorkBuddyHome(config), 'projects')
  const dirs = [primary]
  // WorkBuddy historically transitioned from ~/.codebuddy, support it as well
  if (config.name === 'workbuddy') {
    const legacy = join(homedir(), '.codebuddy', 'projects')
    if (legacy !== primary) dirs.push(legacy)
  }
  return dirs
}

export function getWorkBuddyProjectsDir(config: WorkBuddyConfig, homeOverride?: string): string {
  return getWorkBuddyProjectsDirs(config, homeOverride)[0]!
}

export function decodeWorkBuddyProjectPath(slug: string): string {
  // Common pattern: "c-Users-MING-.pi-agent" -> "C:\Users\MING\.pi\agent"
  // If slug starts with a single drive letter followed by dash, like "c-" or "d-"
  if (/^[a-zA-Z]-/.test(slug)) {
    const drive = slug[0].toUpperCase()
    const rest = slug.slice(2).replace(/-/g, '\\')
    return `${drive}:\\${rest}`
  }
  if (slug.startsWith('-')) {
    return slug.replace(/-/g, '/')
  }
  return slug
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

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < MIN_REASONABLE_TIMESTAMP_MS ? value * 1000 : value
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime()) && date.getTime() >= MIN_REASONABLE_TIMESTAMP_MS) {
      return date.toISOString()
    }
  }
  const parsed = nonEmptyString(value)
  if (parsed) {
    const date = new Date(parsed)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallback
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined
  for (const key of keys) {
    const value = nonEmptyString(input[key])
    if (value) return value
  }
  return undefined
}

export function normalizeWorkBuddyTool(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower === 'read' || lower === 'read_file' || lower === 'readfile' || lower === 'view') return 'Read'
  if (lower === 'write' || lower === 'write_file' || lower === 'write_to_file' || lower === 'create_file') return 'Write'
  if (lower === 'edit' || lower === 'edit_file' || lower === 'replace_in_file' || lower === 'str_replace') return 'Edit'
  if (lower === 'bash' || lower === 'execute_command' || lower === 'terminal' || lower === 'run_command' || lower === 'cmd') return 'Bash'
  if (lower === 'grep' || lower === 'search_code' || lower === 'code_search' || lower === 'regex_search') return 'Grep'
  if (lower === 'glob' || lower === 'find_files' || lower === 'list_files' || lower === 'ls') return 'Glob'
  if (lower.includes('browser')) return 'Browser'
  return toolName
}

export function extractUserPrompt(text: string): string {
  if (!text) return ''
  if (text.includes('<user_query>')) {
    const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/)
    if (match && match[1]?.trim()) {
      return match[1].trim()
    }
  }
  // Strip system reminders if present
  const cleaned = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '').trim()
  return cleaned || text.trim()
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let result = ''
  for (const block of content) {
    if (isRecord(block) && typeof block['text'] === 'string') {
      result += (result ? '\n' : '') + block['text']
    }
  }
  return result
}

function firstUserMessage(lines: unknown[]): string {
  for (const line of lines) {
    if (!isRecord(line) || line['type'] !== 'message' || line['role'] !== 'user') continue
    const raw = textFromContent(line['content'])
    const extracted = extractUserPrompt(raw)
    if (extracted) return extracted
  }
  return ''
}

function findSessionTitle(lines: unknown[]): string | undefined {
  for (const line of lines) {
    if (!isRecord(line)) continue
    const type = line['type']
    if (type === 'custom-title' || type === 'ai-title') {
      const title = nonEmptyString(line['content']) || nonEmptyString(line['title'])
      if (title) return title
    }
  }
  return undefined
}

function projectFromCwd(cwd: string): string | undefined {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1)
}

function createParser(config: WorkBuddyConfig, source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      const parsedLines: unknown[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          parsedLines.push(JSON.parse(line) as unknown)
        } catch {
          // Corrupt line - skip it
        }
      }

      let fileTimestamp = new Date(0).toISOString()
      for (const line of parsedLines) {
        if (!isRecord(line)) continue
        const ts = line['timestamp']
        const iso = isoTimestamp(ts, '')
        if (iso) {
          fileTimestamp = iso
          break
        }
      }

      const explicitTitle = findSessionTitle(parsedLines)
      const userMessage = explicitTitle ?? firstUserMessage(parsedLines)

      let firstSeenCwd: string | undefined
      let transcriptSessionId: string | undefined
      for (const line of parsedLines) {
        if (!isRecord(line)) continue
        if (!firstSeenCwd && nonEmptyString(line['cwd'])) {
          firstSeenCwd = nonEmptyString(line['cwd'])
        }
        if (!transcriptSessionId && nonEmptyString(line['sessionId'])) {
          transcriptSessionId = nonEmptyString(line['sessionId'])
        }
        if (firstSeenCwd && transcriptSessionId) break
      }

      const sessionId = transcriptSessionId ?? basename(source.path).replace(/\.jsonl$/, '')
      const project = firstSeenCwd
        ? (projectFromCwd(firstSeenCwd) ?? source.project)
        : source.project

      for (const [index, line] of parsedLines.entries()) {
        if (!isRecord(line)) continue

        const prov = isRecord(line['providerData']) ? line['providerData'] : undefined
        const rawUsage = prov && isRecord(prov['rawUsage'])
          ? prov['rawUsage']
          : (isRecord(line['usage']) ? line['usage'] : undefined)

        if (!rawUsage) continue

        const promptTokens = safeTokenCount(rawUsage['prompt_tokens'])
        const completionTokens = safeTokenCount(rawUsage['completion_tokens'])
        const promptDetails = isRecord(rawUsage['prompt_tokens_details']) ? rawUsage['prompt_tokens_details'] : undefined
        const compDetails = isRecord(rawUsage['completion_tokens_details']) ? rawUsage['completion_tokens_details'] : undefined

        const cacheReadTokens = safeTokenCount(
          rawUsage['prompt_cache_hit_tokens'] ??
          rawUsage['cached_tokens'] ??
          rawUsage['cache_read_input_tokens'] ??
          (promptDetails ? promptDetails['cached_tokens'] : undefined),
        )
        const cacheWriteTokens = safeTokenCount(
          rawUsage['prompt_cache_write_tokens'] ??
          rawUsage['cache_creation_input_tokens'],
        )
        const reasoningTokens = safeTokenCount(
          rawUsage['completion_thinking_tokens'] ??
          (compDetails ? compDetails['reasoning_tokens'] : undefined),
        )

        const rawModel = (prov ? nonEmptyString(prov['model']) : undefined)
          ?? (prov ? nonEmptyString(prov['requestModelId']) : undefined)
          ?? nonEmptyString(line['model'])
          ?? 'unknown'
        const model = rawModel

        const lineId = nonEmptyString(line['id']) ?? nonEmptyString(line['msgId']) ?? String(index)
        const deduplicationKey = `${config.name}:${sessionId}:${lineId}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        const tools: string[] = []
        const bashCommands: string[] = []
        const turnTools: ToolCall[] = []

        if (line['type'] === 'function_call' && nonEmptyString(line['name'])) {
          const rawTool = nonEmptyString(line['name'])!
          const normalized = normalizeWorkBuddyTool(rawTool)
          tools.push(normalized)
          const toolCall: ToolCall = { tool: normalized }

          const args = line['arguments']
          let parsedArgs: Record<string, unknown> | undefined
          if (typeof args === 'string') {
            try {
              parsedArgs = JSON.parse(args)
            } catch {
              // ignore
            }
          } else if (isRecord(args)) {
            parsedArgs = args
          }

          if (parsedArgs) {
            const file = firstString(parsedArgs, ['path', 'file_path', 'paths', 'file'])
            if (file) toolCall.file = file

            if (normalized === 'Bash') {
              const command = firstString(parsedArgs, ['command'])
              if (command) {
                toolCall.command = command
                bashCommands.push(...extractBashCommands(command))
              }
            }
          }
          turnTools.push(toolCall)
        }

        const toolSequence = turnTools.length > 0 ? [turnTools] : undefined

        yield {
          provider: config.name,
          model,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheCreationInputTokens: cacheWriteTokens,
          cacheReadInputTokens: cacheReadTokens,
          cachedInputTokens: 0,
          reasoningTokens,
          webSearchRequests: 0,
          costUSD: calculateCost(model, promptTokens, completionTokens, cacheWriteTokens, cacheReadTokens, 0),
          costIsEstimated: true,
          tools,
          bashCommands,
          skills: undefined,
          subagentTypes: undefined,
          timestamp: isoTimestamp(line['timestamp'], fileTimestamp),
          speed: 'standard',
          deduplicationKey,
          turnId: `${sessionId}:${lineId}`,
          toolSequence,
          userMessage,
          sessionId,
          project,
          projectPath: firstSeenCwd ?? decodeWorkBuddyProjectPath(source.project),
          workingDirectory: nonEmptyString(line['cwd']) ?? firstSeenCwd,
        }
      }
    },
  }
}

export function createWorkBuddyProvider(config: WorkBuddyConfig, overrideProjectsDir?: string): Provider {
  const getDirs = (): string[] => overrideProjectsDir ? [overrideProjectsDir] : getWorkBuddyProjectsDirs(config)

  return {
    name: config.name,
    displayName: config.displayName,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return normalizeWorkBuddyTool(rawTool)
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return getDirs().map((d, i) => ({ path: d, label: i === 0 ? 'projects' : 'legacy projects' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dirs = getDirs()
      const sources: SessionSource[] = []
      const seenPaths = new Set<string>()

      for (const dir of dirs) {
        const projectEntries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const projectEntry of projectEntries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!projectEntry.isDirectory()) continue
          const projectDir = join(dir, projectEntry.name)
          const fileEntries = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
          for (const fileEntry of fileEntries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!fileEntry.isFile()) continue
            if (!fileEntry.name.endsWith('.jsonl')) continue
            const fullPath = join(projectDir, fileEntry.name)
            if (seenPaths.has(fullPath)) continue
            seenPaths.add(fullPath)
            sources.push({
              path: fullPath,
              project: projectEntry.name,
              provider: config.name,
            })
          }
        }
      }

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(config, source, seenKeys)
    },
  }
}

export const workbuddy = createWorkBuddyProvider(WORKBUDDY_CONFIG)
export const workbuddyai = createWorkBuddyProvider(WORKBUDDYAI_CONFIG)
