// Minimizing transform: rich CodeWhale decode -> the strict observation envelope.
//
// Only opaque ids, fingerprints, enums, numbers, timestamps, and canonical tool
// names cross into the output. Project paths are fingerprinted; user messages,
// commands, and file paths stay behind.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import { extractResourceRefs } from '../resource-refs.js'
import type { CodeWhaleDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One CodeWhale session's rich decode, as the host holds it before minimization. */
export interface RichCodeWhaleSessionDecode {
  sessionId: string
  /** Absolute project path (the session workspace); fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich, cost-free calls in decode order (CodeWhale emits one per session). */
  calls: CodeWhaleDecodedCall[]
}

export interface CodeWhaleToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: CodeWhaleDecodedCall, turnIndex: number, privacyKey: string): CallObservation {
  const obs: CallObservation = {
    provider: call.provider,
    model: normalizeModelIdentifier(call.model),
    tokens: {
      input: call.inputTokens,
      output: call.outputTokens,
      reasoning: call.reasoningTokens,
      cacheRead: call.cacheReadInputTokens,
      cacheCreate: call.cacheCreationInputTokens,
    },
    webSearchRequests: call.webSearchRequests,
    speed: call.speed,
    costBasis: call.measuredCostUSD !== undefined ? 'measured' : 'estimated',
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
    ...extractResourceRefs(privacyKey, call.toolSequence),
  }
  if (call.measuredCostUSD !== undefined) {
    ;(obs as CallObservation & { measuredCostUSD: number }).measuredCostUSD = call.measuredCostUSD
  }
  return obs
}

function toSessionObservation(
  decode: RichCodeWhaleSessionDecode,
  ctx: CodeWhaleToObservationsContext,
): SessionObservation {
  const provider = ctx.provider ?? 'codewhale'
  const calls: CallObservation[] = decode.calls.map((call, i) => toCallObservation(call, i, ctx.privacyKey))

  const timestamps = calls.map(c => c.timestamp).filter(t => t.length > 0).sort()
  const startedAt = timestamps[0] ?? ''
  const endedAt = timestamps.length > 0 ? timestamps[timestamps.length - 1]! : ''

  const session: SessionObservation = {
    sessionRef: sessionRef(ctx.privacyKey, provider, decode.sessionId),
    projectRef: projectRef(ctx.privacyKey, decode.projectPath),
    providerId: provider,
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    calls,
    turnCount: calls.length,
  }
  return session
}

/**
 * Map a rich CodeWhale decode into the minimized observation layer. Returns the
 * `sessions` array plus any per-record `diagnostics`.
 */
export function toObservations(
  decode: RichCodeWhaleSessionDecode | RichCodeWhaleSessionDecode[],
  ctx: CodeWhaleToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
