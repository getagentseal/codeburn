import { z } from 'zod'

import type { RecordDiagnostic } from './diagnostics.js'
import { FingerprintHex } from './schema.js'
import type { ObservationEnvelope, SessionObservation } from './observations.js'

/**
 * Finding schema version. 0.x per decision D8: pre-stability, minor bumps may
 * break consumers.
 */
export const FINDING_SCHEMA_VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Decoder contract (types only — implementations live in per-provider packages)
// ---------------------------------------------------------------------------

/** Context a decoder needs, but that must never appear in its output. */
export interface DecodeContext {
  /** Caller-supplied HMAC key for all fingerprints (decision D1). */
  privacyKey: string
  /** The provider whose records these are. */
  providerId: string
  /**
   * The host's absolute filesystem path to the source being decoded — NOT an
   * opaque fingerprint. Decoders may use it to derive session/chat identity
   * (a chat directory name, a session file's basename), but the RAW value must
   * never cross into an observation output — and dedupKey is an observation
   * output: it is a field on CallObservation that ships on the envelope, so
   * folding the raw path into a dedup key is a leak. A decoder that needs an
   * opaque form of the source in a dedup key or identity must fingerprint it
   * first via fingerprint.ts (`sourceRefFingerprint` — keyed HMAC-SHA256,
   * decision D1; the key is required and an empty key throws, so the ref can
   * never degrade to an unkeyed digest). Every fingerprint/ref field on the
   * envelope (sessionRef, projectRef, gitBranchRef, resource refs, and the
   * dedupKey's source component) is HMAC-derived via fingerprint.ts with the
   * host privacyKey, which the CLI bridge threads from getHostPrivacyKey().
   */
  sourceRef: string
}

/**
 * A decoder turns a batch of raw provider records into observations plus
 * diagnostics, threading optional streaming `state` between batches.
 */
export type Decoder<TState = unknown> = (input: {
  records: unknown[]
  context: DecodeContext
  state?: TState
}) => {
  observations: SessionObservation[]
  diagnostics: RecordDiagnostic[]
  state?: TState
}

/** A detector inspects a full envelope and emits findings. */
export type Detector = (envelope: ObservationEnvelope) => Finding[]

// ---------------------------------------------------------------------------
// Finding contract (zod validators — this is a wire schema)
// ---------------------------------------------------------------------------

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * A single machine-readable piece of evidence. `refs`/`sessionRefs` may hold
 * ONLY fingerprints (16-char hex) — never raw ids — so a finding cannot smuggle
 * identifying data. `.strict()` blocks unknown fields.
 */
export const Evidence = z
  .object({
    kind: z.string().min(1).max(64),
    count: z.number().int().nonnegative().optional(),
    refs: z.array(FingerprintHex).optional(),
    sessionRefs: z.array(FingerprintHex).optional(),
  })
  .strict()
export type Evidence = z.infer<typeof Evidence>

export const Confidence = z
  .object({
    score: z.number().min(0).max(1),
    /** A short, algorithm-authored rationale (bounded to keep it non-narrative). */
    basis: z.string().min(1).max(200),
  })
  .strict()
export type Confidence = z.infer<typeof Confidence>

export const Finding = z
  .object({
    detectorId: z.string().min(1).max(128),
    algorithmVersion: z.string().regex(SEMVER, 'must be a semver string'),
    confidence: Confidence,
    evidence: z.array(Evidence),
    impactUSD: z.number().optional(),
  })
  .strict()
export type Finding = z.infer<typeof Finding>
