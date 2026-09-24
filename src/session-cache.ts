import { readFile, stat, open, rename, unlink, readdir, mkdir, rm, type FileHandle } from 'fs/promises'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'

import { getCodeburnCacheDir, RETIRED_PROVIDER_NAMES } from './cache-dir.js'
import { acquireCacheRefreshLock, releaseOwnedRefreshLocksForExit } from './cache-refresh-lock.js'
import { parseBillingMode, type BillingMode } from './models.js'
import type { ToolCall } from './types.js'
import { isWslUncPath } from './wsl.js'

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
  /// See ParsedProviderCall.fallbackCostUSD.
  fallbackCostUSD?: number
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
  /** Present only when workingDirectory came from a dedicated provider field. */
  workingDirectoryProvenance?: 'provider-field'
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
  // Copilot session-store billing metadata. Plan math reads nanoAiu (1e9 = 1
  // credit). requestMultiplier stays capture-only. Omitted when the store's
  // schema predates the columns.
  nanoAiu?: number
  requestMultiplier?: number
  // Copilot shutdown rollups only: stamp of the last successful in-session
  // compaction before this leg. See ParsedProviderCall.compactedAt.
  compactedAt?: string
  // Copilot session-store rows only: the store's `initiator` label when
  // present. See ParsedProviderCall.initiator.
  initiator?: string
  // Hermes observation-time deltas persist this so a warm read does not
  // depend on the `:obs:` key regex alone. Copilot still assigns the flag
  // at serve time and does not persist it.
  supplementaryAccounting?: boolean
  // Requests this one call stands for (see ParsedProviderCall.requestCount).
  requestCount?: number
  // Billing route id the provider recorded (see ParsedProviderCall).
  // Persisted so the row key survives the cache; a cached call without it is
  // a direct-door call or one parsed before the provider carried the column
  // (its parse version forces a re-parse).
  route?: string
  // Billing mode the provider recorded (see ParsedProviderCall.billing).
  // Persisted so a warm read answers the same --billing question a cold parse
  // would. Absent means the provider stated no fact; a value outside the two
  // modes fails validation rather than being coerced into one.
  billing?: BillingMode
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
  // OMP nested agent transcripts retain their file-stem identity and session
  // header timestamp for the menubar's per-agent activity rows.
  agentName?: string
  agentStartedAt?: string
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
  // Provider-recorded parent/child lineage (CB-1, slice 1). Set when the
  // parser captured durable evidence (see SessionLineage). Mirrors onto
  // SessionSummary.lineage at serve time so a warm read retains the field.
  // Absent when no provider-recorded evidence exists - the brief forbids
  // inferring lineage from directory layout or time adjacency.
  lineage?: import('./types.js').SessionLineage
}

export type ProviderSection = {
  envFingerprint: string
  files: Record<string, CachedFile>
  /** True when the provider's cache entries survive source-file eviction. */
  durable?: boolean
  /** True once a scan walked THIS provider end to end. A `--provider X` run
   *  only ever learns about X, so completeness is recorded per provider and the
   *  whole-cache `complete` below is reserved for an unscoped scan. Absent →
   *  fall back to the whole-cache flag (a cache written before this field, or
   *  by an unscoped run that already vouched for every provider). */
  complete?: boolean
  /** Epoch ms floor of what `complete` covers: the scan skipped sources whose
   *  mtime predates this (the `dateRange` filter in parseProviderSources), so
   *  the section answers "complete" only for a query starting at or after it.
   *  Absent means complete for any range. */
  completeFrom?: number
}

export type SessionCache = {
  version: number
  providers: Record<string, ProviderSection>
  /** True only once a full UNSCOPED scan has run to completion. The throttled
   *  partial saves during a cold hydration persist `false`; the single
   *  end-of-parse save flips it `true`. A cache that is present-but-incomplete
   *  (an interrupted cold start left a partial behind) must be treated as still
   *  cold — otherwise the emptiness heuristic reads the partial as warm, the
   *  cross-process hydration lock never engages, and totals heal only gradually
   *  while a concurrent parse can freeze a partial daily history. Absent on
   *  caches written before this field existed → read as incomplete (one
   *  self-healing re-hydration).
   *
   *  A provider-scoped run never sets it — it saw one provider — and instead
   *  stamps that provider's own `ProviderSection.complete`. Kept as the
   *  whole-cache answer so a reader that only knows the envelope (and every
   *  cache written before per-provider stamps existed) keeps working. */
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
// v10: on-disk layout only - a provider's files are stored in pieces by the UTC
// day of each file's newest call, with a per-provider index of every cached
// file (piece, fingerprint, call span) and a per-piece file of dedup keys. A
// narrow query reads the index, the keys, and only the members it reports on;
// an append rewrites one day. Turn shape unchanged, so v9 migrates losslessly.
export const CACHE_VERSION = 10

// The cache directory is version-suffixed for the same reason the file used to
// be: different binaries (an old launchd menubar, a newer desktop app) each own
// a distinct layout and can never clobber each other's incompatible schema.
const CACHE_DIR_NAME = `session-cache.v${CACHE_VERSION}`
// The v9 month shards and the v8 provider shards, each read once by a lossless
// re-layout.
const MONTH_SHARD_DIR_NAME = 'session-cache.v9'
const PRIOR_SHARD_DIR_NAME = 'session-cache.v8'
// Written LAST on every save: it names every provider's index, which names its
// pieces, so the rename that publishes it is the single point at which a save
// becomes visible.
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
//
// CODEBURN_COPILOT_SESSION_STORE_DB is covered by that ruling too, and needs
// no exception: repointing it cannot serve stale data. Copilot's
// rollup-vs-store reconciliation runs at SERVE time over the cached serve set
// (parseProviderSources), never against a discovery-time snapshot, so a
// repointed path is simply a new source parsed on sight while the old path's
// cached rows persist as durable orphans contributing exactly what they
// always did. There is no cross-file dependency for the fingerprint to catch,
// so declaring it would buy nothing and cost the durable-history loss above.
//
// CODEBURN_WSL (src/wsl.ts) is also deliberately absent, for claude and codex
// alike. It is a live read policy, not parsed content: active roots add paths;
// stopped roots retain historical WSL rows without touching their UNC share;
// and active-root deletions are reconciled explicitly by src/parser.ts.
// `off` disables discovery/UNC access while leaving that retained history
// readable. Hashing the policy here would instead discard the rows that make a
// shutdown/restart cycle lossless and force a full 9P re-parse after re-enable.
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
  grokbot: ['CODEBURN_GROKBOT_DIR', 'APPDATA'],
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

// Read in full by a ranged load, like the durable providers: their parse reads
// cached entries no report shows. hermes seeds its ledger cursors from every
// cached call, quickdesk has durable sources before its section is stamped
// durable, and antigravity, devin and gemini decide a re-parse from the cached
// entry itself (cachedFileNeedsProviderReparse in parser.ts).
const FULL_LOAD_PROVIDER_NAMES: ReadonlySet<string> = new Set(['hermes', 'quickdesk', 'antigravity', 'devin', 'gemini'])

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
  // session-lineage-capture-v1: SessionLineage (CB-1, slice 1) is now carried
  // on the cached file. The child evidence is the transcript's
  // provider-recorded `parentSessionId` (already captured); the root evidence
  // is the parent-side `agentSpawnLinks` (already captured). A one-time
  // re-parse is forced so cached sessions without the lineage field gain it.
  // The field is purely additive; every cost / token / call total is
  // byte-identical to a build that omits it (see parser-lineage-capture test).
  claude: 'advisor-usage-v1-skills-rich-capture-v1-cross-provider-pr-v1-session-lineage-capture-v1',
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
  // session_id/forked_from_id/model_provider, not just model. (#1055)
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
  // activity-price-v1: `codex-auto-review` now prices via the recommended
  // review model. session-cache.json would otherwise keep the pre-alias $0.
  // Compose all four — a take-ours merge would drop #1075, #1079, or #1092.
  codex: 'mcp-attribution-v5-est-cost-active-timing-mcp-wait-rich-capture-v1-cross-provider-pr-v1-session-meta-model-v1-session-meta-fields-v1-codex-pricing-v1-codex-tps-v1-codex-mcp-skills-v1-activity-price-v1',
  cursor: 'composer-anchored-crediting-v1-est-cost',
  // full-turn-accounting: every assistant message counts as a turn
  // (previously only the first after each user message survived), tool_use
  // inputs join the output text, and input tokens use the full user text
  // instead of the 500-char display truncation. Cached sessions hold a
  // fraction of their turns, so they must re-parse. v2 bills the user text
  // once per user message instead of once per assistant message.
  // store-db-v1 (#986): sessions with no exported transcript are read from
  // ~/.cursor/chats/*/*/store.db.
  'cursor-agent': 'workspaceless-transcript-v1-full-turn-accounting-v2-store-db-v1',
  // source-provenance-v1 (#944): CLI sessions were misread as VS Code
  // transcripts (both carry producer 'copilot-agent'), skipping the shutdown
  // input/cache rollup; this bump re-parses them so the missing tokens land.
  // #1051 did NOT bump this on its own. A fingerprint change drops every present
  // Copilot source (parser.ts getOrCreateProviderSection) and would erase
  // conversations already pruned from a still-present OTel DB. Old `:n`
  // shutdown keys migrate via cachedFileNeedsProviderReparse + a durable
  // strip of legacy shutdown calls on that JSONL file only.
  // session-store-v2: input/cache for sessions covered by session-store.db
  // moved from shutdown-rollup calls to per-request DB rows. This bump
  // re-parses pre-store caches so the DB rows land; the rollup calls stay
  // cached (the durable union merge never deletes) and the serve-time
  // reconciliation in parseProviderSources decides per (session, model) what
  // they still contribute. v2 (over the never-released v1): store dedup keys
  // grew a content discriminator so a same-path DB reset cannot alias rows.
  // v3: the `initiator='compaction'` row now carries its own output tokens (no
  // assistant.message owns them). The dedup key deliberately did NOT change -
  // it identifies the request, and moving it would leave the cached output-0
  // copy beside the new row - so only this bump re-parses a v2 cache into the
  // corrected shape.
  // chatsession-otel-skills-v1: structured Skill calls are now extracted from
  // VS Code chatSessions and OTel execute_tool spans. Cached calls lack those
  // fields, so force one re-parse before serving period breakdowns.
  // otel-trace-metadata-once-v1: trace-level tool/skill/bash metadata is now
  // attributed to one chat span per trace instead of every span, so cached
  // calls carry the old per-span duplication - force one re-parse.
  // transcript-unknown-usage-v1: a transcript call with no token count is
  // marked estimated; cached entries hold no flag and must re-parse once.
  // otel-workspace-project-v1 (#1529): OTel conversations without a repository
  // attribute take their VS Code workspace name instead of `copilot-chat`, and
  // multi-root workspaces are named after their .code-workspace file. Dedup
  // keys are unchanged, so the durable union replaces the cached calls in place.
  copilot: 'cli-shutdown-cost-v1-skills-source-provenance-v1-session-store-v3-chatsession-otel-skills-v1-otel-trace-metadata-once-v1-transcript-unknown-usage-v1-otel-workspace-project-v1',
  // authoritative-usage-v4: persist one Grok session call from top-level
  // authoritative totals, use modelUsage only for priced attribution, clamp
  // reasoning per record, and label mixed sessions estimated.
  grok: 'authoritative-usage-v4',
  // Estimated from message text: Grok Bot's local mirror records no tokens.
  grokbot: 'estimated-usage-v1',
  // v0-v3 generations, embedded attempt streams, retry accounting, and the
  // version-specific inherited-prefix rules all change cached DSH calls.
  dsh: 'session-formats-v0-v3-attempts-v5',
  // cost-provenance-v3: preserve Hermes included/estimated/actual status and
  // rebuild the provider section alongside the v3 lifetime ledger. The parse
  // bump is required with the ledger bump: seeding a new ledger from a section
  // produced under v2 can turn historical accounting deltas into today's use.
  // billing-route-v1: the session's `billing_provider` column now rides on
  // each call as `route`. Cached calls hold none, so they must re-parse.
  // billing-mode-v1: the resolved cost basis now rides on each call as
  // `billing` (`included` -> subscription, `actual` -> metered). Cached calls
  // hold none, so they must re-parse.
  hermes: 'reasoning-output-accounting-v1-est-cost-routed-ids-workspace-pr-v5-cost-provenance-v3-billing-route-v1-billing-mode-v1',
  // reported-cost-v1: OpenClaw's per-message `usage.cost.total` is now
  // preserved through the cache via `costFromBilling`. This is OpenClaw's
  // first parse version; adding it moves the provider's env fingerprint,
  // which is what forces the one re-parse that lands the reported dollars.
  openclaw: 'reported-cost-v1',
  'lingtai-tui': 'token-ledger-registry-activity-v3',
  'ibm-bob': 'worktree-project-grouping-v1',
  // project-path-v1: the parser now records the session's full working
  // directory as projectPath (CLI meta.cwd, v2 workspacePaths[0], workspace
  // sessions' workspaceDirectory), which sync attribution needs to resolve
  // the git repo. Cached entries from before the bump lack projectPath and
  // would serve attribution-blind sessions forever without a re-parse.
  // working-directory-v1: project-path-v1 wired the session's directory to
  // projectPath only, but sync attribution does not read that field. It calls
  // buildRepoGroups in "trusted-session-cwd" mode, which resolves the repo from
  // `session.workingDirectory` and drops any session whose own directory does
  // not resolve — so every kiro session stayed attribution-blind despite
  // carrying the path. All three parsers now emit workingDirectory from the
  // same provider-recorded value; parser.ts stamps
  // workingDirectoryProvenance: 'provider-field' on it, which is what the
  // consumer requires (a marker-less value is treated as synthesized and fails
  // closed). Entries cached under project-path-v1 hold projectPath but no
  // workingDirectory, so a re-parse is required for the fix to take effect.
  kiro: 'ide-parsing-v1-est-cost-project-path-v1-working-directory-v1',
  // nested-agent-v1: OMP writes crewmate transcripts one directory below each
  // parent session. reported-cost-v2 persists those measured costs through the
  // cache, including the explicit zero on xai-oauth turns.
  // cwd-project-path-v1 (#1260): retain absolute session header cwd on
  // projectPath/workingDirectory instead of basename-only identity.
  // project-group-by-abs-v1 (#1260): parseProviderSources groups by abs
  // projectPath/workingDirectory so same-basename distinct roots stay apart.
  // reported-cost-v1: Pi writes a per-message `usage.cost.total`, which is now
  // preserved through the cache via `costFromBilling` instead of being
  // re-priced from tokens on every read. (omp, the same parser, has carried
  // reported costs since reported-cost-v2 below.) Cached calls hold
  // costUSD: undefined, so they must re-parse once.
  pi: 'cwd-project-path-v1-project-group-by-abs-v1-reported-cost-v1',
  // project-group-by-abs-v1: shared Pi/OMP serve grouping uses abs identity.
  omp: 'nested-agent-v1-reported-cost-v2-cwd-project-path-v1-project-group-by-abs-v1',
  // archived-subtree-v1 (#1362): the subtree walk no longer filters
  // `time_archived IS NULL`. An archived ROOT self-heals — it was evicted as an
  // undiscovered non-durable source and comes back new — but a root whose CHILD
  // was archived stays a present, unchanged source: every opencode entry
  // fingerprints the same database file, so a warm cache keeps serving the
  // parse that dropped the child's calls until the database is written again.
  // billing-routes-v2: OpenCode's exact `providerID` values now ride on every
  // parsed call as `route`: `openrouter` and `amazon-bedrock`. Cached calls hold
  // neither, so they must re-parse. v2 also invalidates the OpenRouter-only
  // fingerprint used by pre-merge builds of #1486.
  // unknown-usage-v1: a message with output but no usage is marked estimated.
  // v2-legacy-union-v1: a session present in both OpenCode 2.x `session_v2` and
  // the frozen 1.x tables now reads its legacy turns too. Cached parses of an
  // upgraded database hold only what the 2.x migration carried over, and v2
  // turns now carry the bare model id 1.x used instead of `provider/model`.
  // vertex-fallback-cost-v1 (#1547): the recorded `cost` of a turn CodeBurn
  // cannot price rides on the cached call as `fallbackCostUSD`, the session-level
  // rollup uses the bare model id, and `google-vertex`/`google-vertex-anthropic`
  // ride as the `vertex` route. Cached calls hold none of these.
  opencode: 'session-model-v1-archived-subtree-v1-billing-routes-v2-v2-legacy-union-v1-unknown-usage-v1-vertex-fallback-cost-v1',
  quickdesk: 'emf-sqlite-v2-est-cost',
  // session-lineage-capture-v1: SessionLineage (CB-1, slice 1) is now carried
  // on the cached file for every kimicode wire. Child evidence is the
  // provider-recorded `state.json` `agents[<id>].parentAgentId === 'main'`
  // (any non-`main` agent); root evidence is a sibling non-`main` entry
  // alongside the `main` agent. A one-time re-parse is forced so cached
  // sessions without the lineage field gain it. The field is purely
  // additive; every cost / token / call total is byte-identical to a build
  // that omits it.
  kimicode: 'wire-usage-v1-est-cost-session-lineage-capture-v1',
  // archived-subtree-v1: KiloCode shares the SQLite parser and the same schema.
  // billing-routes-v2: its warm cache must move with both shared route fields.
  'kilo-code': 'worktree-project-grouping-v1-session-model-v1-archived-subtree-v1-billing-routes-v2-v2-legacy-union-v1-unknown-usage-v1-vertex-fallback-cost-v1',
  // billing-cost-v1: Warp's own billing record (total_provider_cost_in_cents,
  // total_charged_usage, credits_spent) now rides on each call as
  // `costFromBilling` and is preserved by providerCallToCachedCall. Entries
  // cached before this hold costUSD: undefined and are re-priced from the
  // token floor on every read, so they must re-parse once for the real dollars
  // to land.
  warp: 'worktree-project-grouping-v1-est-cost-billing-cost-v1',
  antigravity: 'worktree-project-grouping-v6',
}

