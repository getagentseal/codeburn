import { readFile, stat, open, rename, unlink, readdir, mkdir, rm } from 'fs/promises'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import type { ToolCall } from './types.js'

// ── Types ──────────────────────────────────────────────────────────────

export type CachedUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  cacheCreationOneHourTokens: number
}

export type CachedCall = {
  provider: string
  model: string
  usage: CachedUsage
  costUSD?: number
  /// True when `costUSD` (or the tokens it is priced from) is estimated rather
  /// than metered. Persisted so the estimated-cost marker survives the cache.
  isEstimated?: boolean
  speed: 'standard' | 'fast'
  timestamp: string
  tools: string[]
  bashCommands: string[]
  skills: string[]
  subagentTypes: string[]
  deduplicationKey: string
  project?: string
  projectPath?: string
  workingDirectory?: string
  toolSequence?: ToolCall[][]
  // Rich-session-capture (capture-only; no report consumes these yet). All
  // optional and omitted at zero/false to keep the per-call cache cost minimal.
  // Lines added/removed by this call's edits, counted from tool-result diffs
  // (Claude structuredPatch / Codex unified_diff). Numbers only, never patch text.
  locAdded?: number
  locRemoved?: number
  // True only. Claude: a tool result was interrupted / user-modified its edit.
  interrupted?: boolean
  userModified?: boolean
  // Claude: count of this call's tool results flagged is_error. Omitted at 0.
  toolErrors?: number
  // Codex: count of this call's patch applications with success === false.
  editFailed?: number
  activeDurationMs?: number
  activeGeneratedTokens?: number
  toolWaitMs?: number
}

export type CachedTurn = {
  timestamp: string
  sessionId: string
  userMessage: string
  calls: CachedCall[]
  // Claude: git branch for this turn, stored only when it differs from the
  // previous turn's branch (a report carries the last stored value forward).
  // Rich-session-capture; optional, Claude only.
  gitBranch?: string
  // GitHub PR URLs referenced during this turn, sorted and deduplicated. Claude
  // can provide native links; all providers can provide explicit URLs from the
  // saved user message. Stored directly so each turn's refs are self-contained.
  prRefs?: string[]
  // Claude: `tool_use` ids of the `Agent`/`Task` subagent spawns in this turn.
  // A spawned sidechain session is folded into the launching turn by matching its
  // resolved spawn id against these. Stored per-turn directly. Optional.
  spawnToolUseIds?: string[]
}

export type FileFingerprint = {
  dev: number
  ino: number
  mtimeMs: number
  sizeBytes: number
}

export type CachedFile = {
  fingerprint: FileFingerprint
  lastCompleteLineOffset?: number
  canonicalCwd?: string
  // Original cwd before linked-worktree canonicalization.
  workingDirectory?: string
  canonicalProjectName?: string
  mcpInventory: string[]
  turns: CachedTurn[]
  // Claude Code only: for a subagent transcript (`subagents/.../agent-*.jsonl`),
  // the `agentType` from its sibling `.meta.json` (e.g. `workflow-subagent`,
  // `Explore`, `general-purpose`). Drives the Claude-scoped agent-type breakdown.
  agentType?: string
  // Negative-result marker: this file threw while parsing at the recorded
  // fingerprint. Cached so we don't re-read + re-throw it on every refresh; it
  // is re-parsed only when the file changes (fingerprint differs). Carries no
  // turns, so it contributes no usage. (issue #441 follow-up)
  failed?: boolean
  // Rich-session-capture, Claude session-level.
  // `title` is the LAST `ai-title` entry's text; `prLinks` accumulates every
  // `pr-link` entry's URL. `isSidechain` is true when any entry is a sidechain:
  // parentUuid references an intra-file entry uuid, not another session id, so it
  // cannot link sessions — only the boolean marker is reliable. All optional.
  title?: string
  prLinks?: string[]
  isSidechain?: boolean
  // Subagent-attribution linkage (Claude only). On a SIDECHAIN file,
  // `parentSessionId` is the spawning session's id (the transcript's internal
  // `sessionId`). On a PARENT file, `agentSpawnLinks` maps each spawned subagent
  // id to the `tool_use` id of the `Agent`/`Task` block that launched it. Both
  // optional; a file is typically one or the other (a nested agent can be both).
  parentSessionId?: string
  agentSpawnLinks?: Record<string, string>
  // Parent file: agent ids whose spawn result named them but whose exact launching
  // tool_use could not be paired (ambiguous multi-result record). Drives a
  // grace-window fallback for a late child. Absent when no pairing was ambiguous.
  ambiguousSpawnAgentIds?: string[]
}

export type ProviderSection = {
  envFingerprint: string
  files: Record<string, CachedFile>
  /** True when the provider's cache entries survive source-file eviction. */
  durable?: boolean
}

export type SessionCache = {
  version: number
  providers: Record<string, ProviderSection>
  /** True only once a full scan has run to completion. The throttled partial
   *  saves during a cold hydration persist `false`; the single end-of-parse save
   *  flips it `true`. A cache that is present-but-incomplete (an interrupted cold
   *  start left a partial behind) must be treated as still cold — otherwise the
   *  emptiness heuristic reads the partial as warm, the cross-process hydration
   *  lock never engages, and totals heal only gradually while a concurrent parse
   *  can freeze a partial daily history. Absent on caches written before this
   *  field existed → read as incomplete (one self-healing re-hydration). */
  complete?: boolean
}

// ── Constants ──────────────────────────────────────────────────────────

// v5: kiro joined the costUSD pass-through allowlist (credit-based pricing).
// Cached kiro entries from v4 carry costUSD: undefined and would keep being
// re-priced from estimated tokens forever, since historical session files
// never change. Bump forces a one-time re-parse so metered credit costs land.
// v6: per-turn `prRefs` capture for turn-level PR spend attribution. Existing
// cache turns carry no prRefs; bumping forces a one-time re-parse so surviving
// transcripts populate the field. (Daily-cache versioning is untouched.)
// v7: sidechain->parent linkage - per-turn `spawnToolUseIds`, per-file
// `parentSessionId` / `agentSpawnLinks` - so subagent spend folds into the parent
// turn's PR set. v6 never shipped, so users cross v5->v7 in a single combined bump.
// INVARIANT: a version bump must extend `PRIOR_CACHE_VERSIONS` (the adoption path
// below) to EVERY prior version that can still exist on disk, or expired-PR
// history from the immediately preceding build silently vanishes.
// v8: on-disk layout only - the single blob became a directory of per-provider
// shards plus a small envelope, so a launch that only touched one provider
// rewrites just that provider's file. The turn shape is unchanged, so a v7 file
// migrates losslessly (migrateSingleFileCache) rather than re-parsing.
// v9: on-disk layout only - a provider's shard split further by the UTC month of
// each cached file, so one appended session rewrites one month instead of the
// provider's whole (100MB-scale) history, and a ranged query loads only the
// months it can possibly report on. Turn shape unchanged, so v8 and v7 both
// migrate losslessly.
export const CACHE_VERSION = 9

// The cache directory is version-suffixed for the same reason the file used to
// be: different binaries (an old launchd menubar, a newer desktop app) each own
// a distinct layout and can never clobber each other's incompatible schema.
const CACHE_DIR_NAME = `session-cache.v${CACHE_VERSION}`
// The v8 shard directory, read once by the lossless v8 -> v9 re-layout.
const PRIOR_SHARD_DIR_NAME = 'session-cache.v8'
// Written LAST on every save: it names the shard file of every provider-month, so
// the rename that publishes it is the single point at which a save becomes visible.
const ENVELOPE_FILE = 'envelope.json'
// The pre-versioning filename. Never written or deleted anymore — old binaries
// still own it. On first load we adopt-copy it once (see loadCache) when the
// versioned file is absent and the legacy file's version matches ours.
const LEGACY_CACHE_FILE = 'session-cache.json'
const TEMP_FILE_MAX_AGE_MS = 5 * 60 * 1000
// A shard the published envelope does not name is either superseded garbage or
// a CONCURRENT writer's shard that its envelope has not published yet. The
// second case is why this guard is an order of magnitude above the temp-file
// one: sweeping a live save's shard out from under it would publish an envelope
// naming a file that no longer exists. No save takes an hour.
const UNREFERENCED_SHARD_MAX_AGE_MS = 60 * 60 * 1000

