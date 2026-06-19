# Zerostack

Zerostack (gi-dellav/zerostack) — a minimal Rust coding agent. Wraps OpenRouter (default), OpenAI, Anthropic, Gemini, and Ollama.

- **Source:** `src/providers/zerostack.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/zerostack.test.ts`

## Where it reads from

The platform data dir + `zerostack/sessions/`, mirroring Rust's `dirs::data_dir` (`src/session/storage.rs` in zerostack):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/zerostack/sessions/` |
| Linux | `$XDG_DATA_HOME/zerostack/sessions/` or `~/.local/share/zerostack/sessions/` |

`ZS_DATA_DIR` overrides the whole data dir (sessions live directly under it). A directory argument to `createZerostackProvider(dir)` overrides the sessions dir outright (used by tests).

## Storage format

JSON — one `<uuid>.json` file per session. Each file is a single `Session` object: a `messages[]` array (`role`, `content`, `estimated_tokens`) plus session-level metadata.

## Token model

**Cumulative, not per-call.** Real billable tokens exist only as session totals — `total_input_tokens`, `total_output_tokens` — alongside `model`, `provider`, and `working_dir`. Individual messages carry only a rough `estimated_tokens`. So the parser emits **one `ParsedProviderCall` per session** from the totals; cost is recomputed with `calculateCost` (LiteLLM), not taken from the session's own `total_cost`.

## Caching

None.

## Deduplication

Per `zerostack:<path>:<updated_at>:<id>`.

## Quirks

- **No cache breakdown.** zerostack's `Usage` only carries `input_tokens` and `output_tokens` (`src/agent/runner.rs`); it folds any cached prompt tokens into the input count and discards the split before writing the session. So cache fields are always `0` and the cache % reads 0. Cost is re-priced at LiteLLM's standard input rate, which can slightly overestimate when caching was active — consistent with zerostack's own flat `input_token_cost`.
- **No tool data.** zerostack persists only final assistant text, not tool-call or bash records, so `tools` and `bashCommands` are always empty.
- **OpenRouter model ids are prefixed** (e.g. `deepseek/deepseek-v4-pro`). `modelDisplayName` strips the route prefix before resolving; `calculateCost` resolves the prefixed id via LiteLLM's canonical-name handling.
- **Whole-session timestamp.** All spend is attributed to `updated_at`, since cumulative totals can't be split across days.
- Unknown/local models (Ollama, custom) price at `$0`, which is expected.

## When fixing a bug here

1. Confirm whether the bug is in **discovery** (session files not picked up — check the data-dir resolution against `src/session/storage.rs`) or **parsing** (totals mapped wrong).
2. The session struct is `Session` in zerostack's `src/session/mod.rs`. If a field is renamed upstream, update `ZerostackSession` to match.
3. Add a fixture-format session to `tests/providers/zerostack.test.ts`; do not mock the filesystem.
