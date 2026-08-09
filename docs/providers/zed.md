# Zed

Zed's built-in AI agent.

- **Source:** `src/providers/zed.ts`
- **Loading:** lazy (`src/providers/index.ts:177`)
- **Test:** `tests/providers/zed.test.ts`

## Where it reads from

One SQLite database with one row per agent thread (`zed.ts:19`):

- macOS: `~/Library/Application Support/Zed/threads/threads.db`
- Linux: `~/.local/share/zed/threads/threads.db`
- Windows: `%LOCALAPPDATA%\Zed\threads\threads.db`

## Storage format

The `threads` table stores each thread's `data` BLOB as zstd-compressed JSON (`data_type = "zstd"`; legacy rows may be uncompressed `"json"`, both are read, `zed.ts:153-165`). Decompression uses Node's built-in `zlib.zstdDecompressSync` (`zed.ts:17`), no extra dependency.

The decompressed thread JSON carries:

- `model`: `{ "provider": ..., "model": ... }`
- `request_token_usage`: map of user-message id to `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` (zero-valued fields are omitted)
- `cumulative_token_usage`: same shape, whole-thread totals

Each row's `folder_paths` column carries the workspace folder roots the thread was created against — absolute paths, one per line, lexicographically sorted (Zed's `PathList` serialization; the `folder_paths_order` column is display-only and unused here). The column is absent on databases written by older Zed, which added it via `ALTER TABLE`; the parser detects it with `PRAGMA table_info` and degrades gracefully (`zed.ts:94-101`).

Token semantics match Anthropic's (separate cache-creation and cache-read fields), so pricing maps directly onto the LiteLLM engine. Shapes verified against Zed's serialization source (`crates/agent/src/db.rs`: `DbThread`, `TokenUsage`, `SerializedLanguageModel`, `DataType`) and a real store.

## Caching

None.

## Deduplication

Per `zed:<threadId>:<requestKey>` (`zed.ts:132`), where `requestKey` is the user-message id from `request_token_usage` or the synthetic `cumulative-remainder`.

## Quirks

- `request_token_usage` is keyed by user message and does not cover every request a thread made (verified on a real thread: cumulative was ~3x the map sum). One remainder entry per thread tops usage up to the exact `cumulative_token_usage` (`zed.ts:170-192`), so totals always match the store.
- The per-request map carries no timestamps, so every call in a thread uses the thread's `updated_at`; day-level attribution inside long-running threads is approximate.
- Node's zlib gained zstd in 22.15. On older Nodes the provider skips with a notice instead of failing (`zed.ts:14-17`).
- Project attribution mirrors Zed's own sidebar grouping (`zed.ts:79-101`): a thread with exactly one `folder_paths` entry maps to that folder's project (`projectPath` = the normalized folder path, `projectIdentity` = the same stable identity, `project` = the folder basename display label); a thread with two or more entries maps to a synthetic project named after the joined basenames (`codeburn, website`, matching `ProjectGroupKey::display_name`), with an empty `projectPath` and `projectIdentity` = the sorted normalized root-set joined by newlines. The root-set is an aggregation key, not a filesystem path, so identical basenames on distinct machines (`/Users/alice/repo` vs `/Users/bob/repo`) never merge; rows without the column (older schemas) keep the single `zed` bucket. Zed records which workspace roots a thread was created against, but not which folder it actually used.

## When fixing a bug here

1. If discovery returns no sessions, confirm `threads.db` exists at the platform path and the `threads` table still has `id`, `summary`, `updated_at`, `data_type`, `data` (`folder_paths` is optional and only read when present).
2. If threads are skipped, check `data_type` values on disk; only `zstd` and `json` are read.
3. If totals disagree with the store, compare against `cumulative_token_usage` per thread; the remainder logic must bring each thread exactly to it.
4. If model names stop pricing, inspect `model.model` strings in a real thread and add aliases if Zed introduces new hosted-model ids.
