# Changelog

## 0.9.15 - 2026-07-02

### Added (CLI)
- **`codeburn context`.** See what fills a session's context window, by role,
  block type, and tool: an interactive terminal browser over Claude Code and
  Codex sessions that separates the live window from compacted history and
  anchors estimates to the exact API-reported context size. Also available as
  a Context page in the browser dashboard and scriptable via
  `codeburn context <id> --json`. (#592)
- **Zed provider.** Zed's built-in agent is tracked: per-request token usage
  with full cache fields, topped up to each thread's exact cumulative counter
  and validated token-for-token against a real store. (#594, format documented
  by @chatzinikolakisk in #480)
- **`codeburn audit`.** Per provider-and-model table of where every number
  comes from: calls, input, output, reasoning, cache read/write, cost. (#578)
- **User price overrides** for any model via `codeburn price-override`.
  (#390, #560, thanks @ozymandiashh)
- **open-design provider** for per-model usage tracking. (#559, thanks @ozymandiashh)
- **Browser dashboard**: fully mobile responsive (#582, thanks @ele-yufo; #589),
  instant first paint with the local payload inlined, defaults to today, and
  fast-fails offline paired devices. (#573)

### Fixed (CLI)
- **Cursor tokens are Cursor's own numbers.** Input comes from the
  per-conversation context meter instead of text-length guesses, credited once
  per conversation on a stable anchor so daily history stays consistent across
  re-scans; tools and shell commands come from the agent stream; Composer house
  models price at Cursor's published rates; figures are flagged estimated where
  they are. (#574, #575; closes #326)
- **Copilot Chat users no longer see $0.00**: VS Code core chatSessions
  journals are read for token counts. (#555, #563, thanks @ozymandiashh)
- **Codex** sessions up to 4GB are parsed (streaming cap raised). (#569)
- **Devin** supports ATIF v1.7 (#570, thanks @tvcsantos) and reports friendly
  GPT model names with effort tiers. (#585)
- **OpenCode** skills and subagents breakdowns are populated. (#557, thanks @KevNev19)
- **Pi** native skill loads classify as Skill, not Read. (#588, #590)
- **Cache read/write** scoped to the selected period in web and devices CLI.
  (#583, #586, thanks @ozymandiashh)
- **Web** rejects invalid dashboard periods instead of exiting. (#554, thanks @ozymandiashh)
- **Pricing**: LiteLLM snapshot refreshed; MiniMax-M3 follows MiniMax's tiered
  pricing (standard tier $0.30/$1.20 per M). Daily cache bumped to v10 so
  history re-hydrates under the new Cursor accounting and pricing.

### macOS menubar
- **Local/Combined usage toggle** backed by combined multi-device data in
  menubar-json. (#566, #567, #568, thanks @ozymandiashh)
- **Update dialog** detects a codeburn CLI too old to install menubar updates
  (pre-0.9.9) and shows the exact CLI upgrade command first. (#593)

## 0.9.14 - 2026-06-22

### Added (CLI)
- **Browser dashboard.** `codeburn web` serves a local React dashboard in your
  browser with the same task, model, tool, and project breakdowns as the TUI,
  plus charts. Data is read locally and the server binds to localhost. (#531, #533)
- **Combine usage across your devices.** `codeburn share` exposes one device's
  usage over your local network (PIN-paired), and `codeburn devices` shows
  combined totals by machine. Devices can also be discovered and paired from the
  browser dashboard. (#532, #534, #536)
- **New providers:** Grok Build (#521), ZCode (z.ai GLM-5.2) (#537), Hermes Agent
  (#544), Kiro CLI sessions (#502), and zerostack (#519, thanks @kevinpauer).
- **`codeburn overview`.** Plain-text monthly usage summary that is
  copy-pasteable, with `--no-color` and `--from`/`--to`. (#528, #535)
- **Codex credit usage.** Compute and surface Codex credit consumption alongside
  dollar cost. (#408, #495, #510)
- **MCP server usage in exports.** `codeburn export` now includes per-MCP-server
  usage in both JSON and CSV. (#496, #514)
- **JSON output for `optimize` and `yield`.** (#492, #500)
- **Claude-scoped agent-type breakdown** in the report.
- **OpenCode 1.1+ file-based JSON sessions.** (#523)
- **Copilot OTel cache-token parsing.** (#477, thanks @steelp02; #498)

### Fixed (CLI)
- **Model names in reports.** Models priced through a sibling alias no longer
  show their internal pricing key: ZCode/Hermes GLM-5.2 and Grok Build display
  their real names, gpt-5.5 labels as GPT-5.5, and gpt-5.3-codex-spark is
  distinguished from base GPT-5.3 Codex. (#548, #550, #539 thanks @ozymandiashh)
- **Hermes lowercase glm-5.2** prices the same as GLM-5.2. (#545, thanks @ozymandiashh)
- **Daily cache** purges cached today/future entries on hydration and is bumped
  to v9 so newly supported providers backfill across history without a manual
  cache clear. (#550)
- **Cursor** scans the requested window instead of a blind 250k ROWID cap. (#482, #512)
- **cursor-agent** ingests the workspace-less CLI transcript layout. (#542, thanks @ozymandiashh)
- **Claude Code project names** no longer collapse to a parent folder, and stray
  `.git` directories no longer over-group projects. (#540, thanks @ozymandiashh)
- **Copilot** shell commands and skills/agents display correctly. (#527, thanks @jonjozwiak)
- **Codex** attributes MCP calls emitted as `event_msg`/`mcp_tool_call_end`. (#513)
- **Antigravity** reads the current `agy` CLI on-disk layout. (#541, thanks @ozymandiashh)
- Workflow/ultracode subagent usage is now counted. (#470)
- `--provider` is validated and the non-TTY report is deterministic. (#501)
- The dashboard plan banner is scoped to its own provider tab. (#524)
- Test isolation and environment-collision fixes. (#530, thanks @tvcsantos)

### Added (macOS menubar)
- **Custom daily budget.** Set a custom daily budget amount; the alert respects
  the display metric (Cost or Tokens). (#497, #505, #506)
- **Agent tabs** show every active agent for the selected range, ordered by
  usage. (#549)
- Polished status-item menu and About tab (Star and Sponsor links). (#509)

### Fixed (macOS menubar)
- **Keychain prompts.** Stop repeated keychain prompts on token refresh; read the
  Claude keychain via the `security` CLI on silent refresh. (#490, #491)
- Restore the right-click status-item menu on macOS 27. (#472, thanks @theparlor)
- Support installer HTTP proxies. (#475, thanks @sleicht)
- Surface the CLI's stdout/stderr on a decode failure so a stray banner is
  self-diagnosing. (#515, #547)
- Reduce repeated status parsing and guard against clock skew. (#486, thanks @vaibhavarora14; #499)
- The cost budget stays in USD and an empty custom budget is flagged. (#508)
- Drop the ` tok` suffix from the Total Tokens metric. (#511)

## 0.9.12 - 2026-06-09

### Added (CLI)
- **MCP server.** `codeburn mcp` runs a stdio Model Context Protocol server
  exposing `get_usage` and `get_savings` to AI agents, with project names
  pseudonymized by default (opt-in reveal). (#429)
- **New providers:** Devin (#444), Antigravity IDE (#418), JetBrains —
  IntelliJ/DataGrip via Copilot (#433), coder/mux (#438), and an opt-in
  Vercel AI Gateway datasource via `AI_GATEWAY_API_KEY` (#432).
- **Automatic pricing gap-fill** from models.dev and OpenRouter for models
  LiteLLM has not indexed yet (e.g. Claude Fable 5). (#457)
- **Proxy-aware cost attribution.** `codeburn proxy-path` marks a project as
  routed through a subscription-backed proxy (e.g. Claude Code over GitHub
  Copilot); the full API-rate cost is reported as subscription-covered so the
  dashboard shows net out-of-pocket, leaving actual cost untouched. (#417, #459)
- **Local-model cost savings reports.** New `codeburn model-savings` command
  maps a local-model name (e.g. `llama3.1:8b`) to a paid baseline (e.g.
  `gpt-4o`) so the dashboard can report the counterfactual spend the same
  tokens would have incurred on the baseline. The local call still costs
  $0; the new `savingsUSD` field tracks the avoided spend separately from
  `costUSD` everywhere a number is shown (dashboard, JSON/CSV exports,
  menubar payload, macOS menubar, GNOME extension, daily cache rollups).
  Historical savings are recomputed automatically when the baseline
  mapping changes (config-hash invalidation on the daily cache). Daily
  cache schema bumped to v8. (#421)
- CNY currency support. (#430)
- Contribution heatmap insight. (#437)

### Added (CLI)
- **Hermes Agent provider.** Track token usage, cost, and tool breakdowns
  for Hermes Agent sessions. Reads from `~/.hermes/state.db` and per-profile
  databases. Supports session-level accounting with actual/estimated costs
  from Hermes, falling back to CodeBurn's model pricing table. Supersedes
  #386, closes #368.

### Fixed (CLI)
- **Per-file parse isolation.** A single malformed session file no longer
  aborts the run or empties the daily-history trend; parse failures are cached
  so broken files are not re-read every run. (#441, #450, #453)
- **Codex fork dedupe** is content-addressed, fixing undercounting of
  divergent events. (#458)
- **Model-name matching on the version boundary** so e.g. `claude-opus-4-6`
  and `claude-opus-4-8` no longer collapse to the same tier. (#417)
- Vercel AI Gateway data now flows through aggregation instead of reporting $0;
  Fable 5 and Mythos 5 price correctly ($10/$50). (#432, #466)
- Cache-read tokens are no longer double-counted in the models report. (#447)
- Critical-path fetches (pricing, currency) now time out so a stalled network
  cannot wedge the CLI or menubar. (#445, #448)
- Cursor lookback is period-aligned with a 6-month floor. (#432)
- **Antigravity hook stale path repair.** `codeburn antigravity-hook install`
  now installs the statusLine command through a persistent `codeburn` binary
  from PATH and repairs older CodeBurn-owned hooks that pointed at stale local
  build artifacts, preventing `agy` from auto-disabling capture after
  `MODULE_NOT_FOUND` failures.

### Added (macOS menubar)
- App icon. (#455)
- Configure `CLAUDE_CONFIG_DIRS` from Settings. (#434, #436)

### Fixed (macOS menubar)
- **Refresh reliability.** The app awaits the CLI's exit via its termination
  handler instead of blocking a queue thread, and caps concurrent CLI spawns —
  fixing the menubar wedging on "Loading…" after a long idle. (#462)
- Recover from stuck loading when an in-flight refresh is orphaned across
  sleep/wake. (#412)
- Use the correct currency enum in the Settings picker. (#435)

## 0.9.11 - 2026-05-27

### Added (CLI)
- **MCP project profile advisor.** `codeburn optimize` now flags MCP servers
  that are useful in one project but loaded into other projects where they are
  never invoked, with a project-scoping prompt that preserves the hot workflow
  while reducing cold-project schema overhead. Thanks @ozymandiashh. (#356)
- **MCP and skill reliability report.** `codeburn optimize` now detects MCP
  servers and skills whose edit turns are disproportionately retry-heavy,
  using turn-level MCP/Skill call evidence and a shared-turn token estimate so
  one retry-heavy turn is not double-counted across multiple capabilities.
  Thanks @ozymandiashh. (#357)
- **VSCodium storage discovery.** Copilot, Roo Code, and KiloCode now scan
  VSCodium and VS Code Insiders storage roots in addition to VS Code, so
  usage from VSCodium is included automatically. Thanks @ozymandiashh. (#233)
- **Tooling breakdowns in dashboard and menubar.** New panels showing core
  tools, MCP servers, and shell command usage per session and across periods.
- **File-aware retry detection with typed ToolCall.** One-shot rate now tracks
  which file was edited, so editing file A then file B after a shell step no
  longer counts as a retry. Claude and Codex extract file paths from tool
  inputs; Codex also parses `patch_apply_end` changes and JSON-encoded
  `function_call` arguments. Providers without file path data fall back to
  tool-name-based detection.

### Fixed (CLI)
- **Codex 100% one-shot rate.** Codex function_call arguments are JSON strings,
  not objects, and `patch_apply_end` stores file paths in `changes` object keys.
  Both are now parsed correctly.
- **Claude toolSequence missing from session cache.** `apiCallToCachedCall` was
  not forwarding the `toolSequence` field, so all cached Claude sessions lost
  their tool ordering data.
- **Forge dedup key instability.** The fallback deduplication key used the raw
  message array index, which shifts when messages are deleted between scans.
  Now uses a composite of model name and token counts. Also fixed a variable
  reference before its declaration that would crash at runtime when no tool
  call ID was present.
- **Session cache rejected `subagentTypes` field.** The cache validator did not
  recognize the `subagentTypes` array, causing entries with this field to be
  silently dropped and reparsed on every run.
- **Conflicting date flags on `status` accepted silently.** Passing `--day`
  with `--from`/`--to`, or `--days` with any other date flag, produced
  undefined behavior. Now exits with a clear error message.

### Changed (CLI)
- **OpenCode provider uses shared SQLite parser.** Delegates to
  `sqlite-session-parser.ts` (same module KiloCode uses), reducing the
  provider from 498 to 66 lines with no behavior change.

### Added (macOS menubar)
- **Configurable menubar status period.** The menubar dropdown now lets you
  choose which period (Today, 7 Days, Month, All Time) is shown in the status
  bar. Persisted via UserDefaults. Thanks @ozymandiashh. (#302)

### Fixed (macOS menubar)
- **Loading watchdog killed healthy CLI fetches.** The recovery loop ran every
  8 seconds with no backoff. Each attempt reset the generation counter,
  discarding in-flight CLI responses (45s timeout) before they could finish.
  Replaced with exponential backoff (8s to 60s, 6 attempts max) that skips
  recovery when a fetch is already in flight. Shows an error overlay with a
  Retry button after all attempts are exhausted.
- **Multi-day cache key mismatch.** `selectedDay` returned the earliest date
  instead of nil when multiple days were selected, and
  `startInteractiveSelectionRefresh` did not pass the day set to the cache key
  constructor. Both now match `PayloadCacheKey` normalization rules.
- **Dead code cleanup.** Removed `RefreshBackoff.swift`, its test file, and a
  broken test that called methods deleted in #393.

## 0.9.10 - 2026-05-20

### Added (CLI)
- **Agent and subagent tracking coverage across providers.** Gemini sessions
  now emit one provider call per assistant message with token usage instead of
  one aggregate call per session, preserving per-message tools, bash commands,
  timestamps, and nearest user prompts. Existing cached aggregate Gemini
  entries are reparsed so the new per-message shape takes effect, and per-tool
  counts may increase because repeated tools are now attributed to the specific
  Gemini message that used them. Claude discovery also scans direct
  project-level `subagents/*.jsonl` files, and Codex agent tool normalization
  is covered by regression tests. Addresses #336. Thanks @ozymandiashh. (#340)
- **Optimize tab with retry tax, routing waste, and token display modes.** New
  `codeburn optimize` surface in the dashboard and menubar, with daily budget
  alerts and project drill-down. (#349)

### Fixed (CLI)
- **OpenCode child sessions are attributed to their root session.** The
  OpenCode parser now walks the unarchived `session.parent_id` subtree so
  child and grandchild agent sessions contribute token and tool usage under
  the discovered root session while still excluding child sessions from
  top-level discovery to avoid double counting. Thanks @ozymandiashh. (#343)
- **OpenCode router sessions with missing usage are still reported.**
  Some OpenCode router/provider combinations can persist assistant messages
  with text or tool activity but zero token and cost fields. The OpenCode
  parser now keeps those turns as zero-cost calls instead of dropping the
  session entirely. Closes #341. Thanks @ozymandiashh. (#342)
- **OpenCode and Goose sessions on fresh installs.** Both providers returned
  zero sessions on first run when their on-disk directories did not yet exist.
  Discovery now treats missing directories as empty instead of erroring out.
  (#347)
- **One-shot rate detection for all non-Claude providers.** Retry detection
  now sees multi-message flows correctly across providers, not only Claude.
  Follow-up to the v0.9.9 fix. (#355)
- **Cursor `#cursor-ws=` compound-path separator in `fingerprintFile`.**
  `session-cache.ts` only handled the OpenCode `:` separator, so Cursor's
  workspace-aware paths could fall back incorrectly. The fingerprint now
  strips both `#` and `:` compound suffixes. Thanks @renerichter. (#358)
- **Per-provider multi-day data loss, division-by-zero, and decode
  fragility.** Switching to Claude/Codex tab on 7-day/30-day/month periods
  previously only showed today's categories, models, sessions, and tokens
  because the cache shortcut only merged cost/calls. Per-provider periods now
  always do a full parse. Also floors `maxCost` at 0.01 to avoid NaN bar
  widths in ActivitySection and ModelsSection. (#362)
- **Kiro post-February 2026 storage discovery.** The Kiro provider now keeps
  legacy `.chat` support while also discovering extensionless session index
  files and nested execution files. Modern execution JSON is parsed for
  identifiers, timestamps, model IDs, conversation text, structured tools, and
  estimated token usage. Thanks @ozymandiashh. Closes #329. (#339)

### Fixed (macOS menubar)
- **Per-provider refresh latency.** Switching provider tabs took ~24s on heavy
  histories. Now ~2s via session cache safety and reuse. (#344)

## 0.9.9 - 2026-05-15

### Added (CLI)
- **IBM Bob provider.** Discovers IBM Bob IDE task history, reuses the
  Cline-family parser for token/cost records, extracts model tags and
  workspace-based project names from session data. Closes #248.

### Fixed (CLI)
- **One-shot rate detection for non-Claude providers.** Gemini and Mistral Vibe
  now emit per-assistant-message calls grouped by user turn, so retry detection
  sees multi-message `Edit -> Bash -> Edit` flows instead of counting each
  message as an independent one-shot turn. Kiro and Goose record per-message
  tool ordering via `toolSequence` for the same effect on aggregated sessions.
  Vibe prefers `meta.json.stats.session_cost` over price-derived estimates when
  available. Session cache bumped to v2. Closes #351.
- **Reduced Claude parser OOM risk.** Large Claude JSONL sessions retained
  full entry objects (text, thinking blocks, tool results) in memory during
  parsing, causing V8 heap exhaustion on heavy usage months. Entries are now
  compacted immediately after JSON.parse, keeping only the fields needed for
  cost/token aggregation. This is a mitigation - very heavy users may still
  need the streaming parser refactor planned next.
- **Eager daily-cache hydration caused OOM on most CLI commands.** Eight
  commands (report, today, month, export, optimize, compare, models, yield)
  called `hydrateCache()` which parses a 365-day backfill, even though only
  `status --format menubar-json` consumes the daily cache. Removed from all
  paths that parse their own date ranges via `parseAllSessions`.
- **Session cache retained between status parses.** The `status --format json`
  path parsed today and month ranges without clearing the in-process session
  cache between them, keeping both result sets pinned. Cache is now cleared
  after each period is consumed.
- **Claude 1-hour cache write pricing.** 1-hour cache writes are now priced
  at 2x base input (previously used the 5-minute 1.25x rate for all writes).
  Daily cache bumped to v6 so stale totals are recomputed. Closes #276.
- **OpenCode MCP usage now counted.** OpenCode stores MCP tool calls as
  `<server>_<tool>` names, which the shared MCP pipeline did not recognize.
  The provider now normalizes these to the canonical `mcp__<server>__<tool>`
  form so MCP breakdowns and `optimize` work correctly. Closes #308.
- **Antigravity Windows language-server discovery.** Antigravity detection now
  supports Windows process discovery, `--extension_server_port`,
  `--extension_server_csrf_token`, `--flag=value` syntax, and both wrapped and
  unwrapped Connect-RPC response shapes. Closes #249.
- **Mangled project names in dashboard.** The By Project and Top Sessions
  panels decoded slugs by splitting on `-`, which broke directory names
  containing dashes or dots (e.g. `my-project` rendered as `my/project`).
  Now uses the real project path instead. Closes #320.
- **Cursor undated bubble rows misattributed to Today.** Bubble rows without
  a `createdAt` timestamp were defaulting to the current date, inflating
  Today's spend. Now skipped at both the SQL and application level.
- **Node version guard.** Running on Node < 22.13.0 now prints a clear
  upgrade message instead of crashing with a cryptic `node:sqlite` parse
  error. Closes #319.

### Fixed (macOS menubar)
- **All-provider refresh OOM.** Refreshing with provider set to "All" could
  exhaust the V8 heap on accounts with heavy session history.
- **Tab refresh recovery.** Switching tabs during a refresh no longer leaves
  the panel in a stale loading state.
- **Stale cache recovery.** The menubar now detects and discards a corrupt or
  outdated on-disk cache instead of rendering zeroes until the next restart.
- **Refresh timer hardening.** The 30-second auto-refresh timer is now
  cancelled on sleep/wake and restarted cleanly, preventing overlapping
  refreshes after lid-open.
- **Version display.** The settings panel now shows the version without the
  `v` prefix for consistency with `codeburn --version`.

## 0.9.8 - 2026-05-10

### Added (CLI)
- **Cline provider support.** CodeBurn now reads Cline task usage from both
  VS Code globalStorage (`saoudrizwan.claude-dev`) and Cline's
  `~/.cline/data` task root. It reuses the existing Cline-family parser for
  `ui_messages.json` usage entries, deduplicates migrated tasks by the newest
  `ui_messages.json`, and exposes Cline in CLI provider filters, docs, and the
  macOS menubar provider tabs. Closes #130.
- **Multiple Claude config directories.** Set `CLAUDE_CONFIG_DIRS` to an
  OS-delimited list of paths (`:`-separated on POSIX, `;`-separated on
  Windows) to scan more than one Claude data directory in a single run.
  Sessions across every configured directory roll up into one project row
  per project, so a user with `~/.claude-work` and `~/.claude-personal`
  who works on the same repo from both accounts sees one combined row
  rather than two split rows. `~` is expanded; missing or unreadable
  directories in the list are skipped instead of aborting the scan; if
  every listed entry is unreadable a one-line hint is written to stderr
  so a misplaced delimiter does not silently produce zero rows.
  Precedence: `CLAUDE_CONFIG_DIRS` > `CLAUDE_CONFIG_DIR` > `~/.claude`.
  As part of this change `~` and `~/foo` are now also expanded in
  `CLAUDE_CONFIG_DIR` (previously the value was passed through verbatim,
  which only worked when the shell expanded `~` before exporting).
  Closes #208.
- **`codeburn models` command.** Per-model breakdown across all providers,
  one row per (provider, model), sorted by cost. Each row carries Input,
  Output, Cache Write, Cache Read, Total, and Cost columns plus a Top Task
  cell showing the dominant task category and its cost share (e.g.
  `Coding (42%)`). Pass `--by-task` to explode each model into one row per
  task type, with provider/model cells blanked on subsequent rows of the
  same group and a horizontal divider between groups. Filters: `--period`
  (default `30days`), `--from/--to`, `--provider`, `--task`, `--top`,
  `--min-cost`, `--no-totals`. Output formats: `table` (Unicode box-drawn,
  default), `markdown` (GitHub-flavored, copy-paste friendly), `json`,
  `csv`. The table renderer auto-sizes every column to its content and
  drops cache columns first, then input/output, then top-task when the
  terminal is too narrow to fit the full set. Headers are cyan, totals row
  is yellow, provider name is dim. Inspired by tokscale's per-model table
  and ccusage's responsive cli-table3 layout, ported to plain Node with
  no new runtime dependency.
- **Per-day one-shot data in `--format json`.** Each entry of `daily[]` now
  carries `turns`, `editTurns`, `oneShotTurns`, and `oneShotRate` (0-100,
  one decimal, `null` when no edit turns). Counts match the existing
  period-level `activities[]` rollup so a consumer can sum across days and
  reconcile. Closes #279.

### Fixed (CLI)
- **Cursor sessions break down by project, not one row called "cursor".**
  Cursor's chat history sat under a single dashboard row labeled `cursor`
  because the provider had no way to attribute bubbles to a workspace.
  The fix walks `~/Library/Application Support/Cursor/User/workspaceStorage/*`
  for each workspace's `workspace.json` (folder URI) and
  `composer.composerData` (the composer ids opened in that workspace),
  then joins those composer ids against the global bubbles. Each
  workspace becomes its own project row, sanitized into the same slug
  shape Claude uses (e.g. `-Users-you-myproject`); composers that have
  no workspace mapping (multi-root workspaces, "no folder open"
  sessions, deleted workspaces) remain under a catch-all `cursor` row.
  As part of this the cursor parser now derives `sessionId` from the
  bubble row key (`bubbleId:<composerId>:<bubbleUuid>`) instead of the
  empty `conversationId` JSON field, which was always falling back to
  `'unknown'`. Cursor result cache version bumped to 3 to invalidate
  prior caches that recorded the old session id. Closes the per-project
  half of #196.
- **Cursor cost shown for every model, not just Auto.** Cursor emits model
  names in a `claude-<dot-version>-<tier>` shape (`claude-4.6-sonnet`,
  `claude-4.5-opus`, `claude-4.5-opus-high-thinking`, etc.) plus its own
  `composer-1` house model, none of which match the canonical LiteLLM
  pricing keys (`claude-sonnet-4-6`, `claude-opus-4-5`). The alias map in
  `src/models.ts` filled some of these in v0.9.4 but missed the plain
  no-suffix forms (`claude-4.5-opus`, `claude-4.5-sonnet`,
  `claude-4.6-opus`), the haiku tier, the forward-looking 4.7 variant,
  and `composer-1`. The dashboard rendered $0 for sessions that used any
  unaliased model. Visible to users in #159 even after the v0.9.4 fix.
  Every Cursor variant in `src/providers/cursor.ts:modelDisplayNames`
  now has an alias and a regression test asserting non-zero pricing
  resolution. Closes #159.
- **Activity classifier no longer mislabels feature work as debugging.**
  Messages like "add error handling", "create an issue tracker", or
  "implement the 404 page" used to land in the Debugging bucket because
  the classifier checked the debug-keyword regex (which matches `error`,
  `issue`, `404`) before the feature regex. Now the keyword that appears
  earliest in the user message wins, so "add" beats "error", "create"
  beats "issue", etc. A real bug report ("login is broken, traceback
  below") still classifies as debugging because the debug word leads.
  Fixes the activity-misattribution half of #196.

### Changed (CLI)
- **`optimize` suggestions now declare their destination.** Every paste-style
  fix carries an explicit destination — `claude-md` (permanent project rule),
  `session-opener` (one-time paste at the start of a future session),
  `prompt` (one-time ask in the current chat), or `shell-config` (append to
  `~/.zshrc` / `~/.bashrc`). Output renders a clearly-labeled section header
  per destination so users no longer accidentally bake one-time session
  openers into their CLAUDE.md as permanent rules. Closes #277.

## 0.9.7 - 2026-05-07

### Added (CLI)
- **MCP tool coverage detector.** New `optimize` finding flags MCP servers
  whose tool inventory is largely unused. Inventory is observed from the
  Claude `deferred_tools_delta` JSONL attachments (exact tool names per
  session) instead of guessed at five tools per server. Token-savings
  estimates are cache-aware: schema bytes pay full input price on the first
  cache-creation turn of a session, then carry at the cache-read discount
  on subsequent turns, capped per call so we never claim more overhead
  than the call's own cache buckets could contain. Threshold:
  >10 tools available, <20% coverage, observed in ≥2 sessions. Closes #2.
- **Session cost outlier detector.** New `optimize` finding flags sessions costing more than 2x their peer-session average within the same project. Ignores sub-$1 outliers to avoid noise. Requires at least 3 sessions per project for a baseline.
- **Context bloat detector.** New `optimize` finding flags sessions where
  effective input/cache tokens are large and disproportionate to output.
  Cache reads are discounted in the estimate to avoid overstating cheap cached
  context. The report highlights top sessions by imbalance, notes sharp
  growth from the previous project session (within a 7-day baseline window),
  and suggests starting fresh with only the current goal, relevant files,
  failing output, and constraints. Sessions flagged here are excluded from
  the cost-outlier finding so the same session is not listed twice.
- **Worth-it score detector.** New `optimize` finding flags expensive sessions
  with weak delivery signals: no edit turns, repeated retries, or edit work
  that never landed in one shot, when no `git`/`gh` delivery command is
  observed. Framed as a conservative review candidate, not proof of waste.
  Sessions flagged here take priority and are excluded from both the
  context-bloat and cost-outlier findings so the same session is not listed
  more than once.
- **Per-model efficiency metrics.** JSON report includes edit turns, one-shot rate, retries per edit, and cost per edit for each model.
- **Custom date range export.** `codeburn export --from --to` exports a single custom period.
- **Live Claude quota bar.** Menubar shows real-time quota usage inside the agent tab strip with OAuth refresh gate.

### Fixed (CLI)
- **Invalid `--format` silently accepted.** All commands now reject unknown format values with a clear error and exit 1 instead of silently falling back to the default.
- **Invalid `--period` silently accepted.** `getDateRange()` no longer falls back to "week" on unknown periods. All period-accepting commands reject invalid values.
- **`status` help text.** Description said "today + week + month" but only today and month were shown. Fixed to match actual output.
- **Windows Claude project paths.** Claude Code project rollups now prefer
  the canonical `cwd` stored in session JSONL files instead of reconstructing
  paths from lossy directory slugs, and group case/slash variants together.
  Closes #217.
- **`all` period semantics unified between CLI and dashboard.** The dashboard treated `--period all` as all-time (epoch start) while the CLI bounded it to the last 6 months. Both now consistently mean "Last 6 months". Period helpers (`Period`, `PERIODS`, `PERIOD_LABELS`, `toPeriod`, `getDateRange`) consolidated into `cli-date.ts`. Use `--from` / `--to` for unbounded historical ranges.
- **Popover anchor, tab strip flicker, and stale-data refresh.** Batch of UI regressions from the menubar hardening round.
- **Validator hardenings.** Batch of edge-case fixes from the multi-agent bug hunt.
- **Command injection in yield.** `yield` now uses `execFileSync` instead of `execSync` to prevent shell injection via crafted branch names.
- **SHA-256 checksum verification.** Menubar installer verifies download integrity before replacing the running app.

### Fixed (macOS menubar)
- **Stuck loading spinner.** The menubar ran `--optimize` on every 30-second background refresh. As sessions accumulated, optimize exceeded the 45-second timeout, and the loading overlay stayed forever with no fallback. Optimize is now stripped from all menubar fetches (use `codeburn optimize` in the CLI instead). On fetch failure with empty cache, the app retries without optimize so the spinner always clears.
- **Stale data after overnight sleep.** Cache keys used the period enum (`.today`) not a calendar date, so data from yesterday persisted after midnight. Cache now tracks the current date and clears itself on day rollover. Wake-from-sleep additionally clears all cached entries before fetching fresh data.
- **Refresh button appeared to do nothing.** Clicking refresh with stale cached data never showed the loading overlay because loading state only triggered on empty cache. Manual refresh and wake-from-sleep now explicitly request loading feedback.
- **Update button stuck spinning forever.** `performUpdate()` only reset `isUpdating` on failure. On success the installer kills and relaunches the app, but if the process survives (pkill fails silently), the button stayed on "Updating..." permanently. Now always resets on termination and clears the update badge on success.

## 0.9.6 - 2026-05-03

### Added (CLI)
- **Goose provider.** New provider for Block's Goose AI coding assistant.
- **Antigravity provider.** New provider for Antigravity IDE sessions.
- **Antigravity model aliases.** gemini-3-pro, flash-image, flash-lite, and community-contributed Gemini model IDs.
- **GPT-5.5 display name** for Codex.
- **Deno support.** `deno dx` added as a run method.

### Fixed (CLI)
- **Streaming dedup.** Claude Code streams each `message.id` multiple times (start, intermediate, stop). The old keep-first strategy lost tool_use blocks and understated output tokens by ~6.3%. Now keeps last occurrence content with first occurrence timestamp for correct date bucketing.
- **`$0.0000` display.** Near-zero costs showed four decimal places instead of `$0.00`. Fixes #205.
- **ANSI escape stripping.** Shell commands containing ANSI color codes now cleaned across all providers.
- **Antigravity dedup collision.** Fixed key collision in session dedup. Added Codex ChatGPT Plus token estimation.
- **Codex large session validation.** Reads full first line for session meta validation; caps read size and handles torn writes.
- **Codex fork dedup.** Deduplicates forked Codex sessions to avoid double-counting.
- **Windows dashboard hang.** Fixed `ExperimentalWarning` and dashboard freeze on Windows.
- **Hardcoded `$` in forecast.** Forecast comparison text now uses the configured currency symbol.

### Fixed (macOS menubar)
- **Provider tabs showing $0.00 after idle.** CLI timeout increased from 20s to 45s for cold file-cache latency. Loading overlay now appears when the all-provider payload confirms a provider has spend but its dedicated data hasn't loaded yet.
- **Refresh button blocked by in-flight requests.** Manual refresh now bypasses the in-flight guard so users can always re-fetch.
- **Tab strip vs hero cost mismatch.** Tab strip prefers the provider-specific payload cost when available, staying in sync with the hero section.
- **Ghost status item on macOS Tahoe.**

## 0.9.5 - 2026-05-01

### Added (CLI)
- **Homebrew.** `brew install codeburn` (originally via tap, now in homebrew-core).
- **GPT-5.3 and DeepSeek display names.** GPT-5.3, DeepSeek Coder, DeepSeek Coder Max, DeepSeek R1.

### Fixed (macOS menubar)
- **Menubar refresh loop.** Was a single-fire Task that never repeated; now a proper while loop with 30s interval and `force: true`.
- **Loading overlay flicker.** Counter-based `isLoading` so concurrent fetches don't toggle the overlay.
- **Rapid tab switching race.** Previous fetch is cancelled when switching tabs; stale results are discarded via `Task.isCancelled`.
- **Tab strip vs hero cost desync.** Provider-specific and all-provider data now fetched in parallel so costs arrive from the same snapshot.
- **Stale menubar icon after wake.** `forceRefresh` now fetches today/all in parallel alongside the current selection.
- **Accent color propagation.** `ThemeState` is now `@Observable`; removes `.id()` view hierarchy teardown hack.
- **Currency flash on first switch.** Symbol and rate now apply atomically — no more wrong-symbol-with-old-rate flash.
- **Export UI freeze.** Uses `terminationHandler` instead of `waitUntilExit`; HHmmss in filename prevents overwrite on double-export.
- **CurrencyState concurrency.** Proper `@MainActor` isolation with `Sendable` conformance; `nonisolated` on pure static functions.
- **Streak count.** Iterates calendar days instead of sparse history entries so gaps correctly break streaks.
- **TrendBar chart flicker.** Stable date-based identity instead of UUID.

## 0.9.4 - 2026-04-29

### Added (CLI)
- **OpenClaw provider.** Parses JSONL agent logs from `~/.openclaw/agents/` with legacy path support (`.clawdbot`, `.moltbot`, `.moldbot`). Token usage from assistant message `usage` blocks.
- **Roo Code provider.** Reads Cline-family `ui_messages.json` from VS Code `globalStorage/rooveterinaryinc.roo-cline/tasks/`.
- **KiloCode provider.** Reads Cline-family `ui_messages.json` from VS Code `globalStorage/kilocode.kilo-code/tasks/`.
- **Qwen CLI provider.** Parses JSONL sessions from `~/.qwen/projects/<project>/chats/`.
- **Droid provider.** Parses sessions from `~/.factory/projects/`.
- **Durable daily cache.** Cache hydration extracted into shared `ensureCacheHydrated()` called by all commands. Schema migration fills missing fields instead of nuking the cache. Old cache versions backed up before reset. Atomic file writes with fsync.
- **Copilot auto-model buckets.** Transcript inference uses auto-model naming for cleaner dashboard display.
- **Cursor model aliases.** Built-in aliases for Cursor proxy model names.

### Fixed (CLI)
- **Gemini provider updated for JSONL format.** Supports Gemini CLI 0.39+ which switched from JSON to JSONL.
- **Duplicate `hydrateCache()` call in JSON reports.** Removed redundant cache hydration inside `runJsonReport()`.

### Changed (CLI)
- Daily cache version bumped to v4 with backward-compatible migration (v2+ supported).
- LiteLLM pricing snapshot replaces hardcoded pricing for Qwen and new models.
- 16 providers now supported (was 10).

### Added (macOS menubar)
- **OpenClaw, Roo Code, KiloCode, Qwen, Droid tabs.** Agent tab strip updated for all new providers.
- **Instant cached data display.** Shows cached data immediately instead of blocking on CLI refresh.

### Fixed (macOS menubar)
- **Menubar stops updating after first load.** Background refresh was silently skipped by the cache TTL guard. Data loaded once, then froze. Fixes #179.
- **Menubar not dimming on inactive screens.**
- **Performance improvements.** Reduced unnecessary redraws and CLI invocations.

### Added (macOS menubar)
- **Right-click context menu.** Right-click the status bar icon for "Check for Updates" and "Quit CodeBurn".
- **Version label in footer.**

### Changed
- README restructured with honeycomb provider hero image, 2x2 screenshot grid, and complete inline reference.
- `bunx codeburn` added as alternative install option.

## 0.9.3 - 2026-04-28

### Added (CLI)
- **Gemini CLI provider.** Parses `~/.gemini/tmp/<project>/chats/session-*.json` from Gemini CLI 0.38+. Uses real embedded token counts (input, output, cached, thoughts) with correct cached/fresh separation to avoid double-charging. Pricing for gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash. Tool normalization (ReadFile->Read, SearchText->Grep, Shell->Bash). Closes #166.
- **Kiro provider.** Parses `.chat` JSON session files with token estimation and auto-model naming (`kiro-auto`). Costed at Sonnet 4.5 rates via `BUILTIN_ALIASES`.
- **Copilot VS Code workspace transcripts.** Copilot now reads transcripts from VS Code's `workspaceStorage/*/GitHub.copilot-chat/transcripts/` in addition to the legacy `~/.copilot/session-state/` path. Tokens estimated from content length, model inferred from tool call ID prefixes. Fixes #161.
- **Auto-model naming.** Cursor, Copilot, and Kiro store transparent model names (`cursor-auto`, `copilot-auto`, `kiro-auto`) instead of guessing the underlying model.

### Fixed (CLI)
- **Cursor provider dropped all data older than 35 days.** Hardcoded lookback silently excluded bubbles outside a 5-week window, making `--period all` return $0. Increased to 180 days. Fixes #159, fixes #163.
- **Cursor-agent subagent transcript discovery.** Scans `subagents/` subdirectories.

### Added (macOS menubar)
- **Gemini, Kiro, Copilot, OMP tabs.** Agent tab strip now shows all detected providers. Cursor + Cursor Agent merged into a single Cursor tab.
- **Accent color picker.** 9 Apple-style system presets in the menubar header, persisted via UserDefaults.
- **Tab costs match selected period.** Provider tab costs now reflect the active period (Today/7 Days/30 Days/etc.) instead of always showing today.

### Changed
- Daily cache version bumped to v4 (forces recompute with auto-model naming).
- Cursor cache versioned to invalidate stale model names.
- Case-insensitive provider key matching for tab cost lookups.

## 0.9.2 - 2026-04-28

### Fixed
- **Cursor provider reported $0 on newer Cursor versions.** Cursor v3 stores zero token counts in bubbles. Now estimates tokens from text length when counts are zero. Fixes #159.
- **Cursor provider dropped rows with NULL `createdAt`.** The SQL filter silently excluded bubbles without a timestamp. Now includes them with a fallback timestamp. Fixes #163.
- **AgentKv entries with plain string content were skipped.** Not all agentKv content is a JSON array; plain strings are now counted toward usage.
- **Subagent transcripts were not discovered.** Transcripts inside `subagents/` subdirectories are now picked up by the cursor-agent provider.

## 0.9.1 - 2026-04-25

### Added
- **`codeburn yield` command.** Correlates AI sessions with git history to categorize spend by outcome: **productive** (code shipped to main), **reverted** (commits later undone), or **abandoned** (work that never committed). Shows percentage breakdown so you know not just what you spent, but what happened to it. Accepts `--today`, `--week`, `--month` flags.

## 0.9.0 - 2026-04-24

### Added (CLI)
- **Claude Max 5x plan preset.** `codeburn plan claude-max-5x` sets a $100/month budget for heavy Claude Code users.

### Fixed (CLI)
- **Cursor provider failed on newer versions.** Cursor 0.50+ stores session data in `agentKv:blob:*` entries instead of `bubbleId:*`. Added fallback parser that extracts usage from the new format.
- **Cursor-agent provider missed Composer 2 sessions.** Composer 2 stores transcripts in `agent-transcripts/<UUID>/<UUID>.jsonl` subdirectories instead of `.txt` files. Now scans both formats. Fixes #142.
- **Codex showed wrong model names.** Model info is now extracted from `turn_context` entries, showing exact names like "GPT-5.4" instead of generic "GPT-5".
- **Codex edit detection showed 0 edit turns.** Codex records file modifications as `patch_apply_end` events, not tool calls. Now tracks these events to enable one-shot rate and retry metrics.
- **Compare chart bar colors didn't match legend.** Non-winning model bars were grayed out despite the legend showing both colors. Bars now always display their assigned colors.

### Fixed (macOS menubar)
- **Menubar icon invisible on macOS Tahoe (26.x).** Status item failed to render on macOS 26.4+ due to window server registration timing. Fixed by starting as regular app, activating, then switching to accessory mode after setup. Fixes #146.
- **High CPU usage (~14%).** Removed duplicate refresh timer, increased LaunchAgent interval to 30s, added 5-second debounce on wake events.

## 0.8.9 - 2026-04-22

### Fixed
- **Menubar showed stale prices.** The "all providers" query used `end: now` while per-provider queries used `end: endOfDay`, causing sessions timestamped after the capture moment to be excluded from totals. Now uses `periodInfo.range` consistently across all queries.

### Changed (macOS menubar)
- **Variable-width status item is now the default.** The menubar pill hugs the rendered text in both compact and default modes instead of reserving a fixed 130pt slot.

## 0.8.8 - 2026-04-22

### Fixed (CLI)
- **OOM crash on large session files.** `scanJsonlFile` and `parseSessionFile` loaded entire files into memory via `readViaStream` (which defeated its own streaming by joining all lines back into one string). Switched both to the existing `readSessionLines` async generator that yields one line at a time. Contributed by @maucher (#132).

### Added (macOS menubar)
- **Compact mode.** Opt-in tighter menubar display: no decimals, variable width that hugs the text. Enable with `defaults write CodeBurnMenubar CodeBurnMenubarCompact -bool true`. Default off.

### Fixed (macOS menubar, shipped alongside via mac-v0.8.8)
- **Plan tab never loaded on Claude Code 2.1.x.** Keychain credential lookup filtered on `kSecAttrAccount == "default"`, but Claude Code writes the macOS login username. Removed the hardcoded allowlist; the service name is sufficient to scope the query.
- **Four keychain prompts on debug builds.** Collapsed two-phase keychain enumeration into a single `SecItemCopyMatching` call.
- **App Nap override not sticking.** The `beginActivity` token was immediately overridden by AppKit. Now disables `automaticTerminationSupport` and `suddenTermination` at the process level.

## 0.8.7 - 2026-04-21

### Added
- **MiniMax-M2.7 and MiniMax-M2.7-highspeed pricing.** Added to `FALLBACK_PRICING` plus display names so MiniMax sessions show up with the right cost and readable labels when users route MiniMax through providers like OpenCode. Rates verified against MiniMax's live paygo pricing: base model $0.3/M input, $1.2/M output; highspeed $0.6/M input, $2.4/M output; cache read $0.06/M, cache write $0.375/M on both.
- **OMP provider (Oh My Pi).** Auto-discovers sessions at `~/.omp/agent/sessions/*.jsonl` and tracks them alongside Pi. Shares Pi's JSONL parser via a `providerName` parameter, so OMP rows keep their own `omp:` dedup prefix and never cross-dedupe with Pi on a shared `conversationId` namespace. `codeburn report --provider omp` filters to OMP only; the default combined view includes both. Contributed by @cgrossde (#59).
- **`codeburn model-alias` command.** Maps any provider-emitted model name to a canonical pricing name so cost rows no longer read `$0.00` when a proxy rewrites names. Aliases persist in `~/.config/codeburn/config.json` under `modelAliases`. Usage: `codeburn model-alias <from> <to>` to set, `--list` to view, `--remove <from>` to clear. User aliases resolve before the built-in list. Contributed by @cgrossde (#59).
- **Built-in aliases for Anthropic-compatible proxy format.** `anthropic--claude-4.6-opus`, `anthropic--claude-4.6-sonnet`, `anthropic--claude-4.5-opus`, `anthropic--claude-4.5-sonnet`, and `anthropic--claude-4.5-haiku` now resolve to canonical Claude names and price correctly with no user configuration. `getCanonicalName` also strips `provider/` prefixes before alias resolution so double-wrapped forms like `anthropic/anthropic--claude-4.6-opus` work the same way. Contributed by @cgrossde (#59).

### Fixed (CLI)
- **Prototype pollution in alias resolution.** A model literally named `__proto__` leaked `Object.prototype` through the `??` fallback chain in `resolveAlias`, which then crashed `canonical.startsWith` downstream. The resolver now uses `Object.hasOwn` checks for both user and built-in alias maps. Caught by the existing prototype-pollution test suite during the #59 merge.

### Fixed (macOS menubar, shipped alongside via mac-v0.8.7)
- **Menubar label froze in the background and only refreshed when you clicked the icon.** Three independent causes fixed:
  - `prefetchAll` on launch spawned four concurrent `codeburn` subprocesses that competed with the main refresh loop for disk and parser time. Removed; period tabs now fetch lazily on first click.
  - `NSStatusItem` sometimes deferred the status bar paint for an accessory app, so `attributedTitle` updates hit memory but not the screen until the popover opened. Explicit `needsDisplay` + `display()` after each update forces the paint.
  - **The real root cause:** macOS App Nap / Automatic Termination was suspending the app whenever the icon sat idle in the background, stretching the 15-second refresh Task's sleep indefinitely. Holding a `ProcessInfo.beginActivity` token for the life of the app opts out. Confirmed via `log show`: `_kLSApplicationWouldBeTerminatedByTALKey` now stays at 0.
- Subprocess `QualityOfService` lifted to `.userInitiated` so `codeburn` runs at terminal speed when spawned from the menubar.

### Skipped
- 0.8.6 was never published to npm. The version was briefly planned and then skipped to align CLI and macOS menubar versioning at 0.8.7.

### Notes
- If you are on 0.8.5 and do not use MiniMax, Oh My Pi, or a proxy that rewrites model names to the `anthropic--claude-X.Y-tier` format, CLI behavior is unchanged and you can safely stay on 0.8.5.
- macOS menubar users on `mac-v0.8.6` or earlier should update: the refresh loop only ticks reliably from `mac-v0.8.7` onward. The in-app update pill surfaces within 2 days, or quit and re-run `npx codeburn menubar` to pull immediately.

## 0.8.5 - 2026-04-21

### Fixed
- **Stale Today totals after 0.8.2.** The persistent source cache introduced in 0.8.2 caused Today's cost to under-report and sometimes drop between polls during active Claude Code sessions. The cache keyed entries on `(mtime, size)` fingerprints that diverged from Claude's append-mostly JSONL model, producing empty or partial entries that were served on subsequent polls. Reverted the cache rewrite to the v0.8.1 full-reparse path for Claude sessions. Both the menubar and `codeburn status` now return consistent, monotonically-increasing Today totals.
- **Menubar and terminal status disagreed on Today.** A turn that straddled midnight (user message in one day, response in the next) was bucketed by user timestamp in one code path and by assistant timestamp in another, producing different Today values in the two surfaces. Both paths now count a turn on the day its first assistant call ran.
- **Kept from 0.8.2-0.8.4:** subscription plan tracking, pricing accuracy and CSV injection hardening, cursor-agent provider, menubar prefetch and timezone alignment. Only the cache rewrite and its follow-up patches were reverted.

### Removed
- `--no-cache` flag on `report`, `today`, `month`, `status`, `export`, `optimize`, and `compare`. The flag existed to bypass the persistent source cache which no longer exists. If your scripts pass `--no-cache`, drop it; the parse runs fresh every time now.

### Notes
- 0.8.2, 0.8.3, and 0.8.4 on npm contain the buggy cache. Upgrade with `npm i -g codeburn@latest` or `npm i -g codeburn@0.8.5`.
- This release uses a full reparse on every invocation, matching v0.8.1 behavior. On large corpora (5,000+ session files) expect 3 to 10 seconds per invocation. An incremental refresh design that preserves correctness is planned for a follow-up release.

## 0.8.0 - 2026-04-19

### Added
- **`codeburn compare` command.** Side-by-side model comparison across any two models in your session data. Interactive model picker, period switching, and provider filtering.
- **Compare view in dashboard.** Press `c` in the TUI to enter compare mode. Arrow keys switch periods, `b` to return.
- **Performance metrics.** One-shot rate, retry rate, and self-correction detection per model. Self-corrections are detected by scanning JSONL transcripts for tool error followed by retry patterns.
- **Efficiency metrics.** Cost per call, cost per edit turn, output tokens per call, and cache hit rate.
- **Per-category one-shot rates.** Breaks down one-shot success by task category (Coding, Debugging, Feature Dev, etc.) for each model.
- **Working style comparison.** Delegation rate, planning rate (TaskCreate, TaskUpdate, TodoWrite), average tools per turn, and fast mode usage.
- **TUI auto-refresh enabled by default.** Dashboard now refreshes every 30 seconds out of the box. Pass `--refresh 0` to disable. Closes #107.
- **36 comparison tests.** Full coverage for metric computation, category breakdown, working style, self-correction scanning, and planning tool detection. Total suite: 274 tests.

### Fixed
- **Planning rate showed ~0% in model comparison.** Only counted `EnterPlanMode` (rarely used) instead of all planning tools (TaskCreate, TaskUpdate, TodoWrite, EnterPlanMode, ExitPlanMode). Now detects planning at the turn level across all five tool types.
- **Menubar "All" tab showed stale data.** Three-layer caching (300s in-memory TTL, daily disk cache, 60s parser cache) prevented tab switches from showing fresh numbers. Cache TTL reduced from 300s to 30s, tab switches always fetch fresh data, background refresh interval reduced from 60s to 15s.

## 0.7.4 - 2026-04-19

### Added
- **`codeburn report --from/--to`.** Filter sessions to an exact `YYYY-MM-DD` date range (local time). Either flag alone is valid: `--from` alone runs from the given date through end-of-today, `--to` alone runs from the earliest data through the given date. Inverted ranges or malformed dates exit with a clear error. In the TUI, pressing `1`-`5` still switches to the predefined periods. Credit: @lfl1337 (PR #80).
- **`avgCostPerSession` in reports.** JSON `projects[]` entries gain an `avgCostPerSession` field and `export -f csv` adds an `Avg/Session (USD)` column to `projects.csv`. Column order in `projects.csv` is now `Project, Cost, Avg/Session, Share, API Calls, Sessions` -- scripts parsing by column position should read by header instead. Credit: @lfl1337 (PR #80).
- **Menubar auto-update checker.** Background check every 2 days against GitHub Releases. When a newer menubar build is available, an "Update" pill appears in the popover header. One click downloads, replaces, and relaunches the app automatically.
- **Smart agent tab visibility.** The provider tab strip hides when fewer than two providers have spend, reducing clutter for single-tool users.

### Fixed
- **Stale daily cache caused wrong menubar costs.** The daily cache never recomputed yesterday once written, so a mid-day CLI run would freeze partial cost data permanently. The "All" provider view relied on this cache, showing wildly incorrect numbers while per-provider tabs (which parse fresh) were correct. Yesterday is now evicted and recomputed on every run.
- **UTC date bucketing instead of local timezone.** Timestamps in session files are UTC ISO strings. Several code paths extracted the date via `.slice(0, 10)` (UTC date) while date range filtering used local-time boundaries. Turns between UTC midnight and local midnight were attributed to the wrong day -- the menubar showed lower today cost than the TUI. All date bucketing now uses local time consistently.
- **OpenCode SQLite ESM loader.** `node:sqlite` is now loaded correctly in ESM runtime. Credit: @aaronflorey (PR #104).
- **Menubar trend tooltip per-provider views.** Tooltip now shows the correct cost when a specific provider tab is selected.
- **Menubar (today, all) cache freshness.** The cache entry powering the menubar title and tab labels is now kept fresh independently of the selected period/provider.
- **Agent tab strip restored.** All detected providers are shown again after a regression hid them.
- **Plan pane button cleanup.** Removed the broken "Connect Claude" button that opened a useless terminal session. The Plan pane now shows only a "Retry" button.

## 0.7.3 - 2026-04-18

### Changed
- **Dropped `better-sqlite3` in favor of Node's built-in `node:sqlite`.** Removes the deprecated `prebuild-install` transitive dependency that npm warned about on every install (issue #75, credit @primeminister). End-user install is now 40 packages down from 167 and shows zero deprecation notices. The experimental-SQLite warning Node 22/23 normally prints on module load is silenced for this specific warning; other warnings pass through unchanged.
- **Minimum Node version raised to 22.** Node 20 reached EOL on 2026-04-30; `node:sqlite` lives in 22+. Users on older Node get a clear upgrade message when a SQLite-backed provider (Cursor, OpenCode) is loaded.


## 0.7.2 - 2026-04-17

### Added
- **Native macOS menubar app.** Swift + SwiftUI app under `mac/` replaces the SwiftBar plugin. Agent tabs, Today/7/30/Month/All period switcher, Trend/Forecast/Pulse/Stats/Plan insights, activity and model breakdowns, optimize findings, CSV/JSON export, instant currency switching, live 60s refresh.
- **`codeburn menubar`.** One-command install: downloads the latest `.app` from GitHub Releases, strips Gatekeeper quarantine, drops it into `~/Applications`, and launches it. `--force` reinstalls in place.
- **`status --format menubar-json`.** Structured payload consumed by the native menubar app. Current-period totals, per-activity and per-model breakdowns, provider costs, optimize findings, and 365-day history.
- **Release workflow.** `.github/workflows/release-menubar.yml` builds a universal `.app` bundle and zip on `mac-v*` tag push.

### Changed
- **`codeburn export -f csv`** now writes a folder of one-table-per-file CSVs (`summary`, `daily`, `activity`, `models`, `projects`, `sessions`, `tools`, `shell-commands`) plus a `README.txt` index. Each file opens cleanly as a single table in any spreadsheet.
- **`codeburn export -f json`** upgraded to schema `codeburn.export.v2` with currency metadata.

### Fixed
- **`codeburn status` terminal Today/Month** now buckets by local date instead of UTC, so spend shows correctly during the window between local midnight and UTC midnight.
- **FX rate validation.** Frankfurter responses are checked to be finite and within `[0.0001, 1_000_000]` before they affect displayed costs.

### Removed
- **SwiftBar plugin.** `src/menubar.ts`, `codeburn install-menubar`, `codeburn uninstall-menubar`, and `status --format menubar` are gone. The native Swift app is the single menubar surface.

### Security
- **`codeburn export -o` guard.** Writes a `.codeburn-export` marker into every folder it creates and refuses to reuse non-marked directories or overwrite existing files, so a typo like `-o ~/.ssh/id_ed25519` cannot delete a sensitive file.

## 0.7.1 - 2026-04-17

### Security
- **External security audit closed.** 1 HIGH, 2 MEDIUM, and 1 LOW finding fixed. Threat model: a compromised third-party AI CLI with write access to `~/.claude/projects/` dropping malicious session JSONL.
- **Prototype pollution blocked.** Breakdown maps in `parser.ts` (model, tool, MCP, bash) now use `Object.create(null)` so attacker-controlled keys like `__proto__` create own properties instead of mutating `Object.prototype`. Credit: @lfl1337 (PR #67).
- **Bounded session-file reads.** New `src/fs-utils.ts` helper caps reads at 128 MB and switches to stream-based parsing above 8 MB. Applied to 13 reachable read sites across parser, Codex, Copilot, Pi, context-budget, and optimize. Credit: @lfl1337 (PR #67).
- **Menubar label sanitizer.** SwiftBar directive-separator (`|`) and ANSI escape injection via crafted model or category names is now prevented by an allowlist (`[A-Za-z0-9 ._/-]`) plus 14-character truncation. Credit: @lfl1337 (PR #67).

### Added
- **`--verbose` flag.** Global CLI option that prints warnings to stderr on skipped (oversize) or failed session-file reads. Silent by default. Credit: @lfl1337 (PR #67).
- **11 new security tests.** `tests/security/prototype-pollution.test.ts`, `tests/security/menubar-injection.test.ts`, `tests/fs-utils.test.ts`. Total suite: 209 tests.

## 0.7.0 - 2026-04-16

### Added
- **`codeburn optimize` command.** Scans your sessions and your `~/.claude/`
  setup for 11 common waste patterns and hands back exact copy-paste fixes.
  Detection-only, never writes to user files. Supports `--period` (today,
  week, 30days, month, all) and `--provider` (all, claude, codex, cursor).
- **Setup health grade (A-F).** Urgency-weighted rollup of all findings, with
  impact scored against observed waste so the most expensive issues rank
  first. High findings penalise more, medium less, low least.
- **Trend tracking.** Repeat runs classify each finding as new, improving,
  or resolved against a 48-hour recent window, so fixed issues disappear
  instead of lingering as noise.
- **11 detectors:** files Claude re-reads across sessions, low Read:Edit
  ratio, projects missing `.claudeignore`, uncapped `BASH_MAX_OUTPUT_LENGTH`,
  unused MCP servers, ghost agents, ghost skills, ghost slash commands,
  bloated `CLAUDE.md` files (with `@-import` expansion counted), cache
  creation overhead, and junk directory reads.
- **Copy-paste fixes.** Each finding comes with a ready-to-paste remedy: a
  `CLAUDE.md` line, a `.claudeignore` template, an environment variable, or
  a `mv` command to archive unused items.
- **In-TUI optimize view.** Press `o` in the dashboard when the status bar
  shows a finding count, `b` to return. Same engine as the standalone
  command, scoped to the current period and provider.
- **Per-project context budget column.** By Project panel now shows the
  estimated per-session context overhead for each project (system prompt +
  tools + `CLAUDE.md` + skills).
- **34 filesystem-mocking tests.** Tmpdir fixtures with `os.homedir` mocked
  via `vi.mock` cover the detector surface end to end. Total suite: 198
  tests across 13 files.

### Performance
- **mtime pre-filter + parallel reads + 60s result cache** cut a cold scan
  from 12-17s to 6-7s on a 10k-session history.

## 0.6.1 - 2026-04-16

### Added
- **JSON output on `report`, `today`, `month`.** `--format json` writes the
  full dashboard (overview, daily, projects, models, activities, tools, MCP
  servers, shell commands, top sessions) to stdout. Contributed by @mallek.
- **Project filters.** `--project <name>` and `--exclude <name>` on all
  commands (`report`, `today`, `month`, `status`, `export`). Case-insensitive
  substring match against project name and path. Both flags are repeatable.
  Contributed by @mallek.
- **claude-opus-4-7 model mapping and pricing.** Displays as `Opus 4.7` with
  the same Opus pricing as 4.6 and a 6x fast multiplier. Contributed by @mallek.
- **Unit tests for `filterProjectsByName`** covering include/exclude
  semantics, case-insensitivity, path matching, and input immutability.

### Fixed
- **Top Sessions panel truncating the calls column.** Row width filled the
  full panel width without leaving room for the border and padding, so Ink
  truncated the last 4 characters -- landing exactly on the calls column and
  producing rows like `$182.58 ...` with no value.
- **SwiftBar custom plugin directory** now honoured when installing the
  menubar widget. Reads the configured path from SwiftBar's defaults before
  falling back to the standard location. Contributed by @Galeas.
- **`status --format menubar` per-provider today totals** now respect
  `--project`/`--exclude`. The main period blocks already did, the provider
  breakdown loop was the one spot that bypassed the filter.

## 0.6.0 - 2026-04-16

### Added
- **GitHub Copilot provider.** Parses `~/.copilot/session-state/*/events.jsonl`
  and tracks model changes via `session.model_change` events. Picks up six new
  model prices (`gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-5-mini`, `o3`,
  `o4-mini`). Contributed by @theodorosD. Note: Copilot logs only output
  tokens, so cost rows will sit below actual API cost.
- **All Time period (key `5`).** Shows every recorded session since CodeBurn
  started tracking. Daily Activity expands to every available day instead of
  the fixed 14- or 31-day window. `codeburn report -p all` also works from
  the CLI. Contributed by @lfl1337.
- **avg/s column in By Project.** Average cost per session next to the
  existing total cost and session count. Surfaces projects where individual
  sessions are expensive even if the total is modest. Contributed by @lfl1337.
- **Top Sessions panel.** Highlights the five most expensive sessions across
  all projects with date, project, cost, and API call count. Helps spot
  outliers that drag weekly or monthly totals. Contributed by @lfl1337.

### Fixed
- `modelDisplayName` now matches longest key first so `gpt-4.1-mini` resolves
  to `GPT-4.1 Mini` instead of `GPT-4.1`.
- `TopSessions` handles missing `firstTimestamp` gracefully with a
  `----------` placeholder instead of rendering a stray whitespace row.

## 0.5.0 - 2026-04-15

### Added
- **Cursor IDE support.** Reads token usage from Cursor's local SQLite
  database. Shows activity classification, model breakdown, and a Languages
  panel extracted from code blocks. Costs estimated using Sonnet pricing for
  Auto mode (labeled clearly). Supports macOS, Linux, and Windows paths.
- SQLite adapter with lazy-loaded `better-sqlite3` (optional dependency).
  Claude Code and Codex users are completely unaffected if it is not installed.
- File-based result cache for Cursor. First run parses the database (can take
  up to a minute on very large databases); subsequent runs load from cache
  in under 250ms. Cache auto-invalidates when Cursor modifies the database.
- Provider-specific dashboard layout. Cursor shows a Languages panel instead
  of Core Tools, Shell Commands, and MCP Servers (Cursor does not log these).
- Provider color coding in the dashboard tab bar (Claude: orange, Codex: green,
  Cursor: cyan).
- Broader activity classification patterns: file extensions, script references,
  URLs, and HTTP status codes now trigger more accurate categories.
- Debounced period switching. Arrow keys wait 600ms before loading data so
  quickly scrolling through periods skips intermediate loads. Number keys
  still load immediately.
- Dynamic version reading from package.json (no more hardcoded version string).

### Fixed
- CLI `--version` reported stale 0.4.1 since v0.4.2. Closes #38.

## 0.4.4 - 2026-04-15

### Added
- Auto-refresh flag. `codeburn report --refresh 60` reloads data at a set
  interval. Works on `report`, `today`, and `month` commands. Default off.
- Readable project names. Strips home directory prefix from encoded paths,
  shows 3 path segments for more context. Home dir sessions display as "home".
- Responsive dashboard reflows on terminal resize via Ink's useWindowSize
  hook. Width cap raised from 104 to 160 columns. Contributed by @AleBles.
- Total downloads and install size badges in README.

### Fixed
- Agent/subagent session files were excluded, dropping ~46% of API calls.
  Subagent sessions live in separate subagents/ directories with unique
  message IDs and are now included. Closes #17.
- Codex cache hit always showed 100%. OpenAI includes cached tokens inside
  input_tokens (unlike Anthropic). Normalized to prevent double-counting
  in cost calculation and cache hit display. Closes #21.
- CSV formula injection. Cells starting with =, +, -, @ are prefixed with
  an apostrophe before CSV escaping. Contributed by @serabi.
- Menubar "Open Full Report" and "Export CSV" actions broken for npm-installed
  users. Invokes resolved binary directly instead of assuming ~/codeburn
  checkout. Currency picker used nonexistent `config currency` subcommand.
  Contributed by @MukundaKatta. Closes #32, #27.
- Activity panel moved from full-width to half-width row for better space
  usage on wide terminals.

## 0.4.1 - 2026-04-14

### Added
- Multi-currency support. `codeburn currency GBP` sets display currency (162 ISO
  4217 codes). Exchange rates from Frankfurter API (ECB data, 24h cache). Applies
  to dashboard, status, menubar, and exports. Contributed by @BlairWelsh.
- 30-day rolling window period (`codeburn report -p 30days`, key `3` in TUI).
  Distinct from calendar month. Contributed by @oysteinkrog.
- Menubar currency picker with 17 common currencies.

### Fixed
- Export "30 Days" period now uses actual 30-day range instead of calendar month.

## 0.4.0 - 2026-04-14

### Added
- Codex (OpenAI) support. Parses sessions from ~/.codex/sessions/ with full
  token tracking, cost calculation, task classification, and tool breakdown.
- Provider plugin system. Adding a new provider (Pi, OpenCode, Amp) is a
  single file in src/providers/.
- TUI provider toggle. Press p to cycle All / Claude / Codex. Auto-detects
  which providers have session data on disk. Hidden when only one is present.
- --provider flag on all CLI commands: report, today, month, status, export.
  Values: all (default), claude, codex.
- Codex tool normalization: exec_command -> Bash, read_file -> Read,
  write_file/apply_diff/apply_patch -> Edit, spawn_agent -> Agent.
- Codex model pricing: gpt-5, gpt-5.3-codex, gpt-5.4, gpt-5.4-mini with
  hardcoded fallbacks to prevent LiteLLM fuzzy matching mispricing.
- CODEX_HOME environment variable support for custom Codex data directories.
- Menubar per-provider cost breakdown when multiple providers have data.
- 1-minute in-memory cache with LRU eviction for instant provider switching.
- 10 new tests (Codex parser, provider registry, tool/model mapping).

### Fixed
- Model name fuzzy matching: gpt-5.4-mini no longer mispriced as gpt-5
  (more specific prefixes checked first).

## 0.3.1 - 2026-04-14

### Added
- Shell Commands breakdown panel showing which CLI binaries are used most
  (git, npm, docker, etc.). Parses compound commands (&&, ;, |) and handles
  quoted strings. Contributed by @rafaelcalleja.

### Changed
- Activity panel is now full-width so the 1-shot column renders cleanly
  on all terminal sizes.

### Fixed
- Crash on unreadable session files (ENOENT). Skips gracefully instead.

## 0.3.0 - 2026-04-14

### Added
- One-shot success rate per activity category. Detects edit/test/fix retry
  cycles (Edit -> Bash -> Edit) within each turn. Shows 1-shot percentage
  in the By Activity panel for categories that involve code edits.

### Fixed
- Turn grouping: tool-result entries (type "user" with no text) no longer
  split turns. Previously inflated Conversation category by 3-5x at the
  expense of Coding, Debugging, and other edit-heavy categories.

## 0.2.0 - 2026-04-14

### Added
- Claude Desktop (code tab) session support. Scans local-agent-mode-sessions
  in addition to ~/.claude/projects/. Same JSONL format, deduplication across
  both sources. macOS, Windows, and Linux paths.
- CLAUDE_CONFIG_DIR environment variable support. Falls back to ~/.claude if
  not set.

### Fixed
- npm package trimmed from 1.1MB to 41KB by adding files field (ships dist/
  only).
- Image URLs switched to jsDelivr CDN for npm readme rendering.

## 0.1.1 - 2026-04-13

### Fixed
- Readme image URLs for npm rendering.

## 0.1.0 - 2026-04-13

### Added
- Interactive TUI dashboard built with Ink (React for terminals).
- 13-category task classifier (coding, debugging, exploration, brainstorming,
  etc.) using tool usage patterns and keyword matching. No LLM calls.
- Breakdowns by daily activity, project, model, task type, core tools, and
  MCP servers.
- Gradient bar charts (blue to amber to orange) inspired by btop.
- Responsive layout: side-by-side panels at 90+ cols, stacked below.
- Keyboard navigation: arrow keys switch Today/7 Days/Month, q to quit.
- Column headers on all panels.
- Bottom status bar with key hints (interactive mode only).
- Per-panel accent border colors with rounded corners.
- SwiftBar/xbar menu bar widget with flame icon, activity breakdown, model
  costs, and token stats. Refreshes every 5 minutes.
- CSV and JSON export with Today, 7 Days, and 30 Days periods.
- LiteLLM pricing integration with 24h cache and hardcoded fallback.
  Supports input, output, cache write, cache read, web search, and fast
  mode multiplier.
- Message deduplication by API message ID across all session files.
- Date-range filtering per entry (not per session) to prevent session bleed.
- Compact status command with terminal, menubar, and JSON output formats.