function getLegacyCachePath(): string {
  return join(getCodeburnCacheDir(), LEGACY_CACHE_FILE)
}

/** Absolute path of the active (version-suffixed) session cache directory. */
export function sessionCacheDir(): string {
  return join(getCodeburnCacheDir(), CACHE_DIR_NAME)
}

// A provider's envelope entry names its index; the index names the provider's
// pieces (UTC day -> file) and holds one row per cached file, in the order a
// full load holds them.
type EnvelopeProvider = {
  envFingerprint: string
  durable?: boolean
  complete?: boolean
  completeFrom?: number
  index: string
}
type CacheEnvelope = {
  version: number
  complete?: boolean
  nonce: string
  providers: Record<string, EnvelopeProvider>
}

/** Where a cached file lives and what a load decides from without reading it.
 *  `day` names its piece: the UTC day of its newest call. `month`/`until` are
 *  its v9 span (cacheFileSpan): the month scope a ranged load reports on, and
 *  the order rows are kept in, are both still the v9 ones, so everything that
 *  depends on load order (orphans, the first-paint snapshot, dedup first-wins)
 *  sees what it saw on v9. */
type IndexRow = {
  day: string
  month: string
  until: string
  fingerprint: FileFingerprint
  /** Oldest and newest call (ms): Infinity / -Infinity when the file has none. */
  lo: number
  hi: number
  flags: number
  /** Byte span of the member line in the piece. */
  offset: number
  length: number
}

// Needed by every range: a failure marker, a turn-less file, a spawn anchor.
const ROW_ALWAYS = 1
const ROW_PR = 2

type ProviderBase = {
  index: string | undefined
  pieces: Record<string, string>
  rows: Map<string, IndexRow>
  /** Hash of the published index text, so an unchanged save keeps its name. */
  hash: string
}

function emptyBase(): ProviderBase {
  return { index: undefined, pieces: {}, rows: new Map(), hash: '' }
}

// Files with no turns (failure markers, empty sessions) have no month to bucket
// by; they form one month group that every load reads.
const UNDATED_BUCKET = '0000-00'
// The piece of a file with no call.
const UNDATED_DAY = '0000-00-00'
// Sentinel inside a provider's dirty paths: every file of the provider is dirty.
const ALL_PATHS = '*'