// Env vars that change what a provider discovers or how its sessions parse.
// computeEnvFingerprint hashes exactly these to decide when a provider's cache
// section is stale; a var read by the provider but missing here means changing
// it serves the old section silently, reporting nothing from the new root.
// One read in src/providers/ is deliberately absent: CODEBURN_VERBOSE
// (sqlite-session-parser.ts:276) only changes logging verbosity, never parsed
// output.
//
// Copilot is deliberately NOT declared here. Declaring any CODEBURN_COPILOT_*
// var would change its fingerprint, and on a fingerprint change
// getOrCreateProviderSection (src/parser.ts:2650) keeps only the cached
// entries whose source path no longer exists — but copilot's OTel discovery
// returns one source per DB file ({ path: dbPath }, src/providers/copilot.ts:1935)
// and that DB keeps existing, so its cached entry would be dropped and
// re-parsed, destroying conversations Copilot has since pruned from the DB
// that only the cache still holds (see DURABLE_PROVIDER_NAMES below). Do not
// "complete" the map for copilot until the durable carry-forward learns to
// merge instead of drop.
export const PROVIDER_ENV_VARS: Record<string, string[]> = {
  claude: ['CLAUDE_CONFIG_DIRS', 'CLAUDE_CONFIG_DIR', 'CODEBURN_DESKTOP_SESSIONS_DIR', 'APPDATA', 'LOCALAPPDATA'],
  'cline-cli': ['CLINE_SESSION_DATA_DIR', 'CLINE_DATA_DIR', 'CLINE_DIR'],
  codebuff: ['CODEBUFF_DATA_DIR'],
  codewhale: ['CODEWHALE_HOME'],
  codex: ['CODEX_HOME'],
  hermes: ['HERMES_HOME'],
  'lingtai-tui': ['LINGTAI_HOME', 'LINGTAI_TUI_HOME', 'LINGTAI_TUI_GLOBAL_DIR'],
  droid: ['FACTORY_DIR'],
  dsh: ['DSH_HOME'],
  cursor: ['CODEBURN_CURSOR_MAX_BUBBLES'],
  // XDG_DATA_HOME is stale here (cursor-agent never reads it) but deliberately
  // kept: removing it would force a re-parse to fix nothing.
  'cursor-agent': ['XDG_DATA_HOME'],
  'open-design': ['CODEBURN_OPEN_DESIGN_DIR', 'APPDATA'],
  openclaude: ['CODEBURN_OPENCLAUDE_DIR'],
  opencode: ['XDG_DATA_HOME', 'OPENCODE_DATA_DIR', 'OPENCODE_DB_PREFIX'],
  goose: ['XDG_DATA_HOME', 'GOOSE_PATH_ROOT'],
  grok: ['GROK_HOME'],
  crush: ['XDG_DATA_HOME', 'CRUSH_GLOBAL_DATA', 'LOCALAPPDATA'],
  warp: ['WARP_DB_PATH'],
  antigravity: ['CODEBURN_CACHE_DIR'],
  'kilo-code': ['XDG_DATA_HOME'],
  kimi: ['KIMI_SHARE_DIR', 'KIMI_MODEL_NAME'],
  kiro: ['KIRO_HOME'],
  'mistral-vibe': ['VIBE_HOME'],
  mux: ['MUX_ROOT', 'CODEBURN_MUX_DIR'],
  qwen: ['QWEN_DATA_DIR'],
  'ibm-bob': ['XDG_CONFIG_HOME', 'APPDATA'],
  quickdesk: ['QUICKWORK_HOME'],
  kimicode: ['KIMI_CODE_HOME'],
  zerostack: ['ZS_DATA_DIR', 'XDG_DATA_HOME'],
  // The gateway credential is a deliberate user override and MUST move the
  // fingerprint: a read-only refresh (the refresh-lock fallback) serves the
  // cached report straight from the section (parser.ts:2875 seeds servedSources
  // before the network re-fetch at parser.ts:2888, which only runs when
  // !readOnly), so an undeclared credential would keep serving the previous
  // account's usage after a swap — the exact #920 defect.
  'vercel-gateway': ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'],
}

// Names of providers whose cache entries are never evicted when source files
// disappear — they are preserved so month-to-date totals never drop.
export const DURABLE_PROVIDER_NAMES: ReadonlySet<string> = new Set(['copilot'])

// Estimated-cost surfacing (#639): providers that set `costIsEstimated` carry a
// `-est-cost` suffix (or a new entry) so their already-cached sessions reparse
// once and the flag lands, instead of silently reading as measured. Copilot
// needs no suffix: the cli-shutdown-cost-v1 bump below already forces its one
// re-parse, which lands the flag too, and durable orphans now survive
// fingerprint changes (the carry-forward in getOrCreateProviderSection).
export const PROVIDER_PARSE_VERSIONS: Record<string, string> = {
  // rich-session-capture-v1: parse-time capture of per-turn gitBranch, per-call
  // LOC deltas / interruptions / userModified / toolErrors, and session-level
  // title / prLinks / isSidechain. Forces one re-parse so cached sessions gain
  // the new optional fields.
  claude: 'advisor-usage-v1-skills-rich-capture-v1-cross-provider-pr-v1',
  cline: 'worktree-project-grouping-v1',
  // reported-cost-v1: the CLI reports its own per-message cost, so entries
  // cached before cline-cli joined the reported-cost allowlist in parser.ts
  // hold costUSD: undefined and get re-priced from tokens on every read.
  'cline-cli': 'reported-cost-v1',
  codewhale: 'aggregate-session-v1-est-cost',
  // Bump when the Codex parser changes attribution so unchanged, already-cached
  // session files re-parse (session-cache.json serves them without invoking the
  // provider parser otherwise). Covers native mcp_tool_call_end (#513) and
  // CLI-wrapped `mcp-cli call` (#478) MCP attribution.
  // rich-session-capture-v1: per-call LOC deltas + editFailed from
  // patch_apply_end. (The codex-results.json CODEX_CACHE_VERSION is bumped in
  // lockstep so the pre-session-cache layer re-parses too.)
  // session-meta-model-v1: parse large session_meta records structurally so a
  // nested base_instructions provenance.model cannot overwrite turn_context.
  // session-meta-fields-v1: the same depth-1 window for cwd/name/originator/
  // session_id/forked_from_id/model_provider, not just model.
  // codex-pricing-v1 (#1075): reasoning tokens are no longer added on top of
  // output, and cache_write_input_tokens moves out of the plain input bucket on
  // models with an explicit cache-write rate. The bucket move does NOT self-heal
  // on read (cached entries store the buckets, not the raw event), so cached
  // sessions must re-parse.
  // codex-tps-v1 (#1079): activeGeneratedTokens summed output + reasoning, the
  // same double-count codex-pricing-v1 removed from cost. Cached entries store
  // activeGeneratedTokens/activeDurationMs/toolWaitMs verbatim (cachedCallToApiCall
  // passes them through without recomputing), so this does NOT self-heal either.
  // codex-mcp-skills-v1 (#478): CLI-wrapped MCP calls and SKILL.md reads made
  // through the `exec` custom tool or the item model's `CommandExecution` item
  // were counted as Bash only. Cached sessions store tools/toolSequence/skills
  // verbatim, so they must re-parse to gain the attribution.
  codex: 'mcp-attribution-v5-est-cost-active-timing-mcp-wait-rich-capture-v1-cross-provider-pr-v1-session-meta-model-v1-session-meta-fields-v1-codex-pricing-v1-codex-tps-v1-codex-mcp-skills-v1',
  cursor: 'composer-anchored-crediting-v1-est-cost',
  'cursor-agent': 'workspaceless-transcript-v1',
  // source-provenance-v1 (#944): CLI sessions were misread as VS Code
  // transcripts (both carry producer 'copilot-agent'), skipping the shutdown
  // input/cache rollup; this bump re-parses them so the missing tokens land.
  // #1051 does NOT bump this again. A fingerprint change drops every present
  // Copilot source (parser.ts getOrCreateProviderSection) and would erase
  // conversations already pruned from a still-present OTel DB. Old `:n`
  // shutdown keys migrate via cachedFileNeedsProviderReparse + a durable
  // strip of legacy shutdown calls on that JSONL file only.
  copilot: 'cli-shutdown-cost-v1-skills-source-provenance-v1',
  // authoritative-usage-v4: persist one Grok session call from top-level
  // authoritative totals, use modelUsage only for priced attribution, clamp
  // reasoning per record, and label mixed sessions estimated.
  grok: 'authoritative-usage-v4',
  // seed-aware-v1: the parser now skips the parent events a forked session
  // replays (double-counted before), takes the model from the reporting
  // assistant/message, and keeps agent-injected context out of the preview.
  dsh: 'seed-aware-v1',
  hermes: 'reasoning-output-accounting-v1-est-cost-routed-ids-workspace-pr-v5',
  'lingtai-tui': 'token-ledger-registry-activity-v3',
  'ibm-bob': 'worktree-project-grouping-v1',
  // project-path-v1: the parser now records the session's full working
  // directory as projectPath (CLI meta.cwd, v2 workspacePaths[0], workspace
  // sessions' workspaceDirectory), which sync attribution needs to resolve
  // the git repo. Cached entries from before the bump lack projectPath and
  // would serve attribution-blind sessions forever without a re-parse.
  kiro: 'ide-parsing-v1-est-cost-project-path-v1',
  opencode: 'session-model-v1',
  quickdesk: 'emf-sqlite-v2-est-cost',
  kimicode: 'wire-usage-v1-est-cost',
  'kilo-code': 'worktree-project-grouping-v1-session-model-v1',
  'roo-code': 'worktree-project-grouping-v1',
  warp: 'worktree-project-grouping-v1-est-cost',
  antigravity: 'worktree-project-grouping-v5',
}

function getLegacyCachePath(): string {
  return join(getCodeburnCacheDir(), LEGACY_CACHE_FILE)
}

/** Absolute path of the active (version-suffixed) session cache directory. */
export function sessionCacheDir(): string {
  return join(getCodeburnCacheDir(), CACHE_DIR_NAME)
}

// `until` is the UTC month of the newest turn any file in the shard holds. The
// shard's own key is the month of the OLDEST (a file is bucketed by its first
// turn), so the pair bounds every turn the shard can contribute and a ranged
// load can skip the shard outright when the two do not overlap the query.
type ShardRef = { name: string; until: string }
type EnvelopeProvider = {
  envFingerprint: string
  durable?: boolean
  /** month (`YYYY-MM`, or `0000-00` for turn-less files) -> shard */
  shards: Record<string, ShardRef>
}
type CacheEnvelope = {
  version: number
  complete?: boolean
  nonce: string
  providers: Record<string, EnvelopeProvider>
}

// Files with no turns (failure markers, empty sessions) have no month to bucket
// by. They live in one always-loaded bucket, which is also what makes the only
// possible re-bucketing safe: a file leaves this bucket the first time it gains
// a turn, and the bucket it leaves is guaranteed to be in memory.
const UNDATED_BUCKET = '0000-00'
// Sentinel inside `dirtyBuckets`: every bucket of the provider is dirty.
const ALL_BUCKETS = '*'

