import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

export type CodexThroughputPoint = {
  timestamp: string
  model?: string
  outputTokens: number
  reasoningTokens: number
  generatedTokens: number
  taskGeneratedTokens?: number
  elapsedSeconds?: number
  generatedTokensPerSecond?: number
  activeDurationSeconds?: number
  activeGeneratedTokensPerSecond?: number
  toolWaitSeconds?: number
}

type TokenUsage = {
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

type RolloutLine = {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    turn_id?: string
    call_id?: string
    started_at?: number
    duration_ms?: number
    duration?: { secs?: number; nanos?: number } | string
    model?: string
    forked_from_id?: string
    info?: {
      last_token_usage?: TokenUsage
      total_token_usage?: TokenUsage
    }
  }
}

const CHUNK_BYTES = 64 * 1024
const MAX_PENDING_LINE_CHARS = 4 * 1024 * 1024
const TRUNCATION_MARKER = '__CODEBURN_TRUNCATED_LINE__'

function rawString(source: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(source)
  if (!match) return undefined
  try { return JSON.parse(`"${match[1]}"`) as string } catch { return undefined }
}

function rawNumber(source: string, field: string): number | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(source)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function compactUsage(source: string, field: 'last_token_usage' | 'total_token_usage'): TokenUsage | undefined {
  const index = source.indexOf(`"${field}"`)
  if (index < 0) return undefined
  const body = source.slice(index, index + 4096)
  return {
    output_tokens: rawNumber(body, 'output_tokens'),
    reasoning_output_tokens: rawNumber(body, 'reasoning_output_tokens'),
    total_tokens: rawNumber(body, 'total_tokens'),
  }
}

