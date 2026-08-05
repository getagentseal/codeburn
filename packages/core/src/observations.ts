import { z } from 'zod'

import {
  CanonicalToolName,
  CostBasis,
  FingerprintHex,
  IsoTimestamp,
  ModelIdentifier,
  NonNegInt,
  NonNegUSD,
  OBSERVATION_SCHEMA_VERSION,
  ResourceRef,
  Speed,
  TokenBuckets,
} from './schema.js'

/**
 * A single model call.
 *
 * Every field is either an opaque id, an enum, a number, a timestamp, a
 * fingerprint, or a canonical-name array. There is deliberately no field that
 * can hold free text: no user message, no title, no path, no command line, no
 * tool arguments, no file contents. `.strict()` rejects unknown fields, so a
 * decoder cannot append one either — that is the structural anti-smuggling
 * property.
 */
export const CallObservation = z
  .object({
    provider: z.string().min(1),
    model: ModelIdentifier,
    pricingModel: ModelIdentifier.optional(),

    tokens: TokenBuckets,
    webSearchRequests: NonNegInt,

    speed: Speed,
    costBasis: CostBasis,
    /** Present only when costBasis === 'measured'. Enforced by the refine below. */
    measuredCostUSD: NonNegUSD.optional(),
    /** A fallback estimate the host may keep alongside a measured figure. */
    fallbackCostUSD: NonNegUSD.optional(),

    timestamp: IsoTimestamp,
    dedupKey: z.string().min(1),
    /** Canonical tool names only — never arguments. */
    toolNames: z.array(CanonicalToolName),
    turnIndex: NonNegInt,

    // Resource refs (schema 0.2.0): the fingerprinted files this call read /
    // edited. Populated from the host's rich decode; each entry is an opaque
    // fingerprint + coarse class, never a raw path. `resourceReads` carries only
    // whole-file reads (Read/FileReadTool); pattern tools (Grep/Glob) target no
    // single file and contribute nothing here.
    resourceReads: z.array(ResourceRef).optional(),
    resourceEdits: z.array(ResourceRef).optional(),

    // Rich-capture numerics: first-class optional fields.
    locAdded: NonNegInt.optional(),
    locRemoved: NonNegInt.optional(),
    interrupted: z.boolean().optional(),
    userModified: z.boolean().optional(),
    toolErrors: NonNegInt.optional(),
    editFailed: NonNegInt.optional(),
  })
  .strict()
  .refine(
    (c) => c.measuredCostUSD === undefined || c.costBasis === 'measured',
    { message: 'measuredCostUSD is only allowed when costBasis is "measured"', path: ['measuredCostUSD'] },
  )
export type CallObservation = z.infer<typeof CallObservation>

/**
 * A single session (a conversation / run).
 *
 * Identity is carried only as fingerprints. Branch names are fingerprinted too:
 * a raw branch name leaks feature intent, so the host keeps the raw value for
 * its own display and hands the observation layer only `gitBranchRef`.
 */
export const SessionObservation = z
  .object({
    sessionRef: FingerprintHex,
    projectRef: FingerprintHex,
    providerId: z.string().min(1),
    startedAt: IsoTimestamp,
    endedAt: IsoTimestamp.optional(),
    gitBranchRef: FingerprintHex.optional(),
    isSidechain: z.boolean().optional(),
    calls: z.array(CallObservation),
    turnCount: NonNegInt,
  })
  .strict()
export type SessionObservation = z.infer<typeof SessionObservation>

/** The top-level container a decoder produces. */
export const ObservationEnvelope = z
  .object({
    schemaVersion: z.literal(OBSERVATION_SCHEMA_VERSION),
    generator: z
      .object({
        name: z.literal('@codeburn/core'),
        version: z.string().min(1),
      })
      .strict(),
    sessions: z.array(SessionObservation),
  })
  .strict()
export type ObservationEnvelope = z.infer<typeof ObservationEnvelope>

/** Parse-or-throw. Convenience wrapper over `ObservationEnvelope.parse`. */
export function parseObservationEnvelope(input: unknown): ObservationEnvelope {
  return ObservationEnvelope.parse(input)
}

/** Non-throwing parse. Returns zod's discriminated `SafeParseReturnType`. */
export function safeParseObservationEnvelope(input: unknown) {
  return ObservationEnvelope.safeParse(input)
}
