# Grok Build

Grok Build, xAI's coding CLI. Sessions use the `grok-build` model by default.

- **Source:** `src/providers/grok.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/grok.test.ts`

## Where it reads from

`$GROK_HOME/sessions/` (or `~/.grok/sessions/`), one directory per session:
`sessions/<url-encoded-cwd>/<uuid>/`. The parser reads `summary.json`, `signals.json`, and `updates.jsonl` from each session directory.

## Storage format

JSON + JSONL. `summary.json` holds the session id, cwd, timestamps, and `current_model_id`. `signals.json` holds `modelsUsed`, `toolsUsed`, and `contextTokensUsed`. `updates.jsonl` is the ACP log: each streamed chunk carries `params._meta.totalTokens` (running context size) and `params._meta.promptId` (one per turn).

## Token model

**Estimated.** Grok does not log billable input/output tokens. It only records the running context fill (`totalTokens` per chunk, and `contextTokensUsed` in signals). The parser reconstructs a rough estimate from the per-turn `totalTokens` curve: input is the context entering each turn, output is the context growth during it. The result is flagged `costIsEstimated` and re-priced with `calculateCost`.

## Pricing

`grok-build` is aliased to `grok-build-0.1` in `src/models.ts`, so it prices off the bundled LiteLLM fallback. Note that xAI's published API rate and the LiteLLM fallback figure differ, so treat the cost as an estimate and verify against your xAI usage console.

## Caching

None.

## Deduplication

Per `grok:<session-dir>:<updated_at>:<id>`.

## Quirks

- **No cache or output/tool-token split.** Only context fill is available, so cache fields are `0` and the cost is an estimate (likely an upper bound, since re-sent context is cached server-side and not exposed in the session files).
- **No bash-command capture.** Tool names come from `signals.toolsUsed`; per-command bash text is not extracted, so `bashCommands` is empty.
- **Whole-session timestamp.** Spend is attributed to `updated_at`, since the context curve is cumulative.
- **Subscription vs API.** Grok Build runs via either a metered xAI API account (tiered) or a SuperGrok subscription; the session files do not record which.

## When fixing a bug here

1. Discovery: check the `sessions/<cwd>/<uuid>/` walk and the `GROK_HOME` resolution.
2. Token estimate: see `estimateTokens` (groups `updates.jsonl` by `promptId`).
3. Add a fixture-format session under `tests/providers/grok.test.ts`; do not mock the filesystem.
