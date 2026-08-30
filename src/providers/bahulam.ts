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

function isReportedCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function reportedCost(...values: unknown[]): { cost: number; reported: boolean } {
  for (const value of values) {
    if (isReportedCost(value)) return { cost: value, reported: true }
  }
  return { cost: 0, reported: false }
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

const toolNameMap: Record<string, string> = {
  shell: 'Bash',
  read_file: 'Read',
  read_files: 'Read',
  list_files: 'Read',
  get_project_overview: 'Read',
  analyze_code: 'Read',
  search_code: 'Grep',
  search_files: 'Glob',
  edit_file: 'Edit',
  write_file: 'Write',
  write_project: 'Write',
  run_tests: 'Bash',
  lint_check: 'Bash',
  validate_file: 'Bash',
  validate_structure: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  plan: 'EnterPlanMode',
  explore: 'Read',
  debug: 'Read',
  verify: 'Bash',
  refactor: 'Edit',
  delegate: 'Agent',
}

function mapToolName(rawTool: string): string {
  return toolNameMap[rawTool] ?? rawTool
}

function extractUsefulBashCommands(command: string): string[] {
  const normalized = command
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .join('\n')
  return extractBashCommands(normalized).filter(cmd => cmd !== '#' && cmd !== '\\')
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
      let sessionCwd = ''
      let pendingTools: string[] = []
      let pendingBashCommands: string[] = []

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
        if (entry.cwd && !sessionCwd) sessionCwd = entry.cwd

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

        // tool_call / tool_request — accumulate tools and bash commands
        if (eventType === 'tool_call' || eventType === 'tool_request') {
          const toolName = String(data['tool_name'] ?? data['tool'] ?? data['name'] ?? '')
          const mappedTool = toolName ? mapToolName(toolName) : ''
          if (mappedTool) pendingTools.push(mappedTool)
          const args = data['arguments'] ?? data['args'] ?? data['input'] ?? {}
          const commandArg = typeof args === 'object' && args !== null
            ? (args as Record<string, unknown>)['command']
            : undefined
          if (mappedTool === 'Bash' && typeof commandArg === 'string') {
            for (const cmd of extractUsefulBashCommands(commandArg)) {
              pendingBashCommands.push(cmd)
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

          const costField = reportedCost(
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
          if (!model) model = resolvedModel

          const responseId = String(u['response_id'] ?? u['id'] ?? '')
          const turnKey = responseId || `${entry.timestamp || 'line'}:${lineIdx}`
          const cwd = sessionCwd || undefined

          // ── yield block using captured locals ──────────────────────────
          const emitCall = (overrides?: Partial<ParsedProviderCall>): ParsedProviderCall | null => {
            const timestamp = ts || pendingUserTs || sessionTs
            if (!timestamp) return null
            const dedupKey = overrides?.deduplicationKey
              ?? `${PROVIDER_NAME}:${source.path}:${turnKey}`
            if (seenKeys.has(dedupKey)) return null
            seenKeys.add(dedupKey)
            return {
              provider: PROVIDER_NAME,
              model: overrides?.model ?? model,
              inputTokens: overrides?.inputTokens ?? inp,
              outputTokens: overrides?.outputTokens ?? out,
              cacheCreationInputTokens: overrides?.cacheCreationInputTokens ?? cw,
              cacheReadInputTokens: overrides?.cacheReadInputTokens ?? cr,
              cachedInputTokens: overrides?.cacheReadInputTokens ?? cr,
              reasoningTokens: overrides?.reasoningTokens ?? reasoning,
              webSearchRequests: 0,
              costUSD: overrides?.costUSD ?? (costField.reported ? costField.cost : calculateCost(model, inp, out, cw, cr, 0, 'standard', cw1h)),
              costIsEstimated: overrides?.costIsEstimated ?? !costField.reported,
              tools: [...pendingTools],
              bashCommands: [...pendingBashCommands],
              timestamp,
              speed: 'standard',
              deduplicationKey: dedupKey,
              userMessage: pendingUserMessage,
              sessionId,
              turnId: `${sessionId}:${turnKey}`,
              project: source.project,
              projectPath: cwd,
              workingDirectory: cwd,
              ...overrides,
            }
          }

          // ── Multi-model: emit one call per model entry ─────────────────
          if (Array.isArray(modelsUsage) && modelsUsage.length > 1) {
            for (const [modelIdx, mEntry] of modelsUsage.entries()) {
              if (!mEntry || typeof mEntry !== 'object') continue
              const me = mEntry as Record<string, unknown>
              const mModel = qualifiedModel(String(me['model'] ?? ''))
              if (!mModel) continue

              const mTotalIn = firstValue(me['total_input_tokens'], me['input_tokens'], me['prompt_tokens'])
              const mCr = firstValue(me['cache_read_input_tokens'], me['cache_read_tokens'], me['cached_input_tokens'])
              const mCw = firstValue(me['cache_creation_input_tokens'], me['cache_creation_tokens'], me['cache_write_tokens'])
              const mInp = Math.max(0, mTotalIn - mCr - mCw)
              const mOut = firstValue(me['total_output_tokens'], me['output_tokens'], me['completion_tokens'])
              const mReasoning = firstValue(me['reasoning_tokens'], me['thinking_tokens'])
              const mCostField = reportedCost(me['cost'], me['cost_usd'], me['total_cost'], me['total_cost_usd'])
              const mCost = mCostField.reported
                ? mCostField.cost
                : calculateCost(mModel, mInp, mOut, mCw, mCr, 0, 'standard', 0)

              const call = emitCall({
                model: mModel,
                inputTokens: mInp,
                outputTokens: mOut,
                cacheCreationInputTokens: mCw,
                cacheReadInputTokens: mCr,
                reasoningTokens: mReasoning,
                costUSD: mCost,
                costIsEstimated: !mCostField.reported,
                deduplicationKey: `${PROVIDER_NAME}:${source.path}:${turnKey}:model:${modelIdx}:${mModel}`,
              })
              if (call) yield call
            }
          } else {
            // Single model or aggregate: emit one call
            const call = emitCall()
            if (call) yield call
          }

          pendingUserMessage = ''
          pendingTools = []
          pendingBashCommands = []
          continue
        }
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
