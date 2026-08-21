// Minimizing transform: rich Kiro decode -> the strict observation envelope.
// Only opaque ids, fingerprints, enums, numbers, timestamps, and canonical tool
// names cross into the output — never the user message, project path, or raw
// tool names.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { KiroDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Kiro session's rich decode, as the host holds it before minimization. */
export interface RichKiroSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich, cost-free calls in decode order (as the kiro decoders emit them). */
  calls: KiroDecodedCall[]
}

export interface KiroToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema.
// This filter is the containment boundary for kiro's arbitrary tool names.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: KiroDecodedCall, turnIndex: number): CallObservation {
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
    costBasis: call.credits > 0 ? 'measured' : 'estimated',
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
  }
}

function toSessionObservation(decode: RichKiroSessionDecode, ctx: KiroToObservationsContext): SessionObservation {
  const provider = ctx.provider ?? 'kiro'
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
 * Map a rich Kiro decode (one or many sessions) into the minimized observation
 * layer. Returns the `sessions` array plus any per-record `diagnostics`.
 *
 * Content-smuggling guarantee: no free text (user message, project path,
 * arbitrary tool name) is ever copied into the result. Only fingerprints,
 * enums, numbers, timestamps, dedup keys, and canonical tool names cross the
 * boundary.
 */
export function toObservations(
  decode: RichKiroSessionDecode | RichKiroSessionDecode[],
  ctx: KiroToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
