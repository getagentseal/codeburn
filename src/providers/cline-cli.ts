import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ToolCall } from '../types.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

// The Cline CLI (npm `cline`, 3.x) stores sessions in a layout unrelated to the
// VS Code extension's tasks/ui_messages.json tree that `cline.ts` reads:
//
//   <sessions>/<sessionId>/<sessionId>.json           metadata + rolled-up usage
//   <sessions>/<sessionId>/<sessionId>.messages.json  per-message metrics
//
// Kept as its own provider rather than a third root on `cline` so the shared
// Cline-family parser (also serving Roo Code and KiloCode) stays untouched.

const PROVIDER_NAME = 'cline-cli'
const DISPLAY_NAME = 'Cline CLI'
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000

// Mirrors the CLI's own resolution chain, each level individually overridable:
//   sessions := CLINE_SESSION_DATA_DIR ?? <data>/sessions
//   data     := CLINE_DATA_DIR         ?? <root>/data
//   root     := CLINE_DIR              ?? ~/.cline
function clineRootDir(): string {
  return process.env['CLINE_DIR']?.trim() || join(homedir(), '.cline')
}

function clineDataDir(): string {
  return process.env['CLINE_DATA_DIR']?.trim() || join(clineRootDir(), 'data')
}

export function getClineCliSessionsDir(): string {
  return process.env['CLINE_SESSION_DATA_DIR']?.trim() || join(clineDataDir(), 'sessions')
}

const toolNameMap: Record<string, string> = {
  run_commands: 'Bash',
  read_files: 'Read',
  editor: 'Edit',
  apply_patch: 'Edit',
  search_codebase: 'Grep',
  fetch_web_content: 'WebFetch',
  skills: 'Skill',
  spawn_agent: 'Agent',
  team_spawn_teammate: 'Agent',
  team_run_task: 'Agent',
  ask_question: 'AskUser',
}

function mapToolName(rawTool: string): string {
  return toolNameMap[rawTool] ?? rawTool
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

// A cost counts as metered only when it is actually present and non-negative.
// `0` is a legitimate metered value (a free/cached call) and must stay reported,
// so this is a presence check, not a truthiness check.
function isReportedCost(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

type ClineCliMetrics = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  costReported: boolean
}

function parseMetrics(value: unknown): ClineCliMetrics | null {
  if (!isRecord(value)) return null
  const metrics: ClineCliMetrics = {
    inputTokens: safeTokenCount(value['inputTokens']),
    outputTokens: safeTokenCount(value['outputTokens']),
    cacheReadTokens: safeTokenCount(value['cacheReadTokens']),
    cacheWriteTokens: safeTokenCount(value['cacheWriteTokens']),
    cost: safeNonNegativeNumber(value['cost']),
    // A negative cost is not a credit we can represent — treat it as absent and
    // fall back to token pricing, rather than reporting a clamped $0 as metered.
    costReported: isReportedCost(value['cost']),
  }
  const hasTokens = metrics.inputTokens > 0 || metrics.outputTokens > 0
    || metrics.cacheReadTokens > 0 || metrics.cacheWriteTokens > 0
  return hasTokens || metrics.cost > 0 ? metrics : null
}

function projectName(workspace: string | undefined): string {
  if (!workspace) return DISPLAY_NAME
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? DISPLAY_NAME
}

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // The CLI writes epoch milliseconds, but a seconds-resolution value would
    // otherwise silently land in 1970. Promote it and reject what stays
    // implausible, matching the guard kiro.ts uses on the same hazard.
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

// `run_commands` carries its commands as a JSON-encoded array in a string
// field; anything else is treated as a single command line.
function commandsFrom(input: unknown): string[] {
  if (!isRecord(input)) return []
  const raw = input['commands'] ?? input['command']
  if (Array.isArray(raw)) return raw.filter((c): c is string => typeof c === 'string')
  const text = nonEmptyString(raw)
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed.filter((c): c is string => typeof c === 'string')
    } catch {
      // Not JSON after all - fall through and treat the whole string as one command.
    }
  }
  return [text]
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

    const file = firstString(input, ['path', 'file_path', 'paths', 'file'])
    if (file) toolCall.file = file

    if (mapped === 'Bash') {
      const commands = commandsFrom(input)
      const [first] = commands
      if (first) toolCall.command = first
      for (const command of commands) collected.bashCommands.push(...extractBashCommands(command))
    }
    if (mapped === 'Skill') {
      const skill = firstString(input, ['name', 'skill', 'skill_name'])
      if (skill) collected.skills.push(skill)
    }
    if (mapped === 'Agent') {
      const subagentType = firstString(input, ['agent', 'agent_type', 'type', 'name'])
      if (subagentType) collected.subagentTypes.push(subagentType)
    }
    if (mapped === 'WebFetch') collected.webSearchRequests++

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

