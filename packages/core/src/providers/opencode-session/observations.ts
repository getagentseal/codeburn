// Minimizing transform: rich OpenCode-session decode -> the strict observation envelope.
//
// Only opaque ids, fingerprints, enums, numbers, timestamps, and canonical tool
// names cross into the output. The OpenCode-session decoder captures free-text
// fields for the HOST, but they are deliberately absent here.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { OpenCodeSessionDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One OpenCode-session decode, as the host holds it before minimization. */
export interface RichOpenCodeSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich calls in decode order. */
  calls: OpenCodeSessionDecodedCall[]
}

export interface OpenCodeSessionToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: OpenCodeSessionDecodedCall, turnIndex: number): CallObservation {
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

function toSessionObservation(
  decode: RichOpenCodeSessionDecode,
  ctx: OpenCodeSessionToObservationsContext,
): SessionObservation {
  const provider = ctx.provider ?? 'opencode'
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
 * Map a rich OpenCode-session decode into the minimized observation layer.
 * Returns the `sessions` array plus any per-record `diagnostics`.
 */
export function toObservations(
  decode: RichOpenCodeSessionDecode | RichOpenCodeSessionDecode[],
  ctx: OpenCodeSessionToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
