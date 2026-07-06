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

The `threads` table stores each thread's `data` BLOB as zstd-compressed JSON (`data_type = "zstd"`; legacy rows may be uncompressed `"json"`, both are read, `zed.ts:117-127`). Decompression uses Node's built-in `zlib.zstdDecompressSync` (`zed.ts:17`), no extra dependency.

The decompressed thread JSON carries:

- `model`: `{ "provider": ..., "model": ... }`
- `request_token_usage`: map of user-message id to `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` (zero-valued fields are omitted)
- `cumulative_token_usage`: same shape, whole-thread totals

Token semantics match Anthropic's (separate cache-creation and cache-read fields), so pricing maps directly onto the LiteLLM engine. Shapes verified against Zed's serialization source (`crates/agent/src/db.rs`: `DbThread`, `TokenUsage`, `SerializedLanguageModel`, `DataType`) and a real store.

## Caching

None.

## Deduplication

Per `zed:<threadId>:<requestKey>` (`zed.ts:96`), where `requestKey` is the user-message id from `request_token_usage` or the synthetic `cumulative-remainder`.

## Quirks

- `request_token_usage` is keyed by user message and does not cover every request a thread made (verified on a real thread: cumulative was ~3x the map sum). One remainder entry per thread tops usage up to the exact `cumulative_token_usage` (`zed.ts:133-153`), so totals always match the store.
- The per-request map carries no timestamps, so every call in a thread uses the thread's `updated_at`; day-level attribution inside long-running threads is approximate.
- Node's zlib gained zstd in 22.15. On older Nodes the provider skips with a notice instead of failing (`zed.ts:14-17`).
- All Zed usage currently lands under a single `zed` project; `folder_paths` is not yet mapped to per-project attribution.

## When fixing a bug here

1. If discovery returns no sessions, confirm `threads.db` exists at the platform path and the `threads` table still has `id`, `summary`, `updated_at`, `data_type`, `data`.
2. If threads are skipped, check `data_type` values on disk; only `zstd` and `json` are read.
3. If totals disagree with the store, compare against `cumulative_token_usage` per thread; the remainder logic must bring each thread exactly to it.
4. If model names stop pricing, inspect `model.model` strings in a real thread and add aliases if Zed introduces new hosted-model ids.
