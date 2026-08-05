// Minimizing transform: rich Forge decode -> the strict observation envelope.
// Only opaque ids, fingerprints, enums, numbers, timestamps, and canonical tool
// names cross into the output — never the user message or a bash command line.
// Forge never captures file targets for its tool calls, so there is nothing to
// fingerprint into resourceReads/resourceEdits.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import type { ForgeDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Forge conversation's rich decode, as the host holds it before minimization. */
export interface RichForgeSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich calls in decode order (one per assistant message with usage). */
  calls: ForgeDecodedCall[]
}

export interface ForgeToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: ForgeDecodedCall, turnIndex: number): CallObservation {
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

function toSessionObservation(decode: RichForgeSessionDecode, ctx: ForgeToObservationsContext): SessionObservation {
  const provider = ctx.provider ?? 'forge'
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
 * Map a rich Forge decode (one or many conversations) into the minimized
 * observation layer. Returns the `sessions` array plus any per-record
 * `diagnostics`.
 */
export function toObservations(
  decode: RichForgeSessionDecode | RichForgeSessionDecode[],
  ctx: ForgeToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
