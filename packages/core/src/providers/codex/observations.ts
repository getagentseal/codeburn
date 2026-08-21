// Minimizing transform: rich Codex decode -> the strict observation envelope.
// This is where the content-smuggling guarantees bind. Only opaque ids,
// fingerprints, enums, numbers, timestamps, and CANONICAL tool names cross into
// the output — never the user message, the cwd/project path, a shell command, an
// edited file path, or a tool argument. `.strict()` on the schemas rejects any
// extra field; this transform simply never emits one.

import { projectRef, sessionRef } from '../../fingerprint.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type { CallObservation, SessionObservation } from '../../observations.js'
import { extractResourceRefs } from '../resource-refs.js'
import type { CodexDecodedCall } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

/** One Codex session's rich decode, as the host holds it before minimization. */
export interface RichCodexSessionDecode {
  sessionId: string
  /** Absolute project path (the session cwd); fingerprinted, never emitted raw. */
  projectPath: string
  /** Rich, cost-free calls in decode order (as decodeCodex emits them). */
  calls: CodexDecodedCall[]
}

export interface CodexToObservationsContext {
  /** HMAC key that scopes every fingerprint. */
  privacyKey: string
  /** Provider id stamped onto sessions/calls and folded into sessionRef. */
  provider?: string
}

// Canonical tool-name charset, mirroring core's CanonicalToolName schema. A name
// that does not match (a smuggled command with spaces/slashes, an argument blob)
// is dropped rather than emitted.
const CANONICAL_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function toCallObservation(call: CodexDecodedCall, turnIndex: number, privacyKey: string): CallObservation {
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
    // Codex calls are priced from token buckets by the host's pricing table;
    // they carry no provider-reported dollar figure.
    costBasis: 'estimated',
    timestamp: call.timestamp,
    dedupKey: call.deduplicationKey,
    toolNames: call.tools.filter(t => CANONICAL_TOOL_NAME.test(t)),
    turnIndex,
    ...(call.locAdded !== undefined ? { locAdded: call.locAdded } : {}),
    ...(call.locRemoved !== undefined ? { locRemoved: call.locRemoved } : {}),
    ...(call.editFailed !== undefined ? { editFailed: call.editFailed } : {}),
    ...extractResourceRefs(privacyKey, call.toolSequence),
  }
}

function toSessionObservation(decode: RichCodexSessionDecode, ctx: CodexToObservationsContext): SessionObservation {
  const provider = ctx.provider ?? 'codex'
  const calls: CallObservation[] = []
  // Assign a turnIndex by grouping consecutive calls that share a turnId, so the
  // raw turnId string (which embeds the session id) never crosses the boundary.
  let turnIndex = -1
  let lastTurnId: string | undefined
  let turnCount = 0
  for (const call of decode.calls) {
    if (call.turnId !== lastTurnId) {
      turnIndex++
      turnCount++
      lastTurnId = call.turnId
    }
    calls.push(toCallObservation(call, turnIndex, ctx.privacyKey))
  }

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
    turnCount,
  }
  return session
}

/**
 * Map a rich Codex decode (one or many sessions) into the minimized observation
 * layer. Returns the `sessions` array plus any per-record `diagnostics`.
 *
 * Content-smuggling guarantee: no free text (user message, cwd, project path,
 * command, edited file path, tool argument) is ever copied into the result. Only
 * fingerprints, enums, numbers, timestamps, dedup keys, and canonical tool names
 * cross the boundary.
 */
export function toObservations(
  decode: RichCodexSessionDecode | RichCodexSessionDecode[],
  ctx: CodexToObservationsContext,
): { sessions: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const decodes = Array.isArray(decode) ? decode : [decode]
  const sessions = decodes.map(d => toSessionObservation(d, ctx))
  return { sessions, diagnostics: [] }
}
