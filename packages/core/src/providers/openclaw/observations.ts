// Minimizing transform: rich OpenClaw decode -> the strict observation envelope.
// Only opaque ids, fingerprints, enums, numbers, timestamps, and canonical tool
// names cross into the output — never the user message, project path, or shell
// command.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { OpenClawDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One OpenClaw session's rich decode, as the host holds it before minimization. */
export interface RichOpenClawSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich, cost-free calls in decode order (as decodeOpenClaw emits them). */
  calls: OpenClawDecodedCall[]
}

export interface OpenClawToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: OpenClawDecodedCall, turnIndex: number, privacyKey: string): CallObservation {
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
    costBasis: call.costBasis,
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
  }
}

function toSessionObservation(decode: RichOpenClawSessionDecode, ctx: OpenClawToObservationsContext): SessionObservation {
  const provider = ctx.provider ?? 'openclaw'
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
 * Map a rich OpenClaw decode (one or many sessions) into the minimized observation
 * layer. Returns the `sessions` array plus any per-record `diagnostics`.
 *
 * Content-smuggling guarantee: no free text (user message, project path,
 * command) is ever copied into the result. Only fingerprints, enums, numbers,
 * timestamps, dedup keys, and canonical tool names cross the boundary.
 */
export function toObservations(
  decode: RichOpenClawSessionDecode | RichOpenClawSessionDecode[],
  ctx: OpenClawToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
