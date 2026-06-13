# Devin Full Model Name Reporting

- **Date:** 2026-06-12
- **Status:** Proposed
- **Scope:** `codeburn report --format json` model names for Devin sessions

## Problem

Devin transcripts include a specific generation model id (for example
`gpt-5-3-codex-xhigh`), but the JSON report currently shows a collapsed short
name (for example `GPT-5`).

Example mismatch:

- Transcript field: `steps[].metadata.generation_model = "gpt-5-3-codex-xhigh"`
- Report field: `models[].name = "GPT-5"`

## Root Cause

1. The Devin provider already extracts the full model id in this order:
   `step.metadata.generation_model` -> `step.model_name` ->
   `transcript.agent.model_name` -> `sessions.model` -> `"devin"`.
2. Later, parser session summarization buckets all providers with
   `getShortModelName(call.model)`, which collapses many model variants into
   broad display buckets.
3. `buildJsonReport()` reads `session.modelBreakdown` keys directly, so once the
   model key is collapsed in the parser, the JSON report cannot recover the
   original full id.

### Code references

- Devin model extraction: `src/providers/devin.ts:getModelName()`
- Collapsing point: `src/parser.ts:buildSessionSummary()` using
  `getShortModelName(call.model)`
- JSON report output source: `src/main.ts:buildJsonReport()` iterating
  `session.modelBreakdown`

## Proposed Change

Apply provider-aware model-key bucketing during parser aggregation:

- Keep existing short-name bucketing for most providers.
- Preserve raw `call.model` for provider `devin`.

### Targeted code changes

1. **`src/parser.ts`**
   - In `buildSessionSummary()`, replace direct use of
     `getShortModelName(call.model)` with a small helper:
     - `if (call.provider === 'devin') return call.model`
     - otherwise return `getShortModelName(call.model)`.
   - Use this helper for `modelBreakdown` keying.

2. **`src/model-efficiency.ts`**
   - Apply the same provider-aware keying logic when computing model efficiency.
   - This keeps `editTurns/oneShotRate/costPerEdit` aligned with
     `modelBreakdown` names surfaced in JSON.

3. **`src/providers/devin.ts`** (for `codeburn models` command consistency)
   - Change `modelDisplayName(model)` to preserve the raw model id for Devin
     instead of re-shortening through `getShortModelName()`.
   - This avoids a separate path re-collapsing Devin variants in model-table
     output.

## Claude Comparison

Yes, Claude output is currently short-name grouped by design.

- Claude provider display uses `getShortModelName(model)`.
- Claude parser stores raw `message.model` on each call, but session-level model
  breakdown is still keyed through parser-wide short-name bucketing.

That is why Claude report JSON typically shows names like:

- `Opus 4.6`
- `Opus 4.8`
- `Haiku 4.5`

instead of raw ids such as `claude-opus-4-6`.

This proposal intentionally changes only Devin behavior.

## Expected Result

After implementation, Devin rows in `report --format json` should preserve full
model ids when available, for example:

- `gpt-5-3-codex-xhigh`

instead of a collapsed bucket such as:

- `GPT-5`

## Tests

1. **Provider parsing test**
   - Extend `tests/providers/devin.test.ts` with a call whose
     `generation_model` is a variant id (`gpt-5-3-codex-xhigh`) and assert that
     parsed call model remains exact.

2. **CLI JSON regression test**
   - Add a CLI integration test (similar style to `tests/cli-*.test.ts`) that:
     - writes a Devin transcript fixture
     - runs `codeburn --format json ...`
     - asserts `models[].name` contains `gpt-5-3-codex-xhigh`.

3. **Model-efficiency alignment test**
   - Add or extend a test to verify efficiency fields are computed under the
     same model key used by JSON model rows for Devin sessions.

## Risks / Trade-offs

- **Higher model-cardinality for Devin:** more distinct model rows (desired for
  forensic accuracy).
- **Mixed naming styles across providers:** Devin may show raw ids while Claude
  remains short-name grouped (intentional in this proposal).
- **No cache migration required:** cached turns already store raw `call.model`;
  the changed grouping is applied at summary-build time.
