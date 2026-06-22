import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir, platform } from 'os'

import { readSessionLines } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const PROVIDER_NAME = 'open-design'
const ENV_DIR = 'CODEBURN_OPEN_DESIGN_DIR'

const modelDisplayNames = new Map<string, string>([
  ['openai-codex:gpt-5.5', 'GPT-5.5'],
  ['glm-5.2', 'GLM-5.2'],
  ['GLM-5.2', 'GLM-5.2'],
])

type OpenDesignEntry = {
  id?: unknown
  event?: unknown
  data?: unknown
  timestamp?: unknown
}

type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function tokenValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function timestampValue(value: unknown): string {
  const text = stringValue(value)
  if (text) return text
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function parseEvent(line: string | Buffer): OpenDesignEntry | null {
  const text = (typeof line === 'string' ? line : line.toString('utf-8')).trim()
  if (!text) return null

  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseUsage(data: unknown): TokenUsage | null {
  if (!isRecord(data) || data['type'] !== 'usage') return null
  const usage = data['usage']
  if (!isRecord(usage)) return null

  return {
    inputTokens: tokenValue(usage['input_tokens']),
    outputTokens: tokenValue(usage['output_tokens']),
    cacheReadTokens: tokenValue(usage['cached_read_tokens']),
    reasoningTokens: tokenValue(usage['thought_tokens']),
  }
}

function getOpenDesignDir(): string {
  const override = process.env[ENV_DIR]
  if (override) return override

  const home = homedir()
  const os = platform()
  if (os === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Open Design')
  }
  if (os === 'win32') {
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Open Design')
  }
  return join(home, '.config', 'Open Design')
}

function namespaceFromDataDir(dataDir: string): string {
  const ns = basename(dirname(dataDir))
  return ns && ns !== 'namespaces' ? ns : PROVIDER_NAME
}

function namespaceFromRunsDir(runsDir: string): string {
  return namespaceFromDataDir(dirname(runsDir))
}

async function discoverRunsDir(runsDir: string, project: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let runDirs: string[]
  try {
    runDirs = await readdir(runsDir)
  } catch {
    return sources
  }

  for (const runDir of runDirs) {
    const eventsPath = join(runsDir, runDir, 'events.jsonl')
    const s = await stat(eventsPath).catch(() => null)
    if (!s?.isFile()) continue
    sources.push({ path: eventsPath, project, provider: PROVIDER_NAME })
  }

  return sources
}

async function discoverNamespacesDir(namespacesDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let namespaces: string[]
  try {
    namespaces = await readdir(namespacesDir)
  } catch {
    return sources
  }

  for (const ns of namespaces) {
    const runsDir = join(namespacesDir, ns, 'data', 'runs')
    sources.push(...await discoverRunsDir(runsDir, ns))
  }

  return sources
}

function dedupeSources(sources: SessionSource[]): SessionSource[] {
  const seen = new Set<string>()
  const out: SessionSource[] = []
  for (const source of sources) {
    if (seen.has(source.path)) continue
    seen.add(source.path)
    out.push(source)
  }
  return out
}

async function discoverOpenDesignSessions(baseDir: string): Promise<SessionSource[]> {
  const baseName = basename(baseDir)
  if (baseName === 'runs') {
    return discoverRunsDir(baseDir, namespaceFromRunsDir(baseDir))
  }
  if (baseName === 'data') {
    return discoverRunsDir(join(baseDir, 'runs'), namespaceFromDataDir(baseDir))
  }

  const sources: SessionSource[] = []
  sources.push(...await discoverRunsDir(join(baseDir, 'data', 'runs'), basename(baseDir) || PROVIDER_NAME))
  sources.push(...await discoverRunsDir(join(baseDir, 'runs'), basename(baseDir) || PROVIDER_NAME))
  sources.push(...await discoverNamespacesDir(baseName === 'namespaces' ? baseDir : join(baseDir, 'namespaces')))
  return dedupeSources(sources)
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const sessionId = basename(dirname(source.path))
      let currentModel = ''
      let fallbackEventCounter = 0

      for await (const line of readSessionLines(source.path)) {
        const entry = parseEvent(line)
        if (!entry) continue

        const eventName = stringValue(entry.event)
        const data = entry.data

        if (eventName === 'start' && isRecord(data)) {
          const model = stringValue(data['model'])
          if (model) currentModel = model
          continue
        }

        if (eventName !== 'agent' || !isRecord(data)) continue

        if (data['type'] === 'status') {
          const model = stringValue(data['model'])
          if (model) currentModel = model
          continue
        }

        const usage = parseUsage(data)
        if (!usage || !currentModel) continue

        const eventId = stringValue(entry.id) ?? `line-${fallbackEventCounter++}`
        const dedupKey = `${PROVIDER_NAME}:${sessionId}:${eventId}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens)
        const costUSD = calculateCost(
          currentModel,
          uncachedInputTokens,
          usage.outputTokens + usage.reasoningTokens,
          0,
          usage.cacheReadTokens,
          0,
        )

        yield {
          provider: PROVIDER_NAME,
          sessionId,
          project: source.project,
          model: currentModel,
          inputTokens: uncachedInputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: usage.cacheReadTokens,
          cachedInputTokens: usage.cacheReadTokens,
          reasoningTokens: usage.reasoningTokens,
          webSearchRequests: 0,
          costUSD,
          tools: [],
          bashCommands: [],
          timestamp: timestampValue(entry.timestamp),
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: '',
        }
      }
    },
  }
}

export function createOpenDesignProvider(overrideDir?: string): Provider {
  return {
    name: PROVIDER_NAME,
    displayName: 'Open Design',

    modelDisplayName(model: string): string {
      return modelDisplayNames.get(model) ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverOpenDesignSessions(overrideDir ?? getOpenDesignDir())
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const openDesign = createOpenDesignProvider()
