// @codeburn/core Antigravity decoder: pure decode over three record shapes the
// host hands it: sqlite gen_metadata rows, RPC generatorMetadata entries, and
// statusline JSONL events. No fs / env / clock — the host owns discovery,
// durable caching, project attribution, and pricing.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { normalizeModelIdentifier } from '../../schema.js'
import type {
  AntigravityDecodedCall,
  AntigravityGeneratorMetadata,
  AntigravityGeneratorMetadataResponse,
  AntigravityGenMetadataRow,
  AntigravityModelMap,
  AntigravityModelMapResponse,
  AntigravityStatusLineEvent,
  AntigravityStatusLinePayload,
  ProtoField,
  ProtoVarint,
} from './types.js'

export type AntigravityGenMetadataDecodeInput = {
  records: unknown[]
  context: DecodeContext
  cascadeId: string
}

export type AntigravityDecodeResult = {
  calls: AntigravityDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

export type AntigravityGeneratorMetadataDecodeInput = {
  records: unknown[]
  context: DecodeContext
  cascadeId: string
  modelMap: AntigravityModelMap
}

export type AntigravityStatusLineDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys: ReadonlySet<string>
}

const protoTextDecoder = new TextDecoder('utf-8', { fatal: false })

function readProtoVarint(data: Uint8Array, startOffset: number): ProtoVarint | null {
  let value = 0n
  let shift = 0n
  let offset = startOffset

  while (offset < data.length) {
    const byte = BigInt(data[offset]!)
    offset += 1
    value |= (byte & 0x7fn) << shift
    if ((byte & 0x80n) === 0n) return { value, offset }
    shift += 7n
    if (shift > 70n) return null
  }

  return null
}

function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0

  while (offset < data.length) {
    const key = readProtoVarint(data, offset)
    if (!key) break
    offset = key.offset

    const fieldNumber = Number(key.value >> 3n)
    const wireType = Number(key.value & 0x7n)
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) break

    if (wireType === 0) {
      const value = readProtoVarint(data, offset)
      if (!value) break
      fields.push({ number: fieldNumber, wireType, value: value.value })
      offset = value.offset
      continue
    }

    if (wireType === 1) {
      if (offset + 8 > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 8) })
      offset += 8
      continue
    }

    if (wireType === 2) {
      const length = readProtoVarint(data, offset)
      if (!length) break
      offset = length.offset
      const byteLength = Number(length.value)
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + byteLength) })
      offset += byteLength
      continue
    }

    if (wireType === 5) {
      if (offset + 4 > data.length) break
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 4) })
      offset += 4
      continue
    }

    break
  }

  return fields
}

function firstProtoField(fields: readonly ProtoField[], fieldNumber: number): ProtoField | undefined {
  return fields.find(field => field.number === fieldNumber)
}

