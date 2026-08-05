// @codeburn/core Zed decoder: pure decode over host-supplied `threads` rows.
// The host runs the sqlite query and the Node-version zstd-availability gate;
// this decoder receives the raw rows (blob and all) and does the decompression,
// JSON parsing, and per-request token accounting. No fs/env/sqlite/pricing.
//
// zstd landed in node:zlib in 22.15 / 23.8. The host only calls this decoder
// after confirming `zstdDecompressSync` exists (see the CLI's `readRecords`), so
// calling it here is safe; the decoder does not re-check Node version support.

import zlib from 'node:zlib'

import type { DecodeContext } from '../../contracts.js'
import { keyedDetail, type RecordDiagnostic } from '../../diagnostics.js'
import type { ZedDecodedCall, ZedThreadJson, ZedThreadRow, ZedTokenUsage } from './types.js'

const zstdDecompressSync = (zlib as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function usageIsEmpty(usage: ZedTokenUsage): boolean {
  return (
    num(usage.input_tokens) === 0 &&
    num(usage.output_tokens) === 0 &&
    num(usage.cache_creation_input_tokens) === 0 &&
    num(usage.cache_read_input_tokens) === 0
  )
}

function buildCall(opts: {
  threadId: string
  requestKey: string
  usage: ZedTokenUsage
  model: string
  timestamp: string
  userMessage: string
}): ZedDecodedCall {
  const input = num(opts.usage.input_tokens)
  const output = num(opts.usage.output_tokens)
  const cacheWrite = num(opts.usage.cache_creation_input_tokens)
  const cacheRead = num(opts.usage.cache_read_input_tokens)
  return {
    provider: 'zed',
    model: opts.model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    cachedInputTokens: cacheRead,
    reasoningTokens: 0,
    webSearchRequests: 0,
    tools: [],
    rawBashCommands: [],
    timestamp: opts.timestamp,
    speed: 'standard',
    deduplicationKey: `zed:${opts.threadId}:${opts.requestKey}`,
    userMessage: opts.userMessage,
    sessionId: opts.threadId,
  }
}

export type ZedDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type ZedDecodeResult = {
  calls: ZedDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode Zed `threads` rows into rich, cost-free calls. The per-request map is
 * keyed by user message and does not cover every request (verified on a real
 * thread: cumulative was ~3x the map sum), so a remainder entry tops the thread
 * up to the exact cumulative counter. Threads with an empty map degrade to one
 * cumulative call. Dedup is keyed on `zed:<threadId>:<requestKey>` against the
 * live `seenKeys` set (host-owned).
 */
export function decodeZed({ records, seenKeys: liveSeen, context }: ZedDecodeInput): ZedDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: ZedDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  records.forEach((raw, index) => {
    const row = raw as ZedThreadRow
    try {
      // Zed's DataType enum is "zstd" (current save path) or "json" (legacy
      // uncompressed rows); anything else is unknown.
      if (!row.id || !row.data || (row.data_type !== 'zstd' && row.data_type !== 'json')) {
        if (row.data != null) diagnostics.push({ index, code: 'unknown-shape' })
        return
      }
      const parsedAt = new Date(row.updated_at ?? '')
      if (Number.isNaN(parsedAt.getTime())) return
      const timestamp = parsedAt.toISOString()

      const jsonText = row.data_type === 'zstd'
        ? zstdDecompressSync!(Buffer.from(row.data)).toString('utf-8')
        : Buffer.from(row.data).toString('utf-8')
      const thread = JSON.parse(jsonText) as ZedThreadJson
      const model = thread.model?.model || 'unknown'
      const userMessage = row.summary ?? ''

      const requests = Object.entries(thread.request_token_usage ?? {}).filter(([, usage]) => usage != null && !usageIsEmpty(usage))
      // The per-request map is keyed by user message and does not cover every
      // request, so a remainder entry tops the thread up to the exact
      // cumulative counter. Threads with an empty map degrade to one
      // cumulative call.
      const entries: Array<[string, ZedTokenUsage]> = [...requests]
      const cumulative = thread.cumulative_token_usage
      if (cumulative && !usageIsEmpty(cumulative)) {
        let sumIn = 0, sumOut = 0, sumWrite = 0, sumRead = 0
        for (const [, usage] of requests) {
          sumIn += num(usage.input_tokens)
          sumOut += num(usage.output_tokens)
          sumWrite += num(usage.cache_creation_input_tokens)
          sumRead += num(usage.cache_read_input_tokens)
        }
        const remainder: ZedTokenUsage = {
          input_tokens: Math.max(0, num(cumulative.input_tokens) - sumIn),
          output_tokens: Math.max(0, num(cumulative.output_tokens) - sumOut),
          cache_creation_input_tokens: Math.max(0, num(cumulative.cache_creation_input_tokens) - sumWrite),
          cache_read_input_tokens: Math.max(0, num(cumulative.cache_read_input_tokens) - sumRead),
        }
        if (!usageIsEmpty(remainder)) entries.push(['cumulative-remainder', remainder])
      }

      for (const [requestKey, usage] of entries) {
        const call = buildCall({ threadId: row.id, requestKey, usage, model, timestamp, userMessage })
        if (seen.has(call.deduplicationKey)) continue
        seen.add(call.deduplicationKey)
        calls.push(call)
      }
    } catch (err) {
      // Keyed fingerprint of the error, never its message: a hostile blob could
      // otherwise smuggle content through a JSON.parse failure. Without a
      // privacy key the detail is omitted entirely (D1: no unkeyed digest).
      // `context?` is defensive: this error path is the only place the decoder
      // touches context, so an untyped caller that supplies records only must
      // get a diagnostic here, not a TypeError.
      const detail = keyedDetail(err, context?.privacyKey)
      diagnostics.push(detail ? { index, code: 'malformed-json', detail } : { index, code: 'malformed-json' })
    }
  })

  return { calls, diagnostics }
}
