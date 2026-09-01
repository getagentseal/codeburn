import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import type { DateRange, ProjectSummary } from './types.js'

// Bumped to 27: claude-haiku-4.5 copilot store rows now price correctly (alias added) — #1093.
// Previously the raw id 'claude-haiku-4.5' (tier-first, dot) from session-store.db had no
// pricing alias, so days finalized with this model were stuck at $0. No self-heal via prefix
// fallback exists for this id, so a version bump is required to force re-derivation.
// Bumped to 26: copilot input/cache tokens for sessions covered by the CLI's
// session-store.db move from one shutdown-rollup lump (stamped at session end)
// to per-request DB rows with real timestamps, supplementary accounting calls
// (rollups, residuals, paired rows) stop counting as api/model calls, and
// reasoning tokens leave the copilot cost recompute (they are inside the
// output the per-turn calls already bill). Per-day attribution, call counts and
// costs all move, so days finalized under an earlier version would disagree
// with the live parse.
//
// Why 26 and not 21 (the number this change first claimed): 20 is #1040 (codex
// model attribution), 18 was burned by an earlier public head of THIS change
// under different accounting, and 21-25 landed on main while this branch was in
// validation — 25 in particular was spent by #1056 (`codex-auto-review`
// pricing) after this PR had already minted it, which is why the number moves
// again here. 26 is the first free number on main's ladder — and it is load
// bearing beyond the collision: the branch's own validators already hold
// daily-cache.v21.json files whose copilot slices were carried stale by the
// bug PENDING_REDERIVE_PROVIDERS fixes below, and only a number those files
// cannot claim gets them re-derived. isMigratableCache/adoptOlderDailyCaches
// carry a same-or-newer version forward as FINALIZED without re-deriving it,
// so a number can never mean two accountings. (feat/core-extraction also sits
// at 26 and reconciles at its final merge by keeping the max.)
//
// Bumped to 25: `codex-auto-review` now prices as the recommended GPT-5.5
// row (#1047). Days already finalized under v24 keep that id at $0
// forever unless MIN_SUPPORTED_VERSION moves: the daily cache has no
// per-provider invalidation. The Codex parse version and CODEX_CACHE_VERSION
// move with this so the lower caches reprice first; this pass then re-derives
// ALL days from the warm session cache (seconds, not a full re-parse).
// adoptOlderDailyCaches keeps the superseded file as the baseline. v21 is
// #946, v22 was this PR's earlier claim, v23 is #1075, v24 is #1090.
//
// Bumped to 20: the Codex fast-path read a nested
// `base_instructions.provenance.model` out of `session_meta` as if it were
// `payload.model` (#1040), so every call a rollout attributed from session
// metadata - the ones before its first `turn_context`, and every one after a
// mid-file `session_meta` - was credited to the wrong model. The codex parse
// version and CODEX_CACHE_VERSION move with it, but the daily cache has no
// per-provider invalidation, so days already finalized keep the wrong model
// rows forever unless MIN_SUPPORTED_VERSION moves too. This pass re-derives
// ALL days for EVERY provider off the warm session cache, so it costs seconds
// rather than a full re-parse, and it is lossless: adoptOlderDailyCaches keeps
// the superseded v19 file as the baseline, and the partial-survival guard from
// #1033 holds any day whose sources have only partly aged out. On a real
// 110-day cache the 19 -> 20 pass moved ZERO days down and lost none: 100 days
// came back byte-identical and 9 grok days rose by $19.80 in total, clearing
// rollups the grok parse change had left stale, while every codex model row
// stayed identical (that corpus predates the `provenance` field, so the fix it
// carries has nothing to correct there).
//
// Bumped to 19: Grok authoritative usage now keeps one session-level rollup
// from top-level totals, clamps reasoning to reported output, and labels mixed
// authoritative/heuristic coverage. Every day finalized under the previous
// accounting carries the old Grok totals, and the daily cache has no
// per-provider invalidation, so raising MIN_SUPPORTED_VERSION is the only
// lever: it forces a one-time re-derivation of ALL days, for every provider,
// not just Grok. That pass reads the warm session cache (CACHE_VERSION is
// unchanged and only PROVIDER_PARSE_VERSIONS.grok moved), so it costs seconds
// rather than a full re-parse, and adoptOlderDailyCaches keeps the superseded
// file as the baseline for days no source can still re-derive. Days whose
// sources only PARTLY survive are held by the partial-survival guard in
// mergeDayEntries, which is what makes a global re-derive safe to force: on a
// real 108-day cache the 17 -> 19 pass moves Grok cost and tokens and nothing
// else - the day-by-day call counts come back identical.
//
// The shipped predecessor is v17; v18 was an unreleased draft of this change
// and only exists in pre-release checkouts. 19 clears both.
//
// Bumped to 17: copilot CLI sessions were misclassified as VS Code transcripts
// (#944), so days finalized at v16 or earlier carry output-only copilot costs —
// the session.shutdown rollup's input/cache tokens were dropped. Raising
// MIN_SUPPORTED_VERSION forces the one-time re-derivation under the
// provenance-based classification; sourceless days carry forward as-is.
//
// v16: Codex discovery is structural instead of originator-gated
// (#873/#626), so rollouts written by third-party frontends driving
// `codex app-server` ("t3code_desktop", "JetBrains.IntelliJ IDEA", ...) now
// contribute usage that v15 rollups never contained. Those files were rejected
// before they were ever parsed, so nothing downstream can notice on its own:
// `usage-aggregator` serves every day before today from this cache, and
// retention is ten years, so an upgrading user with a warm cache would keep the
// pre-fix history forever while today's numbers silently disagreed with it.
// Raising MIN_SUPPORTED_VERSION forces the one-time re-derivation.
//
// v15: per-project daily rollups. Days and provider slices now carry
// a `projects` breakdown (cost/calls/savings/sessions per project) so project
// history outlives the session files, like models and categories already do.
// This bump is the first to ride the v14 carry-forward: the old cache is
// adopted losslessly and only days whose sources survive are re-derived (now
// with projects); days already sourceless keep their totals and simply have
// no project split.
//
// v14: NEVER-LOSE history. Session files are ephemeral (Claude Code
// deletes transcripts after ~30 days), so a day that can no longer be re-derived
// from sources exists ONLY in this cache. Every earlier version treated the
// cache as disposable — schema bumps, savings-config changes, timezone changes
// and incomplete-hydration retries all dropped the days and re-derived from
// whatever sources survived, silently truncating history to the source-retention
// window (five bumps between 2026-06-22 and 2026-07-16 erased everything before
// 2026-04-24 on a machine with usage since March). From v14 on, invalidation
// re-derives what it can and CARRIES FORWARD every (day, provider) slice it
// cannot, and loading a missing/unsupported cache file adopts days from every
// older daily-cache file in the cache dir instead of starting empty. Bumping
// the version now only forces re-derivation of days whose sources still exist;
// it must never again lose the rest. DailyEntry.providers slices carry a full
// per-provider breakdown (tokens, models, categories) so those carry-forwards
// stay exact across rebuilds.
//
// v13: day bucketing is now TURN-anchored (a turn's whole cost/calls
// land on the day of its user-message timestamp) to match the live headline/
// report rollup. v12 bucketed each call by its own timestamp, so a midnight-
// straddling turn split across two days and history.daily / the provider
// breakdown never reconciled to current.cost. Raising MIN_SUPPORTED_VERSION
// forces the one-time re-hydration that rebuilds history under turn bucketing.
//
// v12: CodeWhale support adds historical usage that earlier rollups
// did not contain. Both the CodeWhale branch and the kiro credit-pricing
// change (below) claimed v11 independently, so v12 is the first version that
// contains both; raising MIN_SUPPORTED_VERSION forces the one-time
// re-hydration for days finalized at either v11.
//
// v11: kiro cost accounting changed (metered credits pass through
// the session cache instead of being re-priced from estimated tokens), so
// days finalized at v10 carry token-estimated kiro costs that were off by up
// to 16× per model. Raising MIN_SUPPORTED_VERSION forces the one-time full
// re-hydration that backfills history under credit-based pricing.
//
// v10: cursor accounting changed (real composer context tokens on
// conversation-anchored records, Cursor-published composer pricing), so days
// finalized at v9 carry the old double-counted agentKv estimates and
// sonnet-proxy composer costs.
//
// v9: providers added since the v8 rollup (Grok, Hermes, ZCode) parse usage
// that older binaries skipped. v8 added local-model savings to the daily
// rollup; the `savingsConfigHash` field is invalidated separately when the
// user changes their `localModelSavings` mapping.
// v23: codex pricing fix (#1075) - reasoning tokens were billed on top of
// output (they are a subset of it) and cache_write_input_tokens was ignored, so
// days finalized at v20 carry codex costs overstated by ~3.5% and codex output
// tokens overstated by ~34.6%. Raising MIN_SUPPORTED_VERSION forces the
// one-time re-derivation.
// It takes 23, not 21: v21 is claimed by the #946 landing branch and v22 by
// PR #1056, so those numbers are spoken for and reusing one would let two
// incompatible schemas share a filename. (feat/core-extraction sits at 26 and
// reconciles at its final merge by keeping the max.)
//
// v24: gpt-5.6-codex / gpt-5.6-codex-max pricing (#1077) - added as explicit
// litellm-snapshot.json rows. getModelCosts already resolved both ids to the
// correct rate via the `gpt-5.6` prefix fallback before this landed, so a day
// finalized on any binary that had a `gpt-5.6` snapshot row already carries
// the right cost; this bump only matters for a day finalized before THAT (a
// window where neither existed). The daily cache has no per-provider
// invalidation, so there is no way to tell those days apart from here -
// raising MIN_SUPPORTED_VERSION forces the one-time re-derivation for
// everyone, which is a lossless no-op for days already correct.
// v25: #1047 activity-id pricing. v24 on main already shipped #1090.
// v26: #946 copilot session-store accounting (see the top of this ladder).
// v27: #1093 claude-haiku-4.5 alias (see top).
// v28: #1115 report/optimize output tokens go through billableOutputTokens.
// Exclusive providers (Grok and the rest) were under-counted by reasoningTokens
// in finalized daily rows; inclusive {claude,codex,copilot} were correct there
// but optimize added reasoning again. Re-derive so report matches the live parse.
// v29: #1118 OrcaRouter route pricing (fusion aliases + peel; auto stays unpriced).
// v28 on main already shipped #1115.
export const DAILY_CACHE_VERSION = 29
const MIN_SUPPORTED_VERSION = 28

