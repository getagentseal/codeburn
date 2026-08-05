// Minimizing transform: rich Vercel AI Gateway decode -> the strict observation
// envelope. This is where the content-smuggling guarantees bind.
//
// Vercel Gateway reports contain no free-text user content. The only string
// fields that cross into the envelope are machine identifiers:
//   - `provider` is emitted by design under the identifier-exemption
//     convention (see architecture-gate.test.ts MACHINE_ID_ALLOWLIST).
//   - `model` is externally supplied (the fetched report) and is normalized at
//     this boundary: values inside the ModelIdentifier charset cross unchanged,
//     anything else (a hostile prompt, a display name) collapses to 'unknown',
//     so a bad model can never reject the whole envelope.
//   - `day` is an API-supplied calendar date. It IS emitted, verbatim, inside the
//     synthesized timestamp and the dedup key. The envelope's `format: date-time`
//     constraint on every timestamp is what bounds it: a `day` that is not a real
//     date fails envelope validation, so a hostile value cannot ship.
// No host-held user prompt, tools, bashCommands, file paths, or command lines
// exist at this layer.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { VercelGatewayDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Vercel Gateway report's rich decode, as the host holds it before minimization. */
export interface RichVercelGatewaySessionDecode {
  sessionId: string
  /** Discovered project label (fingerprinted, never emitted raw). */
  projectPath: string
  /** Rich, cost-carrying calls in decode order (as decodeVercelGateway emits them). */
  calls: VercelGatewayDecodedCall[]
}

export interface VercelGatewayToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

function toCallObservation(call: VercelGatewayDecodedCall, turnIndex: number): CallObservation {
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
    // The provider reports a measured dollar figure directly from the API.
    costBasis: 'measured',
    measuredCostUSD: call.costUSD,
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: [],
    turnIndex,
  }
}

function toSessionObservation(
  decode: RichVercelGatewaySessionDecode,
  ctx: VercelGatewayToObservationsContext,
): SessionObservation {
  const provider = ctx.provider ?? 'vercel-gateway'
  const calls = decode.calls.map((call, i) => toCallObservation(call, i))

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
 * Map a rich Vercel Gateway decode into the minimized observation layer.
 * Returns the `sessions` array plus any per-record `diagnostics` (none for this
 * provider).
 *
 * Content-smuggling guarantee: no free text (host-held user prompt, project
 * path, command, file path, tool argument) is ever copied into the result. Only
 * fingerprints, enums, numbers, timestamps, dedup keys, and the API model
 * identifier cross the boundary under the identifier-exemption convention.
 */
export function toObservations(
  decode: RichVercelGatewaySessionDecode | RichVercelGatewaySessionDecode[],
  ctx: VercelGatewayToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
