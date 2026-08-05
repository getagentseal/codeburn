import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { decodePi } from '@codeburn/core/providers/pi'
import type { PiDecodedCall } from '@codeburn/core/providers/pi'
import { readSessionFile, readSessionLines } from '../fs-utils.js'
import { extractBashCommands } from '../bash-utils.js'
import { createBridgedProvider } from './bridge.js'
import type { Provider, SessionSource, ParsedProviderCall } from './types.js'

type PiEntry = {
  type: string
  id?: string
  timestamp?: string
  /// JSON can carry anything here; the reader validates before use (a real
  /// transcript always writes a string, but a malformed record must not
  /// crash discovery with a `basename` type error).
  cwd?: unknown
  message?: unknown
}

function getPiSessionsDir(override?: string): string {
  return override ?? join(homedir(), '.pi', 'agent', 'sessions')
}

function getOmpSessionsDir(override?: string): string {
  return override ?? join(homedir(), '.omp', 'agent', 'sessions')
}

// OMP can write a fixed-width title metadata line (`type: "title"`) before the
// `type: "session"` header (issue #845), and either provider may pad the
// header with blank lines. Scan a bounded number of leading lines rather than
// just the first one, so discovery stops after twenty parse attempts and never
// walks a message-only or pathological transcript line by line to EOF. The
// bound caps how many LINES are inspected, not how many bytes: readSessionLines
// buffers one physical line whole, so a single oversized line is bounded only
// by the streaming reader's cap, not by this constant.
const MAX_HEADER_LINES_SCANNED = 20

async function readSessionEntry(filePath: string): Promise<PiEntry | null> {
  let linesScanned = 0
  for await (const line of readSessionLines(filePath)) {
    if (linesScanned >= MAX_HEADER_LINES_SCANNED) break
    linesScanned++
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as PiEntry
      if (entry.type === 'session') return entry
    } catch {
      continue
    }
  }
  return null
}

async function discoverSessionsInDir(sessionsDir: string, providerName: string): Promise<SessionSource[]> {
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

    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(dirPath, file)
      const fileStat = await stat(filePath).catch(() => null)
      if (!fileStat?.isFile()) continue

      const entry = await readSessionEntry(filePath)
      if (!entry) continue

      // A malformed record can carry a non-string cwd (e.g. a number); fall
      // back to the project directory the way a missing cwd does, rather than
      // crashing basename with a type error.
      const cwd = typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : dirName
      sources.push({ path: filePath, project: basename(cwd), provider: providerName })
    }
  }

  return sources
}

function toProviderCall(rich: PiDecodedCall): ParsedProviderCall {
  return {
    provider: rich.provider,
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    tools: rich.tools,
    // Pi/OMP's legacy decode did NOT dedup bash commands: it flat-mapped every
    // extracted base name into a flat list. Preserve that (no Set).
    bashCommands: rich.rawBashCommands.flatMap(c => extractBashCommands(c)),
    skills: rich.skills ?? [],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
  }
}

async function readRecords(source: SessionSource): Promise<unknown[] | null> {
  const content = await readSessionFile(source.path)
  if (content === null) return null
  return content.split('\n').filter(l => l.trim())
}

export function createPiProvider(sessionsDir?: string): Provider {
  const dir = getPiSessionsDir(sessionsDir)

  return createBridgedProvider<PiDecodedCall>({
    name: 'pi',
    displayName: 'Pi',

    modelDisplayName(model: string): string {
      const displayNames: Record<string, string> = {
        'gpt-5.4': 'GPT-5.4',
        'gpt-5.4-mini': 'GPT-5.4 Mini',
        'gpt-5.5': 'GPT-5.5',
        'gpt-5': 'GPT-5',
        'gpt-4o': 'GPT-4o',
        'gpt-4o-mini': 'GPT-4o Mini',
      }
      const entries = Object.entries(displayNames).sort((a, b) => b[0].length - a[0].length)
      for (const [key, name] of entries) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
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
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir, 'pi')
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      return readRecords(source)
    },

    // Pi vs OMP is disambiguated inside the decoder via context.providerId, which
    // the bridge sets from spec.name ('pi' here) — no wrapper needed.
    decode: decodePi,
    toProviderCall,
  })
}

export const pi = createPiProvider()

export function createOmpProvider(sessionsDir?: string): Provider {
  const dir = getOmpSessionsDir(sessionsDir)

  return createBridgedProvider<PiDecodedCall>({
    name: 'omp',
    displayName: 'OMP',

    modelDisplayName(model: string): string {
      const displayNames: Record<string, string> = {
        'gpt-5.4': 'GPT-5.4',
        'gpt-5.4-mini': 'GPT-5.4 Mini',
        'gpt-5.5': 'GPT-5.5',
        'gpt-5': 'GPT-5',
        'gpt-4o': 'GPT-4o',
        'gpt-4o-mini': 'GPT-4o Mini',
      }
      const entries = Object.entries(displayNames).sort((a, b) => b[0].length - a[0].length)
      for (const [key, name] of entries) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
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
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir, 'omp')
    },

    async readRecords(source: SessionSource): Promise<unknown[] | null> {
      return readRecords(source)
    },

    // context.providerId is 'omp' here (from spec.name), so the shared decoder
    // stamps provider: 'omp' and the omp dedup-key prefix.
    decode: decodePi,
    toProviderCall,
  })
}

export const omp = createOmpProvider()