function protoFieldText(field: ProtoField | undefined): string | undefined {
  if (!field?.bytes || field.bytes.length === 0) return undefined
  const text = protoTextDecoder.decode(field.bytes)
  if (!text || /[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(text)) return undefined
  return text
}

function protoFieldPositiveInteger(field: ProtoField | undefined): number {
  if (field?.value === undefined) return 0
  const value = Number(field.value)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function protoFieldBytes(field: ProtoField | undefined): Uint8Array | undefined {
  return field?.bytes
}

// Antigravity's own model-map config sometimes hasn't caught up with a new
// model yet, so both the config key and displayName can still be the raw
// placeholder id (e.g. "MODEL_PLACEHOLDER_M26"). Falling through to that
// value as the "canonical" model would leak an internal placeholder as a
// model name; 'unknown' is what the CLI already uses when no model can be
// resolved at all.
const MODEL_PLACEHOLDER_PATTERN = /^MODEL_PLACEHOLDER_/

function dropPlaceholderModelId(model: string): string {
  return MODEL_PLACEHOLDER_PATTERN.test(model) ? 'unknown' : model
}

function getCanonicalModelId(key: string, displayName?: string): string {
  if (displayName) {
    const lower = displayName.toLowerCase()
    if (lower.includes('3.5 flash')) {
      if (lower.includes('high')) return 'gemini-3.5-flash-high'
      if (lower.includes('medium')) return 'gemini-3.5-flash-medium'
      if (lower.includes('low')) return 'gemini-3.5-flash-low'
      return 'gemini-3.5-flash'
    }
    if (lower.includes('3.1 pro')) {
      if (lower.includes('high')) return 'gemini-3.1-pro-high'
      if (lower.includes('low')) return 'gemini-3.1-pro-low'
      return 'gemini-3.1-pro'
    }
    if (lower.includes('3.1 flash')) {
      if (lower.includes('image')) return 'gemini-3.1-flash-image'
      if (lower.includes('lite')) return 'gemini-3.1-flash-lite'
      return 'gemini-3.1-flash'
    }
    if (lower.includes('3 flash')) {
      return 'gemini-3-flash'
    }
    if (lower.includes('3 pro')) {
      return 'gemini-3-pro'
    }
  }
  return dropPlaceholderModelId(key)
}

function isAntigravityResponseId(value: string): boolean {
  return /^[^\s]+$/.test(value)
}

function antigravitySqliteResponseId(usageFields: readonly ProtoField[], fallback: string): string {
  const responseId = protoFieldText(firstProtoField(usageFields, 11))
  return responseId && isAntigravityResponseId(responseId) ? responseId : fallback
}

function genMetadataDataBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value
}

function antigravitySqliteMetadataAttributes(chatFields: readonly ProtoField[]): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const field of chatFields) {
    if (field.number !== 20) continue
    const pairFields = parseProtoFields(protoFieldBytes(field) ?? new Uint8Array())
    const key = protoFieldText(firstProtoField(pairFields, 1))
    const value = protoFieldText(firstProtoField(pairFields, 2))
    if (key && value) attributes.set(key, value)
  }
  return attributes
}

function antigravitySqliteModel(chatFields: readonly ProtoField[]): string {
  const attributes = antigravitySqliteMetadataAttributes(chatFields)
  const displayName = protoFieldText(firstProtoField(chatFields, 21))
  const rawModel = protoFieldText(firstProtoField(chatFields, 19))
    ?? attributes.get('model_enum')
    ?? displayName
    ?? 'unknown'

  return getCanonicalModelId(rawModel, displayName)
}

// Decode a proto field that carries a time into an ISO-8601 string. Antigravity
// may encode ChatStartMetadata.created_at as an ISO string, a Timestamp
// submessage (seconds in field 1), or a bare unix varint. Returns '' when the
// field is absent or unparseable so the caller can fall back.
function protoTimestampToIso(field: ProtoField | undefined): string {
  if (!field) return ''
  const text = protoFieldText(field)
  if (text && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString()
  if (field.bytes) {
    // google.protobuf.Timestamp submessage: seconds (#1), nanos (#2).
    const tsFields = parseProtoFields(field.bytes)
    const seconds = firstProtoField(tsFields, 1)?.value
    if (seconds !== undefined) {
      const nanos = firstProtoField(tsFields, 2)?.value ?? 0n
      const ms = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6)
      if (Number.isSafeInteger(ms) && ms > 0) return new Date(ms).toISOString()
    }
  }
  if (field.value !== undefined) {
    const raw = Number(field.value)
    const ms = raw < 1e12 ? raw * 1000 : raw
    if (Number.isSafeInteger(ms) && ms > 0) return new Date(ms).toISOString()
  }
  return ''
}

// ChatStartMetadata lives at chatModel(#1).#9; its created_at is #4. Not every
// gen_metadata row carries it, so this returns '' when missing.
function antigravitySqliteCreatedAt(chatFields: readonly ProtoField[]): string {
  const metadataBytes = protoFieldBytes(firstProtoField(chatFields, 9))
  if (!metadataBytes) return ''
  return protoTimestampToIso(firstProtoField(parseProtoFields(metadataBytes), 4))
}

