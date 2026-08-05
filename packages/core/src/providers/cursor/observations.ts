// Minimizing transform: rich Cursor decode -> the strict observation envelope.
// Only opaque ids, fingerprints, enums, numbers, timestamps, and CANONICAL tool
// names cross into the output — never the user message, raw bash command, or
// project path.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { CursorDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Cursor session's rich decode, as the host holds it before minimization. */
export interface RichCursorSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  calls: CursorDecodedCall[]
}

export interface CursorToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema. A name
// that does not match is dropped rather than emitted. For Cursor this filters
// the synthetic 'cursor:edit' and 'lang:<anything>' entries (both contain a
// colon) while letting through canonical names like 'Bash' and 'Read'.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: CursorDecodedCall, turnIndex: number): CallObservation {
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
    // Cursor calls are estimated from token buckets by the host's pricing table;
    // they carry no provider-reported dollar figure.
    costBasis: 'estimated',
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
  }
}

function toSessionObservation(
  decode: RichCursorSessionDecode,
  ctx: CursorToObservationsContext,
): SessionObservation {
  const provider = ctx.provider ?? 'cursor'
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
 * Map a rich Cursor decode (one or many sessions) into the minimized
 * observation layer. Returns the `sessions` array plus any per-record
 * `diagnostics`.
 *
 * Content-smuggling guarantee: no free text (user message, cwd, project path,
 * raw command) is ever copied into the result. Only fingerprints, enums,
 * numbers, timestamps, dedup keys, and canonical tool names cross the boundary.
 */
export function toObservations(
  decode: RichCursorSessionDecode | RichCursorSessionDecode[],
  ctx: CursorToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