function monthKey(timestamp: string | undefined): string | null {
  if (!timestamp) return null
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The UTC month span a cached file covers: `bucket` is its OLDEST turn's month
 *  (the shard it lives in), `until` its NEWEST (how far forward the shard can
 *  contribute). Both scan every turn rather than reading turns[0]/turns[-1]:
 *  several providers emit turns out of chronological order (cursor composers by
 *  ROWID, goose/crush/copilot by a DESC ordering), and a `until < bucket` span
 *  is empty, which makes the shard unreachable at EVERY scope. */
export function cacheFileSpan(file: CachedFile): { bucket: string; until: string } {
  let bucket: string | null = null
  let until: string | null = null
  for (const turn of file.turns) {
    const month = monthKey(turn.timestamp)
    if (month === null) continue
    if (bucket === null || month < bucket) bucket = month
    if (until === null || month > until) until = month
  }
  return bucket === null ? { bucket: UNDATED_BUCKET, until: UNDATED_BUCKET } : { bucket, until: until! }
}

/** The shard bucket a cached file belongs to. Derived from the file's own turns,
 *  so an APPEND never moves it: appending can only extend `until`. */
export function cacheBucketMonth(file: CachedFile): string {
  return cacheFileSpan(file).bucket
}

// Save bookkeeping, held beside the cache rather than on it so it never lands in
// a shard's JSON or in a caller's deep-equality.
type CacheState = {
  dirty: boolean
  /** provider -> dirty months (or `ALL_BUCKETS`). */
  dirtyBuckets: Map<string, Set<string>>
  /** provider -> the shard refs the last load/save published. */
  shards: Map<string, Record<string, ShardRef>>
  /** provider -> months held in memory; `null` when the whole provider loaded. */
  loaded: Map<string, Set<string> | null>
  /** provider -> the envFingerprint the published envelope recorded. */
  fingerprints: Map<string, string>
  /** `provider\0path` -> the bucket the entry was loaded/saved under, so a
   *  delete or a re-bucketing can dirty the bucket it is leaving. */
  bucketOf: Map<string, string>
  /** The load scope this cache was read under, for the cross-request memo. */
  scope: string
}
const cacheStates = new WeakMap<SessionCache, CacheState>()

function stateOf(cache: SessionCache): CacheState {
  let state = cacheStates.get(cache)
  if (!state) {
    state = {
      dirty: false,
      dirtyBuckets: new Map(),
      shards: new Map(),
      loaded: new Map(),
      fingerprints: new Map(),
      bucketOf: new Map(),
      scope: 'all',
    }
    cacheStates.set(cache, state)
  }
  return state
}

function markBucketDirty(state: CacheState, provider: string, bucket: string): void {
  state.dirty = true
  let buckets = state.dirtyBuckets.get(provider)
  if (!buckets) { buckets = new Set(); state.dirtyBuckets.set(provider, buckets) }
  buckets.add(bucket)
}

function isBucketDirty(state: CacheState, provider: string, bucket: string): boolean {
  const buckets = state.dirtyBuckets.get(provider)
  return buckets !== undefined && (buckets.has(ALL_BUCKETS) || buckets.has(bucket))
}

/** Record that `provider`'s section changed, so the next save rewrites the
 *  affected shards. Pass `filePath` whenever the change is scoped to one cached
 *  file — both the bucket it was last saved in and the bucket it is in now are
 *  marked, so a delete, a rewrite and a re-bucketing are all covered whichever
 *  order the caller mutates and marks in. Omitting it dirties every bucket. */
export function markCacheDirty(cache: SessionCache, provider: string, filePath?: string): void {
  const state = stateOf(cache)
  if (filePath === undefined) { markBucketDirty(state, provider, ALL_BUCKETS); return }
  const prior = state.bucketOf.get(`${provider}\0${filePath}`)
  if (prior !== undefined) markBucketDirty(state, provider, prior)
  const file = cache.providers[provider]?.files[filePath]
  if (file) markBucketDirty(state, provider, cacheBucketMonth(file))
  // A path with neither a prior bucket nor a live entry (deleted before this
  // process ever saw it) still has to move `dirty`, or the save is skipped.
  state.dirty = true
}

/** True when any provider section changed since the last save. */
export function isCacheDirty(cache: SessionCache): boolean {
  return stateOf(cache).dirty
}

// ── Env Fingerprint ────────────────────────────────────────────────────

export function computeEnvFingerprint(provider: string): string {
  const vars = PROVIDER_ENV_VARS[provider] ?? []
  const parts = vars.map(v => `${v}=${process.env[v] ?? ''}`)
  const parseVersion = PROVIDER_PARSE_VERSIONS[provider]
  if (parseVersion) parts.push(`parser=${parseVersion}`)
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

// ── Load / Save ────────────────────────────────────────────────────────

export function emptyCache(): SessionCache {
  return { version: CACHE_VERSION, providers: {}, complete: false }
}

/** A cache is warm only when a full scan finished against it. Empty-but-marked
 *  (a machine with no sessions) is complete; present-but-unmarked (an interrupted
 *  cold start, or a pre-marker cache) is NOT — it is still cold. */
export function isCacheComplete(cache: SessionCache): boolean {
  return cache.complete === true
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(e => typeof e === 'string')
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isOptionalNum(v: unknown): boolean {
  return v === undefined || isNum(v)
}

function isOptionalBool(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean'
}

// A plain object whose every value is a string (or undefined). Used for the
// sidechain `agentSpawnLinks` map (agentId -> spawn tool_use id).
function isOptionalStringRecord(v: unknown): boolean {
  if (v === undefined) return true
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(e => typeof e === 'string')
}

function isToolCall(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['tool'] === 'string'
    && isOptionalString(o['file'])
    && isOptionalString(o['command'])
}

function isToolCallArray(v: unknown): boolean {
  return Array.isArray(v) && (v as unknown[]).every(isToolCall)
}

function validateFingerprint(fp: unknown): fp is FileFingerprint {
  if (!fp || typeof fp !== 'object') return false
  const f = fp as Record<string, unknown>
  return isNum(f['dev']) && isNum(f['ino']) && isNum(f['mtimeMs']) && isNum(f['sizeBytes'])
}

function validateUsage(u: unknown): u is CachedUsage {
  if (!u || typeof u !== 'object') return false
  const o = u as Record<string, unknown>
  return isNum(o['inputTokens']) && isNum(o['outputTokens'])
    && isNum(o['cacheCreationInputTokens']) && isNum(o['cacheReadInputTokens'])
    && isNum(o['cachedInputTokens']) && isNum(o['reasoningTokens'])
    && isNum(o['webSearchRequests']) && isNum(o['cacheCreationOneHourTokens'])
}

function validateCall(c: unknown): c is CachedCall {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return typeof o['provider'] === 'string'
    && typeof o['model'] === 'string'
    && typeof o['deduplicationKey'] === 'string'
    && typeof o['timestamp'] === 'string'
    && (o['speed'] === 'standard' || o['speed'] === 'fast')
    && isOptionalNum(o['costUSD'])
    && isOptionalBool(o['isEstimated'])
    && isOptionalNum(o['activeDurationMs'])
    && isOptionalNum(o['activeGeneratedTokens'])
    && isOptionalNum(o['toolWaitMs'])
    && isStringArray(o['tools'])
    && isStringArray(o['bashCommands'])
    && isStringArray(o['skills'])
    && (o['subagentTypes'] === undefined || isStringArray(o['subagentTypes']))
    && isOptionalString(o['project'])
    && isOptionalString(o['projectPath'])
    && isOptionalString(o['workingDirectory'])
    && (o['toolSequence'] === undefined || (Array.isArray(o['toolSequence']) && (o['toolSequence'] as unknown[]).every(s => isToolCallArray(s))))
    && isOptionalNum(o['locAdded'])
    && isOptionalNum(o['locRemoved'])
    && isOptionalBool(o['interrupted'])
    && isOptionalBool(o['userModified'])
    && isOptionalNum(o['toolErrors'])
    && isOptionalNum(o['editFailed'])
    && validateUsage(o['usage'])
}

function validateTurn(t: unknown): t is CachedTurn {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return typeof o['timestamp'] === 'string'
    && typeof o['sessionId'] === 'string'
    && typeof o['userMessage'] === 'string'
    && isOptionalString(o['gitBranch'])
    && (o['prRefs'] === undefined || isStringArray(o['prRefs']))
    && (o['spawnToolUseIds'] === undefined || isStringArray(o['spawnToolUseIds']))
    && Array.isArray(o['calls'])
    && (o['calls'] as unknown[]).every(validateCall)
}

function validateCachedFile(f: unknown): f is CachedFile {
  if (!f || typeof f !== 'object') return false
  const o = f as Record<string, unknown>
  return validateFingerprint(o['fingerprint'])
    && isOptionalNum(o['lastCompleteLineOffset'])
    && isOptionalString(o['canonicalCwd'])
    && isOptionalString(o['workingDirectory'])
    && isOptionalString(o['canonicalProjectName'])
    && isStringArray(o['mcpInventory'])
    && isOptionalString(o['title'])
    && (o['prLinks'] === undefined || isStringArray(o['prLinks']))
    && isOptionalBool(o['isSidechain'])
    && isOptionalString(o['agentType'])
    && isOptionalBool(o['failed'])
    && isOptionalString(o['parentSessionId'])
    && isOptionalStringRecord(o['agentSpawnLinks'])
    && (o['ambiguousSpawnAgentIds'] === undefined || isStringArray(o['ambiguousSpawnAgentIds']))
    && Array.isArray(o['turns'])
    && (o['turns'] as unknown[]).every(validateTurn)
}

// A shard's payload: the provider's `files` map, restricted to one month.
function validateFiles(v: unknown): v is Record<string, CachedFile> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every(validateCachedFile)
}

function validateProviderSection(s: unknown): s is ProviderSection {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  if (typeof o['envFingerprint'] !== 'string') return false
  if (!o['files'] || typeof o['files'] !== 'object' || Array.isArray(o['files'])) return false
  return Object.values(o['files'] as Record<string, unknown>).every(validateCachedFile)
}

// Full validation of a single-file (pre-v8) cache blob at `version`.
function validateCache(raw: unknown, version: number): raw is SessionCache {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  if (o['version'] !== version) return false
  if (!o['providers'] || typeof o['providers'] !== 'object' || Array.isArray(o['providers'])) return false
  return Object.values(o['providers'] as Record<string, unknown>).every(validateProviderSection)
}

// Every prior versioned cache file that can still exist on disk from a shipped or
// dev build, NEWEST first. On a bump we adopt the newest one present: its
// expired-source PR orphans (transcripts since deleted) hold attributable spend
// that can never be re-parsed, and each newer version already carried the older
// versions' orphans forward, so the newest is a superset. INVARIANT: a
// CACHE_VERSION bump MUST extend this list to every prior version that can still
// exist on disk, or that history silently vanishes. (v5 was missed on the 5->6
// bump; v6 on the 6->7 bump; both are listed here.)
const PRIOR_CACHE_VERSIONS = [7, 6, 5] as const

function priorCacheFile(version: number): string {
  return `session-cache.v${version}.json`
}

// Lightweight top-level check: a specific prior-version cache envelope with a
// providers object. Files are validated per-entry in adoptPriorCache so one
// corrupt entry cannot drop every valid expired-transcript PR session.
function isCacheEnvelope(raw: unknown, version: number): raw is { version: number; providers: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return o['version'] === version
    && !!o['providers'] && typeof o['providers'] === 'object' && !Array.isArray(o['providers'])
}

// One-time migration on a version bump: carry forward exactly the prior-version
// entries whose source no longer exists AND that carry prLinks (they can never
// re-parse, but they hold attributable PR spend); present sources are dropped so
// they re-parse fresh under the new version and gain the new fields. Each file is
// validated individually, so a single corrupt entry is skipped rather than
// discarding the whole cache. Each carried section takes the CURRENT
// envFingerprint so the scan reuses it and appends the freshly-parsed present
// sources. The daily cache (durable cost history) is not touched.
async function adoptPriorCache(version: number): Promise<SessionCache | null> {
  try {
    const raw = await readFile(join(getCodeburnCacheDir(), priorCacheFile(version)), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isCacheEnvelope(parsed, version)) return null
    const migrated: SessionCache = { version: CACHE_VERSION, providers: {}, complete: false }
    for (const [provider, section] of Object.entries(parsed.providers)) {
      if (!section || typeof section !== 'object') continue
      const rawFiles = (section as Record<string, unknown>)['files']
      const files: Record<string, CachedFile> = {}
      if (rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)) {
        for (const [path, file] of Object.entries(rawFiles as Record<string, unknown>)) {
          if (!validateCachedFile(file)) continue
          if (!existsSync(path) && file.prLinks?.length) files[path] = file
        }
      }
      migrated.providers[provider] = {
        envFingerprint: computeEnvFingerprint(provider),
        files,
        ...((section as Record<string, unknown>)['durable'] ? { durable: true } : {}),
      }
    }
    return migrated
  } catch {
    return null
  }
}

// Adopt EVERY prior versioned cache present on disk, migrating OLDEST first and
// merging per source path so a newer version wins per entry. Returning the newest
// alone would be wrong: a sparse or partial newer file (e.g. v6 holding only some
// orphans) would mask older-only orphans that still hold attributable spend. Newer
// entries overwrite older ones for the same path; entries unique to an older
// version survive.
async function adoptNewestPriorCache(): Promise<SessionCache | null> {
  const oldestFirst = [...PRIOR_CACHE_VERSIONS].sort((a, b) => a - b)
  let merged: SessionCache | null = null
  for (const version of oldestFirst) {
    const adopted = await adoptPriorCache(version)
    if (!adopted) continue
    if (!merged) { merged = adopted; continue }
    for (const [provider, section] of Object.entries(adopted.providers)) {
      const existing = merged.providers[provider]
      if (!existing) { merged.providers[provider] = section; continue }
      // Newer version's entries overwrite older ones for the same source path.
      Object.assign(existing.files, section.files)
      if (section.durable) existing.durable = true
    }
  }
  return merged
}

// In-process memo of the parsed cache, keyed by the envelope nonce that last
// produced it. On a 100MB+ corpus the JSON.parse of the shards is seconds of
// work per load; a resident process (codeburn serve) pays it once and
// revalidates by re-reading the (tiny) envelope per request. A save by ANOTHER
// process mints a new nonce and forces a reload, so cross-process freshness is
// preserved; saveCache updates the memo write-through so the object handed out
// stays the canonical one after a refresh.
let cacheMemo: { dir: string; nonce: string; scope: string; cache: SessionCache } | null = null

export function clearLoadCacheMemo(): void {
  cacheMemo = null
}

/** Months (UTC `YYYY-MM`, inclusive) a query can possibly report on. The load
 *  widens this by one month BELOW `fromMonth` and none above (see
 *  shardInScope): every cross-range carry in the report reads BACKWARDS from the
 *  first in-range turn, never forwards, so there is nothing above the range to
 *  reach for. */
export type CacheLoadScope = { fromMonth: string; toMonth: string }

export function monthScopeForRange(start: Date, end: Date): CacheLoadScope {
  return { fromMonth: monthKey(start.toISOString())!, toMonth: monthKey(end.toISOString())! }
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

// A shard is in scope when its [bucket .. until] span overlaps the query. One
// extra month of slack BELOW the range (and none above — every carry reads
// backwards) covers the cross-range carries that read turns from before the
// window: the pre-range PR set / git branch a session carries into its first
// in-range turn (both resolved from the same file, so they only need the file
// loaded at all), and the out-of-range subagent-spawn ANCHOR whose in-range
// child folds into it. LIMITATION: an anchor whose last turn is two or more
// months before its child's is not loaded, so that child attributes without the
// parent's PR set. One month of slack is the deliberate ceiling; widening it
// gives back the read savings the scope exists for.
// The undated bucket has no span and is always loaded.
function shardInScope(bucket: string, until: string, scope: CacheLoadScope): boolean {
  if (bucket === UNDATED_BUCKET) return true
  return bucket <= scope.toMonth && until >= previousMonth(scope.fromMonth)
}

function isShardRef(v: unknown): v is ShardRef {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['name'] === 'string' && typeof o['until'] === 'string'
}

function isEnvelope(raw: unknown): raw is CacheEnvelope {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  if (o['version'] !== CACHE_VERSION || typeof o['nonce'] !== 'string') return false
  const providers = o['providers']
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false
  return Object.values(providers as Record<string, unknown>).every(p => {
    if (!p || typeof p !== 'object') return false
    const e = p as Record<string, unknown>
    if (typeof e['envFingerprint'] !== 'string') return false
    if (!e['shards'] || typeof e['shards'] !== 'object' || Array.isArray(e['shards'])) return false
    return Object.values(e['shards'] as Record<string, unknown>).every(isShardRef)
  })
}

async function readEnvelope(dir: string): Promise<CacheEnvelope | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, ENVELOPE_FILE), 'utf-8'))
    return isEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

