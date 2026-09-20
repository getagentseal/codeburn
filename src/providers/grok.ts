import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { FS_SCAN_CONCURRENCY, mapWithConcurrency, readSessionFile } from '../fs-utils.js'
import { calculateCost, getModelCosts, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import type { DedupSet } from '../session-cache.js'

// Grok Build (xAI's coding CLI) stores one session per directory at
// <grok-home>/sessions/<url-encoded-cwd>/<uuid>/, where grok-home is $GROK_HOME
// or ~/.grok. Each session dir holds summary.json, signals.json, and the ACP
// log updates.jsonl.
//
// Newer Grok CLI versions append a `turn_completed` update with provider-recorded
// input/output/cache/reasoning usage. That record is authoritative: cached reads
// are part of input, and reasoning is a subset of output. Cache creation is
// treated as another input subset by analogy because the record exposes no
// separate fresh-input field; any per-record violation is clamped before pricing.
// Older sessions only carry
// `signals.json.contextTokensUsed` and the running `_meta.totalTokens` curve; for
// those we retain the old compaction-aware estimate and mark its cost estimated.
// `costUsdTicks` is deliberately ignored because its scale is not documented.

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

// updates.jsonl is one ACP JSON-RPC notification per line. Streamed chunks carry
// params._meta.{totalTokens, promptId}; completed turns carry snake_case
// params.update.{prompt_id, usage}.
type GrokUpdate = {
  params?: {
    _meta?: { totalTokens?: unknown; promptId?: unknown }
    update?: {
      sessionUpdate?: unknown
      prompt_id?: unknown
      usage?: unknown
      title?: unknown
      rawInput?: { command?: unknown; subagent_type?: unknown }
    }
  }
}

type GrokUsageValues = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
}

type GrokAuthoritativeUsage = GrokUsageValues & {
  modelUsage: Map<string, GrokUsageValues>
}

type GrokTokenTotals = {
  input: number
  cacheRead: number
  output: number
  cacheCreation: number
  reasoning: number
}

function emptyTokenTotals(): GrokTokenTotals {
  return { input: 0, cacheRead: 0, output: 0, cacheCreation: 0, reasoning: 0 }
}

const authoritativeTokenFields = [
  'inputTokens',
  'outputTokens',
  'cachedReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// JSONL is third-party input. Keep the check local to this provider so bad
// usage fields become absent rather than leaking NaN, negative tokens, or a
// throwing arithmetic operation into the session aggregate.
function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  // Token counts this large are not meaningful in a session and can overflow
  // when summed or priced. Capping preserves the non-negative finite invariant.
  return Math.min(value, Number.MAX_SAFE_INTEGER)
}

