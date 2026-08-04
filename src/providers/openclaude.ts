// OpenClaude (npm `@gitlawb/openclaude`) is a Claude Code fork that runs the
// same agent loop against any LLM (DeepSeek, OpenAI, etc.). Each session is a
// Claude-Code-schema JSONL transcript under a project slug:
//
//   ~/.openclaude/projects/<project-slug>/<uuid>.jsonl
//
// Every transcript has a sibling `<uuid>.replay.json` that only carries replay
// state; discovery only picks up `.jsonl` files, so the replay files are
// skipped. Subagent (sidechain) traffic is interleaved in the same transcript
// with `isSidechain: true`; those lines are real spend and are counted like
// any other assistant line. The transcript reports no cost field, so every
// call's cost is computed from token counts via calculateCost and always
// flagged costIsEstimated: true.

import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

const PROVIDER_NAME = 'openclaude'
const DISPLAY_NAME = 'OpenClaude'
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000

// Mirrors the CLI's own resolution chain, each level individually overridable:
//   root     := CODEBURN_OPENCLAUDE_DIR ?? ~/.openclaude
//   projects := <root>/projects
function openClaudeRootDir(): string {
  return process.env['CODEBURN_OPENCLAUDE_DIR']?.trim() || join(homedir(), '.openclaude')
}

export function getOpenClaudeProjectsDir(): string {
  return join(openClaudeRootDir(), 'projects')
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

// The transcript only ever carries ISO timestamps, but keep the epoch-millis
// branch so an exotic export can never silently land in 1970, matching the
// guard cline-cli.ts uses on the same hazard.
function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Promote seconds-resolution values to milliseconds, then reject anything
    // that stays implausible.
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

type CollectedTools = {
  tools: string[]
  bashCommands: string[]
  toolSequence: ToolCall[][]
  skills: string[]
  subagentTypes: string[]
}

// Tool names are already codeburn-canonical (Write, Read, Bash, Grep, Edit,
// Task, Skill, WebFetch, ...) because OpenClaude is a Claude Code fork, so no
// mapping table is needed: the raw name is used as-is.
function collectTools(content: unknown): CollectedTools {
  const collected: CollectedTools = {
    tools: [], bashCommands: [], toolSequence: [], skills: [], subagentTypes: [],
  }
  if (!Array.isArray(content)) return collected

  const turnTools: ToolCall[] = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue
    const name = nonEmptyString(block['name'])
    if (!name) continue
    const input = block['input']
    const toolCall: ToolCall = { tool: name }

    const file = firstString(input, ['path', 'file_path', 'paths', 'file'])
    if (file) toolCall.file = file

    if (name === 'Bash') {
      const command = firstString(input, ['command'])
      if (command) {
        toolCall.command = command
        collected.bashCommands.push(...extractBashCommands(command))
      }
    }
    if (name === 'Skill') {
      const skill = firstString(input, ['name', 'skill'])
      if (skill) collected.skills.push(skill)
    }
    if (name === 'Task') {
      const subagentType = firstString(input, ['subagent_type'])
      if (subagentType) collected.subagentTypes.push(subagentType)
    }

    collected.tools.push(name)
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
// also arrive as user lines but as blocks with no text block, so they are
// skipped here.
function firstUserMessage(lines: unknown[]): string {
  for (const line of lines) {
    if (!isRecord(line) || line['type'] !== 'user') continue
    const message = line['message']
    if (!isRecord(message)) continue
    const text = textFromContent(message['content'])
    if (text) return text
  }
  return ''
}

function projectFromCwd(cwd: string): string | undefined {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1)
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      // Decode the file once, skipping blank and corrupt lines, so the
      // timestamp, cwd, and user-message scans below share a single parse.
      const parsedLines: unknown[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          parsedLines.push(JSON.parse(line) as unknown)
        } catch {
          // Corrupt line - skip it.
        }
      }

      // File-level fallback timestamp: the first valid ISO timestamp in the
      // file, so a line missing one still lands inside the session's window.
      let fileTimestamp = new Date(0).toISOString()
      for (const line of parsedLines) {
        if (!isRecord(line)) continue
        const ts = nonEmptyString(line['timestamp'])
        if (!ts) continue
        const date = new Date(ts)
        if (Number.isNaN(date.getTime())) continue
        fileTimestamp = date.toISOString()
        break
      }

      const userMessage = firstUserMessage(parsedLines)

      // The project is the basename of the first cwd seen in the transcript
      // (what the user recognizes); the discovery-time slug is the fallback.
      let firstSeenCwd: string | undefined
      for (const line of parsedLines) {
        if (!isRecord(line)) continue
        const cwd = nonEmptyString(line['cwd'])
        if (!cwd) continue
        firstSeenCwd = cwd
        break
      }
      const project = firstSeenCwd
        ? (projectFromCwd(firstSeenCwd) ?? source.project)
        : source.project

      for (const [index, line] of parsedLines.entries()) {
        if (!isRecord(line) || line['type'] !== 'assistant') continue
        const message = line['message']
        if (!isRecord(message)) continue
        // Only assistant lines carrying a usage record become calls; the rest
        // of the transcript (queue-operation, last-prompt, user lines) is
        // skipped silently.
        const usage = message['usage']
        if (!isRecord(usage)) continue

        const inputTokens = safeTokenCount(usage['input_tokens'])
        const outputTokens = safeTokenCount(usage['output_tokens'])
        const cacheWriteTokens = safeTokenCount(usage['cache_creation_input_tokens'])
        const cacheReadTokens = safeTokenCount(usage['cache_read_input_tokens'])
        const webSearchRequests = safeTokenCount(
          isRecord(usage['server_tool_use']) ? usage['server_tool_use']['web_search_requests'] : undefined,
        )

        const model = nonEmptyString(message['model']) ?? 'unknown'
        const sessionId = nonEmptyString(line['sessionId']) ?? basename(source.path).replace(/\.jsonl$/, '')
        const messageId = nonEmptyString(message['id']) ?? nonEmptyString(line['uuid']) ?? String(index)
        const deduplicationKey = `${PROVIDER_NAME}:${sessionId}:${messageId}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        const { tools, bashCommands, toolSequence, skills, subagentTypes } = collectTools(message['content'])

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
          costUSD: calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, 0),
          costIsEstimated: true,
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
          workingDirectory: nonEmptyString(line['cwd']),
        }
      }
    },
  }
}

export function createOpenClaudeProvider(overrideProjectsDir?: string): Provider {
  const projectsDir = (): string => overrideProjectsDir ?? getOpenClaudeProjectsDir()

  return {
    name: PROVIDER_NAME,
    displayName: DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      // OpenClaude tool names are already codeburn-canonical - pass through.
      return rawTool
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
          // Only transcripts; the sibling `<uuid>.replay.json` files end in
          // `.json` and never match.
          if (!fileEntry.name.endsWith('.jsonl')) continue
          sources.push({
            path: join(projectDir, fileEntry.name),
            // The whole slug is the discovery-time fallback; parse-time
            // project naming prefers the basename of the first cwd seen in
            // the transcript.
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

export const openclaude = createOpenClaudeProvider()
