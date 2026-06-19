import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// Grok Build (xAI's coding CLI) stores one session per directory at
// <grok-home>/sessions/<url-encoded-cwd>/<uuid>/, where grok-home is $GROK_HOME
// or ~/.grok. Each session dir holds summary.json, signals.json, and the ACP
// log updates.jsonl.
//
// Grok does NOT record billable input/output tokens. signals.json carries
// `contextTokensUsed` (current context fill) and updates.jsonl carries a running
// `_meta.totalTokens` per streamed chunk; there is no per-call input/output
// split. We reconstruct an ESTIMATE from the per-turn totalTokens curve. Agentic
// turns re-send the growing context every call, and that re-sent context is
// cached server-side, so we bill the unique (peak) context as fresh input once,
// the re-sent remainder as cache reads, and the per-turn growth as output. Cost
// is flagged estimated; grok-build is priced via its grok-build-0.1 alias.

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  run_terminal_command: 'Bash',
  read_file: 'Read',
  read: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  edit: 'Edit',
  list_dir: 'Glob',
  glob: 'Glob',
  grep: 'Grep',
  search: 'WebSearch',
  web_search: 'WebSearch',
  fetch: 'WebFetch',
  task: 'Agent',
  search_replace: 'Edit',
  todo_write: 'TodoWrite',
  spawn_subagent: 'Agent',
}

function defaultSessionsDir(): string {
  const home = process.env['GROK_HOME'] ?? join(homedir(), '.grok')
  return join(home, 'sessions')
}

type GrokSummary = {
  info?: { id?: string; cwd?: string }
  created_at?: string
  updated_at?: string
  last_active_at?: string
  current_model_id?: string
  session_summary?: string
  generated_title?: string
}

type GrokSignals = {
  primaryModelId?: string
  modelsUsed?: string[]
  toolsUsed?: string[]
}

async function readJson<T>(path: string): Promise<T | null> {
  const content = await readSessionFile(path)
  if (content === null) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

// updates.jsonl is one ACP JSON-RPC notification per line; streamed chunks carry
// params._meta.{totalTokens, promptId}. totalTokens is the running context size,
// so grouping by promptId (one per turn) gives each turn's first/last value.
type GrokUpdate = {
  params?: {
    _meta?: { totalTokens?: number; promptId?: string }
    update?: { sessionUpdate?: string; title?: string; rawInput?: { command?: unknown } }
  }
}

// Single pass over updates.jsonl: per-turn totalTokens for the cost estimate,
// plus the real tool calls (each tool_call's title -> a tool, and
// run_terminal_command's rawInput.command -> shell commands).
function parseUpdates(updates: string): {
  input: number
  cacheRead: number
  output: number
  tools: string[]
  bashCommands: string[]
} {
  const turns = new Map<string, { first: number; last: number }>()
  const tools: string[] = []
  const bashCommands: string[] = []

  for (const line of updates.split('\n')) {
    if (!line.trim()) continue
    let params: GrokUpdate['params']
    try {
      params = (JSON.parse(line) as GrokUpdate).params
    } catch {
      continue
    }
    if (!params) continue

    const total = params._meta?.totalTokens
    const promptId = params._meta?.promptId
    if (typeof total === 'number' && promptId) {
      const turn = turns.get(promptId)
      if (!turn) turns.set(promptId, { first: total, last: total })
      else turn.last = total
    }

    const update = params.update
    if (update?.sessionUpdate === 'tool_call' && typeof update.title === 'string') {
      tools.push(toolNameMap[update.title] ?? update.title)
      if (update.title === 'run_terminal_command' && typeof update.rawInput?.command === 'string') {
        bashCommands.push(...extractBashCommands(update.rawInput.command))
      }
    }
  }

  let sumFirst = 0
  let output = 0
  let peak = 0
  for (const { first, last } of turns.values()) {
    sumFirst += first
    output += Math.max(0, last - first)
    if (last > peak) peak = last
  }
  // Unique context (peak) is fresh input billed once; the rest of the per-turn
  // re-sends are cache reads (Grok caches them, even though it reports nothing).
  const cacheRead = Math.max(0, sumFirst - peak)
  return { input: peak, cacheRead, output, tools, bashCommands }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const dir = dirname(source.path)
      const summary = await readJson<GrokSummary>(join(dir, 'summary.json'))
      const updates = await readSessionFile(source.path)
      if (!summary || updates === null) return

      const { input, cacheRead, output, tools, bashCommands } = parseUpdates(updates)
      if (input === 0 && output === 0) return

      const signals = await readJson<GrokSignals>(join(dir, 'signals.json'))
      const model =
        summary.current_model_id ?? signals?.primaryModelId ?? signals?.modelsUsed?.[0] ?? 'grok-build'
      const timestamp = summary.updated_at ?? summary.last_active_at ?? summary.created_at ?? ''
      const sessionId = summary.info?.id ?? basename(dir)

      const dedupKey = `${source.provider}:${dir}:${timestamp}:${sessionId}`
      if (seenKeys.has(dedupKey)) return
      seenKeys.add(dedupKey)

      yield {
        provider: source.provider,
        model,
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: cacheRead,
        cachedInputTokens: cacheRead,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: calculateCost(model, input, output, 0, cacheRead, 0),
        costIsEstimated: true,
        tools,
        bashCommands,
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: summary.session_summary ?? summary.generated_title ?? '',
        sessionId,
        project: source.project,
        projectPath: summary.info?.cwd,
      }
    },
  }
}

async function discoverSessions(sessionsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let cwdDirs: string[]
  try {
    cwdDirs = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const cwdName of cwdDirs) {
    const cwdPath = join(sessionsDir, cwdName)
    const cwdStat = await stat(cwdPath).catch(() => null)
    if (!cwdStat?.isDirectory()) continue

    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(cwdPath)
    } catch {
      continue
    }

    for (const sessionName of sessionDirs) {
      const sessionPath = join(cwdPath, sessionName)
      const sessionStat = await stat(sessionPath).catch(() => null)
      if (!sessionStat?.isDirectory()) continue

      const summary = await readJson<GrokSummary>(join(sessionPath, 'summary.json'))
      if (!summary) continue

      const cwd = summary.info?.cwd ?? safeDecode(cwdName)
      sources.push({ path: join(sessionPath, 'updates.jsonl'), project: basename(cwd), provider: 'grok' })
    }
  }

  return sources
}

export function createGrokProvider(sessionsDir?: string): Provider {
  const dir = sessionsDir ?? defaultSessionsDir()

  return {
    name: 'grok',
    displayName: 'Grok Build',

    modelDisplayName(model: string): string {
      if (model.startsWith('grok-build')) return 'Grok Build'
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions(dir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const grok = createGrokProvider()