/// Providers whose per-day CALL COUNT means something different at
/// DAILY_CACHE_VERSION 26 than it did before it. Copilot's supplementary
/// accounting calls (rollups, residuals, store rows paired with a per-turn
/// call) stopped counting as api calls here, so a settled day's re-derivation
/// legitimately reports FEWER calls than the cache holds — which is exactly
/// the shape `isPartialSurvival` reads as "the sources aged out" (see the
/// TRADE-OFF note there, which called this case out in advance). Left
/// unhandled the guard pins every store-era copilot slice to its pre-store
/// value: measured on a real 17 -> 21 upgrade, `overview` served 2,980,804
/// tokens for a day whose fresh derivation is 74,811,412, while
/// `export`/`models`/`audit` (which never read this cache) served the
/// corrected figures off the same machine.
///
/// The exemption is one-shot and provider-scoped, not a relaxation of the
/// guard: `pendingRederive` is set only when a cache is migrated FROM a
/// version below this one, it is spent by the first complete re-derivation,
/// and it only ever fires where that re-derivation actually produced a slice
/// for the (day, provider). A day whose copilot sources are gone yields no
/// fresh slice at all, so it still carries forward whole — the #1033 bar is
/// untouched, in both directions, and every other provider keeps the guard.
const PENDING_REDERIVE_PROVIDERS: readonly string[] = ['copilot']
// Version-suffixed so different binaries each own a distinct file and never
// clobber an incompatible schema. Bumping the version mints a fresh filename;
// adoptOlderDailyCaches then unions days out of every previous file (including
// the pre-versioning `daily-cache.json`, which old binaries still own and we
// never write or delete).
const DAILY_CACHE_FILENAME = `daily-cache.v${DAILY_CACHE_VERSION}.json`

