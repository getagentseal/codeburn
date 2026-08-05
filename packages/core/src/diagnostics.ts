import { createHmac } from 'node:crypto'

import { z } from 'zod'

import type { SessionObservation } from './observations.js'

/**
 * A bounded, content-free diagnostic detail: the first 16 hex chars of an
 * HMAC-SHA-256 of the offending input, keyed by the host's privacy key (D1).
 * A keyed fingerprint is REQUIRED — a keyless path must omit the field
 * entirely (see {@link keyedDetail}), never degrade to an unkeyed digest.
 *
 * The contract for a diagnostic is that it carries a record index, a
 * controlled error code, and a keyed fingerprint — NEVER content.
 * A detail that echoed the error would leak a path, a command fragment, a
 * prompt line, or an API key; the old rule ("no path separators, max 200
 * chars") let all of those through as long as they were slash-free. A digest
 * cannot: identical failures dedupe to the same fingerprint, distinct
 * failures differ, and no substring of the input survives in the output.
 */
export const DiagnosticDetail = z
  .string()
  .regex(/^[0-9a-f]{16}$/, 'diagnostic detail must be a 16-hex fingerprint, never content')

/** Classification of why a record could not be turned into an observation. */
export const DiagnosticCode = z.enum([
  'malformed-json',
  'unknown-shape',
  'missing-required',
  'invalid-value',
  'other',
])
export type DiagnosticCode = z.infer<typeof DiagnosticCode>

export const RecordDiagnostic = z
  .object({
    /** Index of the offending record within the input batch, when known. */
    index: z.number().int().nonnegative().optional(),
    code: DiagnosticCode,
    detail: DiagnosticDetail.optional(),
  })
  .strict()
export type RecordDiagnostic = z.infer<typeof RecordDiagnostic>

/**
 * The result of decoding a batch. Poison records must never throw or drop their
 * siblings; instead they surface as diagnostics. `state` is opaque and lets a
 * streaming decoder thread its carry-over between batches.
 */
export interface DecodeResult<TState = unknown> {
  observations: SessionObservation[]
  diagnostics: RecordDiagnostic[]
  state?: TState
}

/**
 * Coerce an arbitrary caught value into a content-free detail: the 16-hex
 * HMAC-SHA-256 fingerprint of the error message, keyed by `key`. The key is
 * REQUIRED (D1): with no key this throws rather than degrade to an unkeyed
 * digest that a host could dictionary-attack. Callers with no key available
 * must omit the detail field entirely — {@link keyedDetail} is the helper
 * for that path. The raw message — and therefore any path, command fragment,
 * prompt line, or API key inside it — never survives in the output.
 */
export function sanitizeDetail(value: unknown, key: string): string {
  if (!key) throw new Error('privacyKey is required')
  const raw = value instanceof Error ? value.message : String(value)
  return createHmac('sha256', key).update(raw).digest('hex').slice(0, 16)
}

/**
 * The detail for a diagnostic when a privacy key is available, or `undefined`
 * when it is not. A keyless diagnostic carries NO detail — the pre-fingerprint
 * shape `{ index, code }` — because D1 forbids an unkeyed digest: a host with
 * no key must not emit a fingerprint that could be dictionary-attacked.
 */
export function keyedDetail(value: unknown, key: string | undefined): string | undefined {
  return key ? sanitizeDetail(value, key) : undefined
}

/**
 * The per-record outcome a caller's `decodeOne` may return. Callers report
 * `{ index, code }` diagnostics only: `isolateRecords` is the sole place a
 * `detail` fingerprint is derived (from a thrown error, keyed with
 * `privacyKey`), so an unkeyed or caller-invented digest can never cross this
 * boundary. The type enforces it for typed callers and the runtime strips it
 * for untyped ones (see {@link isolateRecords}).
 */
export interface RecordOutcome {
  observations?: SessionObservation[]
  diagnostics?: Array<Omit<RecordDiagnostic, 'detail'>>
}

/**
 * Generic poison-isolation loop. Runs `decodeOne` against each record; a record
 * that throws becomes an 'other' diagnostic and the loop continues, so one bad
 * record never drops its siblings. When `privacyKey` is supplied the diagnostic
 * carries the keyed fingerprint of the error (never its content); without one
 * it carries no detail at all — D1 forbids an unkeyed digest. Diagnostics a
 * caller RETURNS are trusted for `index`/`code` only: any `detail` they carry
 * is stripped, because the only legitimate fingerprint is the one derived here
 * from a thrown error under the key this function owns.
 */
export function isolateRecords(
  records: readonly unknown[],
  decodeOne: (record: unknown, index: number) => RecordOutcome,
  privacyKey?: string,
): { observations: SessionObservation[]; diagnostics: RecordDiagnostic[] } {
  const observations: SessionObservation[] = []
  const diagnostics: RecordDiagnostic[] = []

  records.forEach((record, index) => {
    try {
      const outcome = decodeOne(record, index)
      if (outcome.observations) observations.push(...outcome.observations)
      if (outcome.diagnostics) {
        for (const d of outcome.diagnostics) {
          // Strip any detail a caller smuggled in (e.g. via a loose cast): it
          // could be an unkeyed digest. Fingerprints are derived here only.
          diagnostics.push({ index: d.index, code: d.code })
        }
      }
    } catch (err) {
      const detail = keyedDetail(err, privacyKey)
      diagnostics.push(detail ? { index, code: 'other', detail } : { index, code: 'other' })
    }
  })

  return { observations, diagnostics }
}
