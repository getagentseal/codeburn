import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { normalizeContentBlocks } from '../content-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.5': 'GPT-5.5',
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

// Pi/OMP have no dedicated skill tool the way Claude Code does. A native skill
// load is emitted as an ordinary `read` tool call whose path points at the
// skill's `SKILL.md` (Pi resolves skills from many roots: ~/.pi/agent/skills,
// project .pi/skills, .agents/skills, package skills/, --skill <path>), or, in
// newer OMP builds, at a `skill://<name>` URI. Left untouched these inflate the
// Read tool count and leave the Skills dimension empty (issue #588). Return the
// skill name when a read is really a skill load, else null so it stays a Read.
function skillLoadName(name: string | undefined, args: Record<string, unknown> | undefined): string | null {
  if (name !== 'read') return null
  const raw = args?.['path'] ?? args?.['file_path']
  if (typeof raw !== 'string') return null
  const path = raw.trim()
  if (path.length === 0) return null

  if (path.startsWith('skill://')) {
    const rest = path.slice('skill://'.length).replace(/^\/+/, '')
    const first = rest.split(/[/?#]/)[0]?.trim() ?? ''
    return first.length > 0 ? first : null
  }

  // Match on the SKILL.md basename, not a directory prefix, because skill roots
  // live in many locations. Split on both separators so Windows paths work.
  const segments = path.split(/[\\/]/).filter(Boolean)
  if (segments[segments.length - 1] !== 'SKILL.md') return null
  const parent = segments[segments.length - 2]?.trim()
  return parent && parent.length > 0 ? parent : null
}

type PiEntry = {
  type: string
  id?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }> | string
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

      const first = await readFirstEntry(filePath)
      if (!first || first.type !== 'session') continue

      const cwd = first.cwd ?? dirName
      sources.push({ path: filePath, project: basename(cwd), provider: providerName })
    }
  }

  return sources
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
          const texts = normalizeContentBlocks(msg.content)
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .filter(Boolean)
          if (texts.length > 0) pendingUserMessage = texts.join(' ')
          continue
        }

        if (msg.role !== 'assistant' || !msg.usage) continue

        // Coerce undefined/null token fields to 0. Pi/OMP session files
        // sometimes omit individual usage fields; the destructure used to
        // pass undefined into calculateCost which then returned NaN, and
        // that NaN propagated into every aggregate cost total.
        const input = msg.usage.input ?? 0
        const output = msg.usage.output ?? 0
        const cacheRead = msg.usage.cacheRead ?? 0
        const cacheWrite = msg.usage.cacheWrite ?? 0
        if (input === 0 && output === 0) continue

        const model = msg.model ?? 'gpt-5'
        const responseId = msg.responseId ?? ''
        const dedupKey = `${source.provider}:${source.path}:${responseId || entry.id || entry.timestamp || String(lineIdx)}`

        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const toolCalls = normalizeContentBlocks(msg.content).filter(c => c.type === 'toolCall' && c.name)

        // A SKILL.md-loading read is surfaced as the `Skill` tool (not `Read`)
        // and its name is recorded in `skills`. This mirrors how the Claude
        // parser represents a skill invocation, so the shared classifier tags
        // the turn `general` and the "Skills & Agents" breakdown picks it up,
        // instead of over-counting a Read and leaving Skills empty (#588).
        // Every other call stays a normal tool.
        const tools: string[] = []
        const skills: string[] = []
        for (const c of toolCalls) {
          const skill = skillLoadName(c.name, c.arguments)
          if (skill !== null) {
            skills.push(skill)
            tools.push('Skill')
            continue
          }
          tools.push(toolNameMap[c.name!] ?? c.name!)
        }

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
          skills,
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
