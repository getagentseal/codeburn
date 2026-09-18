import { DAILY_CACHE_VERSION } from './daily-cache.js'

/// Bump when the menubar payload's rendering semantics change without a
/// package release or daily-cache version change. The envelope version in
/// session-cache protects record shape; this protects the meaning of an
/// otherwise valid one. Each revision must be distinct from every OTHER
/// branch's revision: a snapshot written by a different change must not be
/// accepted here while lacking this change's fields.
/// v5: providerDetails carries per-provider tokens and sessions, which a v4
///     record predates — the dock glance would read a provider as having no
///     token breakdown purely because the snapshot was written before that.
/// v6: sessionCountBasis is now part of payload meaning. A same-package v5
///     snapshot written before that field existed still matches the v5
///     semantic key; omitting it makes empty identity-0 read as undefined-0
///     ("unavailable") and nonempty exact counts as a bound. Daily and session
///     cache versions stay put: retained unknown accounting must remain a
///     partial bound, not be discarded to regain exact labels.
/// v7: providerDetails also carries per-provider cacheReadTokens, which a v6
///     record predates — the dock's cache-read row would stay hidden behind a
///     warm snapshot even once the live payload had the data.
/// v8: the payload carries `streak` and `periodTotals`. A v7 record predates
///     both, so a warm snapshot would leave the streak pill and every period
///     headline reading from the client's own fallback while the live payload
///     already had the numbers.
/// v9: current.topModels rows carry per-model input/output/cache-read/write
///     counts, and the list is no longer capped at 20 rows (#1318). A v8
///     record has no per-model token breakdown and holds only the 20 costliest
///     rows, so the Models sections would render no counts and the Overview
///     model table would keep dropping the tail — the local and free models
///     the uncap exists to surface — until the next recompute. A v8 record is
///     treated as a miss (one real recompute per query), then the fresh record
///     is served; daily/session caches are separate version domains and are
///     not touched.
// v10: current.skills is rebuilt from the newly reparsed Copilot
// chatSessions/OTel calls; older snapshots can contain stale or empty skill
// breakdowns for otherwise identical period queries.
export const STATUS_SNAPSHOT_RENDER_VERSION = 10

/// The semantic key recorded on every status snapshot. A snapshot whose stored
/// key differs (an older render revision, or a different daily-cache version)
/// is rejected by `loadStatusSnapshot` and recomputed exactly once, then
/// reused stably under the new key.
export function statusSnapshotSemanticKey(
  version: string,
  renderVersion: number = STATUS_SNAPSHOT_RENDER_VERSION,
): string {
  return `${version}:render-${renderVersion}:daily-${DAILY_CACHE_VERSION}`
}
