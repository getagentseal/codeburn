import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'

import { readSessionLines } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  file_read: 'Read',
  file_edit_replace_string: 'Edit',
  file_edit_replace_lines: 'Edit',
  file_edit_insert: 'Edit',
  file_edit_operation: 'Edit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  task: 'Agent',
  todo: 'TodoWrite',
}

type MuxPart = {
  type?: string
  text?: string
  toolName?: string
  input?: unknown
}

type MuxMessage = {
  id?: string
  role?: string
  parts?: MuxPart[]
  createdAt?: string
  metadata?: {
    model?: string
    timestamp?: number
    historySequence?: number
    usage?: unknown
    providerMetadata?: Record<string, unknown>
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function getMuxRoot(override?: string): string {
  if (override) return resolve(expandHome(override))
  const codeburnOverride = process.env['CODEBURN_MUX_DIR']
  if (codeburnOverride) return resolve(expandHome(codeburnOverride))
  const muxRoot = process.env['MUX_ROOT']
  if (muxRoot) return resolve(expandHome(muxRoot))
  return join(homedir(), '.mux')
}

// Splits on the first colon only, leaving any colon inside the id intact.
function stripProvider(model: string): string {
  const i = model.indexOf(':')
  return i >= 0 ? model.slice(i + 1) : model
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

// Guard against non-finite / out-of-range ms, which make toISOString() throw.
function toIsoTimestamp(ts: unknown, createdAt: unknown): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const d = new Date(ts)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return typeof createdAt === 'string' ? createdAt : ''
}

// config.json shape: { projects: [[projectPath, { workspaces: [{ id }] }], ...] }
async function loadProjectMap(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let data: unknown
  try {
    data = JSON.parse(await readFile(join(root, 'config.json'), 'utf-8'))
  } catch {
    return map
  }
  const projects = asRecord(data)?.['projects']
  if (!Array.isArray(projects)) return map
  for (const pair of projects) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const projectPath = pair[0]
    if (typeof projectPath !== 'string') continue
    const label = basename(projectPath) || projectPath
    const workspaces = asRecord(pair[1])?.['workspaces']
    if (!Array.isArray(workspaces)) continue
    for (const ws of workspaces) {
      const id = asRecord(ws)?.['id']
      if (typeof id === 'string' && id) map.set(id, label)
    }
  }
  return map
}

async function pushChatSource(sources: SessionSource[], chatPath: string, project: string): Promise<void> {
  const s = await stat(chatPath).catch(() => null)
  if (s?.isFile()) sources.push({ path: chatPath, project, provider: 'mux' })
}

async function discoverSessions(root: string): Promise<SessionSource[]> {
  const sessionsDir = join(root, 'sessions')

  let workspaceIds: string[]
  try {
    workspaceIds = await readdir(sessionsDir)
  } catch {
    return []
  }

  const projectMap = await loadProjectMap(root)
  const sources: SessionSource[] = []
  for (const workspaceId of workspaceIds) {
    const workspaceDir = join(sessionsDir, workspaceId)
    const project = projectMap.get(workspaceId) ?? workspaceId

    // The workspace's own turns.
    await pushChatSource(sources, join(workspaceDir, 'chat.jsonl'), project)

    // Sub-agent turns. Each spawned sub-agent is a separate LLM-client session
    // recorded at subagent-transcripts/<childTaskId>/chat.jsonl — mux does NOT
    // mirror these into a top-level sessions/<id> dir, so they are only
    // reachable here. They carry real token usage (often the bulk of a
    // session's spend) and are attributed to the parent workspace's project.
    // Dedup stays correct: the parser keys off the child-task dir name, which
    // is distinct from every workspace id, so each call is still counted once.
    const subagentDir = join(workspaceDir, 'subagent-transcripts')
    let childTaskIds: string[]
    try {
      childTaskIds = await readdir(subagentDir)
    } catch {
      continue
    }
    for (const childTaskId of childTaskIds) {
      await pushChatSource(sources, join(subagentDir, childTaskId, 'chat.jsonl'), project)
    }
  }
  return sources
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const workspaceId = basename(dirname(source.path))
      let pendingUserMessage = ''
      let lineIdx = 0

      for await (const line of readSessionLines(source.path)) {
        lineIdx++
        let msg: MuxMessage
        try {
          msg = JSON.parse(line) as MuxMessage
        } catch {
          continue
        }
        if (!msg || typeof msg !== 'object') continue

        if (msg.role === 'user') {
          const texts = (Array.isArray(msg.parts) ? msg.parts : [])
            .filter(p => p?.type === 'text' && typeof p.text === 'string')
            .map(p => p.text as string)
            .filter(Boolean)
          if (texts.length > 0) pendingUserMessage = texts.join(' ').slice(0, 500)
          continue
        }

        if (msg.role !== 'assistant') continue
        const meta = msg.metadata
        const usage = asRecord(meta?.usage)
        if (!meta || !usage) continue

        const pm = meta.providerMetadata ?? {}
        const anthropic = asRecord(pm['anthropic'])
        const openai = asRecord(pm['openai'])

        // mux reports inputTokens inclusive of cache read+creation and
        // outputTokens inclusive of reasoning; decompose to codeburn's
        // cache/reasoning-exclusive convention. Cache creation is Anthropic-only.
        const cacheRead = num(usage['cachedInputTokens'])
        const cacheCreate = num(anthropic?.['cacheCreationInputTokens'])
        const reasoning = num(usage['reasoningTokens']) || num(openai?.['reasoningTokens'])
        const inputTokens = Math.max(0, num(usage['inputTokens']) - cacheRead - cacheCreate)
        const outputTokens = Math.max(0, num(usage['outputTokens']) - reasoning)

        if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheCreate === 0 && reasoning === 0) {
          continue
        }

        // Strip the "provider:" prefix — codeburn's getCanonicalName only strips
        // slash prefixes, so a colon-prefixed model would price at $0.
        const rawModel = typeof meta.model === 'string' && meta.model ? meta.model : 'unknown'
        const model = stripProvider(rawModel)
        const id = typeof msg.id === 'string' && msg.id ? msg.id : `L${lineIdx}`
        const dedupKey = `mux:${workspaceId}:${id}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const toolParts = (Array.isArray(msg.parts) ? msg.parts : []).filter(
          p => p?.type === 'dynamic-tool' && typeof p.toolName === 'string',
        )
        const tools = toolParts.map(p => toolNameMap[p.toolName!] ?? p.toolName!)
        const bashCommands = toolParts
          .filter(p => p.toolName === 'bash')
          .flatMap(p => {
            const input = asRecord(p.input)
            const script = input?.['script'] ?? input?.['command']
            return typeof script === 'string' ? extractBashCommands(script) : []
          })

        const costUSD = calculateCost(
          model,
          inputTokens,
          outputTokens + reasoning,
          cacheCreate,
          cacheRead,
          0,
        )

        const timestamp = toIsoTimestamp(meta.timestamp, msg.createdAt)

        yield {
          provider: 'mux',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheCreate,
          cacheReadInputTokens: cacheRead,
          cachedInputTokens: cacheRead,
          reasoningTokens: reasoning,
          webSearchRequests: 0,
          costUSD,
          tools,
          bashCommands,
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: pendingUserMessage,
          sessionId: workspaceId,
        }

        pendingUserMessage = ''
      }
    },
  }
}

export function createMuxProvider(muxRoot?: string): Provider {
  const root = getMuxRoot(muxRoot)

  return {
    name: 'mux',
    displayName: 'Mux',

    modelDisplayName(model: string): string {
      return getShortModelName(stripProvider(model))
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions(root)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const mux = createMuxProvider()
