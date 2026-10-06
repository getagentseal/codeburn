# Antigravity

Google Antigravity (CLI and IDE). CodeBurn discovers session files on disk and queries the local language-server RPC endpoint to parse them.

- **Source:** `src/providers/antigravity.ts`
- **Loading:** lazy via `src/providers/index.ts`. Lazy because the protobuf dependency is heavy.
- **Test:** focused helper coverage in `tests/providers/antigravity.test.ts`.

## Where it reads from

CodeBurn discovers Antigravity sessions from local directories on disk, then queries the live language-server process (if running) to fetch detailed trajectory generator metadata:

1. **Session Discovery:** It scans the following folders for `.pb` or `.db` files:
   - **Antigravity CLI:** `%USERPROFILE%\.gemini\antigravity-cli\conversations` (and `implicit`)
   - **Antigravity App/older path:** `%USERPROFILE%\.gemini\antigravity\conversations`. The standalone app (2.19+, `language_server --standalone --subclient_type hub --app_data_dir antigravity`) writes here too: new conversations as `.db`, older ones stay `.pb`.
   - **Antigravity IDE:** `%USERPROFILE%\.gemini\antigravity-ide\conversations` (and `implicit`). The IDE also maintains VSCode-style global state at `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb`, but that DB stores trajectory metadata (titles, timestamps, workspace paths) — not token usage. Token usage data still comes from the `.db` conversation files.
2. **Language Server RPC Query:** It locates the active language-server process via `ps` on POSIX or `Get-CimInstance Win32_Process` on Windows. It extracts the port and CSRF token from the process arguments, and queries the local HTTPS RPC endpoint `GetCascadeTrajectoryGeneratorMetadata` to parse the session.
3. **Cache Fallback:** If the language server is not running, it falls back to the local results cache.

Antigravity exposes slightly different process flags across platforms:
POSIX builds have used `--https_server_port` and `--csrf_token`; Windows
builds can expose `--extension_server_port` and
`--extension_server_csrf_token`. Both space-separated and `--flag=value`
forms are supported. The parser identifies the target app type using the `--app-data-dir` flag (e.g., `antigravity`, `antigravity-cli`, or `antigravity-ide`).

For Antigravity CLI (`agy`), CodeBurn can also install an opt-in status line
hook with `codeburn antigravity-hook install`. The hook records the CLI's
sanitized `context_window.current_usage` payload while `agy` is still alive,
without prompts or local working-directory paths. It also attempts a best-effort
RPC snapshot for full response metadata. The installed command points at a
persistent `codeburn` binary from PATH rather than a local build artifact, and
running `codeburn antigravity-hook install` again repairs older CodeBurn-owned
statusLine commands that used stale absolute paths. Remove it with `codeburn
antigravity-hook uninstall`; if `--force` replaced an existing statusLine
command, uninstall restores that previous command.

## Storage format

Protobuf and SQLite.

### SQLite `.db` Files
Native Antigravity Desktop, IDE, and CLI sessions store structured state in SQLite databases under `~/.gemini/<app>/conversations/<id>.db`:

1. **`gen_metadata` (Model Generations)**:
   - Each row represents a completed LLM completion turn.
   - `data` BLOB Protobuf:
     - **Field 1 (`ChatModel`)**: Token usage (`Field 4`, see Accuracy), model config id (`Field 19`, e.g. `gemini-pro-default`), key/value metadata including `model_enum` (`Field 20`), display name (`Field 21`, absent in the standalone app), and generation timestamp (`Field 9 -> Field 4`).
     - **Field 2 (`stepIndices`)**: Packed varints listing the exact `steps.idx` rows produced during that generation turn.
     - **Field 4**: Generation UUID used for deduplication (`<cascadeId>:<responseId>`).
2. **`steps` (Execution Steps & Tools)**:
   - Monotonic step records (`idx`, `step_type`, `status`, `metadata`).
   - `metadata` BLOB Protobuf:
     - **Field 4 (`ToolCallMetadata`)**: Contains `call_id` (Field 1), canonical `tool_name` (Field 2), and `argumentsJson` (Field 3).
     - Standard tool calls are mapped directly:
       - `run_command`: populates `bashCommands`.
       - `call_mcp_tool`: extracts `ServerName` and `ToolName` as `mcp__<server>__<tool>`.
       - `view_file`: scans `AbsolutePath` for `SKILL.md` to identify activated skills.
       - `invoke_subagent`: parses `Subagents` array for subagent archetype roles.
       - Assistant-to-assistant replies (`send_message`) are explicitly excluded from developer tools.
3. **Concurrency & Lifecycle**:
   - Operates in SQLite WAL mode.
   - Transient database write locks during progressing sessions propagate `SQLITE_BUSY` to allow automatic retry on the next refresh pass.
   - In-flight steps (`status = 2`) settle into subsequent generation records once completed.
   - User-cancelled turns (`status = 7`) commit partial token spend to `gen_metadata`.

For older `.pb` files, cascade and response objects map to `ParsedProviderCall` directly via the language-server RPC.

