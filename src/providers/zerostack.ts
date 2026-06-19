import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { homedir, platform } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// zerostack (https://github.com/gi-dellav/zerostack) is a minimal Rust coding
// agent. Each session is a single JSON file under <dataDir>/zerostack/sessions/.
// Token counts are stored as CUMULATIVE session totals (total_input_tokens,
// total_output_tokens, total_cost) — there is no per-call breakdown — so we emit
// one ParsedProviderCall per session.

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  fetch: 'WebFetch',
  search: 'WebSearch',
  task: 'Agent',
}

type ZerostackMessage = {
  role?: string
  content?: string | Array<{ text?: string }>
}

type ZerostackSession = {
  id?: string
  messages?: ZerostackMessage[]
  created_at?: string
  updated_at?: string
  total_input_tokens?: number
  total_output_tokens?: number
  model?: string
  provider?: string
  working_dir?: string
}

// zerostack uses the platform data dir (Rust `dirs::data_dir`): macOS maps to
// ~/Library/Application Support, everything else to $XDG_DATA_HOME or
// ~/.local/share, then a `zerostack` subdir. ZS_DATA_DIR overrides the whole
// data dir (sessions live directly under it). Matches src/session/storage.rs.
function defaultSessionsDir(): string {
  const override = process.env['ZS_DATA_DIR']
  if (override) return join(override, 'sessions')
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(base, 'zerostack', 'sessions')
}

function firstUserMessage(messages: ZerostackMessage[]): string {
  const msg = messages.find(m => m.role === 'user')
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  return (msg.content ?? []).map(c => c.text ?? '').filter(Boolean).join(' ')
}

async function readSession(path: string): Promise<ZerostackSession | null> {
  const content = await readSessionFile(path)
  if (content === null) return null
  try {
    return JSON.parse(content) as ZerostackSession
  } catch {
    return null
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const session = await readSession(source.path)
      if (!session) return

      const input = session.total_input_tokens ?? 0
      const output = session.total_output_tokens ?? 0
      if (input === 0 && output === 0) return

      const timestamp = session.updated_at ?? session.created_at ?? ''
      const sessionId = session.id ?? basename(source.path, '.json')
      const dedupKey = `${source.provider}:${source.path}:${timestamp}:${sessionId}`
      if (seenKeys.has(dedupKey)) return
      seenKeys.add(dedupKey)

      const model = session.model ?? ''

      yield {
        provider: source.provider,
        model,
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: calculateCost(model, input, output, 0, 0, 0),
        // zerostack persists only final assistant text, not tool-call records,
        // so there is nothing to extract here.
        tools: [],
        bashCommands: [],
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: firstUserMessage(session.messages ?? []),
        sessionId,
        project: source.project,
        projectPath: session.working_dir,
      }
    },
  }
}

export function createZerostackProvider(sessionsDir?: string): Provider {
  const dir = sessionsDir ?? defaultSessionsDir()

  return {
    name: 'zerostack',
    displayName: 'Zerostack',

    modelDisplayName(model: string): string {
      // OpenRouter routes arrive prefixed (e.g. "deepseek/deepseek-v4-pro").
      return getShortModelName(model.replace(/^[^/]+\//, ''))
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        return []
      }

      const sources: SessionSource[] = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const path = join(dir, file)
        const session = await readSession(path)
        if (!session) continue
        const project = session.working_dir ? basename(session.working_dir) : basename(file, '.json')
        sources.push({ path, project, provider: 'zerostack' })
      }
      return sources
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const zerostack = createZerostackProvider()
