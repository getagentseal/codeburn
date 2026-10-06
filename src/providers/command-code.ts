// Command Code (the `cmd` CLI) writes one JSONL transcript per session under a
// project slug:
//
//   ~/.commandcode/projects/<project-slug>/<uuid>.jsonl
//
// Each transcript opens with a `session` record ({type, version, id, timestamp,
// cwd}) followed by `message` records. Assistant messages carry a `model` and a
// `usage` block with the call's token counts and the tool's own `costUsd`; user
// messages carry the prompt text and tool_result blocks. A sibling
// `<uuid>.checkpoints.jsonl` holds rewind checkpoints only, so discovery skips
// every `*.checkpoints.jsonl` file.
//
// The tool already records dollars per call, so `costUsd` is preserved as the
// call cost (costFromBilling) instead of being re-priced from tokens.

import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

const PROVIDER_NAME = 'command-code'
const DISPLAY_NAME = 'Command Code'
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000

// Command Code tool names are native snake_case identifiers. Map the ones that
// have a CodeBurn-canonical equivalent so the tools/activity breakdowns line up
// with every other provider; anything unknown passes through unchanged.
const TOOL_NAME_MAP: Record<string, string> = {
  shell_command: 'Bash',
  run_command: 'Bash',
  monitor_command: 'Bash',
  kill_shell: 'Bash',
  shell_output: 'Bash',
  shell_tasks: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'Edit',
  read_directory: 'Glob',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  activate_skill: 'Skill',
  agent: 'Agent',
  ask_user_question: 'AskUser',
}

function mapToolName(rawName: string): string {
  if (rawName.startsWith('mcp__')) return rawName
  return Object.prototype.hasOwnProperty.call(TOOL_NAME_MAP, rawName)
    ? TOOL_NAME_MAP[rawName]!
    : rawName
}

// Root := CODEBURN_COMMANDCODE_DIR ?? ~/.commandcode ; projects live under
// <root>/projects.
function commandCodeRootDir(): string {
  return process.env['CODEBURN_COMMANDCODE_DIR']?.trim() || join(homedir(), '.commandcode')
}

export function getCommandCodeProjectsDir(): string {
  return join(commandCodeRootDir(), 'projects')
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

// Transcripts write ISO timestamps, but guard the seconds-vs-milliseconds
// hazard anyway: an epoch value is promoted and anything that stays implausible
// is rejected rather than silently landing in 1970 (see kiro.ts / cline-cli.ts).
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

// A metered cost counts as reported only when actually present and
// non-negative: `0` is a legitimate metered value (a free/cached call) and must
// stay reported, so this is a presence check, not a truthiness check.
function isReportedCost(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined
  for (const key of keys) {
    const value = nonEmptyString(input[key])
    if (value) return value
  }
  return undefined
}

function projectFromCwd(cwd: string): string | undefined {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1)
}

type CollectedTools = {
  tools: string[]
  bashCommands: string[]
  toolSequence: ToolCall[][]
  skills: string[]
  subagentTypes: string[]
  webSearchRequests: number
}

function collectTools(content: unknown): CollectedTools {
  const collected: CollectedTools = {
    tools: [], bashCommands: [], toolSequence: [], skills: [], subagentTypes: [], webSearchRequests: 0,
  }
  if (!Array.isArray(content)) return collected

  const turnTools: ToolCall[] = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue
    const rawName = nonEmptyString(block['name'])
    if (!rawName) continue
    const mapped = mapToolName(rawName)
    const input = block['input']
    const toolCall: ToolCall = { tool: mapped }

    const file = firstString(input, ['file_path', 'path', 'paths', 'file'])
    if (file) toolCall.file = file

    const command = firstString(input, ['command'])
    if (command) {
      toolCall.command = command
      if (mapped === 'Bash') collected.bashCommands.push(...extractBashCommands(command))
    }
    if (mapped === 'Skill') {
      const skill = firstString(input, ['name', 'skill'])
      if (skill) collected.skills.push(skill)
    }
    if (mapped === 'Agent') {
      const subagentType = firstString(input, ['subagent_type', 'type'])
      if (subagentType) collected.subagentTypes.push(subagentType)
    }
    if (mapped === 'WebSearch') collected.webSearchRequests++

    collected.tools.push(mapped)
    turnTools.push(toolCall)
  }

  if (turnTools.length > 0) collected.toolSequence.push(turnTools)
  return collected
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text') continue
    const text = nonEmptyString(block['text'])
    if (text) return text
  }
  return ''
}