// A shard that is missing or malformed costs exactly the provider-months it
// held, not the provider and never the whole cache: those files re-parse while
// every other month keeps serving.
async function loadShard(path: string): Promise<Record<string, CachedFile> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return validateFiles(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the cache. With a `scope`, only the shards whose months can contribute a
 * turn to that range are read — everything else stays on disk and is carried
 * across the next save untouched (see saveCache). Durable providers and any
 * provider whose recorded fingerprint no longer matches are always read in
 * full: the first because its cache is the only surviving record of pruned
 * usage, the second because a fingerprint change discards the whole section and
 * must see every entry it is discarding.
 *
 * `CODEBURN_CACHE_SCOPE=all` is the escape hatch: it drops the scope here, at
 * the one place every caller routes through, so a suspect scoped read can be
 * compared against a full one without a rebuild. It is a READ policy and
 * deliberately not part of any env fingerprint (PROVIDER_ENV_VARS) — setting or
 * unsetting it must never invalidate a cache, only change how much of it is read.
 */
export async function loadCache(scope?: CacheLoadScope): Promise<SessionCache> {
  if (process.env['CODEBURN_CACHE_SCOPE'] === 'all') scope = undefined
  const dir = sessionCacheDir()
  const envelope = await readEnvelope(dir)
  if (!envelope) return afterMissingShardCache()
  const scopeKey = scope ? `${scope.fromMonth}..${scope.toMonth}` : 'all'
  if (cacheMemo && cacheMemo.dir === dir && cacheMemo.nonce === envelope.nonce
    && (cacheMemo.scope === 'all' || cacheMemo.scope === scopeKey)) return cacheMemo.cache

  const cache: SessionCache = { version: CACHE_VERSION, providers: {}, complete: envelope.complete === true }
  const state = stateOf(cache)
  const reads: Promise<void>[] = []
  for (const [provider, meta] of Object.entries(envelope.providers)) {
    const section: ProviderSection = {
      envFingerprint: meta.envFingerprint,
      files: {},
      ...(meta.durable ? { durable: true } : {}),
    }
    // Recorded even when every shard is skipped or unreadable: the section is
    // what tells the next save which provider these carried-forward shard refs
    // belong to, and what stops the reconcile from re-parsing under a
    // fingerprint the envelope already agrees with.
    cache.providers[provider] = section
    const full = !scope || meta.durable === true || meta.envFingerprint !== computeEnvFingerprint(provider)
    const loaded: Set<string> | null = full ? null : new Set()
    // Shards are read concurrently but merged in envelope order, so the result
    // never depends on which read finished first. A path that somehow ended up
    // in two shards resolves to the FRESHEST fingerprint and dirties both
    // buckets, so the next save prunes the loser instead of letting it linger.
    const pending: { bucket: string; files: Promise<Record<string, CachedFile> | null> }[] = []
    for (const [bucket, ref] of Object.entries(meta.shards)) {
      if (loaded && !shardInScope(bucket, ref.until, scope!)) continue
      loaded?.add(bucket)
      pending.push({ bucket, files: loadShard(join(dir, ref.name)) })
    }
    reads.push((async () => {
      for (const { bucket, files: read } of pending) {
        const files = await read
        // Unreadable: the bucket counts as loaded-and-empty and is marked
        // dirty, so the re-parsed files replace it instead of the stale shard
        // being carried forward forever.
        if (!files) { markBucketDirty(state, provider, bucket); continue }
        for (const [path, file] of Object.entries(files)) {
          const key = `${provider}\0${path}`
          const seenIn = state.bucketOf.get(key)
          if (seenIn !== undefined) {
            markBucketDirty(state, provider, seenIn)
            markBucketDirty(state, provider, bucket)
            if (section.files[path]!.fingerprint.mtimeMs >= file.fingerprint.mtimeMs) continue
          }
          state.bucketOf.set(key, bucket)
          section.files[path] = file
        }
      }
    })())
    state.loaded.set(provider, loaded)
    state.shards.set(provider, meta.shards)
    state.fingerprints.set(provider, meta.envFingerprint)
  }
  await Promise.all(reads)
  state.scope = scopeKey
  cacheMemo = { dir, nonce: envelope.nonce, scope: scopeKey, cache }
  return cache
}

// The shard directory is absent/unreadable. Prefer a LOSSLESS re-layout of the
// newest prior layout that is present (v8 provider shards, then the v7 single
// file — both hold the current turn shape, so nothing re-parses); failing that,
// adopt the prior versions' expired-source PR orphans, then the legacy
// unversioned file. Either way the shard directory is minted on the next save.
async function afterMissingShardCache(): Promise<SessionCache> {
  const relaid = await migrateProviderShardCache() ?? await migrateSingleFileCache()
  if (relaid) return relaid
  const prior = await adoptNewestPriorCache()
  if (prior) return prior
  // validateCache requires the version to match, so a different-version legacy
  // file is ignored (left intact). We copy it into the shard layout once via
  // saveCache; the legacy file is never modified.
  return adoptLegacyCache()
}

// One-time, lossless re-layout of the v8 per-provider shard directory: v9
// changed the on-disk LAYOUT only, so every entry moves across verbatim (just
// re-bucketed by month in memory) and nothing re-parses. The v8 directory is
// removed only once the v9 save has published.
async function migrateProviderShardCache(): Promise<SessionCache | null> {
  const dir = join(getCodeburnCacheDir(), PRIOR_SHARD_DIR_NAME)
  let envelope: { complete?: boolean; shards: Record<string, string> }
  try {
    const parsed = JSON.parse(await readFile(join(dir, ENVELOPE_FILE), 'utf-8')) as Record<string, unknown>
    if (parsed['version'] !== 8 || !parsed['shards'] || typeof parsed['shards'] !== 'object') return null
    envelope = parsed as { complete?: boolean; shards: Record<string, string> }
  } catch {
    return null
  }
  const cache: SessionCache = { version: CACHE_VERSION, providers: {}, complete: envelope.complete === true }
  await Promise.all(Object.entries(envelope.shards).map(async ([provider, name]) => {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf-8'))
      if (validateProviderSection(parsed)) cache.providers[provider] = parsed
    } catch { /* one unreadable v8 shard costs that provider, as it already did */ }
  }))
  return publishRelaidCache(cache, () => rm(dir, { recursive: true, force: true }))
}

