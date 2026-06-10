import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// Display name overrides for tools that are common across providers but are
// surfaced under Hermes' own naming scheme. Unknown names are passed through
// unchanged so newly-added Hermes tools (e.g. fact_store, fact_feedback) still
// show up in the dashboard.
const toolNameMap: Record<string, string> = {
  terminal: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  patch: 'Edit',
  search_files: 'Grep',
  browser_navigate: 'WebFetch',
  browser_click: 'WebFetch',
  browser_snapshot: 'WebFetch',
  browser_type: 'WebFetch',
  browser_press: 'WebFetch',
  browser_back: 'WebFetch',
  browser_scroll: 'WebFetch',
  browser_vision: 'WebFetch',
  browser_console: 'WebFetch',
  browser_get_images: 'WebFetch',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
  vision_analyze: 'Read',
  image_generate: 'Read',
  text_to_speech: 'Read',
  skill_view: 'Read',
  skills_list: 'Read',
  skill_manage: 'Bash',
  todo: 'TodoWrite',
  memory: 'Bash',
  fact_store: 'Bash',
  fact_feedback: 'Bash',
  session_search: 'Grep',
  process: 'Bash',
  cronjob: 'Bash',
  delegate_task: 'Agent',
  execute_code: 'Bash',
  clarify: 'AskUserQuestion',
  send_message: 'Agent',
}

type HermesToolCall = {
  id?: string
  call_id?: string
  type?: string
  function?: {
    name?: string
    // Hermes stores arguments as a JSON-encoded string. The assistant may
    // also encrypt reasoning payloads in adjacent fields (e.g.
    // `codex_reasoning_items[*].encrypted_content`) but the tool-call
    // argument blob itself is plaintext in every session we sampled.
    arguments?: string
  }
}

type HermesMessage = {
  role?: string
  content?: string
  reasoning?: string
  finish_reason?: string
  name?: string
  tool_calls?: HermesToolCall[]
}

type HermesSession = {
  session_id?: string
  model?: string
  base_url?: string
  platform?: string
  session_start?: string
  last_updated?: string
  system_prompt?: string
  tools?: Array<{ type?: string; function?: { name?: string } }>
  message_count?: number
  messages?: HermesMessage[]
}

// Hermes writes three kinds of file into `~/.hermes/sessions/`:
//   - session_*.json          — the conversation transcript (what we parse)
//   - request_dump_*.json     — captured failed HTTP requests, no usage data
//   - session_bg_*.json       — background-task sessions, same schema as session_*
// We only consume the conversation files; the dumps exist for debugging and
// hold no token counts.
function getHermesDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.hermes', 'sessions'),
  ]
}

function mapToolName(raw: string | undefined): string {
  if (!raw) return 'Unknown'
  return toolNameMap[raw] ?? raw
}

function safeParseArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function extractTools(messages: HermesMessage[]): { tools: string[]; bashCommands: string[] } {
  const tools: string[] = []
  const bashCommands: string[] = []
  for (const m of messages) {
    if (!m || m.role !== 'assistant') continue
    for (const tc of m.tool_calls ?? []) {
      const rawName = tc.function?.name
      if (!rawName) continue
      const display = mapToolName(rawName)
      tools.push(display)
      if (display === 'Bash') {
        const args = safeParseArgs(tc.function?.arguments)
        const cmd = args['command']
        if (typeof cmd === 'string') {
          bashCommands.push(...extractBashCommands(cmd))
        }
      }
    }
  }
  return { tools, bashCommands }
}