function decodeAntigravityGenMetadataRow(
  cascadeId: string,
  row: AntigravityGenMetadataRow,
): AntigravityDecodedCall | null {
  const rootFields = parseProtoFields(genMetadataDataBytes(row.data))
  const chatFields = parseProtoFields(protoFieldBytes(firstProtoField(rootFields, 1)) ?? new Uint8Array())
  const usageFields = parseProtoFields(protoFieldBytes(firstProtoField(chatFields, 4)) ?? new Uint8Array())
  if (usageFields.length === 0) return null

  const inputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 2))
    || protoFieldPositiveInteger(firstProtoField(usageFields, 1))
  const totalOutputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 3))
  let responseTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 9))
  let thinkingTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 10))

  if (responseTokens === 0 && thinkingTokens === 0) {
    responseTokens = totalOutputTokens
  } else if (totalOutputTokens > 0 && responseTokens + thinkingTokens !== totalOutputTokens) {
    const adjustedResponseTokens = totalOutputTokens - thinkingTokens
    if (adjustedResponseTokens >= 0) responseTokens = adjustedResponseTokens
  }

  if (inputTokens === 0 && totalOutputTokens === 0) return null

  const responseId = antigravitySqliteResponseId(usageFields, String(row.idx))
  const model = antigravitySqliteModel(chatFields)

  return {
    provider: 'antigravity',
    model,
    inputTokens,
    outputTokens: responseTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: thinkingTokens,
    webSearchRequests: 0,
    timestamp: antigravitySqliteCreatedAt(chatFields),
    speed: 'standard',
    deduplicationKey: `antigravity:${cascadeId}:${responseId}`,
    sessionId: cascadeId,
  }
}

/** gen_metadata rows -> calls. Per-cascade dedup on deduplicationKey (host-side
 *  cross-file dedup is applied later by the caller, exactly as before). */
export function decodeAntigravityGenMetadata(
  input: AntigravityGenMetadataDecodeInput,
): AntigravityDecodeResult {
  const { records, cascadeId } = input
  const calls: AntigravityDecodedCall[] = []
  const seenResponseIds = new Set<string>()

  for (const row of records as AntigravityGenMetadataRow[]) {
    const call = decodeAntigravityGenMetadataRow(cascadeId, row)
    if (!call) continue
    if (seenResponseIds.has(call.deduplicationKey)) continue
    seenResponseIds.add(call.deduplicationKey)
    calls.push(call)
  }

  return { calls, diagnostics: [] }
}

export function extractAntigravityModelMap(resp: unknown): AntigravityModelMap {
  if (!resp || typeof resp !== 'object') return {}
  const data = resp as AntigravityModelMapResponse
  const models = data.response?.models ?? data.models
  const map = new Map<string, string>()
  if (!models) return {}
  for (const [key, info] of Object.entries(models)) {
    if (info && typeof info === 'object' && typeof info.model === 'string') {
      const canonicalKey = getCanonicalModelId(key, info.displayName)
      map.set(info.model, canonicalKey)
    }
  }
  return Object.fromEntries(map)
}

export function extractAntigravityGeneratorMetadata(resp: unknown): AntigravityGeneratorMetadata[] {
  if (!resp || typeof resp !== 'object') return []
  const data = resp as AntigravityGeneratorMetadataResponse
  const metadata = data.response?.generatorMetadata ?? data.generatorMetadata
  return Array.isArray(metadata) ? metadata : []
}

function parseFiniteToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function usageSignature(event: AntigravityStatusLineEvent): string {
  const u = event.usage
  return [
    // The model component must never be the raw display name: this signature
    // feeds the dedup key, which SHIPS on the envelope, and the observation
    // boundary normalizes the same value (a display name like "Gemini 3.5
    // Flash (High)" collapses to 'unknown' there). Building the signature
    // from the normalized identifier keeps the key and the envelope's model
    // field consistent and stops free text from riding the key.
    normalizeModelIdentifier(event.model),
    u.inputTokens,
    u.outputTokens,
    u.cacheCreationInputTokens,
    u.cacheReadInputTokens,
  ].join(':')
}

function usageHasTokens(usage: AntigravityStatusLineEvent['usage']): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheCreationInputTokens > 0 ||
    usage.cacheReadInputTokens > 0
  )
}

function usageIsMonotonic(
  current: AntigravityStatusLineEvent['usage'],
  previous: AntigravityStatusLineEvent['usage'],
): boolean {
  return (
    current.inputTokens >= previous.inputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.cacheCreationInputTokens >= previous.cacheCreationInputTokens &&
    current.cacheReadInputTokens >= previous.cacheReadInputTokens
  )
}

function usageDelta(
  current: AntigravityStatusLineEvent['usage'],
  previous: AntigravityStatusLineEvent['usage'],
): AntigravityStatusLineEvent['usage'] {
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens - previous.cacheCreationInputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens - previous.cacheReadInputTokens,
  }
}

/** Hook-capture record parse. The wall clock is INJECTED (`at`) so the decoder
 *  stays pure; the host passes a freshly-generated ISO-8601 timestamp. */
export function parseAntigravityStatusLinePayload(
  input: unknown,
  at: string,
): AntigravityStatusLineEvent | null {
  if (!input || typeof input !== 'object') return null
  const payload = input as AntigravityStatusLinePayload
  if (typeof payload.conversation_id !== 'string' || payload.conversation_id.length === 0) return null
  const usage = payload.context_window?.current_usage
  if (!usage) return null

  const event: AntigravityStatusLineEvent = {
    at,
    conversationId: payload.conversation_id,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    model: typeof payload.model === 'string'
      ? payload.model
      : payload.model?.id ?? payload.model?.display_name ?? 'unknown',
    usage: {
      inputTokens: parseFiniteToken(usage.input_tokens),
      outputTokens: parseFiniteToken(usage.output_tokens),
      cacheCreationInputTokens: parseFiniteToken(usage.cache_creation_input_tokens),
      cacheReadInputTokens: parseFiniteToken(usage.cache_read_input_tokens),
    },
  }

  const u = event.usage
  if (u.inputTokens === 0 && u.outputTokens === 0 && u.cacheCreationInputTokens === 0 && u.cacheReadInputTokens === 0) {
    return null
  }
  if (event.model === 'unknown') return null
  return event
}

function parseStatusLineEvent(input: unknown): AntigravityStatusLineEvent | null {
  if (!input || typeof input !== 'object') return null
  const event = input as AntigravityStatusLineEvent
  if (typeof event.at !== 'string' || Number.isNaN(new Date(event.at).getTime())) return null
  if (typeof event.conversationId !== 'string' || event.conversationId.length === 0) return null
  if (typeof event.model !== 'string' || event.model.length === 0) return null
  if (!event.usage || typeof event.usage !== 'object') return null

  const usage = {
    inputTokens: parseFiniteToken(event.usage.inputTokens),
    outputTokens: parseFiniteToken(event.usage.outputTokens),
    cacheCreationInputTokens: parseFiniteToken(event.usage.cacheCreationInputTokens),
    cacheReadInputTokens: parseFiniteToken(event.usage.cacheReadInputTokens),
  }

  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheCreationInputTokens === 0 &&
    usage.cacheReadInputTokens === 0
  ) return null

  return {
    at: event.at,
    conversationId: event.conversationId,
    sessionId: typeof event.sessionId === 'string' ? event.sessionId : undefined,
    model: event.model,
    usage,
  }
}