function monthKey(timestamp: string | undefined): string | null {
  if (!timestamp) return null
  const ms = Date.parse(timestamp)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
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

function keysOf(file: CachedFile): string[][] {
  return file.turns.map(turn => turn.calls.map(call => call.deduplicationKey))
}

function rowFor(path: string, file: CachedFile): IndexRow {
  let lo = Infinity
  let hi = -Infinity
  for (const turn of file.turns) {
    for (const call of turn.calls) {
      const ms = Date.parse(call.timestamp)
      if (ms < lo) lo = ms
      if (ms > hi) hi = ms
    }
  }
  const span = cacheFileSpan(file)
  const anchor = !!file.prLinks?.length && file.isSidechain !== true && file.turns.some(t => t.spawnToolUseIds?.length)
  return {
    day: hi === -Infinity ? UNDATED_DAY : dayKey(hi),
    month: span.bucket,
    until: span.until,
    fingerprint: file.fingerprint,
    lo,
    hi,
    flags: (file.failed || file.turns.length === 0 || anchor ? ROW_ALWAYS : 0) | (file.prLinks?.length ? ROW_PR : 0),
    offset: 0,
    length: 0,
  }
}

// Needed by a query over [startMs, endMs]: a call in the range, or something a
// report reads whatever the range: a spawn anchor (an in-range child folds into
// it), a failure marker or turn-less file, and a WSL path (its orphan handling
// depends on the root being online).
function fileNeeded(path: string, row: IndexRow, startMs: number, endMs: number): boolean {
  if ((row.flags & ROW_ALWAYS) !== 0 || isWslUncPath(path)) return true
  return row.hi === -Infinity || (row.hi >= startMs && row.lo <= endMs)
}

/** A cached file a ranged load held back because the range cannot report on
 *  it. It keeps what reconcile, the dedup pre-seeds and replays, orphan
 *  handling and the save need; its member stays in its piece and is loaded on
 *  demand. Never persisted. */
export type CacheStub = {
  fingerprint: FileFingerprint
  hasPr: boolean
  /** Dedup keys per turn, in turn order. */
  keys: string[][]
  /** Oldest and newest call timestamp (ms). */
  lo: number
  hi: number
  /** Load position, shared with full entries (see `CacheState.seq`). */
  seq: number
}

// Save bookkeeping, held beside the cache rather than on it so it never lands in
// a piece's JSON or in a caller's deep-equality.
type CacheState = {
  dirty: boolean
  /** provider -> paths changed since the last save (or `ALL_PATHS`). */
  dirtyPaths: Map<string, Set<string>>
  /** provider -> the published index this cache was read from or last saved. */
  base: Map<string, ProviderBase>
  /** provider -> the v9 months the load reported on; null when it read them all. */
  visible: Map<string, Set<string> | null>
  /** provider -> the envFingerprint the published envelope recorded. */
  fingerprints: Map<string, string>
  /** The nonce of the envelope `base` came from. */
  nonce: string | undefined
  /** The load scope this cache was read under, for the cross-request memo. */
  scope: string
  /** The piece directory this cache was read from. */
  dir: string
  /** provider -> stubbed paths, valid only while `section` is still the provider's section. */
  stubs: Map<string, { section: ProviderSection; byPath: Map<string, CacheStub> }>
  /** provider -> rows outside the months the load reported on. As on v9 they
   *  are not part of the section; only a reconcile consults them. */
  hidden: Map<string, { section: ProviderSection; byPath: Map<string, IndexRow> }>
  /** Load position of every entry read from disk. An entry replaced since has
   *  none, and sorts after all loaded ones, which is where a full load's
   *  `files` object would hold it. */
  seq: WeakMap<CachedFile, number>
  /** Every cached file with a call in this range is held in full; null when
   *  nothing was stubbed. */
  covered: { startMs: number; endMs: number } | null
}
const cacheStates = new WeakMap<SessionCache, CacheState>()

function stateOf(cache: SessionCache): CacheState {
  let state = cacheStates.get(cache)
  if (!state) {
    state = {
      dirty: false,
      dirtyPaths: new Map(),
      base: new Map(),
      visible: new Map(),
      fingerprints: new Map(),
      nonce: undefined,
      scope: 'all',
      dir: sessionCacheDir(),
      stubs: new Map(),
      hidden: new Map(),
      seq: new WeakMap(),
      covered: null,
    }
    cacheStates.set(cache, state)
  }
  return state
}

function markPathDirty(state: CacheState, provider: string, path: string): void {
  state.dirty = true
  let paths = state.dirtyPaths.get(provider)
  if (!paths) { paths = new Set(); state.dirtyPaths.set(provider, paths) }
  paths.add(path)
}

/** Record that `provider`'s section changed, so the next save rewrites the
 *  pieces involved. Pass `filePath` whenever the change is scoped to one cached
 *  file (a write, a delete or a re-parse); omitting it dirties every file. */
export function markCacheDirty(cache: SessionCache, provider: string, filePath?: string): void {
  markPathDirty(stateOf(cache), provider, filePath ?? ALL_PATHS)
}

/** True when any provider section changed since the last save. */
export function isCacheDirty(cache: SessionCache): boolean {
  return stateOf(cache).dirty
}

function stubsOf(state: CacheState, cache: SessionCache, provider: string): Map<string, CacheStub> | undefined {
  const held = state.stubs.get(provider)
  return held && held.section === cache.providers[provider] ? held.byPath : undefined
}

function hiddenOf(state: CacheState, cache: SessionCache, provider: string): Map<string, IndexRow> | undefined {
  const held = state.hidden.get(provider)
  return held && held.section === cache.providers[provider] ? held.byPath : undefined
}

/** The paths of `provider` a ranged load holds as stubs (see {@link CacheStub}). */
export function cacheStubs(cache: SessionCache, provider: string): ReadonlyMap<string, CacheStub> | undefined {
  return stubsOf(stateOf(cache), cache, provider)
}

/** The fingerprint a cached file outside the load's months was saved at. v9
 *  could not see such a file at all, so a narrow query re-parsed every older
 *  transcript it discovered; an unchanged one needs nothing from this range. */
export function cacheHiddenFingerprint(cache: SessionCache, provider: string, path: string): FileFingerprint | undefined {
  return hiddenOf(stateOf(cache), cache, provider)?.get(path)?.fingerprint
}

/** The dedup keys of hidden files, per turn. A transcript parsed now can replay
 *  their message ids (a fork or resume of an old session), and the cached copy
 *  must win, as it does for every loaded month. */
export async function loadCacheHiddenKeys(cache: SessionCache, provider: string, paths: Iterable<string>): Promise<string[][][]> {
  const state = stateOf(cache)
  const hidden = hiddenOf(state, cache, provider)
  const base = state.base.get(provider)
  const out: string[][][] = []
  if (!hidden || !base) return out
  const byPiece = new Map<string, Array<[string, IndexRow]>>()
  for (const path of paths) {
    const row = hidden.get(path)
    if (row) pushTo(byPiece, row.day, [path, row])
  }
  for (const [day, rows] of byPiece) {
    const name = base.pieces[day]
    if (name) for (const list of (await readKeyLists(state.dir, name, rows)).values()) out.push(list)
  }
  return out
}

// A key file is written without a sync, so one lost to a crash is rebuilt
// from its piece's members.
async function readKeyLists(dir: string, name: string, rows: Array<[string, IndexRow]>): Promise<Map<string, string[][]>> {
  const keys = await readKeys(dir, name)
  const missing = rows.filter(([path]) => !isKeyList(keys?.[path]))
  const files = missing.length > 0 ? await readMembersAt(join(dir, name), missing) : null
  const out = new Map<string, string[][]>()
  for (const [path] of rows) {
    const file = files?.get(path)
    const list = file ? keysOf(file) : keys?.[path]
    if (isKeyList(list)) out.set(path, list)
  }
  return out
}

/** True when `provider` has any cached entry, full or stubbed. */
export function hasCachedEntries(cache: SessionCache, provider: string): boolean {
  const section = cache.providers[provider]
  if (!section) return false
  for (const _ in section.files) return true
  return (stubsOf(stateOf(cache), cache, provider)?.size ?? 0) > 0
}

/** Drop a stub whose source is gone, exactly as deleting its entry would. */
export function evictCacheStub(cache: SessionCache, provider: string, path: string): void {
  stubsOf(stateOf(cache), cache, provider)?.delete(path)
  markCacheDirty(cache, provider, path)
}

function entriesInLoadOrder(state: CacheState, section: ProviderSection, stubs: Map<string, CacheStub> | undefined): Array<[string, CachedFile | CacheStub]> {
  if (!stubs) return Object.entries(section.files)
  const loaded: Array<[string, CachedFile | CacheStub, number]> = []
  const later: Array<[string, CachedFile]> = []
  for (const [path, file] of Object.entries(section.files)) {
    const seq = state.seq.get(file)
    if (seq === undefined) later.push([path, file])
    else loaded.push([path, file, seq])
  }
  for (const [path, stub] of stubs) loaded.push([path, stub, stub.seq])
  loaded.sort((a, b) => a[2] - b[2])
  return [...loaded.map(([path, entry]): [string, CachedFile | CacheStub] => [path, entry]), ...later]
}

/** Every cached entry of `provider`, full or stubbed, in the order a full load
 *  would hold them in `files`: loaded entries in index order, then entries
 *  written since in the order they were written. */
export function cacheEntriesInLoadOrder(cache: SessionCache, provider: string): Array<[string, CachedFile | CacheStub]> {
  const section = cache.providers[provider]
  if (!section) return []
  const state = stateOf(cache)
  return entriesInLoadOrder(state, section, stubsOf(state, cache, provider))
}

export function isCacheStub(entry: CachedFile | CacheStub): entry is CacheStub {
  return 'keys' in entry
}

/** Load stubbed members in full, in place, at their load position. A member
 *  that can no longer be read loses its stub, so the file re-parses like any
 *  uncached one and the save drops its line. */
export async function loadCacheStubs(cache: SessionCache, provider: string, paths: Iterable<string>): Promise<void> {
  const state = stateOf(cache)
  const stubs = stubsOf(state, cache, provider)
  const section = cache.providers[provider]
  const base = state.base.get(provider)
  if (!stubs || !section || !base) return
  const byPiece = new Map<string, Array<[string, IndexRow]>>()
  for (const path of paths) {
    const row = stubs.has(path) ? base.rows.get(path) : undefined
    if (row) pushTo(byPiece, row.day, [path, row])
  }
  for (const [day, rows] of byPiece) {
    const name = base.pieces[day]
    const members = name ? await readMembersAt(join(state.dir, name), rows) : new Map<string, CachedFile>()
    for (const [path] of rows) {
      const stub = stubs.get(path)!
      stubs.delete(path)
      const file = members.get(path)
      if (file) {
        section.files[path] = file
        state.seq.set(file, stub.seq)
      } else {
        markPathDirty(state, provider, path)
      }
    }
  }
}

// Widen what a memoized ranged load holds in full to [startMs, endMs] (and
// whatever it already covered), loading the stubs that range can report on.
async function coverRange(cache: SessionCache, startMs: number, endMs: number): Promise<void> {
  const state = stateOf(cache)
  const covered = state.covered
  if (!covered || (startMs >= covered.startMs && endMs <= covered.endMs)) return
  const from = Math.min(startMs, covered.startMs)
  const to = Math.max(endMs, covered.endMs)
  for (const provider of Object.keys(cache.providers)) {
    const stubs = stubsOf(state, cache, provider)
    if (!stubs) continue
    const wanted: string[] = []
    for (const [path, stub] of stubs) if (stub.hi >= from && stub.lo <= to) wanted.push(path)
    await loadCacheStubs(cache, provider, wanted)
  }
  state.covered = { startMs: from, endMs: to }
}

/** True when a dirty bucket belongs to a provider whose cache entry is the ONLY
 *  surviving record of that spend (see {@link DURABLE_PROVIDER_NAMES}): the
 *  source can be pruned before the next publish, so such a window must never be
 *  held back by the resident process's coalescing. */
export function hasDirtyDurableProvider(cache: SessionCache): boolean {
  for (const provider of stateOf(cache).dirtyPaths.keys()) {
    if (DURABLE_PROVIDER_NAMES.has(provider) || cache.providers[provider]?.durable) return true
  }
  return false
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
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
 *  cold start, or a pre-marker cache) is NOT — it is still cold.
 *
 *  The answer is composed from the sections the REQUEST needs, on both axes a
 *  scan can be scoped on:
 *  - provider: a `--provider X` request asks only about X's section; an
 *    unscoped one needs the whole-cache flag (only an unscoped scan can vouch
 *    for the providers that have no section at all) plus every section it holds.
 *  - date: a section stamped with a `completeFrom` floor skipped older sources,
 *    so it answers a query starting at or after that floor and no other.
 *
 *  `sinceMs` is the requested range start; omitting it asks about ALL of
 *  history, which only a section with no floor can satisfy. A section with no
 *  `complete` of its own inherits the whole-cache flag, which is what keeps a
 *  cache written before per-provider stamps (and one an unscoped scan wrote)
 *  reading exactly as it did. */
export function isCacheComplete(cache: SessionCache, providerFilter?: string, sinceMs?: number): boolean {
  const sectionComplete = (provider: string): boolean => {
    const section = cache.providers[provider]
    if ((section?.complete ?? cache.complete) !== true) return false
    const from = section?.completeFrom
    return from === undefined || (sinceMs !== undefined && sinceMs >= from)
  }
  if (providerFilter && providerFilter !== 'all') return sectionComplete(providerFilter)
  return cache.complete === true && Object.keys(cache.providers).every(sectionComplete)
}

/** Record that this scan walked `provider` to the end, optionally only back to
 *  `completeFrom` (the range start that filtered older sources out). Coverage
 *  only ever grows — a section already complete for all of history stays that
 *  way — so the stored floor is the lowest of the two. Returns whether anything
 *  changed, which is what makes the caller save a cache that is otherwise
 *  clean. The section is created when absent: a scoped scan of a provider with
 *  no sessions has nothing to cache but still has completeness to record, and
 *  without it every such run would re-enter cold hydration forever. */
export function markProviderComplete(cache: SessionCache, provider: string, completeFrom?: number): boolean {
  const section = cache.providers[provider]
    ?? (cache.providers[provider] = { envFingerprint: computeEnvFingerprint(provider), files: {} })
  const prior = section.complete === true ? section.completeFrom ?? 0 : undefined
  const widened = prior === undefined ? completeFrom : Math.min(prior, completeFrom ?? 0)
  const floor = widened !== undefined && widened > 0 ? widened : undefined
  const changed = section.complete !== true || section.completeFrom !== floor
  section.complete = true
  if (floor === undefined) delete section.completeFrom
  else section.completeFrom = floor
  return changed
}

/** Pre-parse probe of the same question `isCacheComplete` answers after a load:
 *  is the next parse going to be a cold hydration? Reads only the (tiny)
 *  envelope, so a caller can branch on coldness before paying for the shards.
 *  A cache still in a legacy layout has no envelope and reads as cold — the
 *  adoption in `loadCache` may still make it warm, which costs the caller
 *  nothing: a warm cache has an entry for every discovered file, so a
 *  cold-start optimisation keyed on missing entries simply finds no work.
 *  Deliberately the WHOLE-cache question, matching `isCacheComplete` with no
 *  provider filter: its callers (the serve first-paint floor, the background
 *  fill) answer for every provider at once, so a cache only one scoped run has
 *  vouched for is still cold to them. A `completeFrom` floor does not make it
 *  cold — the floored months are cached, and a wider request re-enters cold
 *  hydration through `isCacheComplete` on its own. */
export async function isColdCacheOnDisk(): Promise<boolean> {
  return (await readEnvelope(sessionCacheDir()))?.complete !== true
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

// Validates the optional SessionLineage payload. Only `provider-recorded`
// is accepted; a stray role/evidence value (e.g. an inferred-link stub the
// brief forbids) must fail the shard validation rather than silently leak.
function isOptionalLineage(v: unknown): boolean {
  if (v === undefined) return true
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (isOptionalString(o['parentSessionId']) === false) return false
  if (o['role'] !== 'root' && o['role'] !== 'child') return false
  if (o['evidence'] !== 'provider-recorded') return false
  return true
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
    && isOptionalNum(o['fallbackCostUSD'])
    && isOptionalBool(o['isEstimated'])
    && isOptionalNum(o['activeDurationMs'])
    && isOptionalNum(o['activeGeneratedTokens'])
    && isOptionalNum(o['toolWaitMs'])
    && isOptionalNum(o['nanoAiu'])
    && isOptionalNum(o['requestMultiplier'])
    && isOptionalString(o['compactedAt'])
    && isOptionalString(o['initiator'])
    && isStringArray(o['tools'])
    && isStringArray(o['bashCommands'])
    && isStringArray(o['skills'])
    && (o['subagentTypes'] === undefined || isStringArray(o['subagentTypes']))
    && isOptionalString(o['project'])
    && isOptionalString(o['projectPath'])
    && (o['workingDirectoryProvenance'] === undefined || o['workingDirectoryProvenance'] === 'provider-field')
    && isOptionalString(o['workingDirectory'])
    && (o['toolSequence'] === undefined || (Array.isArray(o['toolSequence']) && (o['toolSequence'] as unknown[]).every(s => isToolCallArray(s))))
    && isOptionalNum(o['locAdded'])
    && isOptionalNum(o['locRemoved'])
    && isOptionalBool(o['interrupted'])
    && isOptionalBool(o['userModified'])
    && isOptionalNum(o['toolErrors'])
    && isOptionalNum(o['editFailed'])
    && isOptionalBool(o['supplementaryAccounting'])
    && isOptionalNum(o['requestCount'])
    && isOptionalString(o['route'])
    && (o['billing'] === undefined || parseBillingMode(o['billing'] as string) !== undefined)
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
    && isOptionalString(o['agentName'])
    && isOptionalString(o['agentStartedAt'])
    && isOptionalBool(o['failed'])
    && isOptionalString(o['parentSessionId'])
    && isOptionalStringRecord(o['agentSpawnLinks'])
    && (o['ambiguousSpawnAgentIds'] === undefined || isStringArray(o['ambiguousSpawnAgentIds']))
    && isOptionalLineage(o['lineage'])
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
  clearShardMemo()
}

/// Is this in-memory cache still the one the published envelope describes? A
/// holder that deferred its publish (see the coalescing window in parser.ts)
/// asks before writing: if another process has published since, this object is
/// a stale pre-image and saving it could drop that process's entries. Dropping
/// the deferred write instead costs a re-parse, never a wrong number.
export async function isCacheCurrent(cache: SessionCache): Promise<boolean> {
  if (!cacheMemo || cacheMemo.cache !== cache) return false
  const live = await readEnvelope(cacheMemo.dir)
  return live?.nonce === cacheMemo.nonce
}
/** Months (UTC `YYYY-MM`, inclusive) a query can possibly report on. The load
 *  widens this by one month BELOW `fromMonth` and none above (see
 *  shardInScope): every cross-range carry in the report reads BACKWARDS from the
 *  first in-range turn, never forwards, so there is nothing above the range to
 *  reach for. `startMs`/`endMs` are the range itself: a cached file the range
 *  cannot report on is then held as a {@link CacheStub}, not in full. */
export type CacheLoadScope = { fromMonth: string; toMonth: string; startMs?: number; endMs?: number }

export function monthScopeForRange(start: Date, end: Date): CacheLoadScope {
  return { fromMonth: monthKey(start.toISOString())!, toMonth: monthKey(end.toISOString())!, startMs: start.getTime(), endMs: end.getTime() }
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


function isEnvelope(raw: unknown): raw is CacheEnvelope {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  if (o['version'] !== CACHE_VERSION || typeof o['nonce'] !== 'string') return false
  const providers = o['providers']
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false
  return Object.values(providers as Record<string, unknown>).every(p => {
    if (!p || typeof p !== 'object') return false
    const e = p as Record<string, unknown>
    return typeof e['envFingerprint'] === 'string' && typeof e['index'] === 'string'
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

type RowTuple = [string, string, string, string, number, number, number, number, number | null, number | null, number, number, number]

function rowTuple(path: string, row: IndexRow): RowTuple {
  const fp = row.fingerprint
  return [path, row.day, row.month, row.until, fp.dev, fp.ino, fp.mtimeMs, fp.sizeBytes,
    row.lo === Infinity ? null : row.lo, row.hi === -Infinity ? null : row.hi, row.flags, row.offset, row.length]
}

function parseRow(t: unknown): [string, IndexRow] | null {
  if (!Array.isArray(t) || t.length !== 13) return null
  const [path, day, month, until, dev, ino, mtimeMs, sizeBytes, lo, hi, flags, offset, length] = t as unknown[]
  if (typeof path !== 'string' || typeof day !== 'string' || typeof month !== 'string' || typeof until !== 'string') return null
  if (![dev, ino, mtimeMs, sizeBytes, flags, offset, length].every(isNum)) return null
  if ((lo !== null && !isNum(lo)) || (hi !== null && !isNum(hi))) return null
  return [path, {
    day, month, until,
    fingerprint: { dev: dev as number, ino: ino as number, mtimeMs: mtimeMs as number, sizeBytes: sizeBytes as number },
    lo: lo === null ? Infinity : lo as number,
    hi: hi === null ? -Infinity : hi as number,
    flags: flags as number, offset: offset as number, length: length as number,
  }]
}

function indexText(pieces: Record<string, string>, rows: Iterable<[string, IndexRow]>): string {
  const tuples: RowTuple[] = []
  for (const [path, row] of rows) tuples.push(rowTuple(path, row))
  return JSON.stringify({ version: CACHE_VERSION, pieces, rows: tuples })
}

function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// Null when missing or malformed: the provider's files then re-parse, as a lost
// v9 shard's did.
async function readIndex(dir: string, name: string | undefined): Promise<ProviderBase | null> {
  if (!name) return null
  try {
    const text = await readFile(join(dir, name), 'utf-8')
    const parsed = JSON.parse(text) as { version?: unknown; pieces?: unknown; rows?: unknown }
    if (parsed.version !== CACHE_VERSION || !parsed.pieces || typeof parsed.pieces !== 'object' || !Array.isArray(parsed.rows)) return null
    const pieces = parsed.pieces as Record<string, unknown>
    if (!Object.values(pieces).every(v => typeof v === 'string')) return null
    const rows = new Map<string, IndexRow>()
    for (const t of parsed.rows) {
      const row = parseRow(t)
      if (!row) return null
      rows.set(row[0], row[1])
    }
    return { index: name, pieces: pieces as Record<string, string>, rows, hash: textHash(text) }
  } catch {
    return null
  }
}

function isKeyList(v: unknown): v is string[][] {
  return Array.isArray(v) && v.every(isStringArray)
}

async function readKeys(dir: string, piece: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, keysFileName(piece)), 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

// A piece (and its keys file) is written one member per line: `{`, then
// `"path":{...}` lines comma-terminated except the last, then `}`. It is still
// one JSON object, it never has to exist as one string, and a member can be read
// back by its byte span alone.
type ShardLine = { key: string; value: string; offset: number; length: number }

const SHARD_READ_CHUNK = 1 << 20

function splitMemberLine(line: string): [string, string] | null {
  if (line.charCodeAt(0) !== 34) return null
  let i = 1
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c === 92) i++
    else if (c === 34) break
  }
  if (line.charCodeAt(i + 1) !== 58) return null
  const end = line.charCodeAt(line.length - 1) === 44 ? line.length - 1 : line.length
  return [JSON.parse(line.slice(0, i + 1)) as string, line.slice(i + 2, end)]
}

function shardLine(text: string, offset: number, length: number): ShardLine {
  const split = splitMemberLine(text)
  if (!split) throw new Error('malformed shard line')
  return { key: split[0], value: split[1], offset, length }
}

// A piece's members one at a time, without holding the file. Throws on anything
// malformed, as JSON.parse would.
async function* shardLines(path: string): AsyncGenerator<ShardLine> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(2)
    await handle.read(head, 0, 2, 0)
    if (head[0] !== 0x7b || head[1] !== 0x0a) {
      if (JSON.stringify(JSON.parse(await readFile(path, 'utf-8'))) === '{}') return
      throw new Error('not a line-format shard')
    }
    // One reused buffer, and a line that spans reads is carried as decoded text:
    // per-line Buffers are off-heap memory only a GC returns, which shows up as
    // RSS when members run to megabytes. A newline is always a character
    // boundary, so the decoder never holds bytes across one.
    const chunk = Buffer.allocUnsafe(SHARD_READ_CHUNK)
    const decoder = new StringDecoder('utf-8')
    let pos = 2
    let lineStart = 2
    let pending = ''
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, SHARD_READ_CHUNK, pos)
      if (bytesRead === 0) break
      const view = chunk.subarray(0, bytesRead)
      let from = 0
      for (let nl = view.indexOf(10); nl !== -1; nl = view.indexOf(10, from)) {
        const text = pending + decoder.write(view.subarray(from, nl))
        pending = ''
        if (text === '}') return
        yield shardLine(text, lineStart, pos + nl - lineStart)
        from = nl + 1
        lineStart = pos + from
      }
      if (from < bytesRead) pending += decoder.write(view.subarray(from))
      pos += bytesRead
    }
    if (pending + decoder.end() !== '}') throw new Error('truncated shard')
  } finally {
    await handle.close()
  }
}

