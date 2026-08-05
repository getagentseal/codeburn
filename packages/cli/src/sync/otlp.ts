/**
 * codeburn sync — OTLP payload builder.
 *
 * Converts ParsedApiCall[] into an ExportTraceServiceRequest (OTLP/HTTP JSON).
 * Span and trace IDs are derived deterministically from deduplicationKey/sessionId
 * under the persisted host privacy key.
 *
 * NOTE: not a pure converter. The first call reads — and, if absent, creates —
 * the persisted privacy key via privacy-key.ts, so it does synchronous
 * filesystem I/O and can THROW. Sync aborts the push when the key cannot be
 * persisted or an existing key file is corrupt, because cross-process id
 * stability (and with it the partial-rejection retry safety in push.ts)
 * depends on a real on-disk key rather than per-process randomness.
 */

import { createHmac, createHash } from 'crypto'
import { hostname, userInfo } from 'os'
import { getPersistedHostPrivacyKey } from '../privacy-key.js'
import type { ParsedApiCall } from '../types.js'
import type { SessionAttributionRecord } from '../yield.js'

export interface OtlpSpan {
  traceId: string
  spanId: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
}

export interface OtlpAttribute {
  key: string
  value: OtlpValue
}

export type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpValue[] } }

export interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] }
    scopeSpans: Array<{
      spans: OtlpSpan[]
    }>
  }>
}

// --- Keyed ID derivation (decision D1) ---
//
// Every identifier this payload emits is an HMAC-SHA256 digest keyed by the
// persisted host privacy key (privacy-key.ts) — never a bare SHA-256. An
// unkeyed digest of an identifier is confirmable by dictionary attack (guess
// the input, hash it, compare); keying makes that infeasible without the key.
// This mirrors core/fingerprint.ts, which requires a caller-supplied key for
// exactly this reason. Ids stay deterministic for a given host because the
// key is stable per install. The domain prefix separates roles so the same
// value in two positions can never produce the same digest; composite inputs
// are joined with the same ASCII Unit Separator (0x1f) core/fingerprint.ts
// uses, so a value containing ':' cannot forge a field boundary (host 'a' +
// user 'b:c' must not collide with host 'a:b' + user 'c').

// Field separator for composite HMAC inputs (ASCII Unit Separator), matching
// core/fingerprint.ts.
const SEP = String.fromCharCode(0x1f)

function keyedId(privacyKey: string, domain: string, parts: string[], len: number): string {
  if (!privacyKey) throw new Error('privacyKey is required')
  return createHmac('sha256', privacyKey)
    .update(`${domain}:${parts.join(SEP)}`)
    .digest('hex')
    .slice(0, len)
}

// --- Device ID (HMAC-keyed, stable) ---

let cachedDeviceId: string | null = null

/** Pure derivation — exposed so the encoding can be golden-pinned in tests. */
export function deriveDeviceId(privacyKey: string, host: string, username: string): string {
  return keyedId(privacyKey, 'sync-device', [host, username], 16)
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  cachedDeviceId = deriveDeviceId(getPersistedHostPrivacyKey(), hostname(), userInfo().username)
  return cachedDeviceId
}

// --- Span/Trace ID derivation (deterministic) ---

export function deriveSpanId(privacyKey: string, deduplicationKey: string): string {
  return keyedId(privacyKey, 'sync-span', [deduplicationKey], 16)
}

export function deriveTraceId(privacyKey: string, sessionId: string): string {
  return keyedId(privacyKey, 'sync-trace', [sessionId], 32)
}

// --- Timestamp conversion ---

function toUnixNano(isoTimestamp: string): string {
  const ms = new Date(isoTimestamp).getTime()
  if (isNaN(ms)) return '0'
  return (BigInt(ms) * 1_000_000n).toString()
}

// --- Payload construction ---

export interface CallWithSession {
  call: ParsedApiCall
  sessionId: string
  project: string
}