function isValidTimestamp(value: string | undefined): value is string {
  if (!value) return false
  const ts = new Date(value).getTime()
  // Reject epoch-zero / NaN. Sessions written before 2001 (ts < 1e12 ms) are
  // suspicious enough to skip — the dashboard would place them in 1970.
  return !Number.isNaN(ts) && ts > 1_000_000_000_000
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const raw = await readSessionFile(source.path)
      if (raw === null) return

      let session: HermesSession
      try {
        session = JSON.parse(raw) as HermesSession
      } catch {
        return
      }

      const sessionId = session.session_id ?? basename(source.path, '.json')
      const model = session.model ?? 'hermes-unknown'
      const messages = Array.isArray(session.messages) ? session.messages : []
      if (messages.length === 0) return

      // Hermes doesn't persist per-turn usage locally — the request payload is
      // forwarded to the upstream provider (OpenAI / Anthropic / OpenRouter /
      // Ollama) and usage is only visible in that provider's logs. We still
      // emit one ParsedProviderCall per assistant turn so the dashboard shows
      // real turn counts, model identity, tool-call frequency, and session
      // duration. Token counts are zero; costUSD is zero (we attempt
      // calculateCost for models that have a price entry, e.g. gpt-5.5).
      const { tools: sessionTools, bashCommands: sessionBash } = extractTools(messages)

      // Find the timestamp of the *last* assistant message so the row is
      // placed at the end of the session in time-series views.
      let lastAssistantTs: string | undefined
      for (const m of messages) {
        // Hermes doesn't stamp each message with a timestamp; fall back to
        // session_start / last_updated at the session level.
        if (m.role === 'assistant' && isValidTimestamp(session.last_updated)) {
          lastAssistantTs = session.last_updated
        }
      }
      const fallbackTs = isValidTimestamp(session.session_start) ? session.session_start : new Date().toISOString()

      const dedupKey = `hermes:${sessionId}`
      if (seenKeys.has(dedupKey)) return
      seenKeys.add(dedupKey)

      // Aggregate the per-turn tools back into a single "call" record. This
      // isn't quite the same granularity as providers that emit one row per
      // LLM response, but it's the most honest translation: the data we have
      // is session-level, so we surface it session-level.
      const inputTokens = 0
      const outputTokens = 0
      const cacheRead = 0
      const cacheWrite = 0
      const costUSD = calculateCost(model, inputTokens, outputTokens, cacheWrite, cacheRead, 0)

      yield {
        provider: 'hermes',
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cacheWrite,
        cacheReadInputTokens: cacheRead,
        cachedInputTokens: cacheRead,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD,
        // Mark the cost as estimated when we have a model the pricing table
        // doesn't recognise — calculateCost returns 0 either way, but the
        // flag tells the dashboard to render the value with an asterisk.
        costIsEstimated: costUSD === 0,
        tools: [...new Set(sessionTools)],
        bashCommands: [...new Set(sessionBash)],
        timestamp: lastAssistantTs ?? fallbackTs,
        speed: 'standard',
        deduplicationKey: dedupKey,
        // First user message is the most useful identifier for the dashboard.
        userMessage: pickUserPrompt(messages),
        sessionId,
        project: source.project,
        projectPath: source.path,
      }
    },
  }
}

function pickUserPrompt(messages: HermesMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.slice(0, 500)
    }
  }
  return ''
}

async function discoverInDir(sessionsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let files: string[]
  try {
    files = await readdir(sessionsDir)
  } catch {
    return sources
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    if (f.startsWith('session_bg_')) {
      // Background sessions share the same schema — keep them but tag the
      // project so the dashboard can split them out.
      sources.push({
        path: join(sessionsDir, f),
        project: 'hermes-background',
        provider: 'hermes',
      })
    } else if (f.startsWith('session_')) {
      sources.push({
        path: join(sessionsDir, f),
        project: 'hermes',
        provider: 'hermes',
      })
    }
    // request_dump_*.json is intentionally skipped — those files contain
    // captured failed HTTP requests, not conversation transcripts, and have
    // no usage data.
  }
  return sources
}

export function createHermesProvider(overrideDir?: string): Provider {
  return {
    name: 'hermes',
    displayName: 'Hermes Agent',

    modelDisplayName(model: string): string {
      return model
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (overrideDir) return discoverInDir(overrideDir)
      const all: SessionSource[] = []
      for (const dir of getHermesDirs()) {
        const sessions = await discoverInDir(dir)
        all.push(...sessions)
      }
      return all
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const hermes = createHermesProvider()