// One-time, lossless re-layout of the v7 single-file cache. v7 never wrote a
// shard directory, so it is migrated straight to v9 without minting a v8 in
// between.
async function migrateSingleFileCache(): Promise<SessionCache | null> {
  const v7Path = join(getCodeburnCacheDir(), priorCacheFile(7))
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(v7Path, 'utf-8'))
  } catch {
    return null
  }
  if (!validateCache(parsed, 7)) return null
  return publishRelaidCache(
    { version: CACHE_VERSION, providers: parsed.providers, complete: parsed.complete === true },
    () => unlink(v7Path),
  )
}

// Every section is marked dirty so the save writes each month's shard; the old
// layout is retired only once that save has published.
async function publishRelaidCache(cache: SessionCache, retire: () => Promise<unknown>): Promise<SessionCache> {
  for (const provider of Object.keys(cache.providers)) markCacheDirty(cache, provider)
  const published = await saveCache(cache).catch(() => false)
  if (published) await retryCacheFileMutation(async () => { await retire() })
  return cache
}

async function adoptLegacyCache(): Promise<SessionCache> {
  try {
    const raw = await readFile(getLegacyCachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!validateCache(parsed, CACHE_VERSION)) return emptyCache()
    for (const provider of Object.keys(parsed.providers)) markCacheDirty(parsed, provider)
    await saveCache(parsed).catch(() => {})
    return parsed
  } catch {
    return emptyCache()
  }
}

// Shard filenames carry a fresh nonce on every write, so a save never overwrites
// the file the currently-published envelope points at: readers keep seeing a
// consistent set until the envelope rename publishes the new one, and a writer
// that loses the ownership fence leaves the canonical shards untouched.
function shardFileName(provider: string, bucket: string): string {
  return `${provider.replace(/[^A-Za-z0-9_-]/g, '_')}.${bucket}.${randomBytes(8).toString('hex')}.json`
}

// The temp name carries a nonce: two processes writing the SAME final path
// (the envelope, every save) would otherwise share one temp file and interleave
// their writes into a torn or foreign payload.
async function writeFileAtomic(finalPath: string, payload: string): Promise<void> {
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(tempPath, finalPath)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 2) throw err
        await new Promise(resolve => { setTimeout(resolve, 10 * (attempt + 1)) })
      }
    }
  } catch (err) {
    await retryCacheFileMutation(() => unlink(tempPath))
    throw err
  }
}

function bucketFiles(section: ProviderSection): { groups: Map<string, Record<string, CachedFile>>; until: Map<string, string> } {
  const groups = new Map<string, Record<string, CachedFile>>()
  const until = new Map<string, string>()
  for (const [path, file] of Object.entries(section.files)) {
    const span = cacheFileSpan(file)
    let group = groups.get(span.bucket)
    if (!group) { group = {}; groups.set(span.bucket, group) }
    group[path] = file
    const seen = until.get(span.bucket)
    if (seen === undefined || span.until > seen) until.set(span.bucket, span.until)
  }
  return { groups, until }
}

function untilMonth(files: Record<string, CachedFile>): string {
  let until = UNDATED_BUCKET
  for (const file of Object.values(files)) {
    const month = cacheFileSpan(file).until
    if (month > until) until = month
  }
  return until
}

// What a save has decided about one provider, carried across the ownership
// fence so every shard READ that a save needs happens as late as possible (see
// the phase-two comment in saveCache).
type ProviderPlan = {
  section: ProviderSection
  groups: Map<string, Record<string, CachedFile>>
  loaded: Set<string> | null
  priorRefs: Record<string, ShardRef>
  reset: boolean
  /** Paths that may ALSO still sit in a shard this run never loaded. */
  moved: Set<string>
  /** Buckets whose payload has to be merged with the published shard first. */
  deferred: string[]
  /** bucket -> the shard name the merge was built from, for the retry below. */
  mergedFrom: Map<string, string | undefined>
  refs: Record<string, ShardRef>
}