function firstUserMessage(messages: unknown[]): string {
  for (const message of messages) {
    if (!isRecord(message) || message['role'] !== 'user') continue
    const text = textFromContent(message['content'])
    // Tool results come back as role:user too; they carry no text block.
    if (text) return text
  }
  return ''
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readSessionFile(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const meta = await readJson(source.path)
      if (!isRecord(meta)) return

      const sessionId = nonEmptyString(meta['session_id']) ?? basename(source.path).replace(/\.json$/, '')
      const metadata = isRecord(meta['metadata']) ? meta['metadata'] : {}
      const workspace = nonEmptyString(meta['workspace_root']) ?? nonEmptyString(meta['cwd'])
      const sessionModel = nonEmptyString(meta['model']) ?? 'unknown'
      const startedAt = isoTimestamp(meta['started_at'], new Date(0).toISOString())
      // Always populated by discoverSessions; projectName falls back to the
      // display name, so there is nothing left to default to here.
      const project = source.project

      // Prefer the co-located messages file over the recorded absolute path,
      // which is stale once a session directory is copied between machines.
      const sibling = join(source.path.replace(/\.json$/, '') + '.messages.json')
      let doc = await readJson(sibling)
      if (!isRecord(doc)) {
        const recorded = nonEmptyString(meta['messages_path'])
        if (recorded) doc = await readJson(recorded)
      }

      const messages = isRecord(doc) && Array.isArray(doc['messages']) ? doc['messages'] : []
      const userMessage = firstUserMessage(messages)
      let hadMetrics = false

      for (const [index, message] of messages.entries()) {
        if (!isRecord(message) || message['role'] !== 'assistant') continue
        const metrics = parseMetrics(message['metrics'])
        if (!metrics) continue

        // Track BEFORE the dedup check: the rollup gate must see metrics-bearing
        // messages even when every one is later suppressed by the shared dedup,
        // or a duplicated session_id double-counts through the rollup - #894.
        hadMetrics = true

        const modelInfo = isRecord(message['modelInfo']) ? message['modelInfo'] : {}
        const model = nonEmptyString(modelInfo['id']) ?? sessionModel
        const messageId = nonEmptyString(message['id']) ?? String(index)
        const deduplicationKey = `${PROVIDER_NAME}:${sessionId}:${messageId}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        const { tools, bashCommands, toolSequence, skills, subagentTypes, webSearchRequests }
          = collectTools(message['content'])

        yield {
          provider: PROVIDER_NAME,
          model,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cacheCreationInputTokens: metrics.cacheWriteTokens,
          cacheReadInputTokens: metrics.cacheReadTokens,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests,
          costUSD: metrics.costReported
            ? metrics.cost
            : calculateCost(model, metrics.inputTokens, metrics.outputTokens, metrics.cacheWriteTokens, metrics.cacheReadTokens, 0),
          costIsEstimated: !metrics.costReported,
          tools,
          bashCommands,
          skills: skills.length > 0 ? skills : undefined,
          subagentTypes: subagentTypes.length > 0 ? subagentTypes : undefined,
          timestamp: isoTimestamp(message['ts'], startedAt),
          speed: 'standard',
          deduplicationKey,
          turnId: `${sessionId}:${messageId}`,
          toolSequence: toolSequence.length > 0 ? toolSequence : undefined,
          userMessage,
          sessionId,
          project,
          projectPath: workspace,
          workingDirectory: nonEmptyString(meta['cwd']),
        }
      }

      // A session with per-message metrics never falls back to the rollup,
      // even when every message was deduped away (#894): the calls were
      // already accounted once under this session_id by an earlier directory.
      if (hadMetrics) return

      // No per-message metrics: fall back to the session rollup so an
      // interrupted or older session still reports its spend. Deliberately
      // reads `usage` and not `aggregateUsage`, which folds in spawned
      // subagents that are themselves separate session directories.
      const rollup = parseMetrics(isRecord(metadata['usage']) ? metadata['usage'] : null)
      if (!rollup) return
      const deduplicationKey = `${PROVIDER_NAME}:${sessionId}:rollup`
      if (seenKeys.has(deduplicationKey)) return
      seenKeys.add(deduplicationKey)

      // Same presence-not-truthiness rule as the per-message path: a metered
      // $0 rollup stays reported instead of being re-estimated from tokens.
      const rawRollupCost = (isRecord(metadata['usage']) ? metadata['usage']['totalCost'] : undefined)
        ?? metadata['totalCost']
      const rollupCostReported = isReportedCost(rawRollupCost)
      const rollupCost = safeNonNegativeNumber(rawRollupCost)

      yield {
        provider: PROVIDER_NAME,
        model: sessionModel,
        inputTokens: rollup.inputTokens,
        outputTokens: rollup.outputTokens,
        cacheCreationInputTokens: rollup.cacheWriteTokens,
        cacheReadInputTokens: rollup.cacheReadTokens,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: rollupCostReported
          ? rollupCost
          : calculateCost(sessionModel, rollup.inputTokens, rollup.outputTokens, rollup.cacheWriteTokens, rollup.cacheReadTokens, 0),
        costIsEstimated: !rollupCostReported,
        tools: [],
        bashCommands: [],
        timestamp: isoTimestamp(meta['ended_at'], startedAt),
        speed: 'standard',
        deduplicationKey,
        turnId: `${sessionId}:rollup`,
        userMessage,
        sessionId,
        project,
        projectPath: workspace,
        workingDirectory: nonEmptyString(meta['cwd']),
      }
    },
  }
}

export function createClineCliProvider(overrideDir?: string): Provider {
  const sessionsDir = (): string => overrideDir ?? getClineCliSessionsDir()

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
      return [{ path: sessionsDir(), label: 'Cline CLI sessions' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const dir = sessionsDir()
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const sources: SessionSource[] = []

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue
        const sessionId = entry.name
        const metaPath = join(dir, sessionId, `${sessionId}.json`)
        const meta = await readJson(metaPath)
        if (!isRecord(meta)) continue

        const workspace = nonEmptyString(meta['workspace_root']) ?? nonEmptyString(meta['cwd'])
        sources.push({
          path: metaPath,
          project: projectName(workspace),
          provider: PROVIDER_NAME,
        })
      }

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const clineCli = createClineCliProvider()