## Accuracy

The usage message is `exa.codeium_common_pb.ModelUsageStats`; field numbers
come from the descriptor embedded in the `language_server` binary and match the
RPC JSON names:

| Field | Name | CodeBurn |
|---|---|---|
| 1 | `model` (enum, e.g. 1016 = `MODEL_PLACEHOLDER_M16`) | not read; the same id comes from the `model_enum` key |
| 2 | `input_tokens` (uncached) | `inputTokens` |
| 3 | `output_tokens` (= 9 + 10) | fills `outputTokens` when 9 and 10 are missing or disagree |
| 4 | `cache_write_tokens` | `cacheCreationInputTokens` |
| 5 | `cache_read_tokens` | `cacheReadInputTokens` |
| 6 | `api_provider` (24 = `API_PROVIDER_GOOGLE_GEMINI`) | ignored |
| 9 | `thinking_output_tokens` | `reasoningTokens`, billed at the output rate |
| 10 | `response_output_tokens` | `outputTokens` |
| 11 | `response_id` | dedup key |

- **Exact:** call count, input, output, thinking and cache-read tokens, from
  both `.db` files and the RPC. Cache read is separate from input (it is often
  larger), so it is priced at the cache-read rate on top of input.
- **Estimated:** the model of `.db` calls that carry only a placeholder. The
  standalone app writes `model_enum=MODEL_PLACEHOLDER_M16` and
  `gemini-pro-default`, with no display name. CodeBurn maps the placeholder
  through a small table taken from the app's own `GetAvailableModels` catalog
  (6 Oct 2026, app 2.19.1): `M16` and `M37` are Gemini 3.1 Pro (High), `M36`
  Gemini 3.1 Pro (Low), `M84` Gemini 3.5 Flash (High), `M18` Gemini 3 Flash,
  `M35` Claude Sonnet 4.6, `M26` Claude Opus 4.6 (Thinking). These calls carry
  `costIsEstimated`, because a later app build can repoint a placeholder.
  `.pb` calls resolve the placeholder through the live catalog at parse time
  and are not flagged. Gemini 3.1 Pro prices as `gemini-3.1-pro-preview`:
  $2/M input, $12/M output, $0.20/M cache read, and $4/$18/$0.40 per request
  whose prompt (input + cache read) reaches 200,000 tokens. Google's rule is
  "over 200k", so a prompt of exactly 200,000 gets the higher rate one token
  early; the shared threshold check uses `>=` for every tiered provider.
- **Timestamps:** `ChatStartMetadata.created_at` when present. Standalone-app
  rows leave it out; they take the time of the generation's first step
  (`steps.metadata` #1), which equals `created_at` to the second wherever both
  exist. The file mtime is the last resort.
- A placeholder that is in neither the table nor the live catalog stays
  unpriced and shows as `$0` under `codeburn models --unpriced`.

## Caching

Custom file cache at `$CODEBURN_CACHE_DIR/antigravity-results.v<n>.json` (version 8, defaults to `~/.cache/codeburn/`). The unsuffixed `antigravity-results.json` is left for older binaries; a matching-version copy is adopted once and never overwritten. The cache is also used as the data source when the RPC endpoint is unavailable, not just as an optimization. Bumping the cache version forces a recompute.

## Deduplication

Per `<cascadeId>:<responseId>` for RPC data. The status line fallback collapses
repeated identical usage snapshots, ignores singleton intermediate snapshots
when a later stabilized usage total is observed for the same conversation, and
uses positive deltas for monotonic snapshots so cumulative counters are not
double-counted.

## Quirks

- **`.pb` conversations need the live process.** `.db` conversations are read straight from SQLite; `.pb` ones only through the RPC, so with Antigravity closed they come from the results cache. After a cache-version bump, a `.pb` cascade missing from the new file is served from the previous version's file (stored with `mtimeMs: -1`) until a run with Antigravity open re-fetches it.
- `~/.gemini/antigravity-backup` is not scanned. On the machine checked it held only a copy of a conversation also under `antigravity` and `antigravity-ide`, which the cascade-id dedup would drop anyway.
- **Antigravity CLI has a shorter capture window than the desktop app.** `agy`
  exposes its language server only while the CLI session is active. The status
  line hook closes that gap for future sessions; older CLI `.pb` files still
  cannot be priced exactly unless an RPC snapshot was captured.
- The 16 MB cap on RPC responses is necessary because individual cascades can balloon. Raising it risks OOM on the user's machine.

## When fixing a bug here

1. Reproducing the full provider path requires Antigravity running locally.
   The unit tests cover process flag parsing and wrapped/unwrapped RPC response
   extraction, but they do not stand up a live Antigravity RPC endpoint.
2. Before any change, capture a sample protobuf response (anonymized) so future regressions can be tested against a recording.
3. If the bug is "no data after Antigravity update", the protobuf schema may have shifted. The parser's response handling is the place to look.
4. If the bug is "stale data", check whether the RPC is reachable; the cache fallback can mask connectivity issues.