// The members of any JSON object file as [key, value text], a chunk at a time:
// the one-member-per-line form and a single-line object main wrote alike, so a
// v9 shard is never one string (or one parse) during the re-layout.
async function* objectMembers(path: string): AsyncGenerator<[string, string]> {
  const handle = await open(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(SHARD_READ_CHUNK)
    const decoder = new StringDecoder('utf-8')
    let depth = 0
    let inString = false
    let escaped = false
    let member = ''
    let pos = 0
    const split = (text: string): [string, string] => {
      const pair = splitMemberLine(text.trim())
      if (!pair) throw new Error('malformed shard member')
      return pair
    }
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, SHARD_READ_CHUNK, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const text = decoder.write(chunk.subarray(0, bytesRead))
      let start = 0
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        if (inString) {
          if (escaped) escaped = false
          else if (c === 92) escaped = true
          else if (c === 34) inString = false
        } else if (c === 34) {
          inString = true
        } else if (c === 123 || c === 91) {
          if (depth++ === 0) start = i + 1
        } else if (c === 125 || c === 93) {
          if (--depth === 0) {
            const last = member + text.slice(start, i)
            if (last.trim()) yield split(last)
            return
          }
        } else if (c === 44 && depth === 1) {
          const done = member + text.slice(start, i)
          member = ''
          start = i + 1
          yield split(done)
        }
      }
      if (depth > 0) member += text.slice(start)
    }
    throw new Error('truncated shard')
  } finally {
    await handle.close()
  }
}

function shardLineText(line: ShardLine): string {
  return `${JSON.stringify(line.key)}:${line.value}`
}

function memberText(path: string, value: unknown): string {
  return `${JSON.stringify(path)}:${JSON.stringify(value)}`
}