export type ModelDayStats = {
  calls: number
  cost: number
  savingsUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type CategoryDayStats = { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }

/// `path` is the project's filesystem path when known — it is what display
/// layers derive a friendly name from once the sessions that carried the
/// mapping are gone.
export type ProjectDayStats = { cost: number; calls: number; savingsUSD: number; sessions: number; path?: string }

export type ProviderDaySlice = {
  calls: number
  cost: number
  savingsUSD: number
  /// Full per-provider breakdown, written since v14. Slices adopted from older
  /// caches carry only the three fields above; carrying such a slice forward
  /// restores exact cost/calls/savings but not the day's token/model/category
  /// split for that provider.
  sessions?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  editTurns?: number
  oneShotTurns?: number
  models?: Record<string, ModelDayStats>
  categories?: Record<string, CategoryDayStats>
  projects?: Record<string, ProjectDayStats>
}

export type DailyEntry = {
  date: string
  cost: number
  savingsUSD: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  editTurns: number
  oneShotTurns: number
  models: Record<string, ModelDayStats>
  categories: Record<string, CategoryDayStats>
  providers: Record<string, ProviderDaySlice>
  /// Per-project rollup (session-level project attribution). Absent on days
  /// recorded before v15 — those days keep their totals but have no project
  /// split, and nothing can reconstruct one once the sources are gone.
  projects?: Record<string, ProjectDayStats>
  /// Present when some of this day's data was carried forward from an earlier
  /// cache generation instead of re-derived from session files (the files no
  /// longer exist). Carried values keep the accounting of the version that
  /// recorded them — stale accounting beats a silent zero.
  carried?: true
}

export type DailyCache = {
  version: number
  /// Hash of the active `localModelSavings` config at the time the cache
  /// was last written. When the user changes their baseline mapping the
  /// hash mismatches and `ensureCacheHydrated` re-derives available history,
  /// then carries forward slices whose sources are gone.
  savingsConfigHash: string
  /// IANA local timezone the days were bucketed under (day boundaries are
  /// local-time). If the machine's timezone changes, previously-cached days are
  /// bucketed against the wrong midnight, so a mismatch forces a full re-hydrate
  /// (same self-heal as `savingsConfigHash`). Absent on caches written before
  /// this field existed → not treated as a mismatch (no gratuitous rebuild).
  tzKey?: string
  lastComputedDate: string | null
  days: DailyEntry[]
  /// True only once the full backfill window has been hydrated from a COMPLETE
  /// session parse. A cache that was finalized against a partial (interrupted)
  /// session hydration — the "chart is empty for the first ~20 days" bug — reads
  /// as incomplete and is fully re-backfilled. Absent on caches written before
  /// this field existed → treated as incomplete (one self-healing re-backfill).
  complete?: boolean
  /// True once a COMPLETE parse finalized this watermark. The pull-back below
  /// only distrusts caches WITHOUT this stamp: a degraded parse can no longer
  /// set `complete`, so a stamped cache whose watermark sits past its newest
  /// populated day is a legitimately idle tail (recent days had no activity),
  /// not a frozen hole, and re-deriving it every launch is pure waste. Absent
  /// on caches written before this field: distrusted once (one healing
  /// pull-back), then stamped.
  watermarkTrusted?: boolean
  /// Providers still owed the one re-derivation that a migration from a
  /// pre-`DAILY_CACHE_VERSION` cache entitles them to, despite a shrinking
  /// call count (see PENDING_REDERIVE_PROVIDERS). Set by the migration,
  /// cleared by the first COMPLETE re-derive — persisted rather than computed
  /// so a partial parse in between does not silently spend the entitlement.
  pendingRederive?: string[]
}

/** IANA name of the current local timezone (respects the TZ env var). Days are
 *  bucketed by local midnight, so this tags the cache for TZ-change invalidation. */
export function currentTzKey(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' }
}

function getCachePath(): string {
  return join(getCodeburnCacheDir(), DAILY_CACHE_FILENAME)
}

/** Absolute path of the active (version-suffixed) daily cache file. */
export function dailyCachePath(): string {
  return getCachePath()
}

export function emptyCache(savingsConfigHash = ''): DailyCache {
  return { version: DAILY_CACHE_VERSION, savingsConfigHash, tzKey: currentTzKey(), lastComputedDate: null, days: [], complete: false }
}

function isMigratableCache(parsed: unknown): parsed is { version: number; lastComputedDate: string | null; savingsConfigHash?: string; tzKey?: string; days: Record<string, unknown>[]; complete?: boolean } {
  if (!parsed || typeof parsed !== 'object') return false
  const c = parsed as Partial<DailyCache>
  if (typeof c.version !== 'number') return false
  if (!Array.isArray(c.days)) return false
  return c.version >= MIN_SUPPORTED_VERSION && c.version <= DAILY_CACHE_VERSION
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeModels(raw: unknown): DailyEntry['models'] {
  if (!isRecord(raw)) return {}
  const out: DailyEntry['models'] = {}
  for (const [name, m] of Object.entries(raw)) {
    if (name in Object.prototype || !isRecord(m)) continue
    setOwn(out, name, {
      calls: num(m.calls),
      cost: num(m.cost),
      savingsUSD: num(m.savingsUSD),
      inputTokens: num(m.inputTokens),
      outputTokens: num(m.outputTokens),
      cacheReadTokens: num(m.cacheReadTokens),
      cacheWriteTokens: num(m.cacheWriteTokens),
    })
  }
  return out
}

function sanitizeCategories(raw: unknown): DailyEntry['categories'] {
  if (!isRecord(raw)) return {}
  const out: DailyEntry['categories'] = {}
  for (const [name, c] of Object.entries(raw)) {
    if (name in Object.prototype || !isRecord(c)) continue
    setOwn(out, name, {
      turns: num(c.turns),
      cost: num(c.cost),
      savingsUSD: num(c.savingsUSD),
      editTurns: num(c.editTurns),
      oneShotTurns: num(c.oneShotTurns),
    })
  }
  return out
}

const OPTIONAL_SLICE_NUMERICS = ['sessions', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'editTurns', 'oneShotTurns'] as const

/// Same junk-tolerance as sanitizeProjects, one level up: a foreign cache can
/// hold anything under a provider slice, and structuredClone in the merge
/// would faithfully preserve that junk into the next cache generation. Numeric
/// fields and nested maps are sanitized before the slice enters the cache.
function sanitizeProviders(raw: unknown): DailyEntry['providers'] {
  if (!isRecord(raw)) return {}
  const out: DailyEntry['providers'] = {}
  for (const [name, s] of Object.entries(raw)) {
    if (name in Object.prototype || !isRecord(s)) continue
    const slice = s
    const clean: ProviderDaySlice = { calls: num(slice.calls), cost: num(slice.cost), savingsUSD: num(slice.savingsUSD) }
    for (const key of OPTIONAL_SLICE_NUMERICS) {
      if (slice[key] !== undefined) clean[key] = num(slice[key])
    }
    if (isRecord(slice.models)) clean.models = sanitizeModels(slice.models)
    if (isRecord(slice.categories)) clean.categories = sanitizeCategories(slice.categories)
    const projects = sanitizeProjects(slice.projects).projects
    if (projects) clean.projects = projects
    setOwn(out, name, clean)
  }
  return out
}

/// Foreign or hand-edited caches can hold anything under `projects`; keep only
/// a plain record of finite numeric stats (arrays and null entries dropped) so
/// later carry merges can't crash on junk.
function sanitizeProjects(raw: unknown): { projects?: DailyEntry['projects'] } {
  if (!isRecord(raw)) return {}
  const out: NonNullable<DailyEntry['projects']> = {}
  for (const [name, p] of Object.entries(raw)) {
    // A project key is a directory basename, so it can legitimately be a
    // prototype-member name ("constructor", "valueOf", ...). `setOwn` writes it
    // as an own property via defineProperty, so keeping it is pollution-safe —
    // and dropping it would silently subtract that project's cost from a
    // --project/--exclude total (the day's split would no longer sum to its own
    // cost, which the filtered headline relies on).
    if (!isRecord(p)) continue
    setOwn(out, name, {
      cost: num(p.cost),
      calls: num(p.calls),
      savingsUSD: num(p.savingsUSD),
      sessions: num(p.sessions),
      ...(typeof p.path === 'string' && p.path.length > 0 ? { path: p.path } : {}),
    })
  }
  return Object.keys(out).length > 0 ? { projects: out } : {}
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function migrateDays(days: Record<string, unknown>[]): DailyEntry[] {
  return days
    .filter(d => d && typeof d === 'object' && typeof d.date === 'string' && DATE_KEY_RE.test(d.date))
    .map(d => ({
      date: d.date as string,
      cost: num(d.cost),
      savingsUSD: num(d.savingsUSD),
      calls: num(d.calls),
      sessions: num(d.sessions),
      inputTokens: num(d.inputTokens),
      outputTokens: num(d.outputTokens),
      cacheReadTokens: num(d.cacheReadTokens),
      cacheWriteTokens: num(d.cacheWriteTokens),
      editTurns: num(d.editTurns),
      oneShotTurns: num(d.oneShotTurns),
      models: sanitizeModels(d.models),
      categories: sanitizeCategories(d.categories),
      providers: sanitizeProviders(d.providers),
      ...(sanitizeProjects(d.projects)),
      ...(d.carried === true ? { carried: true as const } : {}),
    }))
}

/// The providers a cache at `fromVersion` still owes a re-derivation, carrying
/// an unspent entitlement out of the parsed file so a same-version reload does
/// not drop it.
function pendingRederiveFor(fromVersion: number, parsed: unknown): string[] | undefined {
  if (fromVersion < DAILY_CACHE_VERSION) return [...PENDING_REDERIVE_PROVIDERS]
  const raw = (parsed as { pendingRederive?: unknown } | null)?.pendingRederive
  if (!Array.isArray(raw)) return undefined
  const kept = raw.filter((p): p is string => typeof p === 'string')
  return kept.length > 0 ? kept : undefined
}

function migratedFrom(parsed: { version: number; lastComputedDate: string | null; savingsConfigHash?: string; tzKey?: string; days: Record<string, unknown>[]; complete?: boolean; watermarkTrusted?: boolean }): DailyCache {
  const pendingRederive = pendingRederiveFor(parsed.version, parsed)
  return {
    ...(pendingRederive ? { pendingRederive } : {}),
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: parsed.savingsConfigHash ?? '',
    tzKey: parsed.tzKey,
    lastComputedDate: typeof parsed.lastComputedDate === 'string' && DATE_KEY_RE.test(parsed.lastComputedDate)
      ? parsed.lastComputedDate
      : null,
    days: migrateDays(parsed.days),
    // Only a cache explicitly marked complete stays trusted; one written before
    // the marker existed reads false and is re-backfilled once.
    complete: parsed.complete === true,
    // Absent on a pre-fix cache: the watermark is distrusted once (healing
    // pull-back), then re-stamped by the finalize that follows.
    watermarkTrusted: parsed.watermarkTrusted === true,
  }
}

export async function loadDailyCache(): Promise<DailyCache> {
  const path = getCachePath()
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
      if (isMigratableCache(parsed)) {
        const migrated = migratedFrom(parsed)
        if (parsed.version < DAILY_CACHE_VERSION) await saveDailyCache(migrated).catch(() => {})
        return migrated
      }
    } catch {
      // fall through to adoption — a corrupt current file must not cost history
      // that older cache files still hold.
    }
    return adoptOlderDailyCaches()
  }
  return adoptOlderDailyCaches()
}

type AdoptableCache = { version: number; lastComputedDate?: string | null; savingsConfigHash?: string; tzKey?: string; days: Record<string, unknown>[]; complete?: boolean }

function isAdoptableCache(parsed: unknown): parsed is AdoptableCache {
  if (!parsed || typeof parsed !== 'object') return false
  const c = parsed as Partial<DailyCache>
  return typeof c.version === 'number' && Array.isArray(c.days)
}

/// Versioned file absent (or unreadable): adopt days from EVERY other
/// daily-cache file in the cache dir — the legacy unversioned file, older
/// versioned files, and manual .bak copies. Files are read, never written or
/// deleted (old binaries still own theirs). A candidate at exactly our version
/// (the legacy file written by a same-version binary) is fully trusted and
/// becomes the base; every other candidate contributes per-(day, provider)
/// slices it alone still has, marked `carried`. This is what makes a schema
/// bump lossless: the new version starts from the union of everything every
/// previous version ever recorded, then re-derives what sources still support.
async function adoptOlderDailyCaches(): Promise<DailyCache> {
  const dir = getCodeburnCacheDir()
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return emptyCache()
  }
  const candidates: { parsed: AdoptableCache; mtimeMs: number }[] = []
  for (const name of names) {
    if (!name.startsWith('daily-cache') || !name.includes('.json')) continue
    if (name === DAILY_CACHE_FILENAME) continue
    // .tmp files are included deliberately: a crash between the atomic write
    // completing and the rename landing leaves the NEWEST state only in the
    // .tmp. A truncated half-write fails JSON.parse below and is skipped.
    const path = join(dir, name)
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
      if (!isAdoptableCache(parsed)) continue
      candidates.push({ parsed, mtimeMs: (await stat(path)).mtimeMs })
    } catch {
      continue
    }
  }
  if (candidates.length === 0) return emptyCache()
  // Priority: newer schema first, then most recently written. Higher priority
  // wins per (day, provider); lower priority only fills what is missing.
  candidates.sort((a, b) => (b.parsed.version - a.parsed.version) || (b.mtimeMs - a.mtimeMs))

  let base: DailyCache
  let rest = candidates
  if (candidates[0]!.parsed.version === DAILY_CACHE_VERSION && isMigratableCache(candidates[0]!.parsed)) {
    base = migratedFrom(candidates[0]!.parsed as Parameters<typeof migratedFrom>[0])
    rest = candidates.slice(1)
  } else {
    base = emptyCache()
  }
  let days = base.days
  for (const { parsed } of rest) {
    days = mergeDayEntries(days, migrateDays(parsed.days), true)
  }
  // loadDailyCache has standalone readers, so the adopted result must already
  // satisfy the cache's own invariants: no today/future entries (they would be
  // served frozen instead of recomputed live) and nothing past retention.
  const now = new Date()
  const todayStr = toDateString(now)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  days = applyRetention(days.filter(d => d.date < todayStr), yesterdayStr)
  // A trusted base can carry lastComputedDate >= today (clock skew wrote a
  // frozen today entry that the purge above just removed). Left as-is it would
  // make hydration skip the gap parse forever and the purged day would never
  // be recomputed. Clamp back to the retained data.
  let lastComputedDate = base.lastComputedDate
  if (lastComputedDate && lastComputedDate > yesterdayStr) {
    lastComputedDate = days.length > 0 ? days[days.length - 1]!.date : null
  }
  const adopted: DailyCache = {
    ...base,
    lastComputedDate,
    days,
    // Anything adopted out of an OLDER file was derived under an older
    // accounting, so the providers whose call counts changed meaning get their
    // one guarded-shrink-exempt re-derivation (see PENDING_REDERIVE_PROVIDERS).
    pendingRederive: base.pendingRederive
      ?? (rest.some(c => c.parsed.version < DAILY_CACHE_VERSION) ? [...PENDING_REDERIVE_PROVIDERS] : undefined),
    // An untrusted base means nothing here was derived under the current
    // accounting: leave complete unset so the next hydration re-derives every
    // day whose sources survive (the merge keeps the rest).
    complete: rest.length === candidates.length ? false : base.complete,
    watermarkTrusted: rest.length === candidates.length ? false : base.watermarkTrusted,
  }
  await saveDailyCache(adopted).catch(() => {})
  return adopted
}

