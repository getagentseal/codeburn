// Bahulam Code — open-source coding agent.
// Each session is a JSONL transcript under a project directory:
//
//   ~/.bahulam/projects/<project-slug>/<session-id>.jsonl
//
// The wire format uses `bahulam_event` / `kepler_event` as the top-level type;
// per-turn usage and cost live in `event.data.usage`.  Every record carries
// `type`, `timestamp`, and `cwd` at the top level.

import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const PROVIDER_NAME = 'bahulam'
const DISPLAY_NAME = 'Bahulam Code'

// Default root. Honor the same env var opentab uses.
function getRootDir(override?: string): string {
  const env = process.env['BAHULAM_PROJECTS_DIR']
  return override ?? env ?? join(homedir(), '.bahulam', 'projects')
}

// ── helpers ────────────────────────────────────────────────────────────────

function safeNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function firstValue(...values: unknown[]): number {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return safeNum(v)
  }
  return 0
}

function qualifiedModel(modelName: string): string {
  if (!modelName) return ''
  if (modelName.includes('/')) return modelName
  // Estimate a prefix family from common Bahulam model names
  if (/^(gpt|o\d)/i.test(modelName)) return `openai/${modelName}`
  if (/^claude/i.test(modelName)) return `anthropic/${modelName}`
  if (/^gemini/i.test(modelName)) return `google/${modelName}`
  if (/^deepseek/i.test(modelName)) return `deepseek/${modelName}`
  return modelName
}

// ── session file discovery ─────────────────────────────────────────────────

async function discoverSessionFiles(rootDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let projectDirs: string[]
  try {
    projectDirs = await readdir(rootDir)
  } catch {
    return sources
  }

  for (const dirName of projectDirs) {
    const dirPath = join(rootDir, dirName)
    const dirStat = await stat(dirPath).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    let entries: string[]
    try {
      entries = await readdir(dirPath)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      sources.push({
        path: join(dirPath, entry),
        project: dirName,
        provider: PROVIDER_NAME,
      })
    }
  }

  return sources
}

// ── JSONL parser ───────────────────────────────────────────────────────────

interface BahulamEntry {
  type?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: string | Array<{ type?: string; text?: string }>
  }
  event?: {
    type?: string
    data?: Record<string, unknown>
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (content === null) return

      const lines = content.split('\n').filter(l => l.trim())
      const sessionId = basename(source.path, '.jsonl')
      let pendingUserMessage = ''
      let pendingUserTs = ''
      let resolvedModel = ''
      let sessionTs = ''

      for (const [lineIdx, line] of lines.entries()) {
        let entry: BahulamEntry
        try {
          entry = JSON.parse(line) as BahulamEntry
        } catch {
          continue
        }
        if (!entry || typeof entry !== 'object') continue

        const ts = entry.timestamp ?? ''
        if (ts && !sessionTs) sessionTs = ts

        // ── user messages ──────────────────────────────────────────────────
        if (entry.type === 'user') {
          const msg = entry.message
          if (msg && typeof msg === 'object') {
            let text = ''
            if (typeof msg.content === 'string') {
              text = msg.content.trim()
            } else if (Array.isArray(msg.content)) {
              const parts = msg.content
                .filter(b => b?.type === 'text' && b.text)
                .map(b => b.text!.trim())
              text = parts.join(' ')
            }
            if (text) {
              pendingUserMessage = text
              pendingUserTs = ts
            }
          }
          continue
        }

        // ── bahulam_event / kepler_event ───────────────────────────────────
        if (entry.type !== 'bahulam_event' && entry.type !== 'kepler_event') continue

        const event = entry.event
        if (!event || typeof event !== 'object') continue

        const eventType = event.type
        const data = event.data
        if (!data || typeof data !== 'object') continue

        // session_info — extract model map
        if (eventType === 'session_info') {
          const models = data['models']
          if (models && typeof models === 'object' && !Array.isArray(models)) {
            for (const key of ['coder', 'main', 'executor', 'orchestrator', 'planning']) {
              const m = (models as Record<string, unknown>)[key]
              if (typeof m === 'string' && m) {
                resolvedModel = qualifiedModel(m)
                break
              }
            }
          }
          continue
        }

        // complete — carries per-turn token usage and cost
        if (eventType === 'complete') {
          const usage = data['usage']
          if (!usage || typeof usage !== 'object') continue

          const u = usage as Record<string, unknown>

          const totalIn = safeNum(u['total_input_tokens'])
          const out = safeNum(u['total_output_tokens'])
          const cr = safeNum(u['cache_read_input_tokens'])
          const cw = safeNum(u['cache_creation_input_tokens'])
          const reasoning = safeNum(u['reasoning_tokens'])
          const inp = Math.max(0, totalIn - cr - cw)

          // Extract 1h cache write from the sub-object
          const cc = u['cache_creation']
          const cw1h = cc && typeof cc === 'object'
            ? safeNum((cc as Record<string, unknown>)['ephemeral_1h_input_tokens'])
            : 0

          const costUSD = firstValue(
            u['total_cost'], u['total_cost_usd'],
            u['cost'], u['cost_usd'],
          )

          // Per-model breakdown
          const modelsUsage = u['models']
          let model = ''
          if (Array.isArray(modelsUsage) && modelsUsage.length > 0) {
            const first = modelsUsage[0]
            if (first && typeof first === 'object') {
              model = qualifiedModel(String((first as Record<string, unknown>)['model'] ?? ''))
            }
          }
          if (!model) {
            model = qualifiedModel(String(data['model'] ?? u['model'] ?? resolvedModel ?? ''))
          }
          if (!model) model = resolvedModel || 'gpt-5'

          const responseId = String(u['response_id'] ?? u['id'] ?? '')
          const dedupKey = `${PROVIDER_NAME}:${source.path}:${responseId || entry.timestamp || String(lineIdx)}`

          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const timestamp = ts || pendingUserTs || sessionTs
          if (!timestamp) continue

          // Cost: Bahulam records true cost; trust it when present
          const finalCost = costUSD !== 0
            ? costUSD
            : calculateCost(model, inp, out, cw, cr, 0, 'standard', cw1h)

          yield {
            provider: PROVIDER_NAME,
            model,
            inputTokens: inp,
            outputTokens: out,
            cacheCreationInputTokens: cw,
            cacheReadInputTokens: cr,
            cachedInputTokens: cr,
            reasoningTokens: reasoning,
            webSearchRequests: 0,
            costUSD: finalCost,
            tools: [],
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: pendingUserMessage,
            sessionId,
          }

          pendingUserMessage = ''
          continue
        }

        // tool_call / tool_request — ignored (tools consumed in UI)
        // We don't accumulate them for ParsedProviderCall; the Pi provider
        // also skips tool-only events.
      }
    },
  }
}

// ── Provider object ────────────────────────────────────────────────────────

export function createBahulamProvider(rootDir?: string): Provider {
  const dir = getRootDir(rootDir)

  return {
    name: PROVIDER_NAME,
    displayName: DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: dir, label: 'projects' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionFiles(dir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const bahulam = createBahulamProvider()