// The writer's side of the format above. `positions`, when given, receives each
// member's byte span.
async function* shardPayload(members: AsyncIterable<string> | Iterable<string>, positions?: Array<[number, number]>): AsyncGenerator<string> {
  let pos = 0
  let first = true
  for await (const member of members) {
    const head = first ? '{\n' : ',\n'
    first = false
    if (positions) {
      const length = Buffer.byteLength(member)
      positions.push([pos + 2, length])
      pos += 2 + length
    }
    yield head + member
  }
  yield first ? '{}' : '\n}'
}

// A piece that is missing or malformed costs exactly the files it held: those
// re-parse while every other piece keeps serving.
async function loadShard(path: string): Promise<Record<string, CachedFile> | null> {
  try {
    const files: Record<string, unknown> = {}
    for await (const line of shardLines(path)) files[line.key] = JSON.parse(line.value)
    return validateFiles(files) ? files : null
  } catch {
    return null
  }
}

// The members of `rows` from one piece. Neighbouring members are read together,
// up to SHARD_READ_CHUNK a read, into one reused buffer: Buffers are off-heap
// memory only a GC returns, which shows up as RSS when members run to megabytes.
async function readMembersAt(path: string, rows: Array<[string, IndexRow]>, scratch: { buf: Buffer } = { buf: Buffer.allocUnsafe(0) }): Promise<Map<string, CachedFile>> {
  const out = new Map<string, CachedFile>()
  try {
    const handle = await open(path, 'r')
    try {
      const sorted = [...rows].sort((a, b) => a[1].offset - b[1].offset)
      for (let i = 0; i < sorted.length;) {
        const from = sorted[i]![1].offset
        let j = i + 1
        while (j < sorted.length && sorted[j]![1].offset + sorted[j]![1].length - from <= SHARD_READ_CHUNK) j++
        const to = sorted[j - 1]![1].offset + sorted[j - 1]![1].length
        if (scratch.buf.length < to - from) scratch.buf = Buffer.allocUnsafe(to - from)
        const buf = scratch.buf
        const { bytesRead } = await handle.read(buf, 0, to - from, from)
        for (const [key, row] of sorted.slice(i, j)) {
          const start = row.offset - from
          if (start + row.length > bytesRead) continue
          const split = splitMemberLine(buf.toString('utf-8', start, start + row.length))
          if (!split || split[0] !== key) continue
          try {
            const file: unknown = JSON.parse(split[1])
            if (validateCachedFile(file)) out.set(key, file)
          } catch { /* a malformed member re-parses */ }
        }
        i = j
      }
    } finally {
      await handle.close()
    }
  } catch { /* unreadable: the caller treats every wanted member as gone */ }
  return out
}

// Shards a resident process (codeburn serve) keeps parsed between requests,
// keyed by shard FILE NAME. A name carries a fresh nonce on every write
// (shardFileName), so a name that is still published names the same bytes and
// the memo needs no revalidation: a rewritten month arrives under a new name
// and the retired one ages out below. This is what makes a period switch stop
// re-parsing the months it already read - the whole-cache memo above is keyed
// by scope and misses the moment the range widens.
// Counted in shard text. A shard the current query scope also holds costs this
// memo nothing extra - the same objects are already in the whole-cache memo
// above - so this budget only bounds the months NOTHING else is holding, which
// is why it is the smaller of the two. Both budgets together have to stay well
// under SERVE_MAX_RSS_BYTES: reaching that guard drops every memo, and the next
// request pays a cold parse and a cold scan.
const SHARD_MEMO_MAX_BYTES = 64 * 1024 * 1024
const SHARD_MEMO_MAX_AGE_MS = 10 * 60 * 1000
type ShardMemoEntry = { files: Record<string, CachedFile>; bytes: number; usedAt: number }
const shardMemo = new Map<string, ShardMemoEntry>()
let shardMemoBytes = 0

export function clearShardMemo(): void {
  shardMemo.clear()
  shardMemoBytes = 0
}

export function shardMemoStats(): { entries: number; bytes: number } {
  return { entries: shardMemo.size, bytes: shardMemoBytes }
}

/// Drop entries unused past the age bound, then least-recently-used entries
/// until the byte budget holds. `now` is injected so the rule is testable.
export function evictShardMemo(now: number, maxBytes: number = SHARD_MEMO_MAX_BYTES): void {
  // Least-recently-used order is the map's own insertion order, because a hit
  // reinserts its entry at the back; walking from the front therefore evicts the
  // oldest first and stops as soon as the budget holds.
  for (const [name, entry] of shardMemo) {
    if (shardMemoBytes <= maxBytes && now - entry.usedAt <= SHARD_MEMO_MAX_AGE_MS) break
    shardMemo.delete(name)
    shardMemoBytes -= entry.bytes
  }
}

export async function loadShardMemoized(dir: string, name: string): Promise<Record<string, CachedFile> | null> {
  const key = `${dir}\0${name}`
  const now = Date.now()
  const hit = shardMemo.get(key)
  if (hit) {
    hit.usedAt = now
    shardMemo.delete(key)
    shardMemo.set(key, hit)
    return hit.files
  }
  let raw: string
  try {
    raw = await readFile(join(dir, name), 'utf-8')
  } catch (err) {
    // Past the string limit a shard can still be read a member at a time. It is
    // far over the memo budget, so it is not memoized.
    return err instanceof RangeError ? loadShard(join(dir, name)) : null
  }
  let files: Record<string, CachedFile>
  try {
    const parsed = JSON.parse(raw)
    if (!validateFiles(parsed)) return null
    files = parsed
  } catch {
    return null
  }
  const bytes = Buffer.byteLength(raw)
  shardMemo.set(key, { files, bytes, usedAt: now })
  shardMemoBytes += bytes
  evictShardMemo(now)
  return files
}


