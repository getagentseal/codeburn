import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { extractBashCommands } from '../bash-utils.js'
import { calculateCost } from '../models.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

type JsonObject = Record<string, unknown>

type SessionState = {
  createdAt?: string
  updatedAt?: string
  workDir?: string
}

type RequestContext = {
  model: string
  modelAlias: string
  turnId: string
  timestamp: string
}

const toolNameMap: Record<string, string> = {
  Bash: 'Bash',
  Shell: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  Read: 'Read',
  ReadFile: 'Read',
  read_file: 'Read',
  Write: 'Write',
  WriteFile: 'Write',
  write_file: 'Write',
  Edit: 'Edit',
  EditFile: 'Edit',
  edit_file: 'Edit',
  Grep: 'Grep',
  grep: 'Grep',
  Glob: 'Glob',
  glob: 'Glob',
  Agent: 'Agent',
  Task: 'Agent',
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nonNegativeNumber(value: unknown): number {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
}

function timestampIso(value: unknown): string {
  if (typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function kimicodeHomes(override?: string): string[] {
  const explicit = override || process.env['KIMI_CODE_HOME']
  if (explicit) return [resolve(explicit)]
  // Default stores. Beyond the CLI's own ~/.kimi-code, embedded runtimes keep
  // the same wire layout under their own home (Kimi desktop app, Kimi Code
  // IDE); each home is scanned so embedded-agent usage is not invisible.
  const home = homedir()
  const homes = [
    join(home, '.kimi-code'),
    join(home, 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home'),
  ]
  return [...new Set(homes.map(h => resolve(h)))]
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readState(sessionDir: string): Promise<SessionState> {
  try {
    const state = asObject(JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')))
    if (!state) return {}
    return {
      createdAt: stringValue(state['createdAt']) || undefined,
      updatedAt: stringValue(state['updatedAt']) || undefined,
      workDir: stringValue(state['workDir']) || undefined,
    }
  } catch {
    return {}
  }
}

function projectFromWorkDir(workDir: string, workDirKey: string): string {
  if (workDir) return basename(workDir.replace(/[\\/]+$/, '')) || workDir
  const match = /^wd_(.+)_[a-f0-9]{12}$/i.exec(workDirKey)
  return match?.[1] || workDirKey.replace(/^wd_/, '') || 'kimicode'
}

async function discoverSources(root: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const sessionsDir = join(root, 'sessions')

  for (const workDirEntry of await directoryEntries(sessionsDir)) {
    if (!workDirEntry.isDirectory() || !workDirEntry.name.startsWith('wd_')) continue
    const workDirPath = join(sessionsDir, workDirEntry.name)

    for (const sessionEntry of await directoryEntries(workDirPath)) {
      // Session dir naming differs by host product: the CLI uses session_*,
      // embedded runtimes (desktop app, IDE) use conv-*/ctitle-*. Any directory
      // is accepted; the agents/*/wire.jsonl probe below gates real sessions.
      if (!sessionEntry.isDirectory()) continue
      const sessionDir = join(workDirPath, sessionEntry.name)
      const state = await readState(sessionDir)
      const project = projectFromWorkDir(state.workDir ?? '', workDirEntry.name)

      for (const agentEntry of await directoryEntries(join(sessionDir, 'agents'))) {
        if (!agentEntry.isDirectory()) continue
        const wirePath = join(sessionDir, 'agents', agentEntry.name, 'wire.jsonl')
        if (!await isFile(wirePath)) continue
        sources.push({
          path: wirePath,
          project,
          provider: 'kimicode',
          sourceId: agentEntry.name,
          sourceLabel: agentEntry.name,
          sourcePath: state.workDir,
        })
      }
    }
  }

  return sources.sort((a, b) => a.path.localeCompare(b.path))
}

function sessionDirForWire(path: string): string {
  return dirname(dirname(dirname(path)))
}

function sessionIdForWire(path: string): string {
  return basename(sessionDirForWire(path)).replace(/^session_/, '')
}

function agentIdForWire(path: string): string {
  return basename(dirname(path))
}

function turnIdFromStep(value: unknown): string {
  const turnStep = stringValue(value)
  if (!turnStep) return ''
  return turnStep.split('.', 1)[0] ?? ''
}

function inputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(part => {
      const record = asObject(part)
      return record?.['type'] === 'text' ? stringValue(record['text']) : ''
    })
    .filter(Boolean)
    .join('\n')
}

function toolDetails(value: unknown): { name: string; bashCommands: string[] } | null {
  const event = asObject(value)
  if (!event || stringValue(event['type']) !== 'tool.call') return null
  const rawName = stringValue(event['name'])
  if (!rawName) return null
  const name = toolNameMap[rawName] ?? rawName

  let args = asObject(event['args'])
  if (!args && typeof event['args'] === 'string') {
    try {
      args = asObject(JSON.parse(event['args']))
    } catch {
      args = null
    }
  }
  const command = stringValue(args?.['command'])
  return {
    name,
    bashCommands: name === 'Bash' && command ? extractBashCommands(command) : [],
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      let contents: string
      try {
        contents = await readFile(source.path, 'utf8')
      } catch {
        return
      }

      const sessionDir = sessionDirForWire(source.path)
      const sessionId = sessionIdForWire(source.path)
      const agentId = source.sourceId || agentIdForWire(source.path)
      const state = await readState(sessionDir)
      const fallbackTimestamp = timestampIso(state.updatedAt) || timestampIso(state.createdAt)
      const projectPath = state.workDir || source.sourcePath
      const aliasModels = new Map<string, string>()
      const prompts = new Map<string, string>()
      let currentPrompt = ''
      let currentRequest: RequestContext | null = null
      let pendingTools: string[] = []
      let pendingBashCommands: string[] = []
      let usageOrdinal = 0

      const lines = contents.split(/\r?\n/)
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]!.trim()
        if (!line) continue

        let record: JsonObject | null
        try {
          record = asObject(JSON.parse(line))
        } catch {
          continue
        }
        if (!record) continue

        const type = stringValue(record['type'])
        if (type === 'turn.prompt') {
          pendingTools = []
          pendingBashCommands = []
          currentPrompt = inputText(record['input'])
          continue
        }

        if (type === 'llm.request') {
          const model = stringValue(record['model'])
          const modelAlias = stringValue(record['modelAlias'])
          const turnId = turnIdFromStep(record['turnStep'])
          if (model && modelAlias) aliasModels.set(modelAlias, model)
          if (turnId && currentPrompt) prompts.set(turnId, currentPrompt)
          currentRequest = {
            model,
            modelAlias,
            turnId,
            timestamp: timestampIso(record['time']),
          }
          continue
        }

        if (type === 'context.append_loop_event') {
          const tool = toolDetails(record['event'])
          if (tool) {
            pendingTools.push(tool.name)
            pendingBashCommands.push(...tool.bashCommands)
          }
          continue
        }

        if (type !== 'usage.record') continue
        const usage = asObject(record['usage'])
        if (!usage) continue

        const usageAlias = stringValue(record['model'])
        const realModel = aliasModels.get(usageAlias) ?? (currentRequest?.model || 'kimicode-unknown')
        const turnId = currentRequest?.turnId || ''
        const inputTokens = nonNegativeNumber(usage['inputOther'])
        const outputTokens = nonNegativeNumber(usage['output'])
        const cacheReadInputTokens = nonNegativeNumber(usage['inputCacheRead'])
        const cacheCreationInputTokens = nonNegativeNumber(usage['inputCacheCreation'])
        const timestamp = timestampIso(record['time']) || currentRequest?.timestamp || fallbackTimestamp
        if (!timestamp) {
          pendingTools = []
          pendingBashCommands = []
          continue
        }

        const deduplicationKey = `kimicode:${sessionId}:${agentId}:${lineIndex + 1}:${usageOrdinal}`
        usageOrdinal++
        if (seenKeys.has(deduplicationKey)) {
          pendingTools = []
          pendingBashCommands = []
          continue
        }
        seenKeys.add(deduplicationKey)

        yield {
          provider: 'kimicode',
          model: realModel,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          cachedInputTokens: cacheReadInputTokens,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD: calculateCost(
            realModel,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
            0,
          ),
          costIsEstimated: true,
          tools: pendingTools,
          bashCommands: pendingBashCommands,
          timestamp,
          speed: 'standard',
          deduplicationKey,
          turnId: turnId || undefined,
          userMessage: prompts.get(turnId) ?? currentPrompt,
          sessionId,
          project: source.project,
          projectPath,
        }

        pendingTools = []
        pendingBashCommands = []
      }
    },
  }
}

export function createKimicodeProvider(homeOverride?: string): Provider {
  return {
    name: 'kimicode',
    displayName: 'Kimi Code',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return kimicodeHomes(homeOverride).map(path => ({ path, label: 'Kimi Code home' }))
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const all: SessionSource[] = []
      for (const home of kimicodeHomes(homeOverride)) {
        all.push(...await discoverSources(home))
      }
      return all.sort((a, b) => a.path.localeCompare(b.path))
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const kimicode = createKimicodeProvider()
