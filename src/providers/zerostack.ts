import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { normalizeContentBlocks } from '../content-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// zerostack (https://github.com/gi-dellav/zerostack) is a minimal Rust coding
// agent inspired by Pi and OpenCode. Sessions live in
// $XDG_DATA_HOME/zerostack/sessions/ as plain-text per-session files.
//
// ponytail: the on-disk entry schema below is modeled on Pi's JSONL format and
// is UNVERIFIED. Per CONTRIBUTING.md, install zerostack, generate real
// sessions, and confirm field names/structure against actual files before
// opening a PR. Adjust ZerostackEntry + the parser to match, then add a
// fixture-based test under tests/providers/zerostack.test.ts.

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  patch: 'Patch',
  review: 'Review',
}

type ZerostackEntry = {
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

function getSessionsDir(override?: string): string {
  const base = override ?? process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'zerostack', 'sessions')
}

async function readFirstEntry(filePath: string): Promise<ZerostackEntry | null> {
  const content = await readSessionFile(filePath)
  if (content === null) return null
  const line = content.split('\n')[0]
  if (!line?.trim()) return null
  try {
    return JSON.parse(line) as ZerostackEntry
  } catch {
    return null
  }
}

async function discoverSessionsInDir(sessionsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const name of entries) {
    const entryPath = join(sessionsDir, name)
    const entryStat = await stat(entryPath).catch(() => null)
    if (!entryStat) continue

    // Sessions may be stored flat or grouped one directory per project.
    const files = entryStat.isDirectory()
      ? (await readdir(entryPath).catch(() => [])).map(f => join(entryPath, f))
      : [entryPath]

    for (const filePath of files) {
      if (!filePath.endsWith('.jsonl')) continue
      const fileStat = await stat(filePath).catch(() => null)
      if (!fileStat?.isFile()) continue

      const first = await readFirstEntry(filePath)
      if (!first || first.type !== 'session') continue

      const cwd = first.cwd ?? name
      sources.push({ path: filePath, project: basename(cwd), provider: 'zerostack' })
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
        let entry: ZerostackEntry
        try {
          entry = JSON.parse(line) as ZerostackEntry
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

        const input = msg.usage.input ?? 0
        const output = msg.usage.output ?? 0
        const cacheRead = msg.usage.cacheRead ?? 0
        const cacheWrite = msg.usage.cacheWrite ?? 0
        if (input === 0 && output === 0) continue

        const model = msg.model ?? ''
        const responseId = msg.responseId ?? ''
        const dedupKey = `${source.provider}:${source.path}:${responseId || entry.id || entry.timestamp || String(lineIdx)}`

        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        const toolCalls = normalizeContentBlocks(msg.content).filter(c => c.type === 'toolCall' && c.name)
        const tools = toolCalls.map(c => toolNameMap[c.name!] ?? c.name!)
        const bashCommands = toolCalls
          .filter(c => c.name === 'bash')
          .flatMap(c => {
            const cmd = c.arguments?.['command']
            return typeof cmd === 'string' ? extractBashCommands(cmd) : []
          })

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
          costUSD: calculateCost(model, input, output, cacheWrite, cacheRead, 0),
          tools,
          bashCommands,
          timestamp: entry.timestamp ?? '',
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

export function createZerostackProvider(sessionsDir?: string): Provider {
  const dir = getSessionsDir(sessionsDir)

  return {
    name: 'zerostack',
    displayName: 'Zerostack',

    modelDisplayName(model: string): string {
      // zerostack proxies OpenRouter/OpenAI/Anthropic/Gemini/Ollama models, so
      // ids arrive already namespaced (e.g. "anthropic/claude-..."). Strip the
      // provider prefix and let the shared resolver handle the rest.
      return model.replace(/^[^/]+\//, '')
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

export const zerostack = createZerostackProvider()