/**
 * Read the cache. With a `scope`, only the files whose v9 month group the range
 * can report on are part of the result; with `startMs`/`endMs` as well, those
 * the range itself cannot report on are held as {@link CacheStub}s built from
 * the index and the piece key files, and only the members a report reads are
 * read. Everything else stays on disk and is carried across the next save
 * untouched (see saveCache). Durable providers and any provider whose recorded
 * fingerprint no longer matches are always read in full: the first because its
 * cache is the only surviving record of pruned usage, the second because a
 * fingerprint change discards the whole section and must see every entry it is
 * discarding.
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
  let envelope = await readEnvelope(dir)
  if (!envelope) {
    // A process that loses the re-layout race reads the winner's publish.
    await migrateMonthShardCache(dir)
    envelope = await readEnvelope(dir)
  }
  if (!envelope) return afterMissingShardCache()
  const scopeKey = scope ? `${scope.fromMonth}..${scope.toMonth}` : 'all'
  if (cacheMemo && cacheMemo.dir === dir && cacheMemo.nonce === envelope.nonce
    && (cacheMemo.scope === 'all' || cacheMemo.scope === scopeKey)) {
    if (scope) await coverRange(cacheMemo.cache, scope.startMs ?? -Infinity, scope.endMs ?? Infinity)
    return cacheMemo.cache
  }
  // Released before the new view is read, so the two are never held at once.
  cacheMemo = null

  const cache: SessionCache = { version: CACHE_VERSION, providers: {}, complete: envelope.complete === true }
  const state = stateOf(cache)
  state.dir = dir
  state.nonce = envelope.nonce
  const ranged = scope?.startMs !== undefined && scope.endMs !== undefined
    ? { startMs: scope.startMs, endMs: scope.endMs }
    : null
  const reads: Promise<void>[] = []
  for (const [provider, meta] of Object.entries(envelope.providers)) {
    if (RETIRED_PROVIDER_NAMES.has(provider)) {
      // Kept only in the base, so the next save leaves it out of the envelope
      // and deletes its index and pieces.
      state.base.set(provider, await readIndex(dir, meta.index) ?? { ...emptyBase(), index: meta.index })
      state.dirty = true
      continue
    }
    const section: ProviderSection = {
      envFingerprint: meta.envFingerprint,
      files: {},
      ...(meta.durable ? { durable: true } : {}),
      ...(meta.complete === true ? { complete: true } : {}),
      ...(typeof meta.completeFrom === 'number' ? { completeFrom: meta.completeFrom } : {}),
    }
    // Recorded even when every file is skipped or unreadable: the section is
    // what tells the next save which provider the carried rows belong to, and
    // what stops the reconcile from re-parsing under a fingerprint the envelope
    // already agrees with.
    cache.providers[provider] = section
    state.fingerprints.set(provider, meta.envFingerprint)
    // Durable providers are ALWAYS loaded in full, by name as well as by the
    // envelope flag: copilot's serve-time reconciliation pairs store rows and
    // retires residuals over the complete cached serve set, so a scoped load
    // of a copilot section persisted before the durable stamp landed would
    // make pairing range-dependent. The name check closes that window.
    const full = !scope || meta.durable === true || DURABLE_PROVIDER_NAMES.has(provider) || meta.envFingerprint !== computeEnvFingerprint(provider)
    const stubbed = !full && ranged !== null && !FULL_LOAD_PROVIDER_NAMES.has(provider)
    if (stubbed) state.covered = ranged
    reads.push(loadProvider(state, provider, section, meta.index, full ? null : scope!, stubbed ? ranged : null))
  }
  await Promise.all(reads)
  state.scope = scopeKey
  cacheMemo = { dir, nonce: envelope.nonce, scope: scopeKey, cache }
  return cache
}

// The months of `rows` a query over `scope` reports on: a v9 shard's span was
// its oldest file's month to its newest file's `until`.
function visibleMonths(rows: Map<string, IndexRow>, scope: CacheLoadScope): Set<string> {
  const until = new Map<string, string>()
  for (const row of rows.values()) {
    const seen = until.get(row.month)
    if (seen === undefined || row.until > seen) until.set(row.month, row.until)
  }
  const visible = new Set<string>([UNDATED_BUCKET])
  for (const [month, last] of until) if (shardInScope(month, last, scope)) visible.add(month)
  return visible
}

async function loadProvider(state: CacheState, provider: string, section: ProviderSection, indexName: string, scope: CacheLoadScope | null, ranged: { startMs: number; endMs: number } | null): Promise<void> {
  const index = await readIndex(state.dir, indexName)
  const base = index ?? emptyBase()
  state.base.set(provider, base)
  // Unreadable: its files re-parse, and the save publishes a fresh index.
  if (!index) markPathDirty(state, provider, ALL_PATHS)
  const visible = scope ? visibleMonths(base.rows, scope) : null
  state.visible.set(provider, visible)
  const stubs = ranged ? new Map<string, CacheStub>() : undefined
  if (stubs) state.stubs.set(provider, { section, byPath: stubs })
  const hidden = new Map<string, IndexRow>()
  state.hidden.set(provider, { section, byPath: hidden })

  const inFull = new Map<string, Array<[string, IndexRow]>>()
  const asStubs = new Map<string, Array<[string, IndexRow]>>()
  for (const [path, row] of base.rows) {
    if (visible && !visible.has(row.month)) hidden.set(path, row)
    else if (!ranged || fileNeeded(path, row, ranged.startMs, ranged.endMs)) pushTo(inFull, row.day, [path, row])
    else pushTo(asStubs, row.day, [path, row])
  }
  const members = new Map<string, CachedFile | CacheStub>()
  // A member or key list that cannot be read is dirtied without an entry: the
  // save drops its line and the file re-parses like any uncached one.
  // A full read takes every piece at once, as v9 read its shards; a ranged one
  // goes piece by piece, so it holds one read buffer at a time.
  const whole = ranged ? [] : [...inFull.keys()].map(day => base.pieces[day] ? loadShardMemoized(state.dir, base.pieces[day]!) : null)
  const scratch = { buf: Buffer.allocUnsafe(0) }
  for (const [i, [day, rows]] of [...inFull].entries()) {
    const name = base.pieces[day]
    let files: Map<string, CachedFile> | Record<string, CachedFile> | null = null
    if (!ranged) files = await whole[i] ?? null
    else if (name) files = await readMembersAt(join(state.dir, name), rows, scratch)
    for (const [path] of rows) {
      const file = files instanceof Map ? files.get(path) : files?.[path]
      if (file) members.set(path, file)
      else markPathDirty(state, provider, path)
    }
  }
  for (const [day, rows] of asStubs) {
    const lists = base.pieces[day] ? await readKeyLists(state.dir, base.pieces[day]!, rows) : null
    for (const [path, row] of rows) {
      const list = lists?.get(path)
      if (!list) { markPathDirty(state, provider, path); continue }
      members.set(path, { fingerprint: row.fingerprint, hasPr: (row.flags & ROW_PR) !== 0, keys: list, lo: row.lo, hi: row.hi, seq: 0 })
    }
  }
  let seq = 0
  for (const path of base.rows.keys()) {
    const entry = members.get(path)
    const at = seq++
    if (!entry) continue
    if (isCacheStub(entry)) {
      entry.seq = at
      stubs!.set(path, entry)
    } else {
      if (stubs) state.seq.set(entry, at)
      section.files[path] = entry
    }
  }
}

// The piece directory is absent/unreadable. Prefer a LOSSLESS re-layout of the
// newest prior layout that is present (v9 is handled by loadCache itself, then
// v8 provider shards, then the v7 single file — all hold the current turn shape,
// so nothing re-parses); failing that, adopt the prior versions' expired-source
// PR orphans, then the legacy unversioned file. Either way the piece directory
// is minted on the next save.
async function afterMissingShardCache(): Promise<SessionCache> {
  const relaid = await migrateProviderShardCache() ?? await migrateSingleFileCache()
  if (relaid) return relaid
  const prior = await adoptNewestPriorCache()
  if (prior) return prior
  // validateCache requires the version to match, so a different-version legacy
  // file is ignored (left intact). We copy it into the piece layout once via
  // saveCache; the legacy file is never modified.
  return adoptLegacyCache()
}

// Migration appends each member to its day piece as it arrives. Only this many
// pieces are held open at once; a piece closed early is reopened for append.
const MIGRATION_OPEN_PIECES = 32

type PieceSink = { name: string; pos: number; count: number }

// One-time, lossless re-layout of the v9 month shards into day pieces. It
// streams: every shard is read a member at a time (a single-line shard main
// wrote included) and each member is appended, verbatim, to its piece, so the
// peak is one member plus the open pieces, never the cache. Rows keep v9's full
// load order. Publishing the v10 envelope commits it; the v9 directory is
// removed only after that.
async function migrateMonthShardCache(dir: string): Promise<boolean> {
  const v9 = join(getCodeburnCacheDir(), MONTH_SHARD_DIR_NAME)
  let prior: { complete?: unknown; providers: Record<string, Record<string, unknown>> }
  try {
    const parsed = JSON.parse(await readFile(join(v9, ENVELOPE_FILE), 'utf-8')) as Record<string, unknown>
    if (parsed['version'] !== 9 || !parsed['providers'] || typeof parsed['providers'] !== 'object') return false
    prior = parsed as typeof prior
  } catch {
    return false
  }
  const written: string[] = []
  const open_ = new Map<string, FileHandle[]>()
  const closeOne = async (day: string): Promise<void> => {
    const handles = open_.get(day)
    open_.delete(day)
    for (const handle of handles ?? []) { await handle.sync(); await handle.close() }
  }
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 })
    const providers: Record<string, EnvelopeProvider> = {}
    for (const [provider, meta] of Object.entries(prior.providers)) {
      const shards = meta?.['shards']
      if (typeof meta?.['envFingerprint'] !== 'string' || !shards || typeof shards !== 'object') continue
      const rows = new Map<string, IndexRow>()
      const sinks = new Map<string, PieceSink>()
      const stale = new Set<string>()
      const append = async (day: string, key: string, value: string, keys: string[][]): Promise<[number, number]> => {
        let sink = sinks.get(day)
        if (!sink) {
          sink = { name: pieceFileName(provider, day), pos: 0, count: 0 }
          sinks.set(day, sink)
          written.push(sink.name, keysFileName(sink.name))
        }
        let handles = open_.get(day)
        if (handles) {
          open_.delete(day)
        } else {
          if (open_.size >= MIGRATION_OPEN_PIECES) await closeOne(open_.keys().next().value!)
          handles = [await open(join(dir, sink.name), 'a', 0o600), await open(join(dir, keysFileName(sink.name)), 'a', 0o600)]
        }
        open_.set(day, handles)
        const head = sink.count === 0 ? '{\n' : ',\n'
        const line = `${JSON.stringify(key)}:${value}`
        await handles[0]!.write(head + line)
        await handles[1]!.write(head + memberText(key, keys))
        const offset = sink.pos + 2
        const length = Buffer.byteLength(line)
        sink.pos = offset + length
        sink.count++
        return [offset, length]
      }
      for (const ref of Object.values(shards as Record<string, unknown>)) {
        const name = (ref as { name?: unknown } | null)?.name
        if (typeof name !== 'string') continue
        try {
          for await (const [key, value] of objectMembers(join(v9, name))) {
            const file: unknown = JSON.parse(value)
            if (!validateCachedFile(file)) continue
            // A path in two shards resolves to the freshest copy, at the first
            // copy's place, as a v9 load did.
            const seen = rows.get(key)
            if (seen && seen.fingerprint.mtimeMs >= file.fingerprint.mtimeMs) continue
            if (seen) stale.add(seen.day)
            const row = rowFor(key, file)
            const [offset, length] = await append(row.day, key, value, keysOf(file))
            rows.set(key, { ...row, offset, length })
          }
        } catch { /* an unreadable shard costs the files it still held, as on v9 */ }
      }
      for (const [day, sink] of sinks) {
        let handles = open_.get(day)
        if (!handles) handles = [await open(join(dir, sink.name), 'a', 0o600), await open(join(dir, keysFileName(sink.name)), 'a', 0o600)]
        open_.set(day, handles)
        await handles[0]!.write('\n}')
        await handles[1]!.write('\n}')
        await closeOne(day)
      }
      // A piece still holding a duplicate's stale line is rewritten without it.
      for (const day of stale) {
        const sink = sinks.get(day)!
        const dayRows = [...rows].filter(([, row]) => row.day === day)
        if (dayRows.length === 0) sinks.delete(day)
        const piece = await writePiece(dir, provider, day, sink.name, dayRows, {}, new Map(), written)
        for (const [path, row] of dayRows) {
          const span = piece.spans.get(path)
          if (span) rows.set(path, { ...row, offset: span[0], length: span[1] })
        }
        for (const name of [sink.name, keysFileName(sink.name)]) await retryCacheFileMutation(() => unlink(join(dir, name)))
        sink.name = piece.name
      }
      const index = indexFileName(provider)
      await writeFileAtomic(join(dir, index), indexText(Object.fromEntries([...sinks].map(([day, sink]) => [day, sink.name])), rows))
      written.push(index)
      providers[provider] = {
        envFingerprint: meta['envFingerprint'] as string,
        ...(meta['durable'] === true ? { durable: true } : {}),
        ...(meta['complete'] === true ? { complete: true } : {}),
        ...(isNum(meta['completeFrom']) ? { completeFrom: meta['completeFrom'] } : {}),
        index,
      }
      await yieldToEventLoop()
    }
    if (await readEnvelope(dir)) throw new Error('another process published first')
    const envelope: CacheEnvelope = { version: CACHE_VERSION, complete: prior.complete === true, nonce: randomBytes(8).toString('hex'), providers }
    await writeFileAtomic(join(dir, ENVELOPE_FILE), JSON.stringify(envelope))
  } catch {
    for (const day of [...open_.keys()]) await closeOne(day).catch(() => {})
    for (const name of written) await retryCacheFileMutation(() => unlink(join(dir, name)))
    return false
  }
  await retryCacheFileMutation(() => rm(v9, { recursive: true, force: true }))
  return true
}

// One-time, lossless re-layout of the v8 per-provider shard directory: v8's
// turn shape is the current one, so every entry moves across verbatim and
// nothing re-parses. The v8 directory is removed only once the save has
// published.
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
// shard directory, so it is migrated straight to the current layout.
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

// Every section is marked dirty so the save writes every piece; the old layout
// is retired only once that save has published.
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

// File names carry a fresh nonce on every write, so a save never overwrites a
// file the currently-published envelope points at: readers keep seeing a
// consistent set until the envelope rename publishes the new one, and a writer
// that loses the ownership fence leaves the canonical files untouched.
function providerFilePart(provider: string): string {
  return provider.replace(/[^A-Za-z0-9_-]/g, '_')
}

function pieceFileName(provider: string, day: string): string {
  return `${providerFilePart(provider)}.${day}.${randomBytes(8).toString('hex')}.json`
}

function keysFileName(piece: string): string {
  return piece.replace(/\.json$/, '.keys.json')
}

function indexFileName(provider: string): string {
  return `index.${providerFilePart(provider)}.${randomBytes(8).toString('hex')}.json`
}

