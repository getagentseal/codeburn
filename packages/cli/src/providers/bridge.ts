import type { DecodeContext } from '@codeburn/core'

import { getHostPrivacyKey } from '../privacy-key.js'
import type { Provider, ProbeRoot, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// ── The dual-registry bridge ────────────────────────────────────────────────
//
// A provider can be expressed in one of two shapes and the registry resolves
// both uniformly (issue #809, phase 8):
//
//  - LEGACY: a hand-written `Provider` whose `createSessionParser` decodes the
//    session in-CLI (the ~32 providers not yet migrated).
//  - CORE-MIGRATED: the pure record decode lives in `@codeburn/core/providers/
//    <name>`; the CLI keeps discovery, file I/O, and pricing and merely feeds
//    records to the core decoder. Expressed as a `BridgedProviderSpec` and
//    wrapped by `createBridgedProvider` into the SAME `Provider` interface, so
//    every existing consumer — the parser.ts scan loop, `doctor` probeRoots,
//    `--provider` filters, tool/model display names — sees no difference.
//
// This GENERALIZES the shape claude/codex established in phases 3/4 (each wrote
// its own bespoke adapter that reads the file, calls its core decoder, and maps
// the rich result to a `ParsedProviderCall`) for the SIMPLE providers: one whole-
// file pass, a live cross-file dedup set, no incremental cache and therefore no
// serializable resume state. Providers that DO cache/resume (codex) or carry a
// stateful session cache (antigravity/kiro) keep their bespoke adapters — the
// bridge is deliberately not built to cover them.

/**
 * A core-migrated provider. Discovery + I/O stay CLI-side; pure record decode
 * delegates to a core decoder that returns rich, cost-free calls.
 *
 * `TRich` is the core decoder's per-call output type (e.g. `QwenDecodedCall`).
 */
export interface BridgedProviderSpec<TRich> {
  name: string
  displayName: string
  network?: boolean
  durableSources?: boolean
  modelDisplayName: (model: string) => string
  toolDisplayName: (rawTool: string) => string

  // Discovery stays CLI-side (fs walk, env overrides, source shaping).
  discoverSessions: () => Promise<SessionSource[]>
  probeRoots?: () => Promise<ProbeRoot[]>

  // I/O adapter (CLI-side): read one discovered source into the raw records the
  // core decoder consumes (e.g. the JSONL lines of a file). Return `null` to
  // skip the source entirely (unreadable / oversized / empty) so a transient
  // read failure yields nothing rather than an empty-but-cached result.
  readRecords: (source: SessionSource) => Promise<unknown[] | null>

  // Pure core decode: records -> rich cost-free calls, threading the host's
  // shared cross-file dedup set (mutated in place). NO fs/env/clock, NO pricing.
  decode: (input: { records: unknown[]; context: DecodeContext; seenKeys: Set<string> }) => { calls: TRich[] }

  // Host-side map of one rich call -> the host's `ParsedProviderCall`. This is
  // where cost re-enters (via `costBasis: 'estimated'` + the parser.ts pricing
  // pass) and where CLI-only concerns (bash base-name extraction) are applied.
  toProviderCall: (rich: TRich) => ParsedProviderCall
}

/**
 * Wrap a `BridgedProviderSpec` into the `Provider` interface every consumer
 * already speaks. The generated `createSessionParser` reads the source (CLI
 * I/O), runs the core decoder against the shared dedup set, and yields each
 * mapped call. Dedup lives inside the core decoder (it threads `seenKeys`), so
 * the wrapper simply relays what the decoder returns.
 */
export function createBridgedProvider<TRich>(spec: BridgedProviderSpec<TRich>): Provider {
  return {
    name: spec.name,
    displayName: spec.displayName,
    ...(spec.network ? { network: spec.network } : {}),
    ...(spec.durableSources ? { durableSources: spec.durableSources } : {}),
    modelDisplayName: spec.modelDisplayName,
    toolDisplayName: spec.toolDisplayName,
    discoverSessions: spec.discoverSessions,
    ...(spec.probeRoots ? { probeRoots: spec.probeRoots } : {}),

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return {
        async *parse(): AsyncGenerator<ParsedProviderCall> {
          const records = await spec.readRecords(source)
          if (records === null) return
          // The host privacy key, threaded into the rich decode (D1). An empty
          // key was correct when the bridge was written — the comment then said
          // the rich decoder never consumes it, because minimization /
          // fingerprinting happened later on the sync path. That intent is
          // OVERTAKEN by the sourceRef-fingerprint work (#931): the rich
          // decoders now derive their dedup keys from sourceRefFingerprint,
          // and dedupKey ships on the observation envelope, so the rich decode
          // DOES consume the key. On an empty key core's fingerprint module
          // throws (it never degrades to an unkeyed digest), so the bridge has
          // to supply the real one. getHostPrivacyKey() is per-install stable
          // (persisted, like the optimize detectors use), so dedup keys stay
          // stable across runs and the session-cache re-parse / dedup
          // semantics are unchanged; it only falls back to a per-process key
          // when the config dir is unwritable, in which case the session cache
          // cannot persist either.
          const context: DecodeContext = { privacyKey: getHostPrivacyKey(), providerId: spec.name, sourceRef: source.path }
          const { calls } = spec.decode({ records, context, seenKeys })
          for (const rich of calls) {
            yield spec.toProviderCall(rich)
          }
        },
      }
    },
  }
}