export async function saveDailyCache(cache: DailyCache): Promise<void> {
  const dir = getCodeburnCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const finalPath = getCachePath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const payload = JSON.stringify(cache)
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, finalPath)
  } catch (err) {
    try { await unlink(tempPath) } catch { /* ignore */ }
    throw err
  }
}

export function addNewDays(cache: DailyCache, incoming: DailyEntry[], newestDate: string): DailyCache {
  const byDate = new Map(cache.days.map(d => [d.date, d]))
  for (const day of incoming) {
    byDate.set(day.date, day)
  }
  const merged = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  const nextLast = cache.lastComputedDate && cache.lastComputedDate > newestDate
    ? cache.lastComputedDate
    : newestDate
  return {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: cache.savingsConfigHash,
    tzKey: cache.tzKey,
    lastComputedDate: nextLast,
    days: applyRetention(merged, newestDate),
    complete: cache.complete,
    watermarkTrusted: cache.watermarkTrusted,
  }
}

/// Prune entries older than the retention window so the cache file does not
/// grow unbounded over years of daily use. Anchor the cutoff on newestDate so
/// a stale or stuck clock can't accidentally evict everything. Skip the prune
/// entirely if newestDate is malformed — an invalid Date would produce a NaN
/// cutoff and `d.date >= "Invalid Date"` would silently drop every entry.
function applyRetention(days: DailyEntry[], newestDate: string): DailyEntry[] {
  const cutoffDate = new Date(`${newestDate}T00:00:00Z`)
  if (isNaN(cutoffDate.getTime())) return days
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - DAILY_CACHE_RETENTION_DAYS)
  const cutoff = toDateString(cutoffDate)
  return days.filter(d => d.date >= cutoff)
}

function hasSliceData(slice: ProviderDaySlice): boolean {
  return slice.cost > 0 || slice.calls > 0 || (slice.savingsUSD ?? 0) > 0
}

/// A day from a pre-v5-era cache: day-level totals exist but the providers map
/// is empty, so nothing can be attributed per provider. Such a day merges
/// all-or-nothing — filling slices into it would double-count whatever share
/// of its totals the incoming provider already contributed.
function isOpaqueDay(day: DailyEntry): boolean {
  return (day.cost > 0 || day.calls > 0) && Object.keys(day.providers).length === 0
}

