# Codex

OpenAI Codex CLI.

- **Source:** `src/providers/codex.ts`
- **Loading:** eager (`src/providers/index.ts:2`)
- **Test:** `tests/providers/codex.test.ts` (374 lines)

## Where it reads from

`$CODEX_HOME` if set, otherwise `~/.codex`. Active sessions are nested by date:

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
```

Archived sessions are stored in a flat directory and are included in usage reports:

```
~/.codex/archived_sessions/rollout-*.jsonl
```

The active-session discovery walk uses strict regex (`^\d{4}$`, `^\d{2}$`) on each path component.

## Storage format

JSONL. The first line must be a `session_meta` entry with `payload.originator` starting with `codex` (case-insensitive). Files that fail this check are silently skipped.

The first line read is capped at 1 MB (`FIRST_LINE_READ_CAP`). Codex CLI 0.128+ embeds the full system prompt in `session_meta`, which can run 20-27 KB; the cap leaves headroom while bounding memory if a corrupt file has no newline.

## Caching

`src/codex-cache.ts` writes `~/.cache/codeburn/codex-results.json` (or `$CODEBURN_CACHE_DIR/codex-results.json`). Each entry is keyed by absolute file path and validated against `mtimeMs + sizeBytes`. Cached entries are returned wholesale.

A session that yielded zero parseable lines does **not** write to the cache (`codex.ts:419`); this prevents a transient read failure from pinning an empty result against a fingerprint.

## Deduplication

`codex:<sessionId>:<timestamp>:<cumulativeTotal>` for accounted events, plus `codex:<sessionId>:<timestamp>:est<n>` for estimated events that fall back to char-counting.

## Quirks

- Codex CLI emits both `last_token_usage` (per turn) and `total_token_usage` (cumulative). The parser handles three modes:
  1. `last_token_usage` present: use it directly.
  2. Only cumulative: compute deltas against the prior turn.
  3. Neither: estimate from message text length (`CHARS_PER_TOKEN = 4`).
- `prevCumulativeTotal` is initialized to `null`, not `0`. A session whose first event reports `total = 0` would otherwise be dropped as a "duplicate" of the initial state.
- `prev*` token counters are advanced on **every** event, including ones that used `last_token_usage`. Earlier code only updated them on the fallback branch, which double-counted any session that mixed modes.
- OpenAI counts cached tokens **inside** `input_tokens`. The parser subtracts them so the rest of the codebase can assume Anthropic semantics (cached are separate).

## When fixing a bug here

1. Reproduce against a real `rollout-*.jsonl` if you can. Drop a redacted copy under `tests/fixtures/codex/` and reference it from `tests/providers/codex.test.ts`.
2. If the bug is "zero tokens reported", first check whether the file is being skipped by `isValidCodexSession`.
3. If the bug is "tokens counted twice", look at `prevCumulativeTotal` and the prev-counter advancement.
4. If you change the dedup key shape, run `tests/providers/codex.test.ts` and `tests/parser-filter.test.ts` together; cross-provider dedup happens via the global `seenKeys` Set.
