import { z } from 'zod'

/**
 * ObservationEnvelope schema version. 0.x per decision D8: the observation
 * contract is pre-stability, so consumers must treat minor bumps as breaking.
 *
 * 0.2.0 adds the optional per-call `resourceReads` / `resourceEdits` arrays
 * (ResourceRef). Strictness rules are unchanged: every added field is either a
 * fingerprint or a coarse enum, so the anti-smuggling property still holds.
 *
 * MIGRATION NOTE (in-place hardening, not a version bump): during 0.2.0's
 * lifetime the `model` / `pricingModel` validation was tightened in place from
 * `minLength: 1` to the ModelIdentifier bound (maxLength 128 + identifier
 * charset), and the published schemas/observation-0.2.0.json changed in lock-
 * step. The envelope shape is unchanged — producers always normalize through
 * `normalizeModelIdentifier` now, so no newly produced envelope can be
 * rejected. The one hazard is ARCHIVED envelopes: a pre-hardening 0.2.0
 * envelope whose model held a display name (e.g. "Gemini 3.5 Flash (High)")
 * now fails validation against the same version string. Such archives must be
 * re-normalized (collapse the model to 'unknown' or an identifier) before
 * re-validating. A version bump was considered and rejected: 0.x is already
 * breaking-by-default, no field changed shape, and a new version would force
 * consumers to carry a second schema for a validation tightening alone.
 */
export const OBSERVATION_SCHEMA_VERSION = '0.2.0'

/**
 * A privacy-preserving fingerprint: the first 16 hex chars of an HMAC-SHA256.
 * Modelled as a strict 16-char lowercase-hex string so the schema can only ever
 * carry an opaque ref — never a raw id, path, or branch name (anti-smuggling).
 */
export const FingerprintHex = z
  .string()
  .regex(/^[0-9a-f]{16}$/, 'must be a 16-char lowercase hex fingerprint')

/** A non-negative integer (token counts, LOC deltas, error counts). */
export const NonNegInt = z.number().int().nonnegative()

/** A non-negative dollar amount. */
export const NonNegUSD = z.number().nonnegative()

/**
 * ISO-8601 timestamp. Offsets are permitted so hosts in any timezone can emit
 * without first normalising to UTC.
 */
export const IsoTimestamp = z.string().datetime({ offset: true })

/**
 * Canonical tool name. Restricted to a conservative identifier charset so a
 * decoder physically cannot smuggle tool ARGUMENTS, paths, or free text through
 * this field — only the canonical name of the tool may appear.
 */
export const CanonicalToolName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, 'canonical tool names only (no args, paths, or spaces)')

/**
 * Model identifier, as reported by the provider. Bounded to the identifier
 * charset real model slugs use — letters, digits, and the separators `._:/@-`
 * (openai/gpt-4o, anthropic--claude-4.6-opus, us.anthropic.claude-3-5-sonnet-
 * 20241022-v2:0, cloudflare/@cf/meta/llama-2-7b-chat-fp16). The bound is
 * anti-free-text: whitespace, punctuation outside the separators, and prompt
 * text cannot fit, so a planted prompt or command line fails validation. It is
 * NOT path-proof — `/`, `.`, `-` and `:` are valid identifier characters, so a
 * path-shaped string (e.g. /Users/victim/company/secret-plan.md) can still
 * match; the anti-path guarantee lives in the fingerprint fields
 * (FingerprintHex), not here. A provider value outside the charset (e.g. a
 * display name like "Gemini 3.5 Flash (High)") is normalized to 'unknown' at
 * the observation boundary by `normalizeModelIdentifier`, never rejected here.
 * The cap is generous (the longest slug in the litellm pricing snapshot is 76
 * chars) but the charset is the binding constraint.
 */
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/@-]+$/

export const ModelIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(MODEL_IDENTIFIER_PATTERN, 'model identifiers only (letters, digits, and . _ : / @ - separators)')

/**
 * Normalize a provider-supplied model string at the observation boundary (each
 * provider's toObservations). Values already inside the ModelIdentifier
 * charset pass through unchanged; anything else — provider display names with
 * spaces ("Gemini 3.5 Flash (High)", "GPT-5.3 Codex (medium reasoning)"),
 * unmapped aliases, empty strings — collapses to 'unknown', the same fallback
 * the decoders already use when no model can be resolved. This mirrors how
 * non-canonical tool names are dropped rather than failing: a hostile value
 * must never be able to reject a whole envelope, because one bad model id in
 * one call would otherwise fail an entire multi-session batch.
 */
export function normalizeModelIdentifier(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 128) return 'unknown'
  return MODEL_IDENTIFIER_PATTERN.test(trimmed) ? trimmed : 'unknown'
}

/** Per-call token buckets. All five are required, non-negative integers. */
export const TokenBuckets = z
  .object({
    input: NonNegInt,
    output: NonNegInt,
    reasoning: NonNegInt,
    cacheRead: NonNegInt,
    cacheCreate: NonNegInt,
  })
  .strict()
export type TokenBuckets = z.infer<typeof TokenBuckets>

/** Inference speed tier. Matches the CLI's `'standard' | 'fast'`. */
export const Speed = z.enum(['standard', 'fast'])
export type Speed = z.infer<typeof Speed>

/**
 * Coarse, non-identifying bucket for a filesystem resource. Mirrors the
 * `ResourceClass` union produced by `classifyResource` in fingerprint.ts. It is
 * a small closed enum so it can never carry a raw path or free text.
 */
export const ResourceClassName = z.enum([
  'dependency',
  'build',
  'vcs',
  'config',
  'source',
  'doc',
  'other',
])
export type ResourceClassName = z.infer<typeof ResourceClassName>

/**
 * A reference to a filesystem resource a call touched: the opaque 16-hex
 * fingerprint of its normalised path plus its coarse class. `.strict()` blocks
 * any extra field, so the RAW path can never ride along — the structural
 * anti-smuggling property extended to resource refs.
 */
export const ResourceRef = z
  .object({
    resourceId: FingerprintHex,
    resourceClass: ResourceClassName,
  })
  .strict()
export type ResourceRef = z.infer<typeof ResourceRef>

/**
 * How a call's cost was determined.
 *  - 'measured'  : a provider-reported dollar figure is authoritative.
 *  - 'estimated' : cost is derived from the token buckets via a pricing pass.
 */
export const CostBasis = z.enum(['measured', 'estimated'])
export type CostBasis = z.infer<typeof CostBasis>
