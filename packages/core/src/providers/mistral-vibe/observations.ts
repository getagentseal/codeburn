// Minimizing transform: rich Mistral Vibe decode -> the strict observation
// envelope. Only opaque ids, fingerprints, enums, numbers, timestamps, dedup
// keys, and canonical tool names cross into the output. Mistral Vibe captures a
// user message and raw bash command strings, but those stay in the rich decode;
// they are never copied into the minimized envelope.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { MistralVibeDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Mistral Vibe session's rich decode, as the host holds it before minimization. */
export interface RichMistralVibeSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich calls in decode order (as decodeMistralVibe emits them). */
  calls: MistralVibeDecodedCall[]
}

export interface MistralVibeToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema. A name
// that does not match (a provider-native id with a slash, an argument blob) is
// dropped rather than emitted.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: MistralVibeDecodedCall, turnIndex: number): CallObservation {
  return {
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
    costBasis: 'measured',
    measuredCostUSD: call.measuredCostUSD,
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
  }
}

function toSessionObservation(
  decode: RichMistralVibeSessionDecode,
  ctx: MistralVibeToObservationsContext,
): SessionObservation {
  const provider = ctx.provider ?? 'mistral-vibe'
  const calls: CallObservation[] = decode.calls.map((call, i) => toCallObservation(call, i))

  const timestamps = calls.map(c => c.timestamp).filter(t => t.length > 0).sort()
  const startedAt = timestamps[0] ?? ''
  const endedAt = timestamps.length > 0 ? timestamps[timestamps.length - 1]! : ''

  return {
    sessionRef: sessionRef(ctx.privacyKey, provider, decode.sessionId),
    projectRef: projectRef(ctx.privacyKey, decode.projectPath),
    providerId: provider,
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    calls,
    turnCount: calls.length,
  }
}

/**
 * Map a rich Mistral Vibe decode (one or many sessions) into the minimized
 * observation layer. Returns the `sessions` array plus any per-record
 * `diagnostics`.
 */
export function toObservations(
  decode: RichMistralVibeSessionDecode | RichMistralVibeSessionDecode[],
  ctx: MistralVibeToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
