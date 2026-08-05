import { createHash } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { extractBashCommands } from '../bash-utils.js'
import { readSessionLines } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ProbeRoot, ParsedProviderCall, Provider, SessionParser, SessionSource } from './types.js'

type JsonObject = Record<string, unknown>

const toolNameMap: Record<string, string> = {
  Shell: 'Bash',
  Bash: 'Bash',
  bash: 'Bash',
  ReadFile: 'Read',
  ReadMediaFile: 'Read',
  WriteFile: 'Write',
  StrReplaceFile: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  SearchWeb: 'WebSearch',
  FetchURL: 'WebFetch',
  Agent: 'Agent',
  AgentTool: 'Agent',
  TaskList: 'Agent',
  TaskOutput: 'Agent',
  TaskStop: 'Agent',
  AskUserQuestion: 'AskUser',
  SetTodoList: 'TodoWrite',
  Think: 'Think',
  EnterPlanMode: 'EnterPlanMode',
  ExitPlanMode: 'ExitPlanMode',
  SendDMail: 'DMail',
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function stringField(obj: JsonObject | null, key: string): string | undefined {
  const value = obj?.[key]
  return typeof value === 'string' ? value : undefined
}

function numericField(obj: JsonObject, ...keys: string[]): number {
  for (const key of keys) {
    const raw = obj[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (Number.isFinite(n) && n > 0) return Math.trunc(n)
  }
  return 0
}

function getShareDir(overrideDir?: string): string {
  return overrideDir ?? process.env['KIMI_SHARE_DIR'] ?? join(homedir(), '.kimi')
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf-8').digest('hex')
}

function projectNameFromPath(pathValue: string): string {
  const cleaned = pathValue.replace(/\/+$/, '')
  return basename(cleaned) || cleaned || 'kimi'
}

async function loadProjectNames(shareDir: string): Promise<Map<string, string>> {
  const projects = new Map<string, string>()
  const raw = await readFile(join(shareDir, 'kimi.json'), 'utf-8').catch(() => null)
  if (!raw) return projects

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return projects
  }

  const workDirs = asObject(data)?.['work_dirs']
  if (!Array.isArray(workDirs)) return projects

  for (const entry of workDirs) {
    const obj = asObject(entry)
    const pathValue = stringField(obj, 'path')
    if (!pathValue) continue
    const hash = md5(pathValue)
    const project = projectNameFromPath(pathValue)
    projects.set(hash, project)

    const kaos = stringField(obj, 'kaos')
    if (kaos && kaos !== 'local') projects.set(`${kaos}_${hash}`, project)
  }

  return projects
}

function parseTomlString(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"/)
    if (!match) return null
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return match[1] ?? null
    }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/)
    return match?.[1] ?? null
  }
  const match = value.match(/^([^#\s]+)/)
  return match?.[1] ?? null
}

function parseDefaultModelKey(configToml: string): string | null {
  for (const line of configToml.split('\n')) {
    const match = line.match(/^\s*default_model\s*=\s*(.+)$/)
    if (!match) continue
    return parseTomlString(match[1]!)
  }
  return null
}

function parseModelSectionName(line: string): string | null {
  const match = line.trim().match(/^\[models\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/)
  if (!match) return null
  return (match[1] ?? match[2] ?? match[3] ?? '').trim() || null
}

function parseModelIdForKey(configToml: string, modelKey: string): string | null {
  let inSection = false
  for (const line of configToml.split('\n')) {
    const section = parseModelSectionName(line)
    if (section !== null) {
      inSection = section === modelKey
      continue
    }
    if (!inSection) continue
    if (/^\s*\[/.test(line)) {
      inSection = false
      continue
    }
    const match = line.match(/^\s*model\s*=\s*(.+)$/)
    if (!match) continue
    return parseTomlString(match[1]!)
  }
  return null
}

async function getConfiguredModel(shareDir: string): Promise<string> {
  const envModel = process.env['KIMI_MODEL_NAME']?.trim()
  if (envModel) return envModel

  const raw = await readFile(join(shareDir, 'config.toml'), 'utf-8').catch(() => null)
  if (!raw) return 'kimi-auto'

  const defaultModel = parseDefaultModelKey(raw)
  if (!defaultModel) return 'kimi-auto'

  return parseModelIdForKey(raw, defaultModel) ?? defaultModel
}

function parseJsonObject(text: string | undefined): JsonObject | null {
  if (!text) return null
  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

function extractUserText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500)
  if (!Array.isArray(value)) return ''

  return value
    .map(part => stringField(asObject(part), 'text') ?? '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 500)
}

function timestampToIso(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''

  const millis = value > 1_000_000_000_000 ? value : value * 1000
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function extractEnvelope(record: JsonObject): { type: string; payload: JsonObject; timestamp: string } | null {
  const message = asObject(record['message'])
  const envelope = message ?? record
  const type = stringField(envelope, 'type')
  const payload = asObject(envelope['payload'])
  if (!type || !payload) return null
  return { type, payload, timestamp: timestampToIso(record['timestamp']) }
}

function extractUsage(payload: JsonObject): {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
} | null {
  const usage = asObject(payload['token_usage']) ?? asObject(payload['usage'])
  if (!usage) return null

  const cacheReadInputTokens = numericField(usage, 'input_cache_read', 'cache_read_input_tokens', 'cached_input_tokens')
  const cacheCreationInputTokens = numericField(usage, 'input_cache_creation', 'cache_creation_input_tokens')
  let inputTokens = numericField(usage, 'input_other', 'input_tokens')
  if (inputTokens === 0) {
    const totalInput = numericField(usage, 'input')
    inputTokens = Math.max(0, totalInput - cacheReadInputTokens - cacheCreationInputTokens)
  }
  const outputTokens = numericField(usage, 'output', 'output_tokens')

  if (inputTokens === 0 && outputTokens === 0 && cacheReadInputTokens === 0 && cacheCreationInputTokens === 0) {
    return null
  }

  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }
}

function extractTool(payload: JsonObject): { tool: string; bashCommands: string[] } | null {
  const fn = asObject(payload['function'])
  const rawName = stringField(fn, 'name') ?? stringField(payload, 'name')
  if (!rawName) return null

  const tool = toolNameMap[rawName] ?? rawName
  const argsText = stringField(fn, 'arguments') ?? stringField(payload, 'arguments')
  const args = parseJsonObject(argsText)
  const command = stringField(args, 'command')
  const bashCommands = tool === 'Bash' && command ? extractBashCommands(command) : []

  return { tool, bashCommands }
}

function createParser(source: SessionSource, shareDir: string, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const configuredModel = await getConfiguredModel(shareDir)
      const tools = new Set<string>()
      const bashCommands = new Set<string>()
      let currentUserMessage = ''
      const sessionId = basename(dirname(source.path))
      let index = 0

      for await (const line of readSessionLines(source.path)) {
        if (!line.trim()) continue

        let record: JsonObject | null = null
        try {
          record = asObject(JSON.parse(line))
        } catch {
          continue
        }
        if (!record) continue

        const envelope = extractEnvelope(record)
        if (!envelope || envelope.type === 'metadata') continue

        if (envelope.type === 'TurnBegin' || envelope.type === 'SteerInput') {
          currentUserMessage = extractUserText(envelope.payload['user_input'])
          continue
        }

        if (envelope.type === 'TurnEnd') {
          currentUserMessage = ''
          tools.clear()
          bashCommands.clear()
          continue
        }

        if (envelope.type === 'ToolCall' || envelope.type === 'ToolCallRequest') {
          const extracted = extractTool(envelope.payload)
          if (!extracted) continue
          tools.add(extracted.tool)
          for (const command of extracted.bashCommands) bashCommands.add(command)
          continue
        }

        if (envelope.type !== 'StatusUpdate') continue

        const usage = extractUsage(envelope.payload)
        if (!usage) continue

        const rawMessageId = stringField(envelope.payload, 'message_id')
        const dedupKey = `kimi:${sessionId}:${rawMessageId ?? index}`
        index++
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const model = stringField(envelope.payload, 'model') ?? stringField(envelope.payload, 'model_name') ?? configuredModel
        const costUSD = calculateCost(
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheCreationInputTokens,
          usage.cacheReadInputTokens,
          0,
        )

        yield {
          provider: 'kimi',
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cachedInputTokens: usage.cacheReadInputTokens,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools: [...tools],
          bashCommands: [...bashCommands],
          timestamp: envelope.timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: currentUserMessage,
          sessionId,
        }

        tools.clear()
        bashCommands.clear()
      }
    },
  }
}

async function addWireSource(sources: SessionSource[], filePath: string, project: string): Promise<void> {
  const s = await stat(filePath).catch(() => null)
  if (!s?.isFile()) return
  sources.push({ path: filePath, project, provider: 'kimi' })
}

export function createKimiProvider(overrideDir?: string): Provider {
  const shareDir = getShareDir(overrideDir)

  return {
    name: 'kimi',
    displayName: 'Kimi',

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: join(shareDir, 'sessions'), label: 'sessions' }]
    },

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      const sessionsRoot = join(shareDir, 'sessions')
      const projectNames = await loadProjectNames(shareDir)
      const workDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])

      for (const workDir of workDirs) {
        if (!workDir.isDirectory()) continue

        const project = projectNames.get(workDir.name) ?? workDir.name
        const workDirPath = join(sessionsRoot, workDir.name)
        const sessionDirs = await readdir(workDirPath, { withFileTypes: true }).catch(() => [])

        for (const sessionDir of sessionDirs) {
          if (!sessionDir.isDirectory()) continue

          const sessionPath = join(workDirPath, sessionDir.name)
          await addWireSource(sources, join(sessionPath, 'wire.jsonl'), project)

          const subagentsPath = join(sessionPath, 'subagents')
          const subagents = await readdir(subagentsPath, { withFileTypes: true }).catch(() => [])
          for (const subagent of subagents) {
            if (!subagent.isDirectory()) continue
            await addWireSource(sources, join(subagentsPath, subagent.name, 'wire.jsonl'), project)
          }
        }
      }

      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, shareDir, seenKeys)
    },
  }
}

export const kimi = createKimiProvider()
