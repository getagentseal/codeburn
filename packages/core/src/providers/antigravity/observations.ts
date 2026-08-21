// Minimizing transform: rich Antigravity decode -> the strict observation
// envelope. Only opaque ids, fingerprints, enums, numbers, timestamps, and
// canonical tool names cross into the output. Antigravity never records file
// paths and has no tool calls, so projectPath is fingerprinted and toolNames is
// always empty.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { AntigravityDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Antigravity cascade's rich decode, as the host holds it before minimization. */
export interface RichAntigravitySessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  calls: AntigravityDecodedCall[]
}

export interface AntigravityToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

function toCallObservation(call: AntigravityDecodedCall, turnIndex: number): CallObservation {
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
    // Antigravity records carry no tool calls at all, so there is nothing to
    // filter through a canonical-name gate here.
    toolNames: [],
    turnIndex,
  }
}

function toSessionObservation(
  decode: RichAntigravitySessionDecode,
  ctx: AntigravityToObservationsContext,
): SessionObservation {
  const provider = ctx.provider ?? 'antigravity'
  const calls: CallObservation[] = decode.calls.map((call, i) => toCallObservation(call, i))

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
 * Map a rich Antigravity decode (one or many cascades) into the minimized
 * observation layer. Returns the `sessions` array plus any per-record
 * `diagnostics`.
 */
export function toObservations(
  decode: RichAntigravitySessionDecode | RichAntigravitySessionDecode[],
  ctx: AntigravityToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
