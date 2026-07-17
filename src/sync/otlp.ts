/**
 * codeburn sync — OTLP payload builder.
 *
 * Converts ParsedApiCall[] into an ExportTraceServiceRequest (OTLP/HTTP JSON).
 * Span and trace IDs are derived deterministically from deduplicationKey/sessionId.
 */

import { createHash } from 'crypto'
import { hostname, userInfo } from 'os'
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

// --- Device ID (pseudonymous, stable) ---

let cachedDeviceId: string | null = null

/** Pure derivation — exposed so the encoding can be golden-pinned in tests. */
export function deriveDeviceId(host: string, username: string): string {
  return createHash('sha256').update(`${host}:${username}`).digest('hex').slice(0, 16)
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  cachedDeviceId = deriveDeviceId(hostname(), userInfo().username)
  return cachedDeviceId
}

// --- Span/Trace ID derivation (deterministic) ---

export function deriveSpanId(deduplicationKey: string): string {
  return createHash('sha256').update(deduplicationKey).digest('hex').slice(0, 16)
}

export function deriveTraceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
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
      traceId: deriveTraceId(sessionId),
      spanId: deriveSpanId(call.deduplicationKey),
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