function parseRawDurationValue(value: string): number | undefined {
  const objectMatch = /^\s*\{\s*"secs"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"nanos"\s*:\s*(-?\d+(?:\.\d+)?)\s*\}/.exec(value)
  if (objectMatch) {
    const seconds = Number(objectMatch[1])
    const nanos = Number(objectMatch[2])
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) return seconds * 1000 + nanos / 1e6
  }
  const stringMatch = /^\s*"(\d+(?:\.\d+)?)(ms|s)?"/.exec(value)
  if (stringMatch) {
    const parsed = Number(stringMatch[1])
    if (Number.isFinite(parsed)) return parsed * (stringMatch[2] === 's' ? 1000 : 1)
  }
  const numberMatch = /^\s*(-?\d+(?:\.\d+)?)/.exec(value)
  if (numberMatch) {
    const parsed = Number(numberMatch[1])
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function durationMs(payload: RolloutLine['payload']): number | undefined {
  if (!payload) return undefined
  if (typeof payload.duration_ms === 'number' && Number.isFinite(payload.duration_ms)) return payload.duration_ms
  if (typeof payload.duration === 'object' && payload.duration) {
    const seconds = payload.duration.secs
    const nanos = payload.duration.nanos
    if (typeof seconds === 'number' && typeof nanos === 'number' && Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return seconds * 1000 + nanos / 1e6
    }
  }
  if (typeof payload.duration === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(payload.duration.trim())
    if (match) return Number(match[1]) * (match[2] === 's' ? 1000 : 1)
  }
  return undefined
}

function mergeToolIntervals(intervals: Array<[number, number]>, durationMs: number, taskStartedAt?: number, taskCompletedAt?: number): number {
  const windowStart = taskStartedAt ?? (taskCompletedAt !== undefined ? taskCompletedAt - durationMs : undefined)
  const windowEnd = windowStart !== undefined ? windowStart + durationMs : undefined
  const clipped = intervals.map(([start, end]) => [
    windowStart !== undefined ? Math.max(start, windowStart) : start,
    windowEnd !== undefined ? Math.min(end, windowEnd) : end,
  ] as [number, number]).filter(([start, end]) => end > start)
  const merged = clipped.sort((a, b) => a[0] - b[0]).reduce<Array<[number, number]>>((result, interval) => {
    const previous = result.at(-1)
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
    else result.push([...interval])
    return result
  }, [])
  return Math.min(durationMs, merged.reduce((total, [start, end]) => total + end - start, 0))
}

function parseLine(line: string): RolloutLine | null {
  const payloadStart = line.indexOf('"payload"')
  const payloadHead = payloadStart >= 0 ? line.slice(payloadStart) : line
  if (line.length > 256 * 1024 || line.startsWith(TRUNCATION_MARKER)) {
    const payloadType = rawString(payloadHead, 'type')
    const infoStart = payloadHead.indexOf('"info"')
    const info = infoStart >= 0 ? payloadHead.slice(infoStart) : ''
    return {
      type: rawString(line, 'type'),
      timestamp: rawString(line, 'timestamp'),
      payload: {
        type: payloadType,
        turn_id: rawString(payloadHead, 'turn_id'),
        call_id: rawString(payloadHead, 'call_id'),
        started_at: rawNumber(payloadHead, 'started_at'),
        duration_ms: rawNumber(payloadHead, 'duration_ms'),
        duration: rawString(payloadHead, 'duration') ?? (rawNumber(payloadHead, 'secs') !== undefined
          ? { secs: rawNumber(payloadHead, 'secs'), nanos: rawNumber(payloadHead, 'nanos') }
          : undefined),
        model: rawString(payloadHead, 'model'),
        forked_from_id: rawString(payloadHead, 'forked_from_id'),
        info: {
          last_token_usage: compactUsage(info, 'last_token_usage'),
          total_token_usage: compactUsage(info, 'total_token_usage'),
        },
      },
    }
  }
  try {
    return JSON.parse(line) as RolloutLine
  } catch {
    return null
  }
}

/**
 * Estimate generated tokens/sec from a Codex rollout's persisted checkpoints.
 * Codex JSONL has no per-token timestamps, so this is deliberately a
 * checkpoint-to-checkpoint estimate, not live decode speed.
 */
type ThroughputState = {
  model?: string
  previousTotal?: number
  previousOutput: number
  previousReasoning: number
  previousTimestamp?: number
  currentTaskGenerated: number
  currentTaskToolIntervals: Array<[number, number]>
  currentTaskStartedAt?: number
  toolStarts: Map<string, number>
  latestPoint?: CodexThroughputPoint
  points: CodexThroughputPoint[]
  forkCutoffMs?: number
}

function newThroughputState(): ThroughputState {
  return {
    previousOutput: 0,
    previousReasoning: 0,
    currentTaskGenerated: 0,
    currentTaskToolIntervals: [],
    toolStarts: new Map(),
    points: [],
  }
}

/**
 * Incrementally parses a rollout. Watch mode feeds only newly appended bytes
 * to this reader, so a growing JSONL file is not reparsed from byte zero.
 */
export class CodexThroughputReader {
  private offset = 0
  private pending = ''
  private decoder = new StringDecoder('utf8')
  private pendingDurationMs: number | undefined
  private scanDepth = 0
  private scanPayloadDepth: number | undefined
  private scanInString = false
  private scanEscape = false
  private scanString = ''
  private scanLastString = ''
  private scanAwaitingColon = false
  private scanCurrentKey: string | undefined
  private scanCapture: { mode: 'string' | 'object' | 'primitive'; text: string; depth: number } | undefined
  private state = newThroughputState()

  reset(): void {
    this.offset = 0
    this.pending = ''
    this.decoder = new StringDecoder('utf8')
    this.pendingDurationMs = undefined
    this.scanDepth = 0
    this.scanPayloadDepth = undefined
    this.scanInString = false
    this.scanEscape = false
    this.scanString = ''
    this.scanLastString = ''
    this.scanAwaitingColon = false
    this.scanCurrentKey = undefined
    this.scanCapture = undefined
    this.state = newThroughputState()
  }

  private finishDurationCapture(): void {
    if (!this.scanCapture) return
    const value = this.scanCapture.mode === 'string' ? `"${this.scanCapture.text}"` : this.scanCapture.text
    const parsed = parseRawDurationValue(value)
    if (parsed !== undefined && this.pendingDurationMs === undefined) this.pendingDurationMs = parsed
    this.scanCapture = undefined
  }

  private scanDurationSegment(source: string): void {
    for (let i = 0; i < source.length; i++) {
      const char = source[i]!
      if (this.scanInString) {
        if (this.scanEscape) {
          this.scanEscape = false
          if (this.scanCapture?.mode === 'object') this.scanCapture.text += char
          else if (this.scanCapture?.mode === 'string') this.scanCapture.text += char
          else this.scanString += char
          continue
        }
        if (char === '\\') {
          this.scanEscape = true
          if (this.scanCapture?.mode === 'object' || this.scanCapture?.mode === 'string') this.scanCapture.text += char
          continue
        }
        if (char === '"') {
          if (this.scanCapture?.mode === 'object') this.scanCapture.text += char
          this.scanInString = false
          if (this.scanCapture?.mode === 'string') this.finishDurationCapture()
          else if (this.scanCapture?.mode === 'object') {
            this.scanAwaitingColon = false
            this.scanCurrentKey = undefined
          } else {
            this.scanLastString = this.scanString
            this.scanAwaitingColon = true
          }
          continue
        }
        if (this.scanCapture?.mode === 'object' || this.scanCapture?.mode === 'string') this.scanCapture.text += char
        else this.scanString += char
        continue
      }

      if (this.scanCapture?.mode === 'primitive') {
        if (char === ',' || char === '}' || char === ']') this.finishDurationCapture()
        else { this.scanCapture.text += char; continue }
      }
      if (this.scanAwaitingColon) {
        if (/\s/.test(char)) continue
        if (char === ':') {
          this.scanCurrentKey = this.scanLastString
          this.scanAwaitingColon = false
          continue
        }
        this.scanAwaitingColon = false
      }
      if (char === '"') {
        this.scanString = ''
        if (this.scanCapture?.mode === 'object') this.scanCapture.text += char
        if (this.scanCurrentKey === 'duration' && this.scanPayloadDepth === this.scanDepth) {
          this.scanCapture = { mode: 'string', text: '', depth: this.scanDepth }
          this.scanCurrentKey = undefined
        }
        this.scanInString = true
        continue
      }
      if (char === '{' || char === '[') {
        if (this.scanCurrentKey === 'payload' && char === '{' && this.scanPayloadDepth === undefined) {
          this.scanPayloadDepth = this.scanDepth + 1
        }
        if (this.scanCurrentKey === 'duration' && this.scanPayloadDepth === this.scanDepth) {
          this.scanCapture = { mode: 'object', text: char, depth: this.scanDepth + 1 }
          this.scanCurrentKey = undefined
        } else if (this.scanCapture?.mode === 'object') {
          this.scanCapture.text += char
        }
        this.scanDepth++
        continue
      }
      if (char === '}' || char === ']') {
        if (this.scanCapture?.mode === 'object') this.scanCapture.text += char
        this.scanDepth = Math.max(0, this.scanDepth - 1)
        if (this.scanCapture?.mode === 'object' && this.scanDepth < this.scanCapture.depth) this.finishDurationCapture()
        continue
      }
      if (this.scanCurrentKey === 'duration' && this.scanPayloadDepth === this.scanDepth && !/\s/.test(char)) {
        this.scanCapture = { mode: 'primitive', text: char, depth: this.scanDepth }
        this.scanCurrentKey = undefined
        continue
      }
      if (this.scanCapture?.mode === 'object') this.scanCapture.text += char
    }
  }

  private processLine(line: string, durationOverride?: number): void {
    const entry = parseLine(line)
    if (!entry) return
    if (durationOverride !== undefined && (line.startsWith(TRUNCATION_MARKER) || line.length > 256 * 1024) && entry.type === 'event_msg' && (entry.payload?.type === 'mcp_tool_call_end' || entry.payload?.type === 'task_complete')) {
      entry.payload = { ...entry.payload, duration_ms: durationOverride }
    }
    const state = this.state
    if (entry.type === 'session_meta') {
      if (entry.payload?.model) state.model = entry.payload.model
      if (entry.payload?.forked_from_id && entry.timestamp) {
        const timestamp = Date.parse(entry.timestamp)
        if (Number.isFinite(timestamp)) state.forkCutoffMs = timestamp + 5000
      }
      return
    }
    if (entry.type === 'turn_context' && entry.payload?.model) state.model = entry.payload.model
    const entryTimestamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN
    const isForkReplay = state.forkCutoffMs !== undefined && Number.isFinite(entryTimestamp) && entryTimestamp < state.forkCutoffMs
    if (isForkReplay && (
      entry.payload?.type === 'task_started' ||
      entry.payload?.type === 'task_complete' ||
      entry.payload?.type === 'function_call' ||
      entry.payload?.type === 'function_call_output' ||
      entry.payload?.type === 'custom_tool_call' ||
      entry.payload?.type === 'custom_tool_call_output' ||
      entry.payload?.type === 'mcp_tool_call_end' ||
      entry.payload?.type === 'patch_apply_end' ||
      entry.payload?.type === 'token_count'
    )) return
    if (entry.type === 'event_msg' && entry.payload?.type === 'task_started') {
      state.currentTaskGenerated = 0
      state.currentTaskToolIntervals = []
      const startedAt = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      state.currentTaskStartedAt = Number.isFinite(startedAt) ? startedAt : undefined
      state.toolStarts.clear()
    }
    if (entry.type === 'response_item' && (entry.payload?.type === 'function_call' || entry.payload?.type === 'custom_tool_call') && entry.payload.call_id && entry.timestamp) {
      const started = Date.parse(entry.timestamp)
      if (Number.isFinite(started)) state.toolStarts.set(entry.payload.call_id, started)
    }
    if (entry.type === 'response_item' && (entry.payload?.type === 'function_call_output' || entry.payload?.type === 'custom_tool_call_output') && entry.payload.call_id && entry.timestamp) {
      const ended = Date.parse(entry.timestamp)
      const started = state.toolStarts.get(entry.payload.call_id)
      if (started !== undefined && Number.isFinite(ended) && ended > started) state.currentTaskToolIntervals.push([started, ended])
      state.toolStarts.delete(entry.payload.call_id)
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'mcp_tool_call_end' && entry.timestamp) {
      const ended = Date.parse(entry.timestamp)
      const elapsed = durationMs(entry.payload)
      if (Number.isFinite(ended) && elapsed !== undefined && elapsed > 0) state.currentTaskToolIntervals.push([ended - elapsed, ended])
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'task_complete') {
      const taskDurationMs = durationMs(entry.payload)
      if (state.latestPoint && typeof taskDurationMs === 'number' && taskDurationMs > 0 && state.currentTaskGenerated > 0) {
        state.latestPoint.taskGeneratedTokens = state.currentTaskGenerated
        const completedAt = entry.timestamp ? Date.parse(entry.timestamp) : undefined
        const toolWaitMs = mergeToolIntervals(state.currentTaskToolIntervals, taskDurationMs, state.currentTaskStartedAt, Number.isFinite(completedAt) ? completedAt : undefined)
        const activeMs = taskDurationMs - toolWaitMs
        if (activeMs > 0) {
          state.latestPoint.activeDurationSeconds = activeMs / 1000
          state.latestPoint.toolWaitSeconds = toolWaitMs / 1000
          state.latestPoint.activeGeneratedTokensPerSecond = state.currentTaskGenerated / (activeMs / 1000)
        }
      }
    }
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') return
    const info = entry.payload.info
    if (!info || !entry.timestamp) return
    const last = info.last_token_usage
    const total = info.total_token_usage
    const cumulative = total?.total_tokens
    if (cumulative !== undefined && cumulative === state.previousTotal) return
    let outputTokens = last?.output_tokens ?? 0
    let reasoningTokens = last?.reasoning_output_tokens ?? 0
    if (!last && total && cumulative !== undefined && state.previousTotal !== undefined) {
      outputTokens = Math.max(0, (total.output_tokens ?? 0) - state.previousOutput)
      reasoningTokens = Math.max(0, (total.reasoning_output_tokens ?? 0) - state.previousReasoning)
    }
    if (cumulative !== undefined) {
      state.previousTotal = cumulative
      state.previousOutput = total?.output_tokens ?? state.previousOutput
      state.previousReasoning = total?.reasoning_output_tokens ?? state.previousReasoning
    }
    const generatedTokens = outputTokens + reasoningTokens
    if (generatedTokens <= 0) return
    const timestampMs = Date.parse(entry.timestamp)
    if (!Number.isFinite(timestampMs)) return
    const point: CodexThroughputPoint = {
      timestamp: entry.timestamp,
      model: state.model,
      outputTokens,
      reasoningTokens,
      generatedTokens,
    }
    state.currentTaskGenerated += generatedTokens
    state.latestPoint = point
    if (state.previousTimestamp !== undefined && timestampMs > state.previousTimestamp) {
      const elapsedSeconds = (timestampMs - state.previousTimestamp) / 1000
      point.elapsedSeconds = elapsedSeconds
      point.generatedTokensPerSecond = generatedTokens / elapsedSeconds
    }
    state.previousTimestamp = timestampMs
    state.points.push(point)
    if (state.points.length > 10000) state.points.splice(0, state.points.length - 10000)
  }

  async update(filePath: string, limit = 10, finalize = false): Promise<CodexThroughputPoint[]> {
    const info = await stat(filePath)
    if (info.size < this.offset) this.reset()
    const bytesToRead = info.size - this.offset
    if (bytesToRead > 0) {
      const file = await open(filePath, 'r')
      try {
        let position = this.offset
        while (position < info.size) {
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, info.size - position))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
          if (bytesRead === 0) break
          position += bytesRead
          this.offset = position
          let chunk = this.decoder.write(buffer.subarray(0, bytesRead))
          while (chunk.length > 0) {
            const newlineIndex = chunk.search(/\r?\n/)
            const segment = newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : chunk
            this.pending += segment
            this.scanDurationSegment(segment)
            if (newlineIndex < 0) break
            const newlineLength = chunk[newlineIndex] === '\r' ? 2 : 1
            const line = this.pending
            const durationOverride = this.pendingDurationMs
            this.pending = ''
            this.pendingDurationMs = undefined
            this.scanDepth = 0
            this.scanPayloadDepth = undefined
            this.scanInString = false
            this.scanEscape = false
            this.scanString = ''
            this.scanLastString = ''
            this.scanAwaitingColon = false
            this.scanCurrentKey = undefined
            this.scanCapture = undefined
            this.processLine(line, durationOverride)
            chunk = chunk.slice(newlineIndex + newlineLength)
          }
          if (this.pending.length > MAX_PENDING_LINE_CHARS) {
            const body = this.pending.startsWith(TRUNCATION_MARKER)
              ? this.pending.slice(TRUNCATION_MARKER.length)
              : this.pending
            this.pending = TRUNCATION_MARKER + body.slice(0, 256 * 1024) + body.slice(-256 * 1024)
          }
        }
      } finally {
        await file.close()
      }
    }
    if (finalize && this.pending) {
      this.processLine(this.pending, this.pendingDurationMs)
      this.pending = ''
      this.pendingDurationMs = undefined
    }
    return limit > 0 ? this.state.points.slice(-limit) : this.state.points.slice()
  }
}