export function buildOtlpPayload(calls: CallWithSession[]): OtlpPayload {
  const deviceId = getDeviceId()
  const privacyKey = getPersistedHostPrivacyKey()

  const spans: OtlpSpan[] = calls.map(({ call, sessionId, project }) => {
    const startNano = toUnixNano(call.timestamp)
    // End time = start + 1ms (we don't have real duration, but OTLP requires both)
    const endNano = (BigInt(startNano) + 1_000_000n).toString()

    const attributes: OtlpAttribute[] = [
      { key: 'ai.provider', value: { stringValue: call.provider } },
      { key: 'ai.model', value: { stringValue: call.model } },
      { key: 'ai.input_tokens', value: { intValue: String(call.usage.inputTokens) } },
      { key: 'ai.output_tokens', value: { intValue: String(call.usage.outputTokens) } },
      { key: 'ai.cost_usd', value: { doubleValue: call.costUSD } },
      { key: 'ai.project', value: { stringValue: project } },
      { key: 'ai.speed', value: { stringValue: call.speed } },
    ]

    if (call.tools.length > 0) {
      attributes.push({
        key: 'ai.tools',
        value: { arrayValue: { values: call.tools.map(t => ({ stringValue: t })) } },
      })
    }

    // cost_estimated = true when provider reports char-based estimates
    const isEstimated = call.provider === 'kiro' || call.usage.inputTokens === 0
    attributes.push({ key: 'ai.cost_estimated', value: { boolValue: isEstimated } })

    return {
      traceId: deriveTraceId(privacyKey, sessionId),
      spanId: deriveSpanId(privacyKey, call.deduplicationKey),
      name: `${call.provider}/${call.model}`,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes,
    }
  })

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'codeburn.device_id', value: { stringValue: deviceId } },
        ],
      },
      scopeSpans: [{
        spans,
      }],
    }],
  }
}

/** Split calls into batches of maxBatchSize. */
export function batchCalls(calls: CallWithSession[], maxBatchSize: number): CallWithSession[][] {
  const batches: CallWithSession[][] = []
  for (let i = 0; i < calls.length; i += maxBatchSize) {
    batches.push(calls.slice(i, i + maxBatchSize))
  }
  return batches
}

// --- Attribution spans (sync push --attribution) ---

export const SESSION_ATTRIBUTION_SPAN_NAME = 'codeburn.session.attribution'
export const COMMIT_ATTRIBUTION_SPAN_NAME = 'codeburn.commit'

/**
 * A single ledger-able attribution unit: either one session-level record
 * (repo + PR links + commit count) or one attributed commit. The dedup key
 * encodes the mutable state (inMain/wasReverted for commits; repo, PR links,
 * and commit set for sessions), so a state TRANSITION mints a new key and the
 * updated fact is re-sent on the next push — the receiver upserts by
 * (repo, sha) / (session). Identical states dedupe via the sent-ledger.
 */
export type AttributionItem = {
  kind: 'session' | 'commit'
  dedupKey: string
  /** Span start: commit author time for commits, session start for sessions. ISO 8601. */
  timestamp: string
  /** Span end for session items (session lastTimestamp). Absent for commits. */
  endTimestamp?: string
  sessionId: string
  project: string
  repo: string | null
  // session kind
  prLinks?: string[]
  commitCount?: number
  // commit kind
  sha?: string
  inMain?: boolean
  wasReverted?: boolean
}

/**
 * Local ledger discriminator over the session's public state (repo, project,
 * window timestamps, PR links, commit states). Deliberately NOT keyed: every
 * value it compresses rides the same payload in cleartext, and the dedup key
 * it feeds never leaves the machine — the wire id is the HMAC of that key
 * under the privacy key (keyedId above), so keying stateHash too would add
 * nothing. It exists only to mint a fresh dedup key when the state changes.
 */
function stateHash(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001e')).digest('hex').slice(0, 16)
}

/** Deterministic dedup key for a commit attribution fact (state included). */
export function commitAttributionKey(sessionId: string, sha: string, inMain: boolean, wasReverted: boolean): string {
  return `attr:c:${sessionId}:${sha}:${inMain ? 1 : 0}${wasReverted ? 1 : 0}`
}

/** Deterministic dedup key for a session attribution fact (state included). */
export function sessionAttributionKey(record: SessionAttributionRecord): string {
  const commitStates = record.commits
    .map(c => `${c.sha}:${c.inMain ? 1 : 0}${c.wasReverted ? 1 : 0}`)
    .sort()
  // Project and both window timestamps are part of the state: an ongoing
  // session whose window grew (or whose project resolution changed) re-emits
  // with the corrected span times instead of freezing at first send.
  return `attr:s:${record.sessionId}:${stateHash([
    record.repo ?? '',
    record.project,
    record.firstTimestamp,
    record.lastTimestamp,
    ...record.prLinks,
    ...commitStates,
  ])}`
}