function emptyModelStats(): ModelDayStats {
  return { calls: 0, cost: 0, savingsUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/// Fold one provider's day slice into a day: the providers map, the day-level
/// totals, and (when the slice carries them — v14+ slices do) the model and
/// category breakdowns. Skinny slices from pre-v14 caches restore only
/// cost/calls/savings; the day's other totals simply don't grow. A zero-data
/// placeholder already present for the provider (a session that started this
/// day but whose turns all landed on another) only contributes its session
/// count, deduplicated by max — the same real session may be counted on both
/// sides.
/// `residual` marks a slice that came out of the tz subtraction (issue #770):
/// the subtraction already removed the placeholder's sessions (the ones the
/// fresh parse explained), so the residual sessions are all distinct from the
/// placeholder's and must ADD to it, not max-dedup against it. Max would clamp
/// max(placeholder, residual) and permanently drop the source-gone sessions the
/// residual still carries.
function addSliceIntoDay(day: DailyEntry, provider: string, slice: ProviderDaySlice, residual = false): void {
  // Reads keyed by names from foreign caches use hasOwn throughout: a plain
  // lookup of "__proto__" returns the prototype object, and accumulating into
  // it pollutes every object in the process.
  const placeholder = Object.hasOwn(day.providers, provider) ? day.providers[provider] : undefined
  const placeholderSessions = placeholder?.sessions ?? 0
  const merged = structuredClone(slice)
  if (residual) {
    // The subtraction removed the placeholder's sessions from this residual, so
    // every remaining session is distinct from the placeholder's - add, don't
    // max (max would clamp 1 + 1 to 1 and lose the source-gone session).
    merged.sessions = placeholderSessions + (merged.sessions ?? 0)
  } else if (placeholderSessions > (merged.sessions ?? 0)) {
    merged.sessions = placeholderSessions
  }
  setOwn(day.providers, provider, merged)
  day.cost += slice.cost
  day.calls += slice.calls
  day.savingsUSD += slice.savingsUSD ?? 0
  day.sessions += residual ? (slice.sessions ?? 0) : Math.max(0, (slice.sessions ?? 0) - placeholderSessions)
  day.inputTokens += slice.inputTokens ?? 0
  day.outputTokens += slice.outputTokens ?? 0
  day.cacheReadTokens += slice.cacheReadTokens ?? 0
  day.cacheWriteTokens += slice.cacheWriteTokens ?? 0
  day.editTurns += slice.editTurns ?? 0
  day.oneShotTurns += slice.oneShotTurns ?? 0
  for (const [name, m] of Object.entries(slice.models ?? {})) {
    const acc = Object.hasOwn(day.models, name) ? day.models[name]! : emptyModelStats()
    acc.calls += m.calls
    acc.cost += m.cost
    acc.savingsUSD += m.savingsUSD ?? 0
    acc.inputTokens += m.inputTokens
    acc.outputTokens += m.outputTokens
    acc.cacheReadTokens += m.cacheReadTokens
    acc.cacheWriteTokens += m.cacheWriteTokens
    setOwn(day.models, name, acc)
  }
  for (const [cat, c] of Object.entries(slice.categories ?? {})) {
    const acc = Object.hasOwn(day.categories, cat) ? day.categories[cat]! : { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
    acc.turns += c.turns
    acc.cost += c.cost
    acc.savingsUSD += c.savingsUSD ?? 0
    acc.editTurns += c.editTurns
    acc.oneShotTurns += c.oneShotTurns
    setOwn(day.categories, cat, acc)
  }
  const placeholderProjects = placeholder?.projects ?? {}
  for (const [name, p] of Object.entries(slice.projects ?? {})) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue
    const dayProjects = (day.projects ??= {})
    const acc = Object.hasOwn(dayProjects, name) ? dayProjects[name]! : { cost: 0, calls: 0, savingsUSD: 0, sessions: 0 }
    acc.cost += num(p.cost)
    acc.calls += num(p.calls)
    acc.savingsUSD += num(p.savingsUSD)
    if (!acc.path && typeof p.path === 'string') acc.path = p.path
    // Same session dedup as the slice-level sessions above: a placeholder's
    // project sessions were already counted into the day when the fresh day
    // was built, so only the excess is added.
    const placeholderProjectSessions = Object.hasOwn(placeholderProjects, name) ? num(placeholderProjects[name]?.sessions) : 0
    acc.sessions += residual ? num(p.sessions) : Math.max(0, num(p.sessions) - placeholderProjectSessions)
    setOwn(dayProjects, name, acc)
  }
  // Placeholder-only projects (session counted fresh, calls landed elsewhere)
  // survive on the merged slice rather than being dropped by the clone above.
  const mergedProjects = merged.projects
  if (mergedProjects) {
    for (const [name, p] of Object.entries(placeholderProjects)) {
      if (!p || typeof p !== 'object') continue
      if (Object.hasOwn(mergedProjects, name)) {
        if (residual) {
          mergedProjects[name]!.sessions = num(mergedProjects[name]!.sessions) + num(p.sessions)
        } else if (num(p.sessions) > num(mergedProjects[name]!.sessions)) {
          mergedProjects[name]!.sessions = num(p.sessions)
        }
      } else {
        setOwn(mergedProjects, name, { cost: 0, calls: 0, savingsUSD: 0, sessions: num(p.sessions) })
      }
    }
  } else if (placeholder?.projects) {
    merged.projects = structuredClone(placeholder.projects)
  }
}

/// Assign via defineProperty so filesystem-derived keys like "__proto__" become
/// ordinary own properties instead of mutating the prototype link.
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

// --- tz-aware carry subtraction (issue #770) ---------------------------------
//
// After a timezone change the full re-derive re-aggregates the same session
// parse under the CURRENT tz and merges it over the cached (old-tz) days.
// mergeDayEntries carries a baseline slice only when the fresh day has no data
// slice for that (date, provider), so a turn that re-bucketed across local
// midnight leaves its old day sliceless, gets carried there, AND counts again on
// its new day. The fix subtracts from each carried baseline slice the content
// the fresh parse still attributes to that (date, provider) under the OLD
// bucketing (`freshUnderOldTz`): exactly the re-bucketed turns, nothing else.
// A sources-gone slice has no such content and survives untouched; a slice fully
// explained away is dropped.

/// Reduce `base` by `sub` at the slice level, clamping every field at 0 and
/// dropping nested entries that reduce to nothing. Returns null when no positive
/// data remains; the merge then drops the slice instead of carrying an empty
/// one. `sub` is always a subset of `base` in practice (same parse, old bucketing
/// vs cached baseline), so the clamp only guards rounding and cache/baseline skew.
function subtractSlice(base: ProviderDaySlice, sub: ProviderDaySlice): ProviderDaySlice | null {
  const calls = Math.max(0, base.calls - (sub.calls ?? 0))
  const cost = Math.max(0, base.cost - (sub.cost ?? 0))
  const savingsUSD = Math.max(0, (base.savingsUSD ?? 0) - (sub.savingsUSD ?? 0))
  const sessions = Math.max(0, (base.sessions ?? 0) - (sub.sessions ?? 0))
  const inputTokens = Math.max(0, (base.inputTokens ?? 0) - (sub.inputTokens ?? 0))
  const outputTokens = Math.max(0, (base.outputTokens ?? 0) - (sub.outputTokens ?? 0))
  const cacheReadTokens = Math.max(0, (base.cacheReadTokens ?? 0) - (sub.cacheReadTokens ?? 0))
  const cacheWriteTokens = Math.max(0, (base.cacheWriteTokens ?? 0) - (sub.cacheWriteTokens ?? 0))
  const editTurns = Math.max(0, (base.editTurns ?? 0) - (sub.editTurns ?? 0))
  const oneShotTurns = Math.max(0, (base.oneShotTurns ?? 0) - (sub.oneShotTurns ?? 0))
  const models = subtractModels(base.models, sub.models)
  const categories = subtractCategories(base.categories, sub.categories)
  const projects = subtractProjects(base.projects, sub.projects)
  const out: ProviderDaySlice = {
    calls, cost, savingsUSD,
    ...(sessions > 0 ? { sessions } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(editTurns > 0 ? { editTurns } : {}),
    ...(oneShotTurns > 0 ? { oneShotTurns } : {}),
    ...(models ? { models } : {}),
    ...(categories ? { categories } : {}),
    ...(projects ? { projects } : {}),
  }
  return hasSliceData(out) || (out.sessions ?? 0) > 0 ? out : null
}

function subtractModelStats(base: ModelDayStats, sub: ModelDayStats): ModelDayStats | null {
  const calls = Math.max(0, base.calls - (sub.calls ?? 0))
  const cost = Math.max(0, base.cost - (sub.cost ?? 0))
  const savingsUSD = Math.max(0, (base.savingsUSD ?? 0) - (sub.savingsUSD ?? 0))
  const inputTokens = Math.max(0, base.inputTokens - (sub.inputTokens ?? 0))
  const outputTokens = Math.max(0, base.outputTokens - (sub.outputTokens ?? 0))
  const cacheReadTokens = Math.max(0, base.cacheReadTokens - (sub.cacheReadTokens ?? 0))
  const cacheWriteTokens = Math.max(0, base.cacheWriteTokens - (sub.cacheWriteTokens ?? 0))
  if (calls === 0 && cost === 0 && savingsUSD === 0 && inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return null
  return { calls, cost, savingsUSD, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function subtractModels(base: DailyEntry['models'] | undefined, sub: DailyEntry['models'] | undefined): DailyEntry['models'] | undefined {
  if (!base) return undefined
  const out: DailyEntry['models'] = {}
  for (const [name, stats] of Object.entries(base)) {
    const s = sub && Object.hasOwn(sub, name) ? sub[name] : undefined
    const reduced = s ? subtractModelStats(stats, s) : stats
    if (reduced) setOwn(out, name, reduced)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function subtractCategoryStats(base: CategoryDayStats, sub: CategoryDayStats): CategoryDayStats | null {
  const turns = Math.max(0, base.turns - (sub.turns ?? 0))
  const cost = Math.max(0, base.cost - (sub.cost ?? 0))
  const savingsUSD = Math.max(0, (base.savingsUSD ?? 0) - (sub.savingsUSD ?? 0))
  const editTurns = Math.max(0, base.editTurns - (sub.editTurns ?? 0))
  const oneShotTurns = Math.max(0, base.oneShotTurns - (sub.oneShotTurns ?? 0))
  if (turns === 0 && cost === 0 && savingsUSD === 0 && editTurns === 0 && oneShotTurns === 0) return null
  return { turns, cost, savingsUSD, editTurns, oneShotTurns }
}

function subtractCategories(base: DailyEntry['categories'] | undefined, sub: DailyEntry['categories'] | undefined): DailyEntry['categories'] | undefined {
  if (!base) return undefined
  const out: DailyEntry['categories'] = {}
  for (const [name, stats] of Object.entries(base)) {
    const s = sub && Object.hasOwn(sub, name) ? sub[name] : undefined
    const reduced = s ? subtractCategoryStats(stats, s) : stats
    if (reduced) setOwn(out, name, reduced)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function subtractProjectStats(base: ProjectDayStats, sub: ProjectDayStats): ProjectDayStats | null {
  const cost = Math.max(0, base.cost - (sub.cost ?? 0))
  const calls = Math.max(0, base.calls - (sub.calls ?? 0))
  const savingsUSD = Math.max(0, (base.savingsUSD ?? 0) - (sub.savingsUSD ?? 0))
  const sessions = Math.max(0, (base.sessions ?? 0) - (sub.sessions ?? 0))
  if (cost === 0 && calls === 0 && savingsUSD === 0 && sessions === 0) return null
  return { cost, calls, savingsUSD, sessions, ...(base.path ? { path: base.path } : {}) }
}

function subtractProjects(base: DailyEntry['projects'] | undefined, sub: DailyEntry['projects'] | undefined): DailyEntry['projects'] | undefined {
  if (!base) return undefined
  const out: DailyEntry['projects'] = {}
  for (const [name, stats] of Object.entries(base)) {
    const s = sub && Object.hasOwn(sub, name) ? sub[name] : undefined
    const reduced = s ? subtractProjectStats(stats, s) : stats
    if (reduced) setOwn(out, name, reduced)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/// How much a nested stat entry actually lost: `base` before minus `reduced`
/// after, or null when nothing was lost. The raw `sub` is only a lower bound -
/// with tz skew it can exceed the slice, and subtracting it would eat OTHER
/// providers' share of the day-level breakdown.
function modelStatsDelta(base: ModelDayStats, reduced: ModelDayStats): ModelDayStats | null {
  const calls = base.calls - reduced.calls
  const cost = base.cost - reduced.cost
  const savingsUSD = (base.savingsUSD ?? 0) - (reduced.savingsUSD ?? 0)
  const inputTokens = base.inputTokens - reduced.inputTokens
  const outputTokens = base.outputTokens - reduced.outputTokens
  const cacheReadTokens = base.cacheReadTokens - reduced.cacheReadTokens
  const cacheWriteTokens = base.cacheWriteTokens - reduced.cacheWriteTokens
  if (calls === 0 && cost === 0 && savingsUSD === 0 && inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return null
  return { calls, cost, savingsUSD, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function categoryStatsDelta(base: CategoryDayStats, reduced: CategoryDayStats): CategoryDayStats | null {
  const turns = base.turns - reduced.turns
  const cost = base.cost - reduced.cost
  const savingsUSD = (base.savingsUSD ?? 0) - (reduced.savingsUSD ?? 0)
  const editTurns = base.editTurns - reduced.editTurns
  const oneShotTurns = base.oneShotTurns - reduced.oneShotTurns
  if (turns === 0 && cost === 0 && savingsUSD === 0 && editTurns === 0 && oneShotTurns === 0) return null
  return { turns, cost, savingsUSD, editTurns, oneShotTurns }
}

function projectStatsDelta(base: ProjectDayStats, reduced: ProjectDayStats): ProjectDayStats | null {
  const cost = base.cost - reduced.cost
  const calls = base.calls - reduced.calls
  const savingsUSD = (base.savingsUSD ?? 0) - (reduced.savingsUSD ?? 0)
  const sessions = (base.sessions ?? 0) - (reduced.sessions ?? 0)
  if (cost === 0 && calls === 0 && savingsUSD === 0 && sessions === 0) return null
  return { cost, calls, savingsUSD, sessions }
}

/// Remove `sub`'s contribution from a carried baseline day (the baseline-only
/// date branch of the merge, where the whole day clones over). Reduces the
/// provider's slice, the day-level totals, and the day-level models/categories/
/// projects maps that `addSliceIntoDay` would have grown them by.
///
/// Every day-level subtraction uses the EFFECTIVE removal - what the provider
/// slice actually lost (current before minus reduced after) - not the raw `sub`.
/// With tz skew (`freshUnderOldTz` content larger than the baseline slice), the
/// raw sub exceeds the slice and subtracting it would over-remove the day's
/// totals and its nested maps, eating unrelated providers' carried history and
/// breaking the invariant that a day's totals sum to its slices. A provider
/// slice that was absent has an effective removal of zero: nothing is subtracted
/// from the day.
function subtractSliceFromDay(day: DailyEntry, provider: string, sub: ProviderDaySlice): void {
  const current = Object.hasOwn(day.providers, provider) ? day.providers[provider] : undefined
  if (!current) return
  const reduced = subtractSlice(current, sub)
  if (reduced) setOwn(day.providers, provider, reduced)
  else delete day.providers[provider]

  day.cost = Math.max(0, day.cost - (current.cost - (reduced?.cost ?? 0)))
  day.calls = Math.max(0, day.calls - (current.calls - (reduced?.calls ?? 0)))
  day.savingsUSD = Math.max(0, (day.savingsUSD ?? 0) - ((current.savingsUSD ?? 0) - (reduced?.savingsUSD ?? 0)))
  day.sessions = Math.max(0, day.sessions - ((current.sessions ?? 0) - (reduced?.sessions ?? 0)))
  day.inputTokens = Math.max(0, day.inputTokens - ((current.inputTokens ?? 0) - (reduced?.inputTokens ?? 0)))
  day.outputTokens = Math.max(0, day.outputTokens - ((current.outputTokens ?? 0) - (reduced?.outputTokens ?? 0)))
  day.cacheReadTokens = Math.max(0, day.cacheReadTokens - ((current.cacheReadTokens ?? 0) - (reduced?.cacheReadTokens ?? 0)))
  day.cacheWriteTokens = Math.max(0, day.cacheWriteTokens - ((current.cacheWriteTokens ?? 0) - (reduced?.cacheWriteTokens ?? 0)))
  day.editTurns = Math.max(0, day.editTurns - ((current.editTurns ?? 0) - (reduced?.editTurns ?? 0)))
  day.oneShotTurns = Math.max(0, day.oneShotTurns - ((current.oneShotTurns ?? 0) - (reduced?.oneShotTurns ?? 0)))

  for (const [name, m] of Object.entries(current.models ?? {})) {
    const rm = reduced?.models && Object.hasOwn(reduced.models, name) ? reduced.models[name] : undefined
    const removed = rm ? modelStatsDelta(m, rm) : m
    if (!removed) continue
    const acc = Object.hasOwn(day.models, name) ? day.models[name] : undefined
    if (!acc) continue
    const reducedM = subtractModelStats(acc, removed)
    if (reducedM) setOwn(day.models, name, reducedM)
    else delete day.models[name]
  }
  for (const [cat, c] of Object.entries(current.categories ?? {})) {
    const rc = reduced?.categories && Object.hasOwn(reduced.categories, cat) ? reduced.categories[cat] : undefined
    const removed = rc ? categoryStatsDelta(c, rc) : c
    if (!removed) continue
    const acc = Object.hasOwn(day.categories, cat) ? day.categories[cat] : undefined
    if (!acc) continue
    const reducedC = subtractCategoryStats(acc, removed)
    if (reducedC) setOwn(day.categories, cat, reducedC)
    else delete day.categories[cat]
  }
  if (!day.projects) return
  for (const [name, p] of Object.entries(current.projects ?? {})) {
    const rp = reduced?.projects && Object.hasOwn(reduced.projects, name) ? reduced.projects[name] : undefined
    const removed = rp ? projectStatsDelta(p, rp) : p
    if (!removed) continue
    const acc = Object.hasOwn(day.projects, name) ? day.projects[name] : undefined
    if (!acc) continue
    const reducedP = subtractProjectStats(acc, removed)
    if (reducedP) setOwn(day.projects, name, reducedP)
    else delete day.projects[name]
  }
}

/// Did the tz subtraction leave any positive data on a carried baseline day?
/// Mirrors the merge's own carry criterion (`hasSliceData` or sessions) at the
/// day level, extended to the day's other scalar and nested content.
function hasPositiveDayContent(day: DailyEntry): boolean {
  if (day.cost > 0 || day.calls > 0 || (day.savingsUSD ?? 0) > 0 || day.sessions > 0) return true
  if (day.inputTokens > 0 || day.outputTokens > 0 || day.cacheReadTokens > 0 || day.cacheWriteTokens > 0) return true
  if (day.editTurns > 0 || day.oneShotTurns > 0) return true
  if (Object.keys(day.providers).length > 0) return true
  if (Object.keys(day.models).length > 0 || Object.keys(day.categories).length > 0) return true
  if (day.projects && Object.keys(day.projects).length > 0) return true
  return false
}

/// PARTIAL SURVIVAL (the v14 never-lose contract, extended past all-or-nothing).
/// v14 protected a (date, provider) slice only when the fresh derivation found
/// NOTHING there. But transcripts age out per FILE, not per day: Claude Code
/// deletes them after ~30 days, and turn-anchored bucketing means a handful of
/// turns from surviving later files still land on a mostly-aged-out day. The
/// fresh slice is then non-empty but truncated, and replacing the baseline with
/// it silently deletes the rest (measured on a real cache upgrading 17 -> 19:
/// 2026-07-16 fell from $1,685.17 / 12,530 calls to $385.44 / 560 calls).
///
/// So a fresh slice replaces a settled baseline slice only when it carries at
/// least as many CALLS — the same or more evidence. Fewer calls means the
/// source set demonstrably lost data, and the baseline is kept whole.
///
/// Why calls and not sessions: session counts shrink routinely on days whose
/// sources are entirely intact (a session's turns re-attribute to a neighbouring
/// day), measured at 1-5 sessions on recent days whose call counts were
/// identical across the re-derivation. A sessions test would freeze stale slices
/// on healthy days. Why not cost/tokens: those are re-priced accounting on the
/// same evidence — exactly what a legitimate re-derivation changes (#1015 Grok
/// keeps its per-day calls and raises cost, and is unaffected by this guard).
///
/// Why no source-set test instead: a day entry records no source files, counts
/// or fingerprints, and the session cache is keyed by file rather than by day,
/// so "were this day's sources all present?" cannot be answered from the cache.
/// The calls comparison is the available proxy.
///
/// TRADE-OFF: a future fix that legitimately REDUCES calls on a settled day
/// (deduplication) is blocked, and that day keeps the older, higher value until
/// its slice is re-derived under an equal-or-greater call count. That is the
/// "estimate high, never lose" direction v14 already chose over silent loss.
///
/// Recent days stay authoritative: within the settle window their session files
/// are still on disk, so a shrink there is a real change (the user deleted a
/// transcript), not aged-out sources. Seven days is far inside the ~30-day
/// retention floor of the shortest-lived source we know of, so any shrink older
/// than that is source loss with overwhelming likelihood.
const SETTLE_DAYS = 7

function settleCutoffDate(now: Date): string {
  return toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - SETTLE_DAYS))
}

function isPartialSurvival(date: string, baseline: ProviderDaySlice, fresh: ProviderDaySlice, settleCutoff: string): boolean {
  return date < settleCutoff && fresh.calls < baseline.calls
}

/// The read path's rule: keep whichever derivation explains MORE calls, on
/// every date, with ties going to the baseline. Unlike the write path this is
/// not deciding what to freeze, so it has no reason to prefer a thinner slice
/// on a recent day — but it is also not the place a re-pricing lands, so an
/// equal-call slice leaves the durable value alone.
function baselineExplainsMore(baseline: ProviderDaySlice, fresh: ProviderDaySlice): boolean {
  return fresh.calls <= baseline.calls
}

/// Index `freshUnderOldTz` (the same parse re-aggregated under the cache's OLD
/// tzKey) by date then provider, so the merge can subtract exactly what the
/// fresh parse still explains under the old bucketing.
function buildTzSubtraction(days: DailyEntry[]): ReadonlyMap<string, ReadonlyMap<string, ProviderDaySlice>> {
  const byDate = new Map<string, Map<string, ProviderDaySlice>>()
  for (const day of days) {
    if (Object.keys(day.providers).length === 0) continue
    const byProvider = new Map<string, ProviderDaySlice>()
    for (const [provider, slice] of Object.entries(day.providers)) {
      byProvider.set(provider, slice)
    }
    byDate.set(day.date, byProvider)
  }
  return byDate
}

/// Merge two day lists per (date, provider): `primary` wins wherever both have
/// data; `secondary` only fills dates primary lacks entirely and provider
/// slices primary lacks on shared dates. Nothing in secondary can overwrite or
/// double into primary. With markSecondaryCarried, every day that received a
/// secondary contribution is flagged `carried`.
///
/// Days that cannot be attributed per provider merge all-or-nothing:
///  - an OPAQUE primary day (pre-v5-era: totals but empty providers map) is
///    never slice-filled — its totals may already contain the incoming
///    provider's share, so adding would double-count;
///  - an opaque secondary day on a date primary already has contributes
///    nothing — its day-level totals cannot be attributed without slices.
/// A primary slice blocks a secondary one only when it carries DATA; a
/// zero-data placeholder (sessions only) is merged into, not treated as a
/// re-derivation of the provider's day — UNLESS that data is a strict shrink of
/// the baseline on a settled day, see `isPartialSurvival`.
/// `subtract`, present ONLY on the tz-change re-derive, maps (date, provider)
/// to the content the fresh parse still attributes there under the OLD
/// bucketing. Every baseline slice the merge would otherwise carry has that
/// content subtracted first (clamped at 0, dropped when nothing positive
/// remains), so turns that re-bucketed across local midnight are not counted on
/// both their old and new days. What remains is by construction content NO
/// surviving source explains, so it is added even when the fresh slice for that
/// (date, provider) already carries data — the tz path's form of the
/// partial-survival rule, exact instead of heuristic. Absent (undefined) on
/// every other path, which keeps those merges byte-identical to the pre-fix
/// behavior apart from that rule.
export function mergeDayEntries(
  primary: DailyEntry[],
  secondary: DailyEntry[],
  markSecondaryCarried: boolean,
  subtract?: ReadonlyMap<string, ReadonlyMap<string, ProviderDaySlice>>,
  /// Set ONLY by the complete-parse re-derive, where `primary` is a fresh
  /// derivation from live sources and `secondary` is the cache baseline: a
  /// primary slice with fewer calls there means sources aged out, so the
  /// baseline wins on settled days (`isPartialSurvival`). The adoption union
  /// leaves it off - both sides are cache generations there and the newer
  /// schema deliberately wins per (date, provider).
  ///
  /// `'prefer-richer'` is the read-path union's rule (`unionDaysForPeriod`):
  /// on EVERY date, keep the slice explaining more calls, ties to the baseline.
  /// That path is choosing what to REPORT, not what to freeze, so a thinner
  /// derivation is never the better answer there — while the write path still
  /// lets a recent day shrink, on the grounds that a still-settling day is
  /// defined by its fresh parse.
  guardPartialSurvival: boolean | 'prefer-richer' = false,
  /// Providers whose baseline slices were recorded under an accounting where a
  /// call meant something else, so a shrink is not evidence of source loss for
  /// this one re-derivation (see PENDING_REDERIVE_PROVIDERS). Only consulted
  /// where the fresh parse actually produced a slice for the (date, provider);
  /// a slice it could not produce at all is carried by the branch above,
  /// exactly as before.
  pendingRederive?: ReadonlySet<string>,
): DailyEntry[] {
  const byDate = new Map<string, DailyEntry>()
  const settleCutoff = settleCutoffDate(new Date())
  for (const day of primary) byDate.set(day.date, structuredClone(day))
  for (const day of secondary) {
    const existing = byDate.get(day.date)
    if (!existing) {
      const copy = structuredClone(day)
      if (subtract) {
        const subForDate = subtract.get(day.date)
        if (subForDate) {
          for (const [provider, slice] of Object.entries(copy.providers)) {
            const subSlice = subForDate.get(provider)
            if (!subSlice) continue
            subtractSliceFromDay(copy, provider, subSlice)
          }
          if (!hasPositiveDayContent(copy)) continue
        }
      }
      if (markSecondaryCarried) copy.carried = true
      byDate.set(day.date, copy)
      continue
    }
    if (isOpaqueDay(existing)) continue
    for (const [provider, slice] of Object.entries(day.providers)) {
      // Sessions-only slices (a session whose calls all landed on another
      // day) still carry a real session count — worth preserving.
      if (!hasSliceData(slice) && !(slice.sessions ?? 0)) continue
      const existingSlice = Object.hasOwn(existing.providers, provider) ? existing.providers[provider] : undefined
      let toAdd = slice
      let residual = false
      if (subtract) {
        const subSlice = subtract.get(day.date)?.get(provider)
        if (subSlice) {
          const reduced = subtractSlice(slice, subSlice)
          if (!reduced) continue
          toAdd = reduced
          // The subtraction already removed the sessions the fresh parse
          // explained, so the residual's sessions are distinct from the fresh
          // placeholder's: merging over it must ADD, not max-dedup (fix round
          // 1 - max would drop the source-gone sessions the residual carries).
          residual = true
        }
      }
      if (existingSlice && hasSliceData(existingSlice) && !residual) {
        const keepBaseline = guardPartialSurvival === 'prefer-richer'
          ? baselineExplainsMore(slice, existingSlice)
          : isPartialSurvival(day.date, slice, existingSlice, settleCutoff)
        if (!guardPartialSurvival || pendingRederive?.has(provider) || !keepBaseline) continue
        // The baseline holds more evidence than the sources can still produce:
        // swap the fresh slice back out for it (inverse of addSliceIntoDay, so
        // the day's totals and nested maps stay reconciled with its slices).
        subtractSliceFromDay(existing, provider, existingSlice)
      }
      addSliceIntoDay(existing, provider, toAdd, residual)
      if (markSecondaryCarried) existing.carried = true
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function getDaysInRange(cache: DailyCache, start: string, end: string): DailyEntry[] {
  return cache.days.filter(d => d.date >= start && d.date <= end)
}

let lockChain: Promise<unknown> = Promise.resolve()

export function withDailyCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lockChain.then(() => fn())
  lockChain = next.catch(() => undefined)
  return next
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000
export const BACKFILL_DAYS = 365
// Ten years. This cache is the ONLY durable record of carried days (their
// session files are long deleted), and the uncapped `lifetime` period reads
// from it via buildDurablePeriod, so pruning at the old 2-year mark would
// have replayed the lost-history bug in slow motion at that horizon.
// Measured envelope keeps this honest: ~2.3 MB / ~11 ms JSON parse per 730
// days of fully dense data, so even a decade of daily use stays ~11 MB and
// well under 100 ms on the polling path.
export const DAILY_CACHE_RETENTION_DAYS = 3650

export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/// A day whose ONLY content is turn-anchored residue (one straddling turn's
/// category/edit counts, no calls) is not a derived day — it is a day the parse
/// under-read. Re-derive it instead of serving it.
export function isTurnResidueOnly(day: DailyEntry): boolean {
  if (day.cost > 0 || day.calls > 0 || day.sessions > 0) return false
  if (day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheWriteTokens > 0) return false
  return Object.values(day.categories).some(c => c.turns > 0)
}

/// Keep only the days a RANGED parse actually covered (issue #1130): a turn
/// anchored before the range start survives range slicing whole, so the
/// aggregator can emit a residue day outside the parsed range — and out-of-range
/// residue days must not reach durable history even with the merge guards.
/// Date keys are zero-padded YYYY-MM-DD, so a string compare is exact.
export function daysInRange(days: DailyEntry[], range: DateRange, dateKeyFn: (date: Date) => string = toDateString): DailyEntry[] {
  const first = dateKeyFn(range.start)
  const last = dateKeyFn(range.end)
  return days.filter(d => d.date >= first && d.date <= last)
}

export async function ensureCacheHydrated(
  parseSessions: (range: DateRange) => Promise<ProjectSummary[]>,
  aggregateDays: (projects: ProjectSummary[]) => DailyEntry[],
  /// Hash of the active `localModelSavings` config. When this changes
  /// (user re-mapped a baseline) the cached `savingsUSD` totals are no
  /// longer accurate, so we treat the cache as stale and force a full
  /// re-hydration. Pass `''` for "no savings config" to disable.
  savingsConfigHash: string = '',
  /// Whether the session parse that fed this backfill left the session cache
  /// fully hydrated. A partial (interrupted) session cache yields empty/partial
  /// older days; finalizing them would freeze that gap into the daily history.
  /// So the backfill is only marked `complete` when this returns true. Defaults
  /// to a trusting `true` for callers that don't (or can't) supply it.
  sessionComplete: () => boolean = () => true,
  /// Re-aggregate the SAME parsed projects under an explicit timezone instead of
  /// the machine's local one. Used only on a tz-change re-derive: the result is
  /// compared against the fresh local-tz days to subtract the turns that
  /// re-bucketed across local midnight from the carried baseline (issue #770).
  /// Absent, the tz-change path carries forward exactly as it did before.
  aggregateDaysInTz?: (projects: ProjectSummary[], tz: string) => DailyEntry[],
): Promise<DailyCache> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayEnd = new Date(todayStart.getTime() - 1)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))

  return withDailyCacheLock(async () => {
    let c = await loadDailyCache()

    // Drop any cached entry dated today or later BEFORE anything else can
    // carry it forward. The cache only ever stores complete past days (up to
    // yesterday), so a >= today entry can only come from the clock moving
    // backward or a stale older cache; left in place it would be served frozen
    // instead of recomputed live. Yesterday and earlier stay cached.
    const todayStr = toDateString(now)
    if (c.days.some(d => d.date >= todayStr)) {
      const freshDays = c.days.filter(d => d.date < todayStr)
      const latestFresh = freshDays.length > 0 ? freshDays[freshDays.length - 1].date : null
      c = { ...c, days: freshDays, lastComputedDate: latestFresh }
    }

    // A cache can claim `complete` while its watermark points PAST its newest
    // populated day — what a run finalizing off a degraded (read-only) parse
    // leaves behind: it advanced lastComputedDate over days the parse never
    // covered. Since gapStart is lastComputedDate + 1, that hole is invisible
    // to the gap logic forever. Trust the DATA over the marker: pull the
    // watermark back to the newest day actually present so the ordinary gap
    // parse re-derives the tail. Nothing is dropped — the cached days all stay.
    //
    // Only UNSTAMPED caches are distrusted here. A degraded parse can no longer
    // set `complete` (that is this fix), so the corrupt state can only be
    // written by pre-fix code: an unstamped cache. A stamped one whose watermark
    // outruns its newest day is a legitimately idle tail (recent days had no
    // activity), and re-deriving that empty tail on every launch is the
    // regression this guard avoids. A cache with NO days is exempt: it has no
    // newest day to trust, and a machine with no history at all must still be
    // able to finalize (below) rather than re-backfill on every launch.
    const newestCachedDate = c.days.reduce<string | null>((max, d) => (max === null || d.date > max ? d.date : max), null)
    if (c.watermarkTrusted !== true && newestCachedDate !== null && c.lastComputedDate !== null && c.lastComputedDate > newestCachedDate) {
      c = { ...c, lastComputedDate: newestCachedDate }
    }

    // Never seal a residue-only day (issue #1127): a day whose only content is
    // turn-anchored residue was under-read by the parse that produced it, so
    // trust the DATA over the marker again — pull the watermark back to just
    // before the oldest such day and let the ordinary gap parse re-derive it.
    // This is what heals every already-broken cache on the next launch, with
    // no version bump.
    //
    // Caveat: a day that GENUINELY held only one straddling turn and no other
    // activity re-derives to the same residue shape and would be re-parsed on
    // every launch. Bound that cost: skip the pull-back when the residue day
    // is the oldest day in the cache, and only pull back inside the settle
    // window — outside it the source files are gone and re-deriving cannot
    // recover the day anyway.
    const oldestCachedDate = c.days.reduce<string | null>((min, d) => (min === null || d.date < min ? d.date : min), null)
    const residueSettleCutoff = settleCutoffDate(now)
    const oldestResidueDate = c.days.reduce<string | null>(
      (min, d) => (d.date >= residueSettleCutoff && d.date !== oldestCachedDate && isTurnResidueOnly(d) && (min === null || d.date < min) ? d.date : min),
      null,
    )
    if (oldestResidueDate !== null && c.lastComputedDate !== null && c.lastComputedDate >= oldestResidueDate) {
      const pulledBack = new Date(
        parseInt(oldestResidueDate.slice(0, 4)),
        parseInt(oldestResidueDate.slice(5, 7)) - 1,
        parseInt(oldestResidueDate.slice(8, 10)) - 1
      )
      c = { ...c, lastComputedDate: toDateString(pulledBack) }
    }

    // Three reasons to re-derive the whole retention window:
    //  1. Savings config changed — cached `savingsUSD` totals are stale.
    //  2. The cache was never finalized against a COMPLETE session parse (an old
    //     pre-marker cache, an adoption from older cache files, or one frozen
    //     from a partial/interrupted hydration).
    //  3. The local timezone changed — days are bucketed by local midnight, so a
    //     TZ change mis-buckets every cached day. Only invalidate when a tzKey is
    //     present and differs (a cache written before this field, or a test
    //     fixture, has none → left alone rather than force a spurious rebuild).
    //
    // Re-derive, NOT discard. Session files are ephemeral; a cached day whose
    // sources are gone exists nowhere else, so the old days stay as a baseline
    // and the fresh parse overrides per (day, provider) wherever it actually
    // produced data. What it could not re-derive is carried forward (marked
    // `carried`) with its old accounting — every wipe here before v14 turned
    // into permanently lost history.
    const tzKey = currentTzKey()
    const tzChanged = c.tzKey !== undefined && c.tzKey !== tzKey
    if (c.savingsConfigHash !== savingsConfigHash || c.complete !== true || tzChanged) {
      const baseline = c.days
      const priorWatermark = c.lastComputedDate
      const backfillStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS)
      let freshDays: DailyEntry[] = []
      let projects: ProjectSummary[] = []
      if (backfillStart.getTime() <= yesterdayEnd.getTime()) {
        // Hoisted so a tz-change re-derive can aggregate the SAME parse twice
        // (once under the current tz as freshDays, once under the cache's old
        // tzKey as freshUnderOldTz) without a second session parse.
        //
        // The parse stops at yesterdayEnd. Keeping it a HISTORY parse is what
        // makes the parser slice a midnight-straddling turn at the yesterday
        // boundary: day-N's turn-level category/counts then carry only the
        // pre-midnight half and today's live parse carries the rest, so the two
        // sides reconcile (issue #852). Widening THIS parse through now would
        // leave the full turn on day N while today's half was excluded from the
        // cache, breaking that reconciliation - so the subtraction below gets
        // its own through-now parse instead.
        projects = await parseSessions({ start: backfillStart, end: yesterdayEnd })
        freshDays = daysInRange(aggregateDays(projects), { start: backfillStart, end: yesterdayEnd })
      }
      const parseWasComplete = sessionComplete()
      // A PARTIAL parse must not overwrite finalized baseline days with
      // undercounts (if their sources die before the next complete parse, the
      // undercount would be what survives). Partial fresh data only fills days
      // and slices the baseline lacks; the next complete parse gets to win.
      //
      // On a complete-parse TZ re-derive (savings config untouched), subtract
      // from each carried baseline slice the content the fresh parse still
      // attributes to that (date, provider) under the OLD bucketing: the turns
      // that re-bucketed across local midnight. That is the issue #770
      // double-count; re-pricing drift (a savings-hash change) must never be
      // subtracted, so a hash change in the same re-derive skips this entirely.
      let tzSubtraction: ReadonlyMap<string, ReadonlyMap<string, ProviderDaySlice>> | undefined
      if (parseWasComplete && tzChanged && c.savingsConfigHash === savingsConfigHash && aggregateDaysInTz && c.tzKey !== undefined) {
        // The subtraction re-parses THROUGH NOW (fix round 1): a call bucketed
        // to OLD-tz yesterday that re-buckets to NEW-tz TODAY sits past the
        // history parse's yesterdayEnd, so `freshUnderOldTz` built from `projects`
        // would never see it - the baseline slice would be carried un-subtracted
        // while today's live parse counts it again. This second parse exists
        // ONLY for the subtraction; it never feeds freshDays, so the merged
        // days written to the cache stay exactly the history days and today is
        // still owned by the caller's live parse.
        const wideProjects = await parseSessions({ start: backfillStart, end: now })
        tzSubtraction = buildTzSubtraction(aggregateDaysInTz(wideProjects, c.tzKey))
      }
      const pendingRederive = c.pendingRederive?.length ? new Set(c.pendingRederive) : undefined
      const merged = parseWasComplete
        ? mergeDayEntries(freshDays, baseline, true, tzSubtraction, true, pendingRederive)
        : mergeDayEntries(baseline, freshDays, false)
      c = {
        version: DAILY_CACHE_VERSION,
        savingsConfigHash,
        tzKey,
        // Spent: this re-derivation was the one the migration owed those
        // providers. A PARTIAL parse never got to use it (its fresh data only
        // filled gaps), so the entitlement is kept for the next complete run.
        ...(parseWasComplete || !c.pendingRederive ? {} : { pendingRederive: c.pendingRederive }),
        // The watermark records how far history has actually been derived, so
        // only a COMPLETE parse may advance it. A partial one produced no data
        // for whatever it could not read; moving the watermark to yesterday
        // anyway would place those days behind the next run's gapStart and
        // freeze the hole in (retention still anchors on yesterdayStr — the
        // real calendar edge — so holding the watermark can't evict anything).
        lastComputedDate: parseWasComplete ? yesterdayStr : priorWatermark,
        days: applyRetention(merged, yesterdayStr),
        complete: parseWasComplete,
        // Stamp the watermark as trusted only when a COMPLETE parse produced it,
        // so a later idle tail under this watermark is not distrusted above.
        watermarkTrusted: parseWasComplete,
      }
      await saveDailyCache(c)
      return c
    }
    if (c.tzKey === undefined) {
      // First write under the tzKey scheme: tag the cache so a later TZ change is
      // detectable, without discarding the (still-valid, same-TZ) cached days.
      c = { ...c, tzKey }
    }

    const gapStart = c.lastComputedDate
      ? new Date(
          parseInt(c.lastComputedDate.slice(0, 4)),
          parseInt(c.lastComputedDate.slice(5, 7)) - 1,
          parseInt(c.lastComputedDate.slice(8, 10)) + 1
        )
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS)

    if (gapStart.getTime() <= yesterdayEnd.getTime()) {
      const gapRange: DateRange = { start: gapStart, end: yesterdayEnd }
      const gapProjects = await parseSessions(gapRange)
      const gapDays = daysInRange(aggregateDays(gapProjects), gapRange)
      const parseWasComplete = sessionComplete()
      const priorWatermark = c.lastComputedDate
      // Gate the merge on parse completeness (issue #1127): replacing cached
      // days wholesale with the gap parse's days let a PARTIAL parse overwrite
      // a populated baseline day with its under-read version — and if the
      // day's sources die before the next complete parse, the undercount is
      // what survives. A complete parse still wins per (date, provider)
      // exactly as the re-derive path does (partial-survival guarded); a
      // partial one only fills days and slices the baseline lacks, so the gap
      // merge is strictly additive and no cached data can shrink.
      const merged = parseWasComplete
        ? mergeDayEntries(gapDays, c.days, false, undefined, true)
        : mergeDayEntries(c.days, gapDays, false)
      // Finalize as complete ONLY when the session parse that produced these days
      // was itself complete. If it was partial, leave `complete: false` so the
      // next launch (once the session cache is whole) re-backfills instead of
      // freezing the partial history — and hold the watermark where it was, for
      // the same reason as the re-derive path above: a partial parse cannot
      // vouch for the days it never read, and gapStart is the only thing that
      // will ever bring them back.
      c = { ...c, days: applyRetention(merged, yesterdayStr), lastComputedDate: parseWasComplete ? yesterdayStr : priorWatermark, complete: parseWasComplete, watermarkTrusted: parseWasComplete }
      await saveDailyCache(c)
    } else if (c.complete !== true && sessionComplete()) {
      // No gap to fill (already current through yesterday) but not yet marked —
      // e.g. a brand-new machine whose only data is today. Finalize so future
      // launches don't re-backfill the whole window every time.
      c = { ...c, complete: true, watermarkTrusted: true }
      await saveDailyCache(c)
    }
    return c
  })
}
