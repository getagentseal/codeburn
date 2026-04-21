import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { type DiscoverySnapshotEntry, loadDiscoveryCache, saveDiscoveryCache } from '../discovery-cache.js'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5': 'GPT-5',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  dispatch_agent: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  patch: 'Patch',
}

// Pre-sorted by key length descending so longer/more-specific keys match first
const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

type PiEntry = {
  type: string
  id?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }>
    model?: string
    responseId?: string
    usage?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
  }
}

function getPiSessionsDir(override?: string): string {
  return override ?? join(homedir(), '.pi', 'agent', 'sessions')
}

function getOmpSessionsDir(override?: string): string {
  return override ?? join(homedir(), '.omp', 'agent', 'sessions')
}

async function readFirstEntry(filePath: string): Promise<PiEntry | null> {
  const content = await readSessionFile(filePath)
  if (content === null) return null
  const line = content.split('\n')[0]
  if (!line?.trim()) return null
  try {
    return JSON.parse(line) as PiEntry
  } catch {
    return null
  }
}

async function collectDiscoverySnapshot(sessionsDir: string): Promise<DiscoverySnapshotEntry[]> {
  const snapshot: DiscoverySnapshotEntry[] = []

  let projectDirs: string[]
  try {
    projectDirs = await readdir(sessionsDir)
  } catch {
    return snapshot
  }

  for (const dirName of projectDirs) {
    const dirPath = join(sessionsDir, dirName)
    const dirStat = await stat(dirPath).catch(() => null)
    if (!dirStat?.isDirectory()) continue
    snapshot.push({ path: dirPath, mtimeMs: dirStat.mtimeMs })

    // Sub-agent sessions land in <project-dir>/<session-id>/ subdirectories.
    // Their mtimes must be tracked separately — adding files inside a subdir
    // does not bump the parent project dir's mtime.
    let subEntries: string[]
    try {
      subEntries = await readdir(dirPath)
    } catch {
      continue
    }
    for (const subName of subEntries) {
      const subPath = join(dirPath, subName)
      const subStat = await stat(subPath).catch(() => null)
      if (subStat?.isDirectory()) {
        snapshot.push({ path: subPath, mtimeMs: subStat.mtimeMs })
      }
    }
  }

  return snapshot
}

async function discoverSessionsInDir(sessionsDir: string, providerName: string): Promise<SessionSource[]> {
  const snapshot = await collectDiscoverySnapshot(sessionsDir)
  const cached = await loadDiscoveryCache(providerName, sessionsDir, snapshot)
  if (cached) return cached

  const sources: SessionSource[] = []

  let projectDirs: string[]
  try {
    projectDirs = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const dirName of projectDirs) {
    const dirPath = join(sessionsDir, dirName)
    const dirStat = await stat(dirPath).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    await collectJsonlFromDir(dirPath, dirName, providerName, sources)
  }

  await saveDiscoveryCache(providerName, sessionsDir, snapshot, sources)
  return sources
}

// Collects session sources from dirPath and one level of subdirectories.
// Sub-agent sessions land in <project-dir>/<parent-session-id>/<agent-name>.jsonl,
// so we must recurse one level deeper than the project directory.
async function collectJsonlFromDir(
  dirPath: string,
  projectDirName: string,
  providerName: string,
  sources: SessionSource[],
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dirPath)
  } catch {
    return
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry)
    const entryStat = await stat(entryPath).catch(() => null)
    if (!entryStat) continue

    if (entryStat.isDirectory()) {
      // Sub-agent session dir: recurse one level, but don't go deeper
      await collectJsonlFromDir(entryPath, projectDirName, providerName, sources)
      continue
    }

    if (!entryStat.isFile() || !entry.endsWith('.jsonl')) continue

    const first = await readFirstEntry(entryPath)
    if (!first || first.type !== 'session') continue

    const cwd = first.cwd ?? projectDirName
    sources.push({
      path: entryPath,
      project: basename(cwd),
      provider: providerName,
      fingerprintPath: entryPath,
      cacheStrategy: 'append-jsonl',
      progressLabel: basename(entryPath),
      parserVersion: `${providerName}:v1`,
    })
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (content === null) return
      const lines = content.split('\n').filter(l => l.trim())
      let sessionId = basename(source.path, '.jsonl')
      let pendingUserMessage = ''

      for (const [lineIdx, line] of lines.entries()) {
        let entry: PiEntry
        try {
          entry = JSON.parse(line) as PiEntry
        } catch {
          continue
        }

        if (entry.type === 'session') {
          sessionId = entry.id ?? sessionId
          continue
        }

        if (entry.type !== 'message') continue

        const msg = entry.message
        if (!msg) continue

        if (msg.role === 'user') {
          const texts = (msg.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .filter(Boolean)
          if (texts.length > 0) pendingUserMessage = texts.join(' ')
          continue
        }

        if (msg.role !== 'assistant' || !msg.usage) continue

        const { input, output, cacheRead, cacheWrite } = msg.usage
        if (input === 0 && output === 0) continue

        const model = msg.model ?? 'gpt-5'
        const responseId = msg.responseId ?? ''
        const dedupKey = `${source.provider}:${source.path}:${responseId || entry.id || entry.timestamp || String(lineIdx)}`

        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const toolCalls = (msg.content ?? []).filter(c => c.type === 'toolCall' && c.name)
        const tools = toolCalls.map(c => toolNameMap[c.name!] ?? c.name!)
        const bashCommands = toolCalls
          .filter(c => c.name === 'bash')
          .flatMap(c => {
            const cmd = c.arguments?.['command']
            return typeof cmd === 'string' ? extractBashCommands(cmd) : []
          })

        const costUSD = calculateCost(model, input, output, cacheWrite, cacheRead, 0)
        const timestamp = entry.timestamp ?? ''

        yield {
          provider: source.provider,
          model,
          inputTokens: input,
          outputTokens: output,
          cacheCreationInputTokens: cacheWrite,
          cacheReadInputTokens: cacheRead,
          cachedInputTokens: cacheRead,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD,
          tools,
          bashCommands,
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: pendingUserMessage,
          sessionId,
        }

        pendingUserMessage = ''
      }
    },
  }
}

export function createPiProvider(sessionsDir?: string): Provider {
  const dir = getPiSessionsDir(sessionsDir)

  return {
    name: 'pi',
    displayName: 'Pi',

    modelDisplayName(model: string): string {
      for (const [key, name] of modelDisplayEntries) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir, 'pi')
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const pi = createPiProvider()

export function createOmpProvider(sessionsDir?: string): Provider {
  const dir = getOmpSessionsDir(sessionsDir)

  return {
    name: 'omp',
    displayName: 'OMP',

    modelDisplayName(model: string): string {
      for (const [key, name] of modelDisplayEntries) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir, 'omp')
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const omp = createOmpProvider()
