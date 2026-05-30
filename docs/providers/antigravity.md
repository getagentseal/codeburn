# Antigravity

Google Antigravity (CLI and IDE). CodeBurn discovers session files on disk and queries the local language-server RPC endpoint to parse them.

- **Source:** `src/providers/antigravity.ts`
- **Loading:** lazy via `src/providers/index.ts`. Lazy because the protobuf dependency is heavy.
- **Test:** focused helper coverage in `tests/providers/antigravity.test.ts`.

## Where it reads from

CodeBurn discovers Antigravity sessions from local directories on disk, then queries the live language-server process (if running) to fetch detailed trajectory generator metadata:

1. **Session Discovery:** It scans the following folders for `.pb` or `.db` files:
   - **Antigravity CLI:** `%USERPROFILE%\.gemini\antigravity-cli\conversations` (and `implicit`)
   - **Antigravity App/older path:** `%USERPROFILE%\.gemini\antigravity\conversations`
   - **Antigravity IDE (VSCode-based):** `%USERPROFILE%\.gemini\antigravity-ide\conversations` (and `implicit`)
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
RPC snapshot for full response metadata. Remove it with
`codeburn antigravity-hook uninstall`; if `--force` replaced an existing
statusLine command, uninstall restores that previous command.

## Storage format

Protobuf. Cascade and response objects map to `ParsedProviderCall` directly.

## Caching

Custom file cache at `$CODEBURN_CACHE_DIR/antigravity-results.json` (defaults to `~/.cache/codeburn/`). The cache is also used as the data source when the RPC endpoint is unavailable, not just as an optimization. Bumping the cache version forces a recompute.

## Deduplication

Per `<cascadeId>:<responseId>` for RPC data. The status line fallback collapses
repeated identical usage snapshots, ignores singleton intermediate snapshots
when a later stabilized usage total is observed for the same conversation, and
uses positive deltas for monotonic snapshots so cumulative counters are not
double-counted.

## Quirks

- **Antigravity is the only provider that requires a live process.** A user who closes Antigravity loses the most-recent data until next launch (the cache covers older runs).
- **Antigravity CLI has a shorter capture window than the desktop app.** `agy`
  exposes its language server only while the CLI session is active. The status
  line hook closes that gap for future sessions; older CLI `.pb` files still
  cannot be priced exactly unless an RPC snapshot was captured.
- The 16 MB cap on RPC responses is necessary because individual cascades can balloon. Raising it risks OOM on the user's machine.
- Token types are split across `inputTokens`, `responseOutputTokens`, and `thinkingOutputTokens`. Thinking is billed at output rate.

## When fixing a bug here

1. Reproducing the full provider path requires Antigravity running locally.
   The unit tests cover process flag parsing and wrapped/unwrapped RPC response
   extraction, but they do not stand up a live Antigravity RPC endpoint.
2. Before any change, capture a sample protobuf response (anonymized) so future regressions can be tested against a recording.
3. If the bug is "no data after Antigravity update", the protobuf schema may have shifted. The parser's response handling is the place to look.
4. If the bug is "stale data", check whether the RPC is reachable; the cache fallback can mask connectivity issues.
