# Grok Build

Grok Build, xAI's coding CLI. Sessions use the `grok-build` model by default.

- **Source:** `src/providers/grok.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/grok-parser-pipeline.test.ts`, `tests/providers/grok.test.ts`

## Where it reads from

`$GROK_HOME/sessions/` (or `~/.grok/sessions/`), one directory per session:
`sessions/<url-encoded-cwd>/<uuid>/`. The parser reads `summary.json`, `signals.json`, and `updates.jsonl` from each session directory.

Scan several data directories together with `GROK_HOMES`. Unix/macOS:

```bash
GROK_HOMES="$HOME/.grok:$HOME/.grok2" codeburn
```

Windows PowerShell:

```powershell
$env:GROK_HOMES = "$HOME\.grok;$HOME\.grok2"
codeburn
```

The separator is `path.delimiter`: `:` on Unix/macOS, `;` on Windows.
Precedence: `GROK_HOMES` > `GROK_HOME` > `~/.grok`. The legacy
`GROK_HOME` remains supported. Empty entries are ignored; an entirely
empty list falls back to the legacy home. Multi-directory paths support `~`.
Missing, empty or unreadable directories are skipped. Sessions from all homes
are aggregated under the existing `grok` provider; duplicate session IDs
(or directory UUIDs when no ID is recorded) are scanned once, preferring the first listed home.

## Storage format

JSON + JSONL. `summary.json` holds the session id, cwd, timestamps, and `current_model_id`. `signals.json` holds `modelsUsed`, `toolsUsed`, and `contextTokensUsed`. `updates.jsonl` is the ACP log: streamed chunks carry `params._meta.totalTokens` (running context size) and `params._meta.promptId` (one per turn); newer CLI versions also append `params.update.sessionUpdate: "turn_completed"` with snake_case `prompt_id` and a provider-recorded `usage` object.

## Token model

**Authoritative when available.** A `turn_completed` record reports the whole input side in `inputTokens` and the whole output side in `outputTokens`. `cachedReadTokens` is treated as a subset of input; `cacheCreationTokens` is treated as another input subset by analogy because the record exposes no separate fresh-input field, with any per-record violation clamped locally. The top-level totals are the accounting basis. `modelUsage` is retained only as a model-attribution signal; multi-model attribution is deliberately out of scope, so one session uses one selected model's rate. `reasoningTokens` is clamped to that record's reported output before the parser emits exclusive output plus reasoning, preserving the reported total through the cache pipeline. These counts are provider-recorded, so `costIsEstimated` is false for fully covered sessions while CodeBurn applies its own pricing table. `costUsdTicks` is ignored because its scale is undocumented.

**Estimated fallback.** Older sessions without any valid `turn_completed.usage` record use the running context fill (`totalTokens` per chunk) and the existing compaction-aware per-turn curve. That path remains flagged `costIsEstimated`; a completed record is never blended with the heuristic.

**Mixed sessions undercount.** The choice between the two paths is per session, not per turn. If a session has at least one usable `turn_completed` record, the whole session is billed from the summed records and any turn WITHOUT a record contributes nothing at all - its tokens are dropped, not estimated, so such a session reads low. The row is marked `costIsEstimated: true` rather than claiming full provider coverage. This is deliberate: blending the heuristic into real records would reintroduce the roughly 5x output over-count this parser exists to remove. It happens when a session straddles a CLI upgrade or a run dies before writing its last record; an open turn is filled by a later parse once it writes one, pre-upgrade turns never are. Measured on a 568-session corpus, 1 turn out of 566 was uncovered.

## Pricing

`grok-build` is aliased to `grok-build-0.1` in `src/models.ts`, so it prices off the bundled LiteLLM fallback. If `usage.modelUsage` contains a model id that CodeBurn can price, that id is preferred; when the real id is not priced yet, the existing summary/signals model is retained so a known alias does not become a $0 row. This is a single attribution choice for the session, not a per-model accounting split; multi-model rate attribution is a follow-up. CodeBurn still does not use Grok's undocumented `costUsdTicks`.

## Caching

Authoritative records expose cache-read and cache-creation token counts. The legacy estimate has no cache-creation signal and keeps its inferred cache-read count.

## Deduplication

Per `grok:<session-dir>:<updated_at>:<id>`.

## Quirks

- **Two token paths.** Completed turns carry provider usage; sessions from older CLI versions have only the context curve and therefore remain estimates (likely an upper bound, since re-sent context is cached server-side and not exposed in those files).
- **A turn with no `turn_completed` record is dropped inside an otherwise-covered session** (see Token model). The session still reports, marked estimated, but reads low by those turns.
- **No bash-command capture.** Tool names come from `signals.toolsUsed`; per-command bash text is not extracted, so `bashCommands` is empty.
- **Whole-session timestamp.** Spend is attributed to `updated_at`, since the context curve is cumulative.
- **Subscription vs API.** Grok Build runs via either a metered xAI API account (tiered) or a SuperGrok subscription; the session files do not record which.

## When fixing a bug here

1. Discovery: check the `sessions/<cwd>/<uuid>/` walk and the `GROK_HOME` resolution.
2. Token accounting: see `parseUpdates` (deduplicates `turn_completed` by snake_case `prompt_id`, then falls back to grouping streamed chunks by camelCase `_meta.promptId`).
3. Add a fixture-format session under `tests/providers/grok.test.ts`; do not mock the filesystem.
