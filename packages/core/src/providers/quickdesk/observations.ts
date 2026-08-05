// Minimizing transform: rich Quickdesk decode -> the strict observation envelope.
// Only opaque ids, fingerprints, enums, numbers, timestamps, and CANONICAL tool
// names cross into the output — never the user message, project path, or shell
// command.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { QuickdeskDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Quickdesk session's rich decode, as the host holds it before minimization. */
export interface RichQuickdeskSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich, cost-free calls in decode order (as decodeQuickdesk emits them). */
  calls: QuickdeskDecodedCall[]
}

export interface QuickdeskToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema. A name
// that does not match (a smuggled command with spaces/slashes, an argument blob)
// is dropped rather than emitted.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: QuickdeskDecodedCall, turnIndex: number, privacyKey: string): CallObservation {
  const measured = call.recordedCost !== undefined
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
    costBasis: measured ? 'measured' : 'estimated',
    ...(measured ? { measuredCostUSD: call.recordedCost } : {}),
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
  }
}

function toSessionObservation(decode: RichQuickdeskSessionDecode, ctx: QuickdeskToObservationsContext): SessionObservation {
  const provider = ctx.provider ?? 'quickdesk'
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
 * Map a rich Quickdesk decode (one or many sessions) into the minimized observation
 * layer. Returns the `sessions` array plus any per-record `diagnostics`.
 *
 * Content-smuggling guarantee: no free text (user message, project path, command,
 * or tool argument) is ever copied into the result. Only fingerprints, enums,
 * numbers, timestamps, dedup keys, and canonical tool names cross the boundary.
 */
export function toObservations(
  decode: RichQuickdeskSessionDecode | RichQuickdeskSessionDecode[],
  ctx: QuickdeskToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