function addTokenCounts(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function readUsageNumber(usage: Record<string, unknown>, field: string): number | undefined {
  return finiteNonNegative(usage[field])
}

function readModelUsage(usage: Record<string, unknown>): Map<string, GrokUsageValues> {
  const modelUsage = usage['modelUsage']
  const result = new Map<string, GrokUsageValues>()
  if (!isRecord(modelUsage)) return result

  for (const [modelId, rawModelUsage] of Object.entries(modelUsage)) {
    if (!modelId || !isRecord(rawModelUsage)) continue
    const values = authoritativeTokenFields.map((field) => finiteNonNegative(rawModelUsage[field]))
    if (!values.some((value) => value !== undefined)) continue
    result.set(modelId, {
      inputTokens: values[0] ?? 0,
      outputTokens: values[1] ?? 0,
      cacheReadTokens: values[2] ?? 0,
      cacheCreationTokens: values[3] ?? 0,
      reasoningTokens: values[4] ?? 0,
    })
  }
  return result
}

function parseAuthoritativeUsage(raw: unknown): GrokAuthoritativeUsage | null {
  if (!isRecord(raw)) return null

  const values = authoritativeTokenFields.map((field) => readUsageNumber(raw, field))
  const modelUsage = readModelUsage(raw)
  return {
    inputTokens: values[0] ?? 0,
    outputTokens: values[1] ?? 0,
    cacheReadTokens: values[2] ?? 0,
    cacheCreationTokens: values[3] ?? 0,
    reasoningTokens: values[4] ?? 0,
    modelUsage,
  }
}

function chooseAuthoritativeModel(modelIds: string[], existingModel: string): string {
  // modelUsage is the best attribution signal, but it may contain a newer
  // provider id that this checkout cannot price yet (for example
  // `grok-4.6-build`). Prefer an actual model id when it prices; otherwise keep
  // the existing summary/signals id when that one prices, avoiding a truthful
  // but $0 row. If neither prices, retain the actual model id for attribution.
  const pricedActualModel = modelIds.find((modelId) => getModelCosts(modelId) !== null)
  if (pricedActualModel) return pricedActualModel
  if (getModelCosts(existingModel) !== null) return existingModel
  return modelIds[0] ?? existingModel
}

// Single pass over updates.jsonl: retain the old per-turn totalTokens estimate,
// the deduplicated authoritative turn records, and the real tool calls.
function parseUpdates(updates: string): {
  usage: GrokTokenTotals
  modelIds: string[]
  authoritative: boolean
  hasUncompletedTurn: boolean
  tools: string[]
  bashCommands: string[]
  subagentTypes: string[]
} {
  const turns = new Map<string, { first: number; last: number }>()
  const completedUsages = new Map<string, GrokAuthoritativeUsage>()
  const tools: string[] = []
  const bashCommands: string[] = []
  const subagentTypes: string[] = []
  // Compaction-aware fresh input: a large drop in totalTokens means the context
  // was compacted and rebuilt, so we sum each segment's peak rather than the
  // single global peak (which would lose everything before the last compaction).
  let prevTotal = -1
  let segmentPeak = 0
  let inputFresh = 0
  let completedWithoutPromptId = 0

  for (const line of updates.split('\n')) {
    if (!line.trim()) continue
    let params: GrokUpdate['params']
    try {
      params = (JSON.parse(line) as GrokUpdate).params
    } catch {
      continue
    }
    if (!params) continue

    const total = finiteNonNegative(params._meta?.totalTokens)
    if (total !== undefined) {
      if (prevTotal >= 0 && total < prevTotal * 0.5) {
        inputFresh = addTokenCounts(inputFresh, segmentPeak) // close the segment a compaction just ended
        segmentPeak = 0
      }
      if (total > segmentPeak) segmentPeak = total
      prevTotal = total

      const promptId = typeof params._meta?.promptId === 'string' ? params._meta.promptId : undefined
      if (promptId) {
        const turn = turns.get(promptId)
        if (!turn) turns.set(promptId, { first: total, last: total })
        else turn.last = total
      }
    }

    const update = params.update
    if (update?.sessionUpdate === 'turn_completed') {
      const usage = parseAuthoritativeUsage(update.usage)
      if (usage) {
        const promptId = typeof update.prompt_id === 'string' && update.prompt_id.length > 0
          ? update.prompt_id
          : `turn_completed:${completedWithoutPromptId++}`
        // Re-emitted turn_completed notifications are cumulative updates for
        // the same turn. Last write wins so they cannot double count.
        completedUsages.set(promptId, usage)
      }
    }

    if (update?.sessionUpdate === 'tool_call' && typeof update.title === 'string') {
      tools.push(toolNameMap[update.title] ?? update.title)
      if (update.title === 'run_terminal_command' && typeof update.rawInput?.command === 'string') {
        bashCommands.push(...extractBashCommands(update.rawInput.command))
      }
      if (update.title === 'spawn_subagent' && typeof update.rawInput?.subagent_type === 'string') {
        subagentTypes.push(update.rawInput.subagent_type)
      }
    }
  }

  inputFresh = addTokenCounts(inputFresh, segmentPeak) // close the final segment
  let sumFirst = 0
  let output = 0
  for (const { first, last } of turns.values()) {
    sumFirst = addTokenCounts(sumFirst, first)
    output = addTokenCounts(output, Math.max(0, last - first))
  }
  // Fresh input (summed segment peaks) is billed once; the rest of the per-turn
  // re-sends are cache reads (Grok caches them, even though it reports nothing).
  const estimated = {
    input: inputFresh,
    cacheRead: Math.max(0, sumFirst - inputFresh),
    output,
  }

  const usageTotals = emptyTokenTotals()
  const modelIds: string[] = []
  const seenModelIds = new Set<string>()
  for (const usage of completedUsages.values()) {
    addUsageToTotals(usageTotals, usage)
    for (const modelId of usage.modelUsage.keys()) {
      if (seenModelIds.has(modelId)) continue
      seenModelIds.add(modelId)
      modelIds.push(modelId)
    }
  }

  // Decide from the final, prompt-deduplicated records. A positive modelUsage
  // entry is attribution metadata only; it is not a substitute for the
  // top-level accounting fields. This also prevents a superseded positive
  // record from suppressing the streaming fallback.
  const hasPositiveCompletedUsage = [...completedUsages.values()].some(hasPositiveTopLevelUsage)
  if (!hasPositiveCompletedUsage || !hasPositiveTotals(usageTotals)) {
    // Older Grok CLI versions have no completed usage record. Keep the
    // heuristic only here; blending it into a real record would reintroduce the
    // large over-count this parser is fixing. A record that only has modelUsage,
    // or whose final deduplicated values are empty, is treated the same way.
    return {
      usage: { input: estimated.input, cacheRead: estimated.cacheRead, output: estimated.output, cacheCreation: 0, reasoning: 0 },
      modelIds: [],
      authoritative: false,
      hasUncompletedTurn: false,
      tools,
      bashCommands,
      subagentTypes,
    }
  }

  const hasUncompletedTurn = [...turns.keys()].some(promptId => !completedUsages.has(promptId))

  // calculateCost follows the cache-exclusive input convention used by the
  // other real-usage providers. Each record is decomposed before its totals
  // are added, so an inconsistent record cannot consume another record's fresh
  // input budget.
  return {
    usage: usageTotals,
    modelIds,
    authoritative: true,
    hasUncompletedTurn,
    tools,
    bashCommands,
    subagentTypes,
  }
}

function hasPositiveTopLevelUsage(usage: GrokAuthoritativeUsage): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.cacheReadTokens > 0
    || usage.cacheCreationTokens > 0
    || usage.reasoningTokens > 0
}

