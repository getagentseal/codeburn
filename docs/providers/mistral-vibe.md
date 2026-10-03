# Mistral Vibe

Mistral Vibe CLI.

- **Source:** `src/providers/mistral-vibe.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/mistral-vibe.test.ts`

## Where it reads from

`$VIBE_HOME/logs/session/` when `VIBE_HOME` is set, otherwise `~/.vibe/logs/session/`.

## Storage format

Legacy Vibe 2.x stores each session as a directory:

- `meta.json` contains session metadata, cumulative token totals, active model config, model prices, timestamps, working directory, and available tools.
- `messages.jsonl` contains non-system messages and assistant `tool_calls`.

Subagent traces are stored under a parent session's `agents/` folder with the same `meta.json` / `messages.jsonl` shape, so CodeBurn scans those one level down as separate sessions.

Vibe 2.25's Unified Harness stores sessions (including subagents) under
`unified/<session_id>/`. Its `meta.json` has no `stats`, and there is no
`messages.jsonl`. `CURRENT` selects a committed generation containing
`projection-state.json`, `runtime-state.json`, and a manifest. The projection's
history can be stored in content-addressed `chunks/` files.

CodeBurn reads `snapshot.session.tokenUsage` and the cumulative usage envelopes
in `journal/*.jsonl`. It supports both `projection_advanced` and
`projection_delta` records. These are recovery journals: Vibe retains only two
segments after checkpointing. Summing `action_result` records alone loses older
usage, while summing every nested usage object double-counts copies of a call.
CodeBurn takes deltas between cumulative envelopes and recovers the older prefix
from the snapshot. If that prefix covers multiple turns whose individual usage
was pruned, it distributes the prefix across their recorded turns. Session totals
remain exact; that older per-turn allocation is approximate.

## Caching

Legacy Vibe local logs do not expose cache-read/cache-write token fields, so
CodeBurn reports cache token counts as `0`. When `meta.json.stats.session_cost`
is present, CodeBurn uses that session total instead of re-estimating from
prompt/completion token prices because it is the best cache-aware cost signal
available in the local log shape.

Unified `inputTokens` includes `cachedInputTokens`. CodeBurn subtracts cached
input from ordinary input and records it as cache-read usage, then estimates
cost using the pricing catalog and the active model recorded in runtime state.
It does not treat `contextUsage` (the latest context window) as cumulative spend.
Historical model switches are not reconstructible from pruned journals; the
runtime's active model is used for the session, as with legacy metadata.

The source cache fingerprints `CURRENT`, metadata, and the bounded journal
segments. Appending usage invalidates the cache even before Vibe publishes a new
generation. Generation contents and chunks are immutable once published.

## Deduplication

Legacy message IDs, or the session ID for an aggregate fallback. Unified usage
uses the session ID, projection sequence, and turn ID. Repeated journal sequences
and cumulative totals are not counted again.

## Quirks

- **Usage is cumulative per session.** Vibe does not write per-assistant-message token usage into `messages.jsonl`; token counts come from `meta.json.stats.session_prompt_tokens` and `session_completion_tokens`. CodeBurn splits assistant-message tools into their user turns for classification and distributes the cumulative token/cost totals across those assistant calls so session totals remain unchanged.
- **Cost prefers Vibe's own session total.** `meta.json.stats.session_cost` is used first. If it is missing, `meta.json.stats.input_price_per_million` and `output_price_per_million` are used with the active model config as a fallback. LiteLLM pricing is only used when Vibe provides no price data.
- **Project names come from metadata.** Discovery uses `meta.json.environment.working_directory` and falls back to the session directory name if that field is missing.
- **Tool calls come from messages.** Assistant `tool_calls[*].function.name` is normalized to the standard CodeBurn names (`bash` to `Bash`, `search_replace` to `Edit`, etc.). Bash commands are extracted from `function.arguments.command`.

## When fixing a bug here

1. Identify the harness first. Legacy sessions require `meta.json` and `messages.jsonl`; Unified sessions use `CURRENT`, generations, chunks, and journals.
2. Check legacy `meta.json.stats` or Unified projection `session.tokenUsage`, never `contextUsage`.
3. Test journal rotation and appends against a warm CodeBurn cache, as well as legacy compatibility. See `tests/fixtures/mistral-vibe-unified.md` for fixture provenance.