export async function saveCache(cache: SessionCache, verifyStillOwner?: () => Promise<boolean>): Promise<boolean> {
  const dir = sessionCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 })

  const state = stateOf(cache)
  const written = new Set<string>()
  const plans = new Map<string, ProviderPlan>()

  const writeShard = async (provider: string, bucket: string, files: Record<string, CachedFile>): Promise<ShardRef> => {
    const name = shardFileName(provider, bucket)
    await writeFileAtomic(join(dir, name), JSON.stringify(files))
    written.add(name)
    return { name, until: untilMonth(files) }
  }

  // Overlay this run's entries for `bucket` onto the published shard `from`,
  // minus any path that has since moved to another month.
  const mergeShard = async (provider: string, plan: ProviderPlan, bucket: string, from: string | undefined): Promise<ShardRef> => {
    const files = plan.groups.get(bucket)!
    const onDisk = from ? await loadShard(join(dir, from)) : null
    if (!onDisk) return writeShard(provider, bucket, files)
    // A file whose month this run never loaded has no visible cache entry, so it
    // looks uncached and is re-parsed into the same bucket — re-deriving the
    // entry the shard already holds. Republishing then churns the shard's nonce
    // name on every run for content that never changed (#1032), so a merge that
    // neither adds, changes nor removes an entry keeps the published shard.
    const adds = Object.entries(files).some(([path, file]) =>
      onDisk[path] === undefined || JSON.stringify(onDisk[path]) !== JSON.stringify(file))
    const removes = [...plan.moved].some(path => onDisk[path] !== undefined && files[path] === undefined)
    if (!adds && !removes) return { name: from!, until: untilMonth(onDisk) }
    for (const path of plan.moved) delete onDisk[path]
    return writeShard(provider, bucket, { ...onDisk, ...files })
  }

  try {
    // ── Phase one: everything that can be written from memory alone ──────
    for (const [provider, section] of Object.entries(cache.providers)) {
      const priorRefs = state.shards.get(provider) ?? {}
      const loaded = state.loaded.get(provider) ?? null
      // A fingerprint change discards the section outright (see
      // getOrCreateProviderSection), so the months it did not load must be
      // dropped rather than carried — they hold entries under the old
      // fingerprint. loadCache never scopes such a provider, so `loaded` is
      // null here in practice; the guard is what makes that safe to rely on.
      const priorFingerprint = state.fingerprints.get(provider)
      const reset = priorFingerprint !== undefined && priorFingerprint !== section.envFingerprint
      const { groups } = bucketFiles(section)
      const plan: ProviderPlan = { section, groups, loaded, priorRefs, reset, moved: new Set(), deferred: [], mergedFrom: new Map(), refs: {} }
      plans.set(provider, plan)

      // An entry whose bucket this run never loaded may ALSO still exist, under
      // an older month, in a shard we are about to carry across verbatim — a
      // re-parse that shifted the file's oldest turn, or (the common #441 path)
      // a parse failure that left a turn-less marker with no month at all. Left
      // alone, the path would live in two shards at once and a later load could
      // resolve to the stale copy. Both cases are rare, so the prune they
      // trigger below reads shards it otherwise would not.
      if (loaded) {
        for (const [path, file] of Object.entries(section.files)) {
          if (state.bucketOf.has(`${provider}\0${path}`)) continue
          const bucket = cacheFileSpan(file).bucket
          if (!loaded.has(bucket) || bucket === UNDATED_BUCKET) plan.moved.add(path)
        }
      }

      for (const [bucket, files] of groups) {
        const prior = priorRefs[bucket]
        // `priorRefs` is this process's snapshot from its last load or save.
        // ANOTHER process may have republished that shard since, unlinking the
        // file we are about to name — so reuse is conditional on the file still
        // being there, and a vanished one is rewritten from memory.
        if (prior && !isBucketDirty(state, provider, bucket) && existsSync(join(dir, prior.name))) {
          plan.refs[bucket] = prior
          continue
        }
        // Dirty but never loaded: memory holds only the entries this run wrote
        // into the bucket, so the published shard's other entries have to be
        // merged back in or the save would drop them. Deferred to phase two so
        // the read happens against the CURRENT shard, not a stale name.
        if (loaded && !loaded.has(bucket) && prior) { plan.deferred.push(bucket); continue }
        plan.refs[bucket] = await writeShard(provider, bucket, files)
      }
    }

    // The warm refresh transaction passes an ownership fence. It must be the
    // final operation before publication so a displaced writer cannot replace
    // the canonical cache with its stale snapshot. Shards written above are
    // unreferenced until the envelope names them, so a lost fence publishes
    // nothing.
    if (verifyStillOwner && !await verifyStillOwner()) {
      for (const name of written) await retryCacheFileMutation(() => unlink(join(dir, name)))
      return false
    }

    // ── Phase two: everything that has to read the published shards ──────
    // Re-read the envelope first. Between our load and now, another process may
    // have republished any month we are carrying or merging into; adopting its
    // CURRENT name is what keeps a carried orphan (an expired transcript's PR
    // spend, unrecoverable by any re-parse) from being dropped just because the
    // name we remembered was retired. It also shrinks the read-modify-write
    // window for a merge down to the publish itself. That window is not zero:
    // two processes merging into the same unloaded month can still interleave,
    // and the loser's entries are re-derived on the next parse rather than lost
    // for good — a full lock here would cost every save the contention.
    const live = await readEnvelope(dir)
    for (const [provider, plan] of plans) {
      const liveShards = live?.providers[provider]?.shards ?? {}
      const currentName = (bucket: string): string | undefined => {
        const name = liveShards[bucket]?.name ?? plan.priorRefs[bucket]?.name
        return name && existsSync(join(dir, name)) ? name : undefined
      }

      for (const bucket of plan.deferred) {
        plan.refs[bucket] = await mergeShard(provider, plan, bucket, currentName(bucket))
        plan.mergedFrom.set(bucket, currentName(bucket))
      }

      // Months this run never loaded keep their published shard. This is the
      // invariant that makes a scoped load safe to save from. A month another
      // process published while we held a partial view is adopted for the same
      // reason: dropping it would delete history we never even saw.
      if (!plan.loaded || plan.reset) continue
      const carried = new Set([...Object.keys(plan.priorRefs), ...Object.keys(liveShards)])
      for (const bucket of carried) {
        if (plan.refs[bucket] || plan.groups.has(bucket) || plan.loaded.has(bucket)) continue
        const name = currentName(bucket)
        if (!name) continue
        const ref = { name, until: (liveShards[bucket] ?? plan.priorRefs[bucket])!.until }
        if (plan.moved.size === 0) { plan.refs[bucket] = ref; continue }
        // A path that moved into another month must not survive here too.
        const onDisk = await loadShard(join(dir, name))
        if (!onDisk || !Object.keys(onDisk).some(p => plan.moved.has(p))) { plan.refs[bucket] = ref; continue }
        for (const path of plan.moved) delete onDisk[path]
        if (Object.keys(onDisk).length > 0) plan.refs[bucket] = await writeShard(provider, bucket, onDisk)
      }
    }

    // One optimistic retry: if another process republished a month we merged
    // into while we were reading it, our shard was built on a superseded
    // pre-image and would drop that process's entries. Redoing the merge from
    // the current shard narrows the read-modify-write window from a shard read
    // down to the envelope publish below. It does not close it — a save that
    // loses the remaining race has its entries re-derived by the next parse
    // (the reconcile sees no cache entry and re-reads the file), never silently
    // dropped for good. A lock here would tax every save for a rare interleave.
    const settled = await readEnvelope(dir)
    for (const [provider, plan] of plans) {
      for (const [bucket, mergedFrom] of plan.mergedFrom) {
        const now = settled?.providers[provider]?.shards[bucket]?.name
        if (!now || now === mergedFrom || !existsSync(join(dir, now))) continue
        plan.refs[bucket] = await mergeShard(provider, plan, bucket, now)
      }
    }

    // Last look before publishing: a concurrent save may have unlinked a shard
    // in the moment since. An envelope must never name a file that is already
    // gone — that reads back as a corrupt month and drops its history.
    const providers: Record<string, EnvelopeProvider> = {}
    for (const [provider, plan] of plans) {
      const shards: Record<string, ShardRef> = {}
      for (const [bucket, ref] of Object.entries(plan.refs)) {
        if (written.has(ref.name) || existsSync(join(dir, ref.name))) { shards[bucket] = ref; continue }
        const files = plan.groups.get(bucket)
        // A carried month whose file vanished and whose content was never in
        // memory cannot be rewritten; dropping the reference is the only honest
        // option, and the sweep retires the name.
        if (files) shards[bucket] = await writeShard(provider, bucket, files)
      }
      providers[provider] = {
        envFingerprint: plan.section.envFingerprint,
        ...(plan.section.durable ? { durable: true } : {}),
        shards,
      }
    }

    const envelope: CacheEnvelope = {
      version: CACHE_VERSION,
      complete: cache.complete === true,
      nonce: randomBytes(8).toString('hex'),
      providers,
    }
    await writeFileAtomic(join(dir, ENVELOPE_FILE), JSON.stringify(envelope))

    // Shards the new envelope no longer references are garbage; a reader that
    // already opened one keeps reading it, and any failure here is swept later
    // by cleanupOrphanedTempFiles.
    const retired: string[] = []
    for (const [provider, priorRefs] of state.shards) {
      const kept = providers[provider]?.shards ?? {}
      for (const [bucket, ref] of Object.entries(priorRefs)) {
        if (kept[bucket]?.name !== ref.name) retired.push(ref.name)
      }
    }

    state.dirty = false
    state.dirtyBuckets.clear()
    state.shards.clear()
    state.fingerprints.clear()
    state.bucketOf.clear()
    // `loaded` deliberately survives: a merged-and-rewritten shard is complete
    // on disk but still partial in memory, so the next save has to merge again.
    for (const [provider, meta] of Object.entries(providers)) {
      state.shards.set(provider, meta.shards)
      state.fingerprints.set(provider, meta.envFingerprint)
      for (const [path, file] of Object.entries(cache.providers[provider]!.files)) {
        state.bucketOf.set(`${provider}\0${path}`, cacheFileSpan(file).bucket)
      }
    }
    // Write-through: the object just published IS the freshest state, so the
    // next loadCache in this process reuses it instead of re-parsing. Its scope
    // is whatever was loaded, not `all` — a save never widens what is in memory.
    cacheMemo = { dir, nonce: envelope.nonce, scope: state.scope, cache }
    for (const name of retired) await retryCacheFileMutation(() => unlink(join(dir, name)))
    return true
  } catch (err) {
    for (const name of written) await retryCacheFileMutation(() => unlink(join(dir, name)))
    throw err
  }
}

async function retryCacheFileMutation(operation: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await operation()
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return true
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 2) return false
      await new Promise(resolve => { setTimeout(resolve, 10 * (attempt + 1)) })
    }
  }
  return false
}

// ── File Fingerprinting ────────────────────────────────────────────────
//
// Fingerprints cover the source's transcript file only. Providers that keep
// metadata in a companion file (kiro CLI: credits in `<id>.json` next to the
// `.jsonl`; kiro v2: modelId in `session.json` next to `messages.jsonl`) have
// a blind spot: a parse that races the companion write caches the turn with
// fallback values, and if the transcript never changes again (a session's
// final turn) the entry never invalidates. Mid-session turns self-heal since
// append-only transcripts keep changing. Fixing this properly means
// multi-file fingerprints per source.

// SQLite database files by extension. Bare-db sources (copilot's
// agent-traces.db) and the virtual-suffix bases below all match one of these.
const SQLITE_DB_PATH = /\.(db|sqlite3?|vscdb)$/i

