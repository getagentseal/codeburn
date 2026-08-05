/**
 * codeburn sync — OTLP payload builder.
 *
 * Converts ParsedApiCall[] into an ExportTraceServiceRequest (OTLP/HTTP JSON).
 * Span and trace IDs are derived deterministically from deduplicationKey/sessionId
 * under the persisted host privacy key.
 *
 * NOTE: not a pure converter. The first call reads — and, if absent, creates —
 * the persisted privacy key via privacy-key.ts, so it does synchronous
 * filesystem I/O and can THROW. Sync aborts the push when the key cannot be
 * persisted or an existing key file is corrupt, because cross-process id
 * stability (and with it the partial-rejection retry safety in push.ts)
 * depends on a real on-disk key rather than per-process randomness.
 */

import { createHmac } from 'crypto'
import { hostname, userInfo } from 'os'
import { getPersistedHostPrivacyKey } from '../privacy-key.js'
import type { ParsedApiCall } from '../types.js'

export interface OtlpSpan {
  traceId: string
  spanId: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
}

export interface OtlpAttribute {
  key: string
  value: OtlpValue
}

export type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpValue[] } }

export interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] }
    scopeSpans: Array<{
      spans: OtlpSpan[]
    }>
  }>
}

// --- Keyed ID derivation (decision D1) ---
//
// Every identifier this payload emits is an HMAC-SHA256 digest keyed by the
// persisted host privacy key (privacy-key.ts) — never a bare SHA-256. An
// unkeyed digest of an identifier is confirmable by dictionary attack (guess
// the input, hash it, compare); keying makes that infeasible without the key.
// This mirrors core/fingerprint.ts, which requires a caller-supplied key for
// exactly this reason. Ids stay deterministic for a given host because the
// key is stable per install. The domain prefix separates roles so the same
// value in two positions can never produce the same digest; composite inputs
// are joined with the same ASCII Unit Separator (0x1f) core/fingerprint.ts
// uses, so a value containing ':' cannot forge a field boundary (host 'a' +
// user 'b:c' must not collide with host 'a:b' + user 'c').

// Field separator for composite HMAC inputs (ASCII Unit Separator), matching
// core/fingerprint.ts.
const SEP = String.fromCharCode(0x1f)

function keyedId(privacyKey: string, domain: string, parts: string[], len: number): string {
  if (!privacyKey) throw new Error('privacyKey is required')
  return createHmac('sha256', privacyKey)
    .update(`${domain}:${parts.join(SEP)}`)
    .digest('hex')
    .slice(0, len)
}

// --- Device ID (HMAC-keyed, stable) ---

let cachedDeviceId: string | null = null

/** Pure derivation — exposed so the encoding can be golden-pinned in tests. */
export function deriveDeviceId(privacyKey: string, host: string, username: string): string {
  return keyedId(privacyKey, 'sync-device', [host, username], 16)
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  cachedDeviceId = deriveDeviceId(getPersistedHostPrivacyKey(), hostname(), userInfo().username)
  return cachedDeviceId
}

// --- Span/Trace ID derivation (deterministic) ---

export function deriveSpanId(privacyKey: string, deduplicationKey: string): string {
  return keyedId(privacyKey, 'sync-span', [deduplicationKey], 16)
}

export function deriveTraceId(privacyKey: string, sessionId: string): string {
  return keyedId(privacyKey, 'sync-trace', [sessionId], 32)
}

// --- Timestamp conversion ---

function toUnixNano(isoTimestamp: string): string {
  const ms = new Date(isoTimestamp).getTime()
  if (isNaN(ms)) return '0'
  return (BigInt(ms) * 1_000_000n).toString()
}

// --- Payload construction ---

export interface CallWithSession {
  call: ParsedApiCall
  sessionId: string
  project: string
}

export function buildOtlpPayload(calls: CallWithSession[]): OtlpPayload {
  const deviceId = getDeviceId()
  const privacyKey = getPersistedHostPrivacyKey()

  const spans: OtlpSpan[] = calls.map(({ call, sessionId, project }) => {
    const startNano = toUnixNano(call.timestamp)
    // End time = start + 1ms (we don't have real duration, but OTLP requires both)
    const endNano = (BigInt(startNano) + 1_000_000n).toString()

    const attributes: OtlpAttribute[] = [
      { key: 'ai.provider', value: { stringValue: call.provider } },
      { key: 'ai.model', value: { stringValue: call.model } },
      { key: 'ai.input_tokens', value: { intValue: String(call.usage.inputTokens) } },
      { key: 'ai.output_tokens', value: { intValue: String(call.usage.outputTokens) } },
      { key: 'ai.cost_usd', value: { doubleValue: call.costUSD } },
      { key: 'ai.project', value: { stringValue: project } },
      { key: 'ai.speed', value: { stringValue: call.speed } },
    ]

    if (call.tools.length > 0) {
      attributes.push({
        key: 'ai.tools',
        value: { arrayValue: { values: call.tools.map(t => ({ stringValue: t })) } },
      })
    }

    // cost_estimated = true when provider reports char-based estimates
    const isEstimated = call.provider === 'kiro' || call.usage.inputTokens === 0
    attributes.push({ key: 'ai.cost_estimated', value: { boolValue: isEstimated } })

    return {
      traceId: deriveTraceId(privacyKey, sessionId),
      spanId: deriveSpanId(privacyKey, call.deduplicationKey),
      name: `${call.provider}/${call.model}`,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes,
    }
  })

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'codeburn.device_id', value: { stringValue: deviceId } },
        ],
      },
      scopeSpans: [{
        spans,
      }],
    }],
  }
}

/** Split calls into batches of maxBatchSize. */
export function batchCalls(calls: CallWithSession[], maxBatchSize: number): CallWithSession[][] {
  const batches: CallWithSession[][] = []
  for (let i = 0; i < calls.length; i += maxBatchSize) {
    batches.push(calls.slice(i, i + maxBatchSize))
  }
  return batches
}