function hasRpcCacheForConversation(seenKeys: ReadonlySet<string>, conversationId: string): boolean {
  const prefix = `antigravity:${conversationId}:`
  for (const key of seenKeys) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

/** statusline jsonl -> calls (run collapse + monotonic deltas). */
export function decodeAntigravityStatusLine(
  input: AntigravityStatusLineDecodeInput,
): AntigravityDecodeResult {
  const { records, seenKeys } = input
  const runsByConversation = new Map<string, Array<{ event: AntigravityStatusLineEvent; signature: string; count: number }>>()

  for (const line of records as string[]) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const event = parseStatusLineEvent(parsed)
    if (!event) continue
    if (hasRpcCacheForConversation(seenKeys, event.conversationId)) continue

    const signature = usageSignature(event)
    const runs = runsByConversation.get(event.conversationId) ?? []
    const lastRun = runs.at(-1)
    if (lastRun?.signature === signature) {
      lastRun.count += 1
      lastRun.event = event
    } else {
      runs.push({ event, signature, count: 1 })
      runsByConversation.set(event.conversationId, runs)
    }
  }

  const calls: AntigravityDecodedCall[] = []

  for (const runs of runsByConversation.values()) {
    let turnIndex = 0
    let previousSnapshotUsage: AntigravityStatusLineEvent['usage'] | null = null
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!
      const isLastRun = i === runs.length - 1
      if (run.count === 1 && !isLastRun) continue

      const event = run.event
      const signature = run.signature
      const billableUsage = previousSnapshotUsage && usageIsMonotonic(event.usage, previousSnapshotUsage)
        ? usageDelta(event.usage, previousSnapshotUsage)
        : event.usage
      previousSnapshotUsage = event.usage
      if (!usageHasTokens(billableUsage)) continue

      const dedupKey = `antigravity-statusline:${event.conversationId}:${turnIndex}:${signature}`
      turnIndex += 1
      if (seenKeys.has(dedupKey)) continue

      const u = billableUsage

      calls.push({
        provider: 'antigravity',
        model: event.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheCreationInputTokens: u.cacheCreationInputTokens,
        cacheReadInputTokens: u.cacheReadInputTokens,
        cachedInputTokens: 0,
        // StatusLine current_usage exposes aggregate output tokens, not a
        // separate thinking/response split. Preserve the exact total instead
        // of inventing a breakdown.
        reasoningTokens: 0,
        webSearchRequests: 0,
        timestamp: event.at,
        speed: 'standard',
        deduplicationKey: dedupKey,
        sessionId: event.conversationId,
      })
    }
  }

  return { calls, diagnostics: [] }
}

/** RPC generatorMetadata entries -> calls. */
export function decodeAntigravityGeneratorMetadata(
  input: AntigravityGeneratorMetadataDecodeInput,
): AntigravityDecodeResult {
  const { records, cascadeId, modelMap } = input
  const calls: AntigravityDecodedCall[] = []

  for (let i = 0; i < records.length; i++) {
    const entry = records[i] as AntigravityGeneratorMetadata
    const usage = entry.chatModel?.usage
    if (!usage) continue

    const inputTokens = parseInt(usage.inputTokens ?? '0', 10)
    const outputTokens = parseInt(usage.outputTokens ?? '0', 10)
    const thinkingTokens = parseInt(usage.thinkingOutputTokens ?? '0', 10)
    const responseTokens = parseInt(usage.responseOutputTokens ?? '0', 10)

    if (inputTokens === 0 && outputTokens === 0) continue

    const responseId = usage.responseId || String(i)
    const dedupKey = `antigravity:${cascadeId}:${responseId}`

    const model = dropPlaceholderModelId(modelMap[usage.model] ?? usage.model)
    const timestamp = entry.chatModel?.chatStartMetadata?.createdAt ?? ''

    calls.push({
      provider: 'antigravity',
      model,
      inputTokens,
      outputTokens: responseTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: thinkingTokens,
      webSearchRequests: 0,
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      sessionId: cascadeId,
    })
  }

  return { calls, diagnostics: [] }
}