// The session's prompt is the first user line carrying real text. Tool results
// also arrive as user lines but as tool_result blocks with no text block.
function firstUserMessage(lines: unknown[]): string {
  for (const line of lines) {
    if (!isRecord(line) || line['type'] !== 'message') continue
    const message = line['message']
    if (!isRecord(message) || message['role'] !== 'user') continue
    const text = textFromContent(message['content'])
    if (text) return text
  }
  return ''
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
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
          // Corrupt line - skip it.
        }
      }

      // Session id and cwd come from the leading `session` record; the file
      // basename is the fallback identity.
      let sessionId = basename(source.path).replace(/\.jsonl$/, '')
      let firstSeenCwd: string | undefined
      let fileTimestamp = new Date(0).toISOString()
      for (const line of parsedLines) {
        if (!isRecord(line)) continue
        const ts = nonEmptyString(line['timestamp'])
        if (ts) {
          const date = new Date(ts)
          if (!Number.isNaN(date.getTime())) fileTimestamp = date.toISOString()
        }
        if (line['type'] === 'session') {
          sessionId = nonEmptyString(line['id']) ?? sessionId
          firstSeenCwd ??= nonEmptyString(line['cwd'])
        } else {
          firstSeenCwd ??= nonEmptyString(line['cwd'])
        }
      }
      const project = firstSeenCwd
        ? (projectFromCwd(firstSeenCwd) ?? source.project)
        : source.project
      const userMessage = firstUserMessage(parsedLines)

      for (const [index, line] of parsedLines.entries()) {
        if (!isRecord(line) || line['type'] !== 'message') continue
        const message = line['message']
        if (!isRecord(message) || message['role'] !== 'assistant') continue
        // Only assistant lines carrying usage become calls.
        const usage = line['usage']
        if (!isRecord(usage)) continue

        const inputTokens = safeTokenCount(usage['inputTokens'])
        const outputTokens = safeTokenCount(usage['outputTokens'])
        const cacheWriteTokens = safeTokenCount(usage['cacheWriteTokens'])
        const cacheReadTokens = safeTokenCount(usage['cacheReadTokens'])
        const costReported = isReportedCost(usage['costUsd'])
        const costUsd = safeNonNegativeNumber(usage['costUsd'])

        const model = nonEmptyString(line['model']) ?? 'unknown'
        const messageId = nonEmptyString(line['id']) ?? String(index)
        const deduplicationKey = `${PROVIDER_NAME}:${sessionId}:${messageId}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        const { tools, bashCommands, toolSequence, skills, subagentTypes, webSearchRequests } = collectTools(message['content'])

        yield {
          provider: PROVIDER_NAME,
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheWriteTokens,
          cacheReadInputTokens: cacheReadTokens,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests,
          costUSD: costReported
            ? costUsd
            : calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, 0),
          costIsEstimated: !costReported,
          // Per-call: a metered cost is preserved through the session cache; a
          // call the tool did not price falls back to token pricing and stays
          // re-priceable. New providers use this flag rather than the
          // REPORTED_COST_PROVIDERS whole-provider set (see parser.ts).
          ...(costReported ? { costFromBilling: true } : {}),
          tools,
          bashCommands,
          skills: skills.length > 0 ? skills : undefined,
          subagentTypes: subagentTypes.length > 0 ? subagentTypes : undefined,
          timestamp: isoTimestamp(line['timestamp'], fileTimestamp),
          speed: 'standard',
          deduplicationKey,
          turnId: `${sessionId}:${messageId}`,
          toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
          userMessage,
          sessionId,
          project,
          projectPath: firstSeenCwd,
          workingDirectory: nonEmptyString(line['cwd']) ?? firstSeenCwd,
        }
      }
    },
  }
}

export function createCommandCodeProvider(overrideProjectsDir?: string): Provider {
  const projectsDir = (): string => overrideProjectsDir ?? getCommandCodeProjectsDir()

  return {
    name: PROVIDER_NAME,
    displayName: DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: projectsDir(), label: 'projects' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dir = projectsDir()
      const projectEntries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const sources: SessionSource[] = []

      for (const projectEntry of projectEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!projectEntry.isDirectory()) continue
        const projectDir = join(dir, projectEntry.name)
        const fileEntries = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
        for (const fileEntry of fileEntries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!fileEntry.isFile()) continue
          if (!fileEntry.name.endsWith('.jsonl')) continue
          // `<uuid>.checkpoints.jsonl` holds rewind checkpoints, not usage.
          if (fileEntry.name.endsWith('.checkpoints.jsonl')) continue
          sources.push({
            path: join(projectDir, fileEntry.name),
            project: projectEntry.name,
            provider: PROVIDER_NAME,
          })
        }
      }

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const commandCode = createCommandCodeProvider()
