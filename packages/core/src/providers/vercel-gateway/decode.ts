// @codeburn/core Vercel AI Gateway decoder: pure decode over the day×model
// aggregate rows the host fetched from the `/v1/report` API. No fs / env /
// clock / network — the host owns authentication, the HTTP request, the stderr
// warning, and the date-range gate. The decoder only maps rows to calls and
// threads the shared cross-file dedup set.

import type { VercelGatewayDecodedCall, VercelGatewayReportRow } from './types.js'
import { normalizeModelIdentifier } from '../../schema.js'

export type VercelGatewayDecodeInput = {
  records: unknown[]
  // Optional live dedup set the host mutates in place (its shared cross-file
  // seenKeys). Simple report providers never persist resume state.
  seenKeys?: Set<string>
}

export type VercelGatewayDecodeResult = {
  calls: VercelGatewayDecodedCall[]
}

/**
 * Decode Vercel AI Gateway report rows into rich, cost-carrying calls. The row
 * mapping matches the original host-side parser verbatim:
 *   - day/model/cost defaults
 *   - all-zero rows are skipped BEFORE dedup key burn
 *   - dedup key `vercel-gateway:<day>:<normalized model>` with add-after-skip
 *     semantics. The model component is run through normalizeModelIdentifier
 *     (the same function the observation boundary applies to `model`): the
 *     key SHIPS on the envelope, so a hostile prompt or display name planted
 *     in the externally-supplied report collapses to 'unknown' inside the key
 *     too, and a legitimate identifier-shaped slug is unchanged.
 *   - timestamp synthesized as `${day}T12:00:00.000Z`
 *   - sessionId synthesized as `${day}:${model}` (rich-decode only — never
 *     shipped raw; the envelope's sessionRef is an HMAC fingerprint of it)
 */
export function decodeVercelGateway(input: VercelGatewayDecodeInput): VercelGatewayDecodeResult {
  const { records, seenKeys: liveSeen } = input
  const seen = liveSeen ?? new Set<string>()
  const calls: VercelGatewayDecodedCall[] = []

  for (const raw of records) {
    const row = raw as VercelGatewayReportRow
    const day = row.day ?? ''
    const model = row.model ?? 'unknown'
    const costUSD = row.total_cost ?? 0
    const inputTokens = row.input_tokens ?? 0
    const outputTokens = row.output_tokens ?? 0

    // Verbatim from the original parser: drop rows that report no usage and no
    // cost before touching the dedup set, so an all-zero row does not burn its
    // key and block a later non-zero row for the same day×model.
    if (costUSD === 0 && inputTokens === 0 && outputTokens === 0) continue

    const deduplicationKey = `vercel-gateway:${day}:${normalizeModelIdentifier(model)}`
    if (seen.has(deduplicationKey)) continue
    seen.add(deduplicationKey)

    calls.push({
      provider: 'vercel-gateway',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: row.cached_input_tokens ?? 0,
      cachedInputTokens: 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      webSearchRequests: 0,
      costUSD,
      timestamp: day ? `${day}T12:00:00.000Z` : '',
      speed: 'standard',
      deduplicationKey,
      sessionId: `${day}:${model}`,
    })
  }

  return { calls }
}