// The temp name carries a nonce: two processes writing the SAME final path
// (the envelope, every save) would otherwise share one temp file and interleave
// their writes into a torn or foreign payload.
async function writeFileAtomic(finalPath: string, payload: string | AsyncIterable<string>, sync = true): Promise<void> {
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tempPath, 'w', 0o600)
  try {
    if (typeof payload === 'string') {
      await handle.writeFile(payload, { encoding: 'utf-8' })
    } else {
      let pending = ''
      for await (const chunk of payload) {
        pending += chunk
        if (pending.length < SHARD_READ_CHUNK) continue
        await handle.writeFile(pending, { encoding: 'utf-8' })
        pending = ''
      }
      if (pending) await handle.writeFile(pending, { encoding: 'utf-8' })
    }
    if (sync) await handle.sync()
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

// Surrender the event loop without microtask overhead. Used inside saveCache
// between piece writes so an interactive TTY's stdin handler (Ink's useInput)
// can run while a long save publishes a 21k-file cache (#1141).
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

// The order a v9 save would leave these files in, which is the order the next
// full load holds them in (see IndexRow). v9 kept files in month shards: a
// month the load read is rewritten from memory in load order, a month it did
// not read that gained a file (a re-parse) keeps its published order with the
// new file after it, behind every month the load read, and the months it
// neither read nor touched follow as they were.
function nextOrder(base: Map<string, IndexRow>, rows: Map<string, IndexRow>, loadOrder: string[], visible: Set<string> | null): string[] {
  const read = (month: string): boolean => visible === null || visible.has(month)
  const before = new Map<string, string[]>()
  for (const [path, row] of base) pushTo(before, row.month, path)
  const now = new Map<string, string[]>()
  for (const path of loadOrder) {
    const row = rows.get(path)
    if (row) pushTo(now, row.month, path)
  }
  const out: string[] = []
  const placed = new Set<string>()
  const put = (path: string): void => {
    if (placed.has(path) || !rows.has(path)) return
    placed.add(path)
    out.push(path)
  }
  const stayed = (month: string) => (path: string): void => { if (rows.get(path)?.month === month) put(path) }
  for (const [month, paths] of now) if (!before.has(month) || read(month)) paths.forEach(put)
  for (const [month, paths] of now) {
    if (!before.has(month) || read(month)) continue
    before.get(month)!.forEach(stayed(month))
    paths.forEach(put)
  }
  for (const [month, paths] of before) if (!now.has(month) && !read(month)) paths.forEach(stayed(month))
  // Rows this process never held (a concurrent writer's), then anything left.
  for (const path of base.keys()) put(path)
  for (const path of rows.keys()) put(path)
  return out
}

// Rewrite one piece: the lines of rows that stay are copied from the published
// piece, the rest come from memory. A piece whose lines all come out the same
// keeps its published name (#1032). Returns each written row's byte span; a
// row the published piece no longer holds has none.
async function writePiece(dir: string, provider: string, day: string, from: string | undefined, rows: Array<[string, IndexRow]>, files: Record<string, CachedFile>, fromMemory: Map<string, IndexRow>, written: string[]): Promise<{ name: string; spans: Map<string, [number, number]> }> {
  const copied = new Map<string, IndexRow>()
  const pending = new Map<string, CachedFile>()
  for (const [path, row] of rows) {
    if (fromMemory.has(path)) pending.set(path, files[path]!)
    else copied.set(path, row)
  }
  const baseKeys = from && copied.size > 0 ? await readKeys(dir, from) : null
  const order: string[] = []
  const keyLines: string[] = []
  let changed = !from
  const members = async function* (): AsyncGenerator<string> {
    if (from) {
      try {
        for await (const line of shardLines(join(dir, from))) {
          const file = pending.get(line.key)
          const row = copied.get(line.key)
          if (file) {
            pending.delete(line.key)
            const text = memberText(line.key, file)
            if (text !== shardLineText(line)) changed = true
            order.push(line.key)
            keyLines.push(memberText(line.key, keysOf(file)))
            yield text
          } else if (row && row.offset === line.offset) {
            copied.delete(line.key)
            const keys = baseKeys?.[line.key]
            order.push(line.key)
            keyLines.push(memberText(line.key, isKeyList(keys) ? keys : keysOf(JSON.parse(line.value) as CachedFile)))
            yield shardLineText(line)
          } else {
            changed = true
          }
        }
      } catch {
        changed = true
      }
    }
    for (const [path, file] of pending) {
      changed = true
      order.push(path)
      keyLines.push(memberText(path, keysOf(file)))
      yield memberText(path, file)
    }
  }
  const name = pieceFileName(provider, day)
  const positions: Array<[number, number]> = []
  await writeFileAtomic(join(dir, name), shardPayload(members(), positions))
  const spans = new Map(order.map((path, i): [string, [number, number]] => [path, positions[i]!]))
  if (!changed && copied.size === 0) {
    await retryCacheFileMutation(() => unlink(join(dir, name)))
    return { name: from!, spans }
  }
  written.push(name)
  await writeFileAtomic(join(dir, keysFileName(name)), shardPayload(keyLines), false)
  written.push(keysFileName(name))
  return { name, spans }
}

type ProviderSave = ProviderBase & { retire: string[]; lost: Set<string> }

// One provider's part of a save: rows changed in memory (dirty paths) over the
// rows of `base`, the pieces those changes touch rewritten, the rest kept.
async function saveProvider(dir: string, state: CacheState, cache: SessionCache, provider: string, section: ProviderSection, base: ProviderBase, reset: boolean, written: string[]): Promise<ProviderSave> {
  const dirty = state.dirtyPaths.get(provider)
  const all = dirty?.has(ALL_PATHS) === true
  const isDirty = (path: string): boolean => all || dirty?.has(path) === true
  const stubs = stubsOf(state, cache, provider)
  const hidden = hiddenOf(state, cache, provider)
  const priorRows = reset ? new Map<string, IndexRow>() : base.rows
  const rows = new Map<string, IndexRow>()
  const fromMemory = new Map<string, IndexRow>()
  const touched = new Set<string>()
  for (const [path, row] of priorRows) {
    if (!isDirty(path) || (!section.files[path] && (stubs?.has(path) || hidden?.has(path)))) rows.set(path, row)
    else if (!section.files[path]) touched.add(row.day)
  }
  for (const [path, file] of Object.entries(section.files)) {
    const prior = priorRows.get(path)
    if (prior && !isDirty(path)) continue
    const row = rowFor(path, file)
    rows.set(path, row)
    fromMemory.set(path, row)
    touched.add(row.day)
    if (prior) touched.add(prior.day)
  }

  const order = nextOrder(priorRows, rows, entriesInLoadOrder(state, section, stubs).map(([path]) => path), reset ? null : state.visible.get(provider) ?? null)
  const byDay = new Map<string, Array<[string, IndexRow]>>()
  for (const path of order) pushTo(byDay, rows.get(path)!.day, [path, rows.get(path)!])

  const priorPieces = reset ? {} : base.pieces
  const pieces: Record<string, string> = {}
  const retire: string[] = []
  const lost = new Set<string>()
  const spansOf = new Map<string, [number, number]>()
  for (const [day, name] of Object.entries(base.pieces)) if (reset || !byDay.has(day)) retire.push(name)
  for (const [day, dayRows] of byDay) {
    const from = priorPieces[day]
    if (from && !touched.has(day)) { pieces[day] = from; continue }
    const piece = await writePiece(dir, provider, day, from, dayRows, section.files, fromMemory, written)
    pieces[day] = piece.name
    if (from && piece.name !== from) retire.push(from)
    for (const [path] of dayRows) {
      const span = piece.spans.get(path)
      if (span) spansOf.set(path, span)
      else lost.add(path)
    }
    await yieldToEventLoop()
  }
  const finalRows = new Map<string, IndexRow>()
  for (const path of order) {
    if (lost.has(path)) continue
    const row = rows.get(path)!
    const span = spansOf.get(path)
    finalRows.set(path, span && (span[0] !== row.offset || span[1] !== row.length) ? { ...row, offset: span[0], length: span[1] } : row)
  }
  if (lost.size > 0) {
    const held = new Set([...finalRows.values()].map(row => row.day))
    for (const day of byDay.keys()) if (!held.has(day)) { retire.push(pieces[day]!); delete pieces[day] }
  }

  const text = indexText(pieces, finalRows)
  const hash = textHash(text)
  let index = base.index
  if (reset || !index || hash !== base.hash) {
    index = indexFileName(provider)
    await writeFileAtomic(join(dir, index), text)
    written.push(index)
    if (base.index) retire.push(base.index)
  }
  return { index, pieces, rows: finalRows, hash, retire, lost }
}

export async function saveCache(cache: SessionCache, verifyStillOwner?: () => Promise<boolean>): Promise<boolean> {
  const dir = sessionCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 })
  const state = stateOf(cache)

  for (let attempt = 0; ; attempt++) {
    const written: string[] = []
    try {
      // Another process may have published since this cache was read. Its
      // envelope is then the base: what this process did not change stays as
      // that process left it, and what it did change is applied on top.
      const live = await readEnvelope(dir)
      const rebased = live !== null && live.nonce !== state.nonce
      const saves = new Map<string, ProviderSave>()
      for (const [provider, section] of Object.entries(cache.providers)) {
        const base = rebased
          ? await readIndex(dir, live!.providers[provider]?.index) ?? emptyBase()
          : state.base.get(provider) ?? emptyBase()
        const baseFingerprint = rebased ? live!.providers[provider]?.envFingerprint : state.fingerprints.get(provider)
        // A fingerprint change discards the section outright (see
        // getOrCreateProviderSection), so nothing is carried from the base.
        const reset = baseFingerprint !== undefined && baseFingerprint !== section.envFingerprint
        saves.set(provider, await saveProvider(dir, state, cache, provider, section, base, reset, written))
      }

      // One optimistic retry when a publish landed while this one was being
      // built: redone from that publish. The remaining window is the envelope
      // rename below; a save that loses it has its changes re-derived by the
      // next parse (the reconcile finds no row and re-reads the file).
      if (attempt === 0 && (await readEnvelope(dir))?.nonce !== live?.nonce) {
        for (const name of written) await retryCacheFileMutation(() => unlink(join(dir, name)))
        continue
      }

      // The warm refresh transaction passes an ownership fence. It must be the
      // final operation before publication so a displaced writer cannot replace
      // the canonical cache with its stale snapshot. Files written above are
      // unreferenced until the envelope names them, so a lost fence publishes
      // nothing.
      if (verifyStillOwner && !await verifyStillOwner()) {
        for (const name of written) await retryCacheFileMutation(() => unlink(join(dir, name)))
        return false
      }

      const providers: Record<string, EnvelopeProvider> = {}
      for (const [provider, save] of saves) {
        const section = cache.providers[provider]!
        providers[provider] = {
          envFingerprint: section.envFingerprint,
          ...(section.durable ? { durable: true } : {}),
          ...(section.complete === true ? { complete: true } : {}),
          ...(section.completeFrom !== undefined ? { completeFrom: section.completeFrom } : {}),
          index: save.index!,
        }
      }
      const envelope: CacheEnvelope = {
        version: CACHE_VERSION,
        complete: cache.complete === true,
        nonce: randomBytes(8).toString('hex'),
        providers,
      }
      await writeFileAtomic(join(dir, ENVELOPE_FILE), JSON.stringify(envelope))

      // Files the new envelope no longer references are garbage; a reader that
      // already opened one keeps reading it, and any failure here is swept later
      // by cleanupOrphanedTempFiles.
      const retired = new Set<string>()
      for (const save of saves.values()) for (const name of save.retire) retired.add(name)
      for (const [provider, base] of state.base) {
        if (saves.has(provider)) continue
        if (base.index) retired.add(base.index)
        for (const name of Object.values(base.pieces)) retired.add(name)
      }

      state.dirty = false
      state.dirtyPaths.clear()
      state.base.clear()
      state.fingerprints.clear()
      state.nonce = envelope.nonce
      for (const [provider, save] of saves) {
        state.base.set(provider, { index: save.index, pieces: save.pieces, rows: save.rows, hash: save.hash })
        state.fingerprints.set(provider, envelope.providers[provider]!.envFingerprint)
        const section = cache.providers[provider]!
        const hidden = hiddenOf(state, cache, provider)
        const stubs = stubsOf(state, cache, provider)
        for (const path of save.lost) { hidden?.delete(path); stubs?.delete(path) }
        if (!stubs) continue
        // Load order continues as it stood in memory, as it does for v9's
        // in-memory `files` after a save.
        let seq = 0
        for (const [, entry] of entriesInLoadOrder(state, section, stubs)) {
          if (isCacheStub(entry)) entry.seq = seq++
          else state.seq.set(entry, seq++)
        }
      }
      // Write-through: the object just published IS the freshest state, so the
      // next loadCache in this process reuses it instead of re-reading. Its
      // scope is whatever was loaded, not `all` — a save never widens what is
      // in memory.
      cacheMemo = { dir, nonce: envelope.nonce, scope: state.scope, cache }
      for (const name of retired) {
        await retryCacheFileMutation(() => unlink(join(dir, name)))
        if (!name.startsWith('index.')) await retryCacheFileMutation(() => unlink(join(dir, keysFileName(name))))
      }
      return true
    } catch (err) {
      for (const name of written) await retryCacheFileMutation(() => unlink(join(dir, name)))
      throw err
    }
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

let fingerprintCalls = 0
export function fingerprintFileCount(): number {
  return fingerprintCalls
}

export async function fingerprintFile(filePath: string): Promise<FileFingerprint | null> {
  fingerprintCalls++
  try {
    const s = await stat(filePath)
    // A source path that IS a SQLite database (copilot OTel's agent-traces.db)
    // needs the same WAL fold as the virtual-suffix forms below.
    if (SQLITE_DB_PATH.test(filePath)) return fingerprintSqliteFile(filePath)
    // WSL's 9P share (`\\wsl$\...`) synthesizes dev/ino per mount, so they can
    // differ run to run for an unchanged file — keying on them would re-parse
    // every WSL session every time. mtime+size only for those paths (#1059).
    if (isWslUncPath(filePath)) return { dev: 0, ino: 0, mtimeMs: s.mtimeMs, sizeBytes: s.size }
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

// The on-disk paths a source path may resolve to, mirroring fingerprintFile's
// virtual-suffix fallbacks above. A caller that got a null fingerprint and
// must distinguish "gone" (every candidate ENOENT) from "present but
// unreadable" (any candidate erroring some other way — data may be changing
// behind the failure) has to check the same underlying paths the fingerprint
// would have read, or a compound path's guaranteed ENOENT masks the real
// file's EACCES.
export function sourcePathStatCandidates(filePath: string): string[] {
  const candidates = [filePath]
  const hashIdx = filePath.indexOf('#')
  if (hashIdx > 0) candidates.push(filePath.slice(0, hashIdx))
  const colonIdx = filePath.lastIndexOf(':')
  if (colonIdx > 0) {
    // Only a prefix that still looks like a path is a candidate: a plain
    // Windows path (`C:\...`) would otherwise yield the bare drive letter,
    // and a stat error on that cwd-relative name must never hold hydration.
    const prefix = filePath.slice(0, colonIdx)
    if (prefix.includes('/') || prefix.includes('\\')) candidates.push(prefix)
  }
  return candidates
}

// ── Reconciliation ─────────────────────────────────────────────────────

export type ReconcileAction =
  | { action: 'unchanged' }
  | { action: 'appended'; readFromOffset: number }
  | { action: 'modified' }
  | { action: 'new' }

export function reconcileFile(
  current: FileFingerprint,
  cached: Pick<CachedFile, 'fingerprint' | 'lastCompleteLineOffset'> | undefined,
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
  // `status-snapshot.<queryKeyHash>.json.<nonce>.tmp` (see
  // writeStatusSnapshotRecord below — one file per queryKey) is swept here
  // too: it lives in this same parent dir, orthogonal to the month-shard
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
  let envelope = await readEnvelope(dir)
  if (envelope) {
    for (const meta of Object.values(envelope.providers)) {
      referenced.add(meta.index)
      const memo = cacheMemo?.nonce === envelope.nonce ? stateOf(cacheMemo.cache).base : undefined
      const pieces = [...(memo?.values() ?? [])].find(base => base.index === meta.index)?.pieces
        ?? (await readIndex(dir, meta.index))?.pieces
      // An index that cannot be read (a concurrent save may just have retired
      // it) leaves its pieces unknown, so nothing is swept this time.
      if (!pieces) { envelope = null; break }
      for (const name of Object.values(pieces)) { referenced.add(name); referenced.add(keysFileName(name)) }
    }
    // A published envelope means the re-layout completed. Its retirement of
    // the old layout is a separate, unsynchronised step, so a crash in between
    // leaves 100MB+ of superseded cache behind forever. Age-guarded for the
    // same reason the piece sweep is: an OLD binary may still be writing there.
    await unlinkIfOlderThan(join(getCodeburnCacheDir(), priorCacheFile(7)), UNREFERENCED_SHARD_MAX_AGE_MS, now)
    for (const name of [PRIOR_SHARD_DIR_NAME, MONTH_SHARD_DIR_NAME]) {
      const old = join(getCodeburnCacheDir(), name)
      try {
        const s = await stat(join(old, ENVELOPE_FILE))
        if (now - s.mtimeMs > UNREFERENCED_SHARD_MAX_AGE_MS) await rm(old, { recursive: true, force: true })
      } catch {}
    }
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

/** Terminate an interactive CLI after synchronously releasing both cache-lock
 * families it can own. The process cannot wait for background parsing to drain,
 * but a direct exit must not make the next launch recover a stale live-pid lock. */
export function exitAfterCacheCleanup(exitCode: number): never {
  releaseOwnedRefreshLocksForExit()
  removeOurLockSync()
  process.exit(exitCode)
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
// snapshot until this record's first observed mismatch has aged past the
// window, instead of recomputing on every single poll of a burst. A streaming
// assistant turn
// can touch its transcript many times a second; without this, a menubar
// polling on a tight interval would pay the full parse+aggregation cost on
// every one of those ticks. The deferred call deliberately does NOT persist
// a new snapshot — the pre-churn baseline it's still serving stays on disk —
// so the first poll after the mismatch clock ages past the window sees a real
// fingerprint mismatch with no fresh grace period left,
// recomputes for real, and persists the settled result. No update is ever
// masked permanently: the window only ever delays picking one up. Mirrors
// the existing `parseBurstWindowMs`/`CODEBURN_PARSE_BURST_MS` convention:
// small, capped, env-overridable for tuning/tests.
function statusSnapshotSettleMs(): number {
  const raw = Number(process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS'] ?? '2000')
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60_000) : 2000
}

const STATUS_SNAPSHOT_FILE = 'status-snapshot'

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
//
// v2 (was v1): the file is now keyed by `queryKey` in its NAME (see
// `statusSnapshotPath` below) instead of being one shared slot — two
// concurrent callers with different queryKeys (a menubar poll for "today"
// racing a manual refresh for "week") used to unconditionally evict each
// other's save. A v1 file at the old fixed path is simply never looked at
// again under v2 (harmless leftover, not actively cleaned).
//
// v3: every record carries the binary/render semantic key and the high-
// resolution time at which its corpus scan began. The latter is the ordering
// fence for competing writers: max(file mtime) is not monotonic because
// deleting the newest file legitimately makes it decrease.
//
// v4: the payload carries `telemetrySnapshot`, which a v3 record predates.
const STATUS_SNAPSHOT_VERSION = 4

type StatusSnapshotRecord = {
  version: number
  semanticKey: string
  corpusFingerprint: string
  newestMtimeMs: number
  observedAtMs: number
  // Kept alongside the hash in the filename as a defensive re-check against
  // a (vanishingly unlikely) hash collision between two different queries.
  queryKey: string
  payload: unknown
  // Wall-clock time (Date.now()) the FIRST mismatch against this record's
  // corpusFingerprint was observed. Absent = not currently mismatched (a
  // fresh save, or a record no load has mismatched against yet). This is
  // what the settle-window decision anchors on — see `loadStatusSnapshot`.
  mismatchFirstSeenAt?: number
}

// Each distinct queryKey gets its OWN file (`status-snapshot.<hash>.json`)
// rather than sharing one slot — see the v2 note above / review finding
// B-G1's "amplifier." This means two writers for different queryKeys never
// touch each other's file at all, so there is no read-merge-write race to
// close between them (a shared-map-file design was tried and demonstrably
// races: two concurrent writers for different keys can each read before
// either has written, then each overwrite the whole file with only their
// own key — verified by a failing test before this per-file design replaced
// it).
function statusSnapshotHash(queryKey: string): string {
  return createHash('sha256').update(queryKey).digest('hex').slice(0, 16)
}

function statusSnapshotPath(queryKey: string): string {
  const hash = statusSnapshotHash(queryKey)
  return join(getCodeburnCacheDir(), `${STATUS_SNAPSHOT_FILE}.${hash}.json`)
}

function statusSnapshotLockFile(queryKey: string): string {
  return `${STATUS_SNAPSHOT_FILE}.${statusSnapshotHash(queryKey)}.write.lock`
}

async function readStatusSnapshotRecord(queryKey: string): Promise<StatusSnapshotRecord | null> {
  try {
    const raw = await readFile(statusSnapshotPath(queryKey), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StatusSnapshotRecord>
    if (
      parsed.version !== STATUS_SNAPSHOT_VERSION ||
      typeof parsed.semanticKey !== 'string' ||
      typeof parsed.corpusFingerprint !== 'string' ||
      typeof parsed.newestMtimeMs !== 'number' || !Number.isFinite(parsed.newestMtimeMs) ||
      typeof parsed.observedAtMs !== 'number' || !Number.isFinite(parsed.observedAtMs) ||
      parsed.queryKey !== queryKey
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
 *  of reusing/deferring — never stale or corrupt data either way.
 *
 *  The guard/read/write/rename transaction runs under a per-query cross-
 *  process lock. A pre-rename re-read alone is not a CAS: two processes can
 *  both pass it before either renames, after which the older writer is free to
 *  land last. The lock makes that decision and publication one atomic critical
 *  section while distinct query keys remain independent. */
async function writeStatusSnapshotRecord(
  queryKey: string,
  record: StatusSnapshotRecord,
  guard: (existing: StatusSnapshotRecord | null) => boolean,
): Promise<boolean> {
  const dir = getCodeburnCacheDir()
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  } catch {
    return false
  }

  // A waiter reports `completed-by-other` when the owner releases cleanly.
  // Writers still need their own critical section to evaluate their guard, so
  // retry acquisition a bounded number of times instead of treating another
  // writer's completion as ours.
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = await acquireCacheRefreshLock({
      cacheDir: dir,
      lockFile: statusSnapshotLockFile(queryKey),
      waitMs: 2_000,
      pollMs: 10,
    })
    if (lock.outcome === 'completed-by-other') continue
    if (lock.outcome !== 'acquired') return false

    let tempPath: string | null = null
    try {
      const finalPath = statusSnapshotPath(queryKey)
      const existing = await readStatusSnapshotRecord(queryKey)
      if (!guard(existing)) return false
      tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
      const handle = await open(tempPath, 'w', 0o600)
      try {
        await handle.writeFile(JSON.stringify(record), { encoding: 'utf-8' })
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Fail closed if takeover or an I/O fault displaced us before publish.
      if (!await lock.handle.verifyStillOwner()) return false
      await rename(tempPath, finalPath)
      tempPath = null
      return true
    } catch {
      return false
    } finally {
      if (tempPath) await unlink(tempPath).catch(() => {})
      await lock.handle.release().catch(() => {})
    }
  }
  return false
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
export async function loadStatusSnapshot(corpusFingerprint: string, queryKey: string, semanticKey: string): Promise<unknown | null> {
  const stored = await readStatusSnapshotRecord(queryKey)
  if (!stored) return null
  if (stored.semanticKey !== semanticKey) return null
  // Belt-and-braces mirror of the save gate in main.ts: a payload marked
  // degraded (`stale === true` or a `hydration` block) must never have been
  // persisted, so one that somehow was (an older build, a hand-edited file)
  // is treated as a miss and recomputed rather than served.
  const candidate = stored.payload as { stale?: unknown; hydration?: unknown } | null | undefined
  if (candidate !== null && typeof candidate === 'object' && (candidate.stale === true || candidate.hydration !== undefined)) return null
  if (stored.corpusFingerprint === corpusFingerprint) return stored.payload ?? null

  const now = Date.now()
  const firstSeenAt = stored.mismatchFirstSeenAt ?? now
  if (now - firstSeenAt >= statusSnapshotSettleMs()) return null
  if (stored.mismatchFirstSeenAt === undefined) {
    // Bookkeeping-only write: only proceed if the on-disk record is exactly
    // what we just read (same corpusFingerprint, still no
    // mismatchFirstSeenAt). If a concurrent real recompute already replaced
    // it, this stale payload must not be reintroduced under a
    // freshly-stamped timestamp.
    const basisFingerprint = stored.corpusFingerprint
    const persisted = await writeStatusSnapshotRecord(
      queryKey,
      { ...stored, mismatchFirstSeenAt: firstSeenAt },
      existing => existing !== null
        && existing.semanticKey === semanticKey
        && existing.corpusFingerprint === basisFingerprint
        && existing.observedAtMs === stored.observedAtMs
        && existing.mismatchFirstSeenAt === undefined,
    )
    // Serving stale is safe only when the first-observed timestamp is durable.
    // Otherwise each short-lived CLI process starts a fresh grace window and a
    // read-only or broken cache can serve the old payload forever.
    if (!persisted) return null
  }
  return stored.payload ?? null
}

/** Best-effort: a failed write just means the next poll recomputes instead
 *  of reusing. Only ever called by the caller when `loadStatusSnapshot`
 *  missed, so a settled recompute's result should supersede whatever was
 *  there before — UNLESS a concurrent recompute already published one based
 *  on a strictly fresher corpus observation (`observedAtMs`), in which case
 *  this (slower, now-stale) write is refused rather than clobbering it. Ties
 *  proceed: both reflect a correct recompute of the same corpus state. Always
 *  writes a fresh record with no `mismatchFirstSeenAt`, which is exactly what
 *  clears the settle-window clock once a real recompute lands. */
export async function saveStatusSnapshot(
  corpusFingerprint: string,
  newestMtimeMs: number,
  observedAtMs: number,
  queryKey: string,
  semanticKey: string,
  payload: unknown,
): Promise<boolean> {
  return writeStatusSnapshotRecord(
    queryKey,
    { version: STATUS_SNAPSHOT_VERSION, semanticKey, corpusFingerprint, newestMtimeMs, observedAtMs, queryKey, payload },
    existing => !existing
      || existing.semanticKey !== semanticKey
      || existing.observedAtMs < observedAtMs
      || (existing.observedAtMs === observedAtMs && existing.corpusFingerprint === corpusFingerprint),
  )
}
