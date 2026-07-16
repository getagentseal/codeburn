/**
 * codeburn sync — push orchestration.
 *
 * Extracted from the CLI action so the flatten/filter/batch/send/ledger
 * pipeline is unit-testable without a full CLI invocation.
 */

import type { ProjectSummary } from '../types.js'
import { assertHttps } from './discovery.js'
import { ledgerKeySet, appendToLedger, type LedgerEntry } from './ledger.js'
import { buildOtlpPayload, batchCalls, type CallWithSession } from './otlp.js'

/**
 * Safety valve, not a routine cap — pushes now loop until all batches are
 * sent (429s are waited out). This only bounds a single push in pathological
 * cases (e.g. corrupted ledger causing a full re-send of years of data).
 */
export const MAX_PER_PUSH = 50_000

/** Flatten parsed projects into individual calls and filter out already-sent ones. */
export function collectUnsentCalls(projects: ProjectSummary[]): {
  allCalls: CallWithSession[]
  unsent: CallWithSession[]
} {
  const allCalls: CallWithSession[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          allCalls.push({
            call,
            sessionId: session.sessionId,
            project: project.project,
          })
        }
      }
    }
  }

  const sent = ledgerKeySet()
  const unsent = allCalls.filter(c => !sent.has(c.call.deduplicationKey))
  return { allCalls, unsent }
}

export type PushOutcome = 'complete' | 'auth-rejected' | 'rate-limited' | 'server-error'

export interface PushResult {
  outcome: PushOutcome
  totalSent: number
  totalRejected: number
  totalCostSent: number
  retryAfter?: string
  httpStatus?: number
  /** Total milliseconds spent waiting on 429 Retry-After */
  totalWaitMs?: number
}

export interface SendBatchesOptions {
  endpoint: string
  accessToken: string
  batches: CallWithSession[][]
  log?: (msg: string) => void
  /** Injectable sleep for tests. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Max wait per 429 (caps Retry-After). Default 120s. */
  maxWaitMs?: number
  /** Consecutive 429 retries per batch before giving up. Default 3. */
  max429Retries?: number
}

/** Parse Retry-After header: delta-seconds or HTTP-date. Returns ms, or null. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  if (/^-?\d+$/.test(value.trim())) {
    const seconds = Number(value)
    return seconds >= 0 ? seconds * 1000 : null
  }
  const date = Date.parse(value)
  if (!isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

/**
 * Send batches sequentially until all are sent. Ledgers each fully-accepted
 * batch. Partially-rejected batches are NOT ledgered (OTLP doesn't identify
 * which spans were rejected; deterministic span IDs make full-batch retry safe).
 *
 * 429 responses are honored: waits Retry-After (capped at maxWaitMs, default
 * backoff 5s when absent) and retries the same batch, up to max429Retries
 * consecutive times before giving up. Stops on 401/5xx — unsent batches
 * retry on the next push.
 */
export async function sendBatches(opts: SendBatchesOptions): Promise<PushResult> {
  assertHttps(opts.endpoint, 'Traces endpoint')
  const log = opts.log ?? (() => {})
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const maxWaitMs = opts.maxWaitMs ?? 120_000
  const max429Retries = opts.max429Retries ?? 3

  let totalSent = 0
  let totalRejected = 0
  let totalCostSent = 0
  let totalWaitMs = 0

  for (const batch of opts.batches) {
    let attempts429 = 0

    // Retry loop for the current batch (429 only)
    for (;;) {
      const payload = buildOtlpPayload(batch)

      const response = await fetch(opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${opts.accessToken}`,
        },
        body: JSON.stringify(payload),
      })

      if (response.status === 401) {
        return { outcome: 'auth-rejected', totalSent, totalRejected, totalCostSent, totalWaitMs, httpStatus: 401 }
      }

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After')
        attempts429++
        if (attempts429 > max429Retries) {
          return {
            outcome: 'rate-limited', totalSent, totalRejected, totalCostSent, totalWaitMs,
            retryAfter: retryAfterHeader ?? undefined, httpStatus: 429,
          }
        }
        const waitMs = Math.min(parseRetryAfterMs(retryAfterHeader) ?? 5000, maxWaitMs)
        log(`  Rate limited — waiting ${Math.round(waitMs / 1000)}s before retrying (attempt ${attempts429}/${max429Retries})`)
        totalWaitMs += waitMs
        await sleep(waitMs)
        continue
      }

      if (!response.ok) {
        return { outcome: 'server-error', totalSent, totalRejected, totalCostSent, totalWaitMs, httpStatus: response.status }
      }

      // Check for partial success
      let rejected = 0
      try {
        const body = await response.json() as { partialSuccess?: { rejectedSpans?: number | string } }
        // proto3 int64 JSON mapping: strict protojson servers send int64 as a
        // string — Number() both so `totalRejected +=` never concatenates.
        rejected = Number(body?.partialSuccess?.rejectedSpans ?? 0)
        if (!Number.isFinite(rejected) || rejected < 0) rejected = 0
      } catch { /* empty response = full success */ }

      if (rejected > 0) {
        // OTLP partial_success doesn't identify WHICH spans were rejected.
        // Ledger nothing — the whole batch retries on the next push.
        totalRejected += rejected
        log(`  Batch: ${rejected}/${batch.length} spans rejected — whole batch will retry on next push`)
      } else {
        const entries: LedgerEntry[] = batch.map(c => ({
          key: c.call.deduplicationKey,
          ts: c.call.timestamp,
        }))
        appendToLedger(entries)
        totalSent += batch.length
        totalCostSent += batch.reduce((s, c) => s + c.call.costUSD, 0)
      }
      break // batch done (success or partial) — move to next batch
    }
  }

  return { outcome: 'complete', totalSent, totalRejected, totalCostSent, totalWaitMs }
}

export { batchCalls }