function addUsageToTotals(totals: GrokTokenTotals, usage: GrokUsageValues): void {
  // `cacheCreationTokens` is treated as an input subset by analogy. Clamp the
  // exclusive portion per record before summing the session. Reasoning is
  // reported inside outputTokens by Grok, so clamp it to that same record's
  // output before the session totals are accumulated.
  const reasoningTokens = Math.min(usage.reasoningTokens, usage.outputTokens)
  totals.input = addTokenCounts(
    totals.input,
    Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens),
  )
  totals.cacheRead = addTokenCounts(totals.cacheRead, usage.cacheReadTokens)
  totals.output = addTokenCounts(totals.output, usage.outputTokens)
  totals.cacheCreation = addTokenCounts(totals.cacheCreation, usage.cacheCreationTokens)
  totals.reasoning = addTokenCounts(totals.reasoning, reasoningTokens)
}

function hasPositiveTotals(totals: GrokTokenTotals): boolean {
  return totals.input > 0
    || totals.cacheRead > 0
    || totals.output > 0
    || totals.cacheCreation > 0
    || totals.reasoning > 0
}

function createParser(source: SessionSource, seenKeys: DedupSet): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const dir = dirname(source.path)
      const summary = await readJson<GrokSummary>(join(dir, 'summary.json'))
      const updates = await readSessionFile(source.path)
      if (!summary || updates === null) return

      const signals = await readJson<GrokSignals>(join(dir, 'signals.json'))
      const existingModel =
        summary.current_model_id ?? signals?.primaryModelId ?? signals?.modelsUsed?.[0] ?? 'grok-build'
      const parsed = parseUpdates(updates)
      if (!hasPositiveTotals(parsed.usage)) return

      const timestamp = summary.updated_at ?? summary.last_active_at ?? summary.created_at ?? ''
      const sessionId = summary.info?.id ?? basename(dir)

      // Multi-model attribution is deliberately out of scope: modelUsage may
      // help choose a priced attribution id, but top-level totals remain the
      // accounting source and one session uses one model's rate.
      const model = parsed.authoritative ? chooseAuthoritativeModel(parsed.modelIds, existingModel) : existingModel

      const baseDedupKey = `${source.provider}:${dir}:${timestamp}:${sessionId}`
      if (seenKeys.has(baseDedupKey)) return
      seenKeys.add(baseDedupKey)

      // `addUsageToTotals` clamps reasoning per authoritative record before
      // summing, so the aggregate preserves this identity as well.
      const reasoningTokens = parsed.usage.reasoning
      yield {
        provider: source.provider,
        model,
        inputTokens: parsed.usage.input,
        // Grok reports reasoning INSIDE outputTokens, but the repo contract is
        // the opposite: ParsedProviderCall.reasoningTokens is exclusive of
        // outputTokens. Downstream consumers reconstitute the billable total
        // through billableOutputTokens() (models.ts): it adds reasoning back on
        // top for grok and every other provider, except the
        // REASONING_INCLUDED_IN_OUTPUT set (claude, codex) whose reasoning is
        // already inside output_tokens and must not be added again.
        // tests/providers/kiro.test.ts states the exclusive contract outright.
        // So split it here rather than special-casing grok in every downstream
        // site: subtracting reasoning makes `output + reasoning` reconstruct
        // exactly the number Grok reported.
        outputTokens: parsed.usage.output - reasoningTokens,
        cacheCreationInputTokens: parsed.usage.cacheCreation,
        cacheReadInputTokens: parsed.usage.cacheRead,
        cachedInputTokens: parsed.usage.cacheRead,
        reasoningTokens,
        webSearchRequests: 0,
        // Authoritative token counts are measured even though CodeBurn applies
        // its own pricing table; only the legacy context-curve path is an
        // estimate. The full provider output is priced once here, which is
        // what the downstream `output + reasoning` recompute reproduces.
        costUSD: calculateCost(
          model,
          parsed.usage.input,
          parsed.usage.output,
          parsed.usage.cacheCreation,
          parsed.usage.cacheRead,
          0,
        ),
        costIsEstimated: !parsed.authoritative || parsed.hasUncompletedTurn,
        tools: parsed.tools,
        bashCommands: parsed.bashCommands,
        subagentTypes: parsed.subagentTypes,
        timestamp,
        speed: 'standard',
        deduplicationKey: baseDedupKey,
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

  // Fanned out per level (the tree is one summary.json read per session); the
  // per-level results are re-concatenated in readdir order so the emitted
  // source order matches the serial walk exactly.
  const cwds = (await mapWithConcurrency(cwdDirs, FS_SCAN_CONCURRENCY, async cwdName => {
    const cwdPath = join(sessionsDir, cwdName)
    const cwdStat = await stat(cwdPath).catch(() => null)
    if (!cwdStat?.isDirectory()) return []
    const sessionDirs = await readdir(cwdPath).catch(() => null)
    if (!sessionDirs) return []
    return sessionDirs.map(sessionName => ({ cwdName, sessionPath: join(cwdPath, sessionName) }))
  })).flat()

  const sessions = await mapWithConcurrency(cwds, FS_SCAN_CONCURRENCY, async ({ cwdName, sessionPath }) => {
    const sessionStat = await stat(sessionPath).catch(() => null)
    if (!sessionStat?.isDirectory()) return null
    const summary = await readJson<GrokSummary>(join(sessionPath, 'summary.json'))
    if (!summary) return null
    const cwd = summary.info?.cwd ?? safeDecode(cwdName)
    return { path: join(sessionPath, 'updates.jsonl'), project: basename(cwd), provider: 'grok' } as SessionSource
  })

  for (const source of sessions) if (source) sources.push(source)

  return sources
}

export function createGrokProvider(sessionsDir?: string): Provider {
  const dir = sessionsDir ?? defaultSessionsDir()

  return {
    name: 'grok',
    displayName: 'Grok Build',

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: dir, label: 'sessions' }]
    },

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

    createSessionParser(source: SessionSource, seenKeys: DedupSet): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const grok = createGrokProvider()
