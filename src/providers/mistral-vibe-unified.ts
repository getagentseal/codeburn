import { readdir } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { readSessionFile, readSessionLines } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { ParsedProviderCall } from './types.js'

type ObjectValue = Record<string, unknown>
type Usage = { input: number; output: number; cached: number }
type UsagePoint = { sequence: number; state: ObjectValue; usage: Usage }

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

async function json(path: string): Promise<ObjectValue | null> {
  const raw = await readSessionFile(path)
  if (raw === null) return null
  try { return object(JSON.parse(raw)) } catch { return null }
}

function usagePoint(sequence: number, stateValue: unknown): UsagePoint | null {
  const state = object(stateValue)
  const usage = object(object(state.session).tokenUsage)
  if (!Object.keys(usage).length) return null
  const input = count(usage.inputTokens)
  return { sequence, state, usage: {
    input, output: count(usage.outputTokens), cached: Math.min(input, count(usage.cachedInputTokens)),
  } }
}

function content(value: unknown): string {
  return typeof value === 'string' ? value : array(value).map(part => text(object(part).text)).join(' ')
}

function timestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

/**
 * Vibe 2.25's journal is a recovery log, not an append-only usage ledger.
 * CURRENT selects the committed snapshot; only two journal segments survive
 * checkpoint rotation. Read cumulative projection usage (never contextUsage or
 * duplicate action_result/core_input copies), then take deltas between envelopes.
 */