/** Ledger-key prefix for a session's attribution facts (any state). */
export function sessionAttributionKeyPrefix(sessionId: string): string {
  return `attr:s:${sessionId}:`
}

/** Flatten attribution records into ledger-able items (one session item + one per commit). */
export function flattenAttributionRecords(records: SessionAttributionRecord[]): AttributionItem[] {
  const items: AttributionItem[] = []
  for (const record of records) {
    items.push({
      kind: 'session',
      dedupKey: sessionAttributionKey(record),
      timestamp: record.firstTimestamp,
      endTimestamp: record.lastTimestamp,
      sessionId: record.sessionId,
      project: record.project,
      repo: record.repo,
      prLinks: record.prLinks,
      commitCount: record.commits.length,
    })
    for (const commit of record.commits) {
      items.push({
        kind: 'commit',
        dedupKey: commitAttributionKey(record.sessionId, commit.sha, commit.inMain, commit.wasReverted),
        timestamp: commit.timestamp,
        sessionId: record.sessionId,
        project: record.project,
        repo: record.repo,
        sha: commit.sha,
        inMain: commit.inMain,
        wasReverted: commit.wasReverted,
      })
    }
  }
  return items
}

/**
 * Build an OTLP payload from attribution items. Spans share the session's
 * traceId with the usage spans (`deriveTraceId(privacyKey, sessionId)`), so a
 * receiver can correlate cost and attribution without any extra key.
 */
export function buildAttributionOtlpPayload(items: AttributionItem[]): OtlpPayload {
  const deviceId = getDeviceId()
  const privacyKey = getPersistedHostPrivacyKey()

  const spans: OtlpSpan[] = items.map(item => {
    const startNano = toUnixNano(item.timestamp)
    // Clamp like the usage builder: end is never 0 (malformed timestamp) and
    // never earlier than start + 1ms (out-of-order session timestamps).
    const minEndNano = BigInt(startNano) + 1_000_000n
    const rawEndNano = item.endTimestamp ? BigInt(toUnixNano(item.endTimestamp)) : 0n
    const endNano = (rawEndNano > minEndNano ? rawEndNano : minEndNano).toString()

    const attributes: OtlpAttribute[] = [
      { key: 'ai.session_id', value: { stringValue: item.sessionId } },
      { key: 'ai.project', value: { stringValue: item.project } },
    ]
    if (item.repo) {
      attributes.push({ key: 'git.repo', value: { stringValue: item.repo } })
    }

    if (item.kind === 'commit') {
      attributes.push(
        { key: 'git.sha', value: { stringValue: item.sha ?? '' } },
        { key: 'git.in_main', value: { boolValue: item.inMain ?? false } },
        { key: 'git.was_reverted', value: { boolValue: item.wasReverted ?? false } },
      )
    } else {
      attributes.push({ key: 'git.commit_count', value: { intValue: String(item.commitCount ?? 0) } })
      if (item.prLinks && item.prLinks.length > 0) {
        attributes.push({
          key: 'git.pr_links',
          value: { arrayValue: { values: item.prLinks.map(u => ({ stringValue: u })) } },
        })
      }
    }

    return {
      traceId: deriveTraceId(privacyKey, item.sessionId),
      spanId: deriveSpanId(privacyKey, item.dedupKey),
      name: item.kind === 'commit' ? COMMIT_ATTRIBUTION_SPAN_NAME : SESSION_ATTRIBUTION_SPAN_NAME,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes,
    }
  })

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'codeburn.device_id', value: { stringValue: deviceId } },
          // Honesty marker: this attribution is inferred (timestamp-window
          // correlation), not declared. Receivers should label it as such.
          { key: 'codeburn.attribution_methodology', value: { stringValue: 'timestamp-window' } },
        ],
      },
      scopeSpans: [{
        spans,
      }],
    }],
  }
}

/** Split attribution items into batches of maxBatchSize. */
export function batchAttributionItems(items: AttributionItem[], maxBatchSize: number): AttributionItem[][] {
  const batches: AttributionItem[][] = []
  for (let i = 0; i < items.length; i += maxBatchSize) {
    batches.push(items.slice(i, i + maxBatchSize))
  }
  return batches
}
