import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { type DiscoverySnapshotEntry, loadDiscoveryCache, saveDiscoveryCache } from '../discovery-cache.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
}

const toolNameMap: Record<string, string> = {
  exec_command: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
}

type CodexEntry = {
  type: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    cwd?: string
    model_provider?: string
    originator?: string
    session_id?: string
    model?: string
    name?: string
    content?: Array<{ type?: string; text?: string }>
    info?: {
      model?: string
      model_name?: string
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

function getCodexDir(override?: string): string {
  return override ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

function sanitizeProject(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '-')
}

async function readFirstLine(filePath: string): Promise<CodexEntry | null> {
  const content = await readSessionFile(filePath)
  if (content === null) return null
  const line = content.split('\n')[0]
  if (!line?.trim()) return null
  try {
    return JSON.parse(line) as CodexEntry
  } catch {
    return null
  }
}

async function isValidCodexSession(filePath: string): Promise<{ valid: boolean; meta?: CodexEntry }> {
  const entry = await readFirstLine(filePath)
  if (!entry) return { valid: false }
  const valid = entry.type === 'session_meta' &&
    typeof entry.payload?.originator === 'string' &&
    entry.payload.originator.toLowerCase().startsWith('codex')
  return { valid, meta: valid ? entry : undefined }
}

async function collectCodexDiscoverySnapshot(sessionsDir: string): Promise<DiscoverySnapshotEntry[]> {
  const snapshot: DiscoverySnapshotEntry[] = []

  let years: string[]
  try {
    years = await readdir(sessionsDir)
  } catch {
    return snapshot
  }

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearDir = join(sessionsDir, year)
    const yearStat = await stat(yearDir).catch(() => null)
    if (!yearStat?.isDirectory()) continue

    const months = await readdir(yearDir).catch(() => [] as string[])
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthDir = join(yearDir, month)
      const monthStat = await stat(monthDir).catch(() => null)
      if (!monthStat?.isDirectory()) continue

      const days = await readdir(monthDir).catch(() => [] as string[])
      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayDir = join(monthDir, day)
        const dayStat = await stat(dayDir).catch(() => null)
        if (!dayStat?.isDirectory()) continue
        snapshot.push({ path: dayDir, mtimeMs: dayStat.mtimeMs })
      }
    }
  }

  return snapshot
}

async function discoverSessionsInDir(codexDir: string): Promise<SessionSource[]> {
  const sessionsDir = join(codexDir, 'sessions')
  const snapshot = await collectCodexDiscoverySnapshot(sessionsDir)
  const cached = await loadDiscoveryCache('codex', sessionsDir, snapshot)
  if (cached) return cached

  const sources: SessionSource[] = []

  let years: string[]
  try {
    years = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearDir = join(sessionsDir, year)
    const months = await readdir(yearDir).catch(() => [] as string[])

    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthDir = join(yearDir, month)
      const days = await readdir(monthDir).catch(() => [] as string[])

      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayDir = join(monthDir, day)
        const files = await readdir(dayDir).catch(() => [] as string[])

        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
          const filePath = join(dayDir, file)
          const s = await stat(filePath).catch(() => null)
          if (!s?.isFile()) continue

          const { valid, meta } = await isValidCodexSession(filePath)
          if (!valid || !meta) continue

          const cwd = meta.payload?.cwd ?? 'unknown'
          sources.push({
            path: filePath,
            project: sanitizeProject(cwd),
            provider: 'codex',
            fingerprintPath: filePath,
            cacheStrategy: 'append-jsonl',
            progressLabel: basename(filePath),
            parserVersion: 'codex:v1',
          })
        }
      }
    }
  }

  await saveDiscoveryCache('codex', sessionsDir, snapshot, sources)
  return sources
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return info?.info?.model
    ?? info?.info?.model_name
    ?? sessionModel
    ?? 'gpt-5'
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (content === null) return
      const lines = content.split('\n').filter(l => l.trim())
      let sessionModel: string | undefined
      let sessionId = ''
      let prevCumulativeTotal = 0
      let prevInput = 0
      let prevCached = 0
      let prevOutput = 0
      let prevReasoning = 0
      let pendingTools: string[] = []
      let pendingUserMessage = ''

      for (const line of lines) {
        let entry: CodexEntry
        try {
          entry = JSON.parse(line) as CodexEntry
        } catch {
          continue
        }

        if (entry.type === 'session_meta') {
          sessionId = entry.payload?.session_id ?? basename(source.path, '.jsonl')
          sessionModel = entry.payload?.model
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          const rawName = entry.payload.name ?? ''
          pendingTools.push(toolNameMap[rawName] ?? rawName)
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
          const texts = (entry.payload.content ?? [])
            .filter(c => c.type === 'input_text')
            .map(c => c.text ?? '')
            .filter(Boolean)
          if (texts.length > 0) pendingUserMessage = texts.join(' ')
          continue
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
          const info = entry.payload.info
          if (!info) continue

          const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
          if (cumulativeTotal > 0 && cumulativeTotal === prevCumulativeTotal) continue
          prevCumulativeTotal = cumulativeTotal

          const last = info.last_token_usage
          let inputTokens = 0
          let cachedInputTokens = 0
          let outputTokens = 0
          let reasoningTokens = 0

          if (last) {
            inputTokens = last.input_tokens ?? 0
            cachedInputTokens = last.cached_input_tokens ?? 0
            outputTokens = last.output_tokens ?? 0
            reasoningTokens = last.reasoning_output_tokens ?? 0
          } else if (cumulativeTotal > 0) {
            const total = info.total_token_usage
            if (!total) continue
            inputTokens = (total.input_tokens ?? 0) - prevInput
            cachedInputTokens = (total.cached_input_tokens ?? 0) - prevCached
            outputTokens = (total.output_tokens ?? 0) - prevOutput
            reasoningTokens = (total.reasoning_output_tokens ?? 0) - prevReasoning
          }

          if (!last) {
            const total = info.total_token_usage
            if (total) {
              prevInput = total.input_tokens ?? 0
              prevCached = total.cached_input_tokens ?? 0
              prevOutput = total.output_tokens ?? 0
              prevReasoning = total.reasoning_output_tokens ?? 0
            }
          }

          const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens
          if (totalTokens === 0) continue

          // OpenAI includes cached tokens inside input_tokens; Anthropic does not.
          // Normalize to Anthropic semantics: inputTokens = non-cached only.
          const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)

          const model = resolveModel(entry.payload, sessionModel)
          const timestamp = entry.timestamp ?? ''
          const dedupKey = `codex:${source.path}:${timestamp}:${cumulativeTotal}`

          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const costUSD = calculateCost(
            model,
            uncachedInputTokens,
            outputTokens + reasoningTokens,
            0,
            cachedInputTokens,
            0,
          )

          yield {
            provider: 'codex',
            model,
            inputTokens: uncachedInputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cachedInputTokens,
            cachedInputTokens,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            tools: pendingTools,
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: pendingUserMessage,
            sessionId,
          }

          pendingTools = []
          pendingUserMessage = ''
        }
      }
    },
  }
}

export function createCodexProvider(codexDir?: string): Provider {
  const dir = getCodexDir(codexDir)

  return {
    name: 'codex',
    displayName: 'Codex',

    modelDisplayName(model: string): string {
      for (const [key, name] of Object.entries(modelDisplayNames)) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const codex = createCodexProvider()