export async function readUnifiedVibeCalls(
  currentPath: string,
  toolDisplayName: (name: string) => string,
  defaultModel: string,
): Promise<ParsedProviderCall[]> {
  const dir = dirname(currentPath)
  const current = await json(currentPath)
  if (current?.store_format !== 'mistral.vibe.unified-session-store/v1') return []
  const generation = text(current.generation)
  if (!/^\d{16}$/.test(generation)) return []
  const generationDir = join(dir, 'generations', generation)
  const projection = await json(join(generationDir, 'projection-state.json'))
  const runtime = await json(join(generationDir, 'runtime-state.json'))
  const manifest = await json(join(generationDir, 'manifest.json'))
  if (!projection || !runtime || !manifest) return []
  const sessionId = text(current.session_id) || basename(dir)
  if (projection.session_id !== sessionId || runtime.session_id !== sessionId) return []
  const snapshotSequence = count(current.snapshot_sequence)
  const snapshot = object(projection.snapshot)
  const meta = await json(join(dir, 'meta.json'))
  const sessionMetadata = object(runtime.session_metadata)
  // active_model is a pin; an unpinned session runs the configured default.
  const model = text(sessionMetadata.active_model) || text(object(meta?.config).active_model) || defaultModel
  const fallbackTime = text(meta?.end_time) || text(meta?.start_time)
  const projectPath = text(sessionMetadata.cwd) || text(object(meta?.environment).working_directory)

  const entries = new Map<string, ObjectValue>()
  const addEntries = (values: unknown) => {
    for (const value of array(values)) {
      const entry = object(value)
      if (typeof entry.id === 'string') entries.set(entry.id, entry)
    }
  }
  addEntries(object(snapshot.history).entries)
  // Manifest chunk names are content hashes, never arbitrary paths from a log.
  for (const hash of array(object(manifest.projection_state).chunks)) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return []
    const raw = await readSessionFile(join(dir, 'chunks', `${hash}.json`))
    if (raw === null) return []
    try { addEntries(JSON.parse(raw)) } catch { return [] }
  }

  const points = new Map<number, UsagePoint>()
  const addPoint = (sequence: number, state: unknown) => {
    const point = usagePoint(sequence, state)
    if (point) points.set(sequence, point)
  }
  addPoint(snapshotSequence, snapshot)
  const journalDir = join(dir, 'journal')
  const segments = (await readdir(journalDir).catch(() => []))
    .filter(name => /^\d{16}\.jsonl$/.test(name)).sort()
  const seenSequences = new Set<number>()
  for (const segment of segments) {
    for await (const line of readSessionLines(join(journalDir, segment))) {
      let record: ObjectValue
      try { record = object(JSON.parse(line)) } catch { continue }
      const sequence = count(record.sequence)
      if (!sequence || seenSequences.has(sequence)) continue
      seenSequences.add(sequence)
      const payload = object(record.payload)
      if (record.type === 'projection_advanced') {
        addPoint(sequence, payload.snapshot)
        if (sequence > snapshotSequence) {
          entries.clear()
          addEntries(object(object(payload.snapshot).history).entries)
        }
      } else if (record.type === 'projection_delta') {
        for (const value of array(payload.delta)) {
          const op = object(value)
          if (op.op === 'set_envelope') addPoint(sequence, op.state)
          if (sequence <= snapshotSequence) continue
          if (op.op === 'append_entry' || op.op === 'replace_entry') addEntries([op.entry])
          else if (op.op === 'remove_entry') entries.delete(text(op.id))
          else if (op.op === 'set_history_entries') {
            entries.clear()
            addEntries(op.entries)
          }
        }
      }
    }
  }

  const history = [...entries.values()].sort((a, b) => count(a.createdAt) - count(b.createdAt))
  const steps: { point: UsagePoint; delta: Usage; first: boolean }[] = []
  let previous: Usage = { input: 0, output: 0, cached: 0 }
  for (const point of [...points.values()].sort((a, b) => a.sequence - b.sequence)) {
    const { usage } = point
    // Projection counters are cumulative. Replayed/stale envelopes cannot add
    // usage again, and context-window shrinkage is not new billable usage.
    if (usage.input < previous.input || usage.output < previous.output || usage.cached < previous.cached) continue
    const delta = {
      input: usage.input - previous.input,
      output: usage.output - previous.output,
      cached: Math.min(usage.input - previous.input, usage.cached - previous.cached),
    }
    const first = previous.input === 0 && previous.output === 0
    previous = usage
    if (delta.input || delta.output) steps.push({ point, delta, first })
  }
  // Rotation drops the per-call usage of the prefix, but runtime state still
  // lists every completion, so the prefix splits into that many calls.
  const completions = array(runtime.actions).filter(value => {
    const action = object(value)
    return action.kind === 'completion' && action.state === 'succeeded'
  }).length
  const journalCalls = steps.filter(step => !step.first && step.point.sequence <= snapshotSequence).length
  const prefixCalls = Math.max(1, completions - journalCalls)
  const split = (total: number, index: number, parts: number) =>
    Math.floor(total / parts) + (index < total % parts ? 1 : 0)

  const calls: ParsedProviderCall[] = []
  const turnsWithTools = new Set<string>()
  for (const { point, delta, first } of steps) {
    const session = object(point.state.session)
    const pointTime = count(session.updatedAt)
    const turnId = text(object(point.state.latestTurn).id) || `${sessionId}:snapshot`
    // After rotation, older per-call usage is gone. Allocate that prefix across
    // its recorded turns, just as the legacy parser allocates cumulative stats.
    const olderTurns = first ? [...new Set(history
      .filter(entry => count(entry.createdAt) <= pointTime && (entry.role === 'assistant' || entry.type === 'effect'))
      .map(entry => text(entry.turnId)).filter(Boolean))] : []
    const turnIds = olderTurns.length ? olderTurns : [turnId]
    const slots = first
      ? turnIds.flatMap((id, index) => Array<string>(Math.max(1, split(prefixCalls, index, turnIds.length))).fill(id))
      : turnIds
    for (const [index, id] of slots.entries()) {
      const turnEntries = history.filter(entry => entry.turnId === id)
      const user = turnEntries.find(entry => entry.role === 'user')
      const assistant = turnEntries.find(entry => entry.role === 'assistant' || entry.type === 'effect')
      const tools: string[] = []
      const bashCommands: string[] = []
      // A turn's tools ride on its first call only, so per-call tool counts stay real.
      if (!turnsWithTools.has(id)) {
        turnsWithTools.add(id)
        for (const entry of turnEntries) {
          const detail = object(entry.detail)
          const rawName = text(detail.toolName)
          if (!rawName) continue
          // History names carry the tool group: `file_system.bash`, `ui.ask_user_question`.
          const name = toolDisplayName(rawName.replace(/^.*\./, ''))
          tools.push(name)
          if (name === 'Bash') {
            const command = text(object(detail.input).command)
            if (command) bashCommands.push(...extractBashCommands(command))
          }
        }
      }
      const inputTokens = split(delta.input - delta.cached, index, slots.length)
      const outputTokens = split(delta.output, index, slots.length)
      const cacheReadInputTokens = split(delta.cached, index, slots.length)
      calls.push({
        provider: 'mistral-vibe', model, inputTokens, outputTokens,
        cacheReadInputTokens, cachedInputTokens: cacheReadInputTokens,
        cacheCreationInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
        costUSD: calculateCost(model, inputTokens, outputTokens, 0, cacheReadInputTokens, 0),
        costIsEstimated: true,
        tools: [...new Set(tools)], bashCommands: [...new Set(bashCommands)],
        timestamp: timestamp(first ? assistant?.createdAt ?? pointTime : pointTime, fallbackTime),
        speed: 'standard', sessionId, turnId: id,
        deduplicationKey: `mistral-vibe:${sessionId}:unified:${point.sequence}:${id}:${index}`,
        userMessage: (content(user?.content) || text(session.preview) || text(meta?.title)).slice(0, 500),
        ...(projectPath ? { projectPath, workingDirectory: projectPath } : {}),
      })
    }
  }
  return calls
}
