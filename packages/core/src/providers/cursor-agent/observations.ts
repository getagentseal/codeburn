// Minimizing transform: rich Cursor Agent decode -> the strict observation
// envelope. Only opaque ids, fingerprints, enums, numbers, timestamps, and
// CANONICAL tool names cross into the output — never the user message, project
// path, or shell command.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { CursorAgentDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Cursor Agent session's rich decode, as the host holds it before minimization. */
export interface RichCursorAgentSessionDecode {
  sessionId: string
  /** Absolute project path (the session cwd); fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich, cost-free calls in decode order (as decodeCursorAgent emits them). */
  calls: CursorAgentDecodedCall[]
}

export interface CursorAgentToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema. A name
// that does not match (a provider-native id with a colon, an argument blob) is
// dropped rather than emitted.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: CursorAgentDecodedCall, turnIndex: number): CallObservation {
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
    // Cursor Agent calls are priced from token buckets by the host's pricing table;
    // they carry no provider-reported dollar figure.
    costBasis: 'estimated',
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
  }
}

function toSessionObservation(
  decode: RichCursorAgentSessionDecode,
  ctx: CursorAgentToObservationsContext,
): SessionObservation {
  const provider = ctx.provider ?? 'cursor-agent'
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
 * Map a rich Cursor Agent decode (one or many sessions) into the minimized
 * observation layer. Returns the `sessions` array plus any per-record
 * `diagnostics`.
 *
 * Content-smuggling guarantee: no free text (user message, cwd, project path,
 * command) is ever copied into the result. Only fingerprints, enums, numbers,
 * timestamps, dedup keys, and canonical tool names cross the boundary.
 */
export function toObservations(
  decode: RichCursorAgentSessionDecode | RichCursorAgentSessionDecode[],
  ctx: CursorAgentToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
