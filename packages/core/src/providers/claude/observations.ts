// Minimizing transform: rich Claude decode -> the strict Phase-2 observation
// envelope. This is where the content-smuggling guarantees bind. Only opaque
// ids, fingerprints, enums, numbers, timestamps, and CANONICAL tool names cross
// into the output — never user text, titles, paths, commands, or tool
// arguments. `.strict()` on the schemas rejects any extra field; this transform
// simply never emits one.

import { branchRef, projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import { extractResourceRefs } from '../resource-refs.js'
import type { DecodedCall, DecodedTurn } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One session's rich decode, as the host holds it before minimization. */
export interface RichSessionDecode {
  sessionId: string
  /** Absolute project path; fingerprinted, never emitted raw. */
  projectPath: string
  /** Raw git branch; fingerprinted, never emitted raw. */
  gitBranch?: string
  isSidechain?: boolean
  turns: DecodedTurn[]
}

export interface ToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema. A tool
// name that does not match (a smuggled command with spaces/slashes, an argument
// blob) is dropped rather than emitted — the structural anti-smuggling property
// enforced at the source, so the output also survives strict schema parse.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: DecodedCall, turnIndex: number, privacyKey: string): CallObservation {
  return {
    provider: call.provider,
    model: normalizeModelIdentifier(call.model),
    tokens: {
      input: call.usage.inputTokens,
      output: call.usage.outputTokens,
      reasoning: call.usage.reasoningTokens,
      cacheRead: call.usage.cacheReadInputTokens,
      cacheCreate: call.usage.cacheCreationInputTokens,
    },
    webSearchRequests: call.usage.webSearchRequests,
    speed: call.speed,
    // Claude native calls are priced from token buckets by the host's pricing
    // table; they carry no provider-reported dollar figure.
    costBasis: 'estimated',
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
    ...(call.locAdded !== undefined ? { locAdded: call.locAdded } : {}),
    ...(call.locRemoved !== undefined ? { locRemoved: call.locRemoved } : {}),
    ...(call.interrupted !== undefined ? { interrupted: call.interrupted } : {}),
    ...(call.userModified !== undefined ? { userModified: call.userModified } : {}),
    ...(call.toolErrors !== undefined ? { toolErrors: call.toolErrors } : {}),
    ...extractResourceRefs(privacyKey, call.toolSequence),
  }
}

function toSessionObservation(decode: RichSessionDecode, ctx: ToObservationsContext): SessionObservation {
  const provider = ctx.provider ?? 'claude'
  const calls: CallObservation[] = []
  decode.turns.forEach((turn, turnIndex) => {
    for (const call of turn.assistantCalls) calls.push(toCallObservation(call, turnIndex, ctx.privacyKey))
  })

  const timestamps = calls.map(c => c.timestamp).filter(t => t.length > 0).sort()
  const fallbackTs = decode.turns.find(t => t.timestamp)?.timestamp ?? ''
  const startedAt = timestamps[0] ?? fallbackTs
  const endedAt = timestamps.length > 0 ? timestamps[timestamps.length - 1]! : fallbackTs

  const session: SessionObservation = {
    sessionRef: sessionRef(ctx.privacyKey, provider, decode.sessionId),
    projectRef: projectRef(ctx.privacyKey, decode.projectPath),
    providerId: provider,
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(decode.gitBranch ? { gitBranchRef: branchRef(ctx.privacyKey, decode.gitBranch) } : {}),
    ...(decode.isSidechain !== undefined ? { isSidechain: decode.isSidechain } : {}),
    calls,
    turnCount: decode.turns.length,
  }
  return session
}

/**
 * Map a rich Claude decode (one or many sessions) into the minimized
 * observation layer. Returns the `sessions` array plus any per-record
 * `diagnostics` — the caller wraps these into an ObservationEnvelope.
 *
 * Content-smuggling guarantee: no free text (user message, title, path,
 * command, tool argument, file content) is ever copied into the result. Only
 * fingerprints, enums, numbers, timestamps, dedup keys, and canonical tool
 * names cross the boundary.
 */
export function toObservations(
  decode: RichSessionDecode | RichSessionDecode[],
  ctx: ToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