/// Fingerprint a SQLite database file together with its `-wal` sibling.
///
/// A database in WAL mode parks committed writes in `<db>-wal`; the main
/// file's stat only moves on checkpoint, and a long-lived writer connection
/// (hermes, cursor and opencode keep their state DBs open for the life of
/// the agent process) can defer checkpoints for hours or days. A fingerprint
/// built from the main file alone then (a) carries an mtime older than the
/// newest committed data, so the date-range mtime pre-filter in
/// parseProviderSources skips the source and sessions committed after the
/// last checkpoint never parse (issue #913: today's Hermes sessions missing
/// from every report), and (b) does not change between checkpoints, so
/// reconcileFile keeps serving stale cached turns for sessions that grew.
/// Folding the WAL sibling in fixes both: the newest mtime wins, and the
/// sizes add so both WAL growth and a checkpoint (db grows, wal truncates)
/// move the fingerprint. `-shm` is deliberately ignored — it mutates on
/// reads too and would churn the fingerprint without any data change.
async function fingerprintSqliteFile(dbPath: string): Promise<FileFingerprint | null> {
  try {
    const s = await stat(dbPath)
    const wal = await stat(dbPath + '-wal').catch(() => null)
    return {
      dev: s.dev,
      ino: s.ino,
      mtimeMs: wal ? Math.max(s.mtimeMs, wal.mtimeMs) : s.mtimeMs,
      sizeBytes: s.size + (wal?.size ?? 0),
    }
  } catch {
    return null
  }
}

export async function fingerprintFile(filePath: string): Promise<FileFingerprint | null> {
  try {
    const s = await stat(filePath)
    // A source path that IS a SQLite database (copilot OTel's agent-traces.db)
    // needs the same WAL fold as the virtual-suffix forms below.
    if (SQLITE_DB_PATH.test(filePath)) return fingerprintSqliteFile(filePath)
    return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
  } catch {
    // Providers encode extra context into source paths using virtual suffixes:
    // - Cursor: `<dbPath>#cursor-ws=<workspace>` (workspace-aware routing)
    // - OpenCode: `<dbPath>:<sessionId>` (session scoping)
    // - Hermes: `<dbPath>#hermes-session=<sessionId>` (session scoping)
    // These compound paths don't exist on disk; strip the suffix to stat the
    // underlying database. Try `#` first (rare in real paths), then `:` (must
    // use lastIndexOf to tolerate Windows drive letters like C:\...).
    const hashIdx = filePath.indexOf('#')
    if (hashIdx > 0) {
      const fp = await fingerprintSqliteFile(filePath.slice(0, hashIdx))
      if (fp) return fp
      // fall through to colon check
    }
    const colonIdx = filePath.lastIndexOf(':')
    if (colonIdx > 0) {
      return fingerprintSqliteFile(filePath.slice(0, colonIdx))
    }
    return null
  }
}

// ── Reconciliation ─────────────────────────────────────────────────────

export type ReconcileAction =
  | { action: 'unchanged' }
  | { action: 'appended'; readFromOffset: number }
  | { action: 'modified' }
  | { action: 'new' }

export function reconcileFile(
  current: FileFingerprint,
  cached: CachedFile | undefined,
): ReconcileAction {
  if (!cached) return { action: 'new' }

  const fp = cached.fingerprint

  if (
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    fp.mtimeMs === current.mtimeMs &&
    fp.sizeBytes === current.sizeBytes
  ) {
    return { action: 'unchanged' }
  }

  if (
    cached.lastCompleteLineOffset !== undefined &&
    // Defensive: never resume past the file's current end. A truncate-then-regrow
    // can leave the cached offset stranded beyond live bytes; reading from there
    // would silently drop the appended tail, so fall back to a full re-parse.
    cached.lastCompleteLineOffset <= current.sizeBytes &&
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    current.sizeBytes > fp.sizeBytes
  ) {
    return { action: 'appended', readFromOffset: cached.lastCompleteLineOffset }
  }

  return { action: 'modified' }
}

// ── Dedup Merge ────────────────────────────────────────────────────────
// When appending incremental data, streaming Claude messages can re-emit
// the same dedup key with updated usage. Merge by key: keep the earliest
// timestamp, take incoming usage/tools/bashCommands/skills (latest wins).

export function mergeCallByDedupKey(
  existing: CachedCall,
  incoming: CachedCall,
): CachedCall {
  return {
    ...incoming,
    timestamp: existing.timestamp < incoming.timestamp
      ? existing.timestamp
      : incoming.timestamp,
  }
}

// ── Temp Cleanup ───────────────────────────────────────────────────────

async function unlinkIfOlderThan(path: string, maxAgeMs: number, now: number): Promise<void> {
  try {
    const s = await stat(path)
    if (now - s.mtimeMs > maxAgeMs) await unlink(path)
  } catch {}
}

// Sweeps our own shard directory: interrupted temp writes, plus shards the
// published envelope no longer references. Also retires the single-file layout's
// leftover temps in the parent directory, which nothing writes anymore.
export async function cleanupOrphanedTempFiles(): Promise<void> {
  const now = Date.now()
  const parent = getCodeburnCacheDir()

  // `session-cache.v<n>.json.<nonce>.tmp` from a pre-v8 binary interrupted
  // mid-write. Age-guarded, so an old binary's in-flight write is left alone.
  // `status-snapshot.json.<nonce>.tmp` (see saveStatusSnapshot below) is swept
  // here too: it lives in this same parent dir, orthogonal to the month-shard
  // layout below, so the shard-dir sweep further down never sees it. Same
  // atomic temp+rename pattern, same narrow crash window between the write
  // and the rename as the versioned cache file above.
  try {
    for (const entry of await readdir(parent)) {
      if (!entry.endsWith('.tmp')) continue
      if (!/^session-cache\.v\d+\.json\./.test(entry) && !entry.startsWith(`${STATUS_SNAPSHOT_FILE}.`)) continue
      await unlinkIfOlderThan(join(parent, entry), TEMP_FILE_MAX_AGE_MS, now)
    }
  } catch {}

  const dir = sessionCacheDir()
  if (!existsSync(dir)) return

  const referenced = new Set<string>([ENVELOPE_FILE])
  const envelope = await readEnvelope(dir)
  if (envelope) {
    for (const meta of Object.values(envelope.providers)) {
      for (const ref of Object.values(meta.shards)) referenced.add(ref.name)
    }
    // A published v9 envelope means the re-layout completed. Its retirement of
    // the old layout is a separate, unsynchronised step, so a crash in between
    // leaves 100MB+ of superseded cache behind forever. Age-guarded for the
    // same reason the shard sweep is: an OLD binary may still be writing there.
    await unlinkIfOlderThan(join(getCodeburnCacheDir(), priorCacheFile(7)), UNREFERENCED_SHARD_MAX_AGE_MS, now)
    const v8Dir = join(getCodeburnCacheDir(), PRIOR_SHARD_DIR_NAME)
    try {
      const s = await stat(join(v8Dir, ENVELOPE_FILE))
      if (now - s.mtimeMs > UNREFERENCED_SHARD_MAX_AGE_MS) await rm(v8Dir, { recursive: true, force: true })
    } catch {}
  }

  try {
    for (const entry of await readdir(dir)) {
      if (entry.endsWith('.tmp')) {
        await unlinkIfOlderThan(join(dir, entry), TEMP_FILE_MAX_AGE_MS, now)
        continue
      }
      if (!envelope || referenced.has(entry)) continue
      await unlinkIfOlderThan(join(dir, entry), UNREFERENCED_SHARD_MAX_AGE_MS, now)
    }
  } catch {}
}

// ── Hydration Lock ─────────────────────────────────────────────────────
//
// Advisory, cross-process coordination for the expensive cold hydration. When
// two live processes (e.g. an old launchd menubar and the desktop app) both
// cold-start against the same cache dir, without this they each parse full
// history and race their writes. The first to arrive creates the lock and
// hydrates; a second live process waits for release, then reads the now-warm
// cache instead of re-parsing. It is strictly an optimization: on any
// uncertainty we proceed with the parse, so it can never wedge a cold start.

const HYDRATION_LOCK_FILE = 'hydrating.lock'
const LOCK_FRESH_MS = 15 * 60_000
const LOCK_WAIT_MAX_MS = 10 * 60_000
const LOCK_POLL_MS = 250

type LockRecord = { pid: number; at: number }
export type HydrationHandle = { waited: boolean; release: () => Promise<void> }

const NOOP_HANDLE: HydrationHandle = { waited: false, release: async () => {} }

function lockPath(): string {
  return join(getCodeburnCacheDir(), HYDRATION_LOCK_FILE)
}

// Our own pid never counts as a foreign holder: a same-process lock is either
// re-entrant or leaked, and waiting on ourselves risks a self-hang. Cross-process
// coordination is the only thing this lock is for. EPERM means the pid exists but
// belongs to another user — still alive.
function pidLooksAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try { process.kill(pid, 0); return true }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

async function readLockRecord(): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath(), 'utf-8')) as Partial<LockRecord>
    if (typeof parsed?.pid === 'number' && typeof parsed?.at === 'number') return { pid: parsed.pid, at: parsed.at }
    return null
  } catch { return null }
}

async function writeOurLock(): Promise<boolean> {
  try {
    const dir = getCodeburnCacheDir()
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const handle = await open(lockPath(), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), { encoding: 'utf-8' }) }
    finally { await handle.close() }
    return true
  } catch { return false }
}

async function removeOurLock(): Promise<void> {
  try {
    const cur = await readLockRecord()
    if (cur && cur.pid === process.pid) await unlink(lockPath())
  } catch { /* best-effort; a leaked lock is reclaimed as stale next cold start */ }
}

// Synchronous variant for the signal path: a handler can't await, so read + unlink
// synchronously. Only unlinks a lock we actually own.
function removeOurLockSync(): void {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), 'utf-8')) as Partial<LockRecord>
    if (parsed?.pid === process.pid) unlinkSync(lockPath())
  } catch { /* best-effort; nothing to clean or already gone */ }
}

// Arm once, only while we hold the lock: on a catchable termination (Ctrl-C, or a
// SIGTERM from a parent) clean our lock before dying so a killed cold parse leaves
// no leftover. SIGKILL can't be caught, so that path still relies on the next cold
// start's stale-lock takeover. process.once + re-raise preserves the default exit.
let signalCleanupArmed = false
function armSignalCleanup(): void {
  if (signalCleanupArmed) return
  signalCleanupArmed = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      removeOurLockSync()
      process.kill(process.pid, sig)
    })
  }
}