export async function readCodexThroughput(filePath: string, limit = 10): Promise<CodexThroughputPoint[]> {
  return new CodexThroughputReader().update(filePath, limit, true)
}

export async function newestCodexSession(sessions: Array<{ path: string }>): Promise<string | undefined> {
  let newest: { path: string; mtimeMs: number } | undefined
  for (const session of sessions) {
    try {
      const info = await stat(session.path)
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path: session.path, mtimeMs: info.mtimeMs }
    } catch {
      // A session can disappear while Codex rotates or archives it.
    }
  }
  return newest?.path
}

export function renderCodexThroughput(points: CodexThroughputPoint[], filePath: string): string {
  const latest = points.at(-1)
  if (!latest) return `No token_count checkpoints found in ${filePath}.`
  const lines = [
    'CodeBurn Codex throughput estimate',
    `Session: ${filePath}`,
    `Latest checkpoint: ${latest.timestamp}`,
    `Latest checkpoint tokens: ${latest.generatedTokens.toLocaleString()} (${latest.outputTokens.toLocaleString()} output + ${latest.reasoningTokens.toLocaleString()} reasoning)`,
  ]
  if (latest.taskGeneratedTokens !== undefined) lines.push(`Completed task total: ${latest.taskGeneratedTokens.toLocaleString()} generated tokens`)
  if (latest.activeGeneratedTokensPerSecond !== undefined) {
    lines.push(`Active throughput: ${latest.activeGeneratedTokensPerSecond.toFixed(1)} generated tokens/sec over ${latest.activeDurationSeconds!.toFixed(1)}s`)
    lines.push(`Excluded tool wait: ${latest.toolWaitSeconds!.toFixed(1)}s`)
  } else if (latest.generatedTokensPerSecond !== undefined) {
    lines.push(`Checkpoint estimate: ${latest.generatedTokensPerSecond.toFixed(1)} generated tokens/sec over ${latest.elapsedSeconds!.toFixed(1)}s`)
  } else {
    lines.push('Throughput: unavailable (waiting for a completed turn)')
  }
  lines.push('Note: offline JSONL estimate; tool intervals are removed, but server/prompt latency may remain.')
  return lines.join('\n')
}
