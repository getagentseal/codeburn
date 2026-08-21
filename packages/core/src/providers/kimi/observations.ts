// Minimizing transform: rich Kimi decode -> the strict observation envelope.
//
// Only opaque ids, fingerprints, enums, numbers, timestamps, and canonical tool
// names cross into the output. The user message and raw bash commands stay
// behind.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { KimiDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Kimi session's rich decode, as the host holds it before minimization. */
export interface RichKimiSessionDecode {
  sessionId: string
  /** Kimi does not record a project path; an empty path is fingerprinted. */
  projectPath: string
  /** Rich, cost-free calls in decode order. */
  calls: KimiDecodedCall[]
}

export interface KimiToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: KimiDecodedCall, turnIndex: number, privacyKey: string): CallObservation {
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
    costBasis: 'estimated',
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
  }
}

function toSessionObservation(decode: RichKimiSessionDecode, ctx: KimiToObservationsContext): SessionObservation {
  const provider = ctx.provider ?? 'kimi'
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
 * Map a rich Kimi decode into the minimized observation layer. Returns the
 * `sessions` array plus any per-record `diagnostics`.
 */
export function toObservations(
  decode: RichKimiSessionDecode | RichKimiSessionDecode[],
  ctx: KimiToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