const releaseHandle: HydrationHandle = { waited: false, release: removeOurLock }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Coordinate a cold hydration. Pass `isCold = true` only when the on-disk cache
 * is empty (a genuine full parse is imminent). Returns a handle:
 *  - `waited: true`  → another live process was hydrating; we waited for it to
 *    finish (or timed out). The caller should RELOAD the cache and let its normal
 *    reconcile serve the now-warm entries instead of re-parsing. `release` is a
 *    no-op (we never held the lock).
 *  - `waited: false` with a real `release` → we hold the lock; hydrate, then call
 *    `release()` in a finally.
 *  - `waited: false` with a no-op `release` → proceed with the parse unlocked
 *    (not cold, or the lock state was uncertain).
 */
export async function beginColdHydration(isCold: boolean): Promise<HydrationHandle> {
  if (!isCold) return NOOP_HANDLE
  try {
    if (await writeOurLock()) { armSignalCleanup(); return releaseHandle }
    const existing = await readLockRecord()
    const fresh = existing !== null && Date.now() - existing.at < LOCK_FRESH_MS
    if (existing && fresh && pidLooksAlive(existing.pid)) {
      // Another live process owns a fresh lock: wait for it to release, go stale,
      // or die. A CLEAN release means the cache is warm — reload it. Going stale or
      // dying (e.g. a SIGKILLed cold scan) means the holder left partial data AND a
      // leftover lock file: take over — clean the stale lock and re-acquire — so we
      // re-parse under our own lock and remove the leftover on release, instead of
      // leaving it for the next cold start to reclaim.
      const deadline = Date.now() + LOCK_WAIT_MAX_MS
      let takeover = false
      while (Date.now() < deadline) {
        await sleep(LOCK_POLL_MS)
        const cur = await readLockRecord()
        if (!cur) break
        if (Date.now() - cur.at >= LOCK_FRESH_MS) { takeover = true; break }
        if (!pidLooksAlive(cur.pid)) { takeover = true; break }
      }
      if (takeover) {
        try { await unlink(lockPath()) } catch { /* another process may have; fine */ }
        if (await writeOurLock()) { armSignalCleanup(); return releaseHandle }
      }
      return { waited: true, release: async () => {} }
    }
    // Stale, dead-pid, or unreadable lock: replace it and take over.
    try { await unlink(lockPath()) } catch { /* another process may have; fine */ }
    if (await writeOurLock()) return releaseHandle
    return NOOP_HANDLE
  } catch {
    return NOOP_HANDLE
  }
}

// ── Status Snapshot ────────────────────────────────────────────────────
//
// `codeburn status --format menubar-json` is spawned as a fresh CLI process
// on every menubar poll tick, so every in-process reuse layer above
// (`cacheMemo`, and `parser.ts`'s TTL/burst maps) starts cold on every poll —
// none of them survive between invocations. Live profiling of a repeat poll
// against an already-warm, unchanged ~386MB session cache showed the cost is
// dominated by re-running `JSON.parse` on that whole file plus re-running the
// full aggregation pipeline over it, every single time, even when nothing in
// the underlying session corpus changed.
//
// This snapshot persists the last computed menubar payload keyed by a
// caller-supplied corpus fingerprint (see `computeCorpusFingerprint` in
// parser.ts — a cheap stat-only pass over every discovered source, with no
// session-cache.json read/parse and no transcript content read) plus the
// resolved query that produced it. A poll whose corpus fingerprint and query
// both still match is served straight from this tiny file with no corpus
// parse or aggregation at all; the instant either changes, the lookup misses
// and the caller recomputes for real. Best-effort throughout: any read/write
// failure just falls back to a full recompute, never to stale or corrupt
// data.

// Debounce: once the corpus fingerprint moves, keep serving the last SETTLED
// snapshot until the freshest touched file (`newestMtimeMs`, from
// `computeCorpusFingerprint`) has aged past this window, instead of
// recomputing on every single poll of a burst. A streaming assistant turn
// can touch its transcript many times a second; without this, a menubar
// polling on a tight interval would pay the full parse+aggregation cost on
// every one of those ticks. The deferred call deliberately does NOT persist
// a new snapshot — the pre-churn baseline it's still serving stays on disk —
// so the very next poll after writes actually stop (mtime ages past the
// window) sees a real fingerprint mismatch with no fresh grace period left,
// recomputes for real, and persists the settled result. No update is ever
// masked permanently: the window only ever delays picking one up. Mirrors
// the existing `parseBurstWindowMs`/`CODEBURN_PARSE_BURST_MS` convention:
// small, capped, env-overridable for tuning/tests.
function statusSnapshotSettleMs(): number {
  const raw = Number(process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS'] ?? '2000')
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60_000) : 2000
}

const STATUS_SNAPSHOT_FILE = 'status-snapshot.json'

// Bump on any incompatible change to the *shape* of the payload this snapshot
// persists (i.e. whenever `buildMenubarPayloadForRange`'s return shape
// changes) or to this record's own envelope fields. Without this, an on-disk
// snapshot written by an older binary would be blindly cast and served
// verbatim by a newer one on a corpus-fingerprint+query match — the payload
// shape has no other correctness gate, unlike the main session cache, which
// already guards exactly this class of drift via `CACHE_VERSION`/
// `validateCache`. A version mismatch is treated as a miss (same as a
// missing/corrupt file): the caller recomputes for real and persists a fresh,
// current-shaped snapshot.
const STATUS_SNAPSHOT_VERSION = 1

type StatusSnapshotRecord = {
  version: number
  corpusFingerprint: string
  newestMtimeMs: number
  queryKey: string
  payload: unknown
  // Wall-clock time (Date.now()) the FIRST mismatch against this record's
  // corpusFingerprint was observed. Absent = not currently mismatched (a
  // fresh save, or a record no load has mismatched against yet). This is
  // what the settle-window decision anchors on — see `loadStatusSnapshot`.
  mismatchFirstSeenAt?: number
}

function statusSnapshotPath(): string {
  return join(getCodeburnCacheDir(), STATUS_SNAPSHOT_FILE)
}

async function readStatusSnapshotRecord(): Promise<StatusSnapshotRecord | null> {
  try {
    const raw = await readFile(statusSnapshotPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StatusSnapshotRecord>
    if (
      parsed.version !== STATUS_SNAPSHOT_VERSION ||
      typeof parsed.corpusFingerprint !== 'string' ||
      typeof parsed.newestMtimeMs !== 'number' || !Number.isFinite(parsed.newestMtimeMs) ||
      typeof parsed.queryKey !== 'string'
    ) return null
    return parsed as StatusSnapshotRecord
  } catch {
    return null
  }
}

/** Shared best-effort atomic writer for both `saveStatusSnapshot` (a fresh,
 *  settled recompute) and `loadStatusSnapshot`'s own bookkeeping write (a
 *  first-observed-mismatch timestamp, so the settle clock survives across
 *  the one-shot processes that call this — each CLI poll is a fresh process
 *  with no in-memory state to carry it). A failed write just means the next
 *  poll recomputes, or re-observes the mismatch as if it were first, instead
 *  of reusing/deferring — never stale or corrupt data either way. */
async function writeStatusSnapshotRecord(record: StatusSnapshotRecord): Promise<void> {
  try {
    const dir = getCodeburnCacheDir()
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const finalPath = statusSnapshotPath()
    const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record), { encoding: 'utf-8' })
    } finally {
      await handle.close()
    }
    await rename(tempPath, finalPath)
  } catch { /* best-effort; next poll just recomputes */ }
}

/** Returns the previously-saved payload when the query still matches AND
 *  either the corpus fingerprint is an exact match (nothing changed) or this
 *  mismatch was first observed less than `statusSnapshotSettleMs()` of
 *  wall-clock time ago (likely still being written). Null otherwise, so the
 *  caller recomputes for real and should persist a fresh snapshot with the
 *  new fingerprint.
 *
 *  Deliberately does NOT use `newestMtimeMs` (the corpus-wide max mtime) to
 *  decide how long a mismatch has been "recent": that value is the max
 *  across every discovered source, so churn in a file the current query
 *  never reads (a different project, or a network-provider source that
 *  `computeCorpusFingerprint` deliberately re-stamps to "now" every call so
 *  it never drops out of the hash) can keep it perpetually fresh, deferring
 *  forever instead of "at most the window." Anchoring on the wall-clock time
 *  THIS record's fingerprint first stopped matching makes the settle window
 *  a true bound regardless of what else in the corpus is busy. */
export async function loadStatusSnapshot(corpusFingerprint: string, newestMtimeMs: number, queryKey: string): Promise<unknown | null> {
  const stored = await readStatusSnapshotRecord()
  if (!stored || stored.queryKey !== queryKey) return null
  if (stored.corpusFingerprint === corpusFingerprint) return stored.payload ?? null

  const now = Date.now()
  const firstSeenAt = stored.mismatchFirstSeenAt ?? now
  if (now - firstSeenAt >= statusSnapshotSettleMs()) return null
  if (stored.mismatchFirstSeenAt === undefined) {
    await writeStatusSnapshotRecord({ ...stored, newestMtimeMs, mismatchFirstSeenAt: firstSeenAt })
  }
  return stored.payload ?? null
}

/** Best-effort: a failed write just means the next poll recomputes instead
 *  of reusing. Only ever called by the caller when `loadStatusSnapshot`
 *  missed, so a settled recompute's result always supersedes whatever was
 *  there before. Always writes a fresh record with no `mismatchFirstSeenAt`,
 *  which is exactly what clears the settle-window clock once a real
 *  recompute lands. */
export async function saveStatusSnapshot(corpusFingerprint: string, newestMtimeMs: number, queryKey: string, payload: unknown): Promise<void> {
  await writeStatusSnapshotRecord({ version: STATUS_SNAPSHOT_VERSION, corpusFingerprint, newestMtimeMs, queryKey, payload })
}
