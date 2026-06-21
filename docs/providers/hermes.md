# Hermes

Nous Research Hermes Agent (desktop + CLI), recording per-session usage in a single global SQLite database.

- **Source:** `src/providers/hermes.ts`
- **Loading:** lazy (`src/providers/index.ts`). Lazy because we read Hermes's SQLite database with `node:sqlite`.
- **Test:** `tests/providers/hermes.test.ts` (7 tests, fixture-based)

## Where it reads from

Hermes keeps a single global SQLite database for all sessions, CLI and desktop alike.

| Source | Path |
|---|---|
| Hermes state db | `~/.hermes/state.db` |

## Storage format

SQLite. Schema verified against state.db on 2026-06-21. One table matters:

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- 'cli' | 'photon' (desktop) | ...
    model TEXT,
    model_config TEXT,
    started_at REAL NOT NULL,        -- Unix seconds (fractional ms precision)
    ended_at REAL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,                -- 'estimated' | 'unknown' | ('actual' ...)
    cost_source TEXT,                -- 'official_docs_snapshot' | 'none' | ...
    cwd TEXT,
    title TEXT,
    parent_session_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    ...
);
```

Each row is one session with aggregated token counts across all of its API calls. One row maps to one `ParsedProviderCall`. Discovery emits one source for the database, then parsing opens SQLite once and reads all eligible rows from that connection.

## Cost resolution

Hermes prices its own sessions when it can. The provider honors those figures and only falls back to codeburn's pricing table when Hermes could not price the session:

| `cost_status` | columns used | `costIsEstimated` |
|---|---|---|
| `actual` (or any with a positive `actual_cost_usd`) | `actual_cost_usd` | `false` |
| `estimated` (positive `estimated_cost_usd`) | `estimated_cost_usd` | `true` |
| `unknown` / missing / zero | computed via `calculateCost` | `true` |

`cost_status = 'unknown'` carries a `0.0` sentinel in `estimated_cost_usd`, not a real estimate, so it always falls through to the pricing table.
Fallback pricing includes `reasoning_tokens` at the model output-token rate. Rows with zero tokens are still kept when `estimated_cost_usd` or `actual_cost_usd` is positive so stored spend is not dropped.

## Caching

None at the provider level. Codeburn's normal file cache fingerprints the SQLite database path; Hermes no longer creates synthetic per-row source paths.

## Deduplication

Per `hermes:<sessions.id>` (`hermes.ts`). `id` is the row primary key, unique per session.

## What we extract

| codeburn field | Hermes source |
|---|---|
| `inputTokens` | `sessions.input_tokens` (fresh input; cache is separate) |
| `outputTokens` | `sessions.output_tokens` |
| `reasoningTokens` | `sessions.reasoning_tokens` |
| `cacheCreationInputTokens` | `sessions.cache_write_tokens` |
| `cacheReadInputTokens` | `sessions.cache_read_tokens` |
| `costUSD` | `actual_cost_usd` / `estimated_cost_usd` per `cost_status`, else `calculateCost` |
| `model` | `sessions.model` (e.g. `deepseek-v4-pro`, `glm-5.2`, `claude-opus-4-8`) |
| `timestamp` | `sessions.ended_at` if set, otherwise `started_at` (Unix seconds) |
| `project` | slug of `sessions.cwd` (falls back to `hermes` when `cwd` is null) |

## Quirks worth knowing

- **Tokens are Anthropic-style, not OpenAI-style.** Unlike ZCode, Hermes stores fresh input and cache reads in separate columns (`input_tokens` does NOT include cached tokens). The parser passes `input_tokens` straight through as fresh input; no subtraction. Confirmed by real data where `input_tokens` (146279) is smaller than `cache_read_tokens` (388352), which is impossible if input folded in cache.
- **Timestamps are Unix seconds (REAL), not milliseconds.** Unlike ZCode (epoch ms), Hermes stores `started_at`/`ended_at` as fractional seconds (e.g. `1782064165.92`). The parser multiplies by 1000 before constructing a `Date`.
- **Hermes's own estimate differs from codeburn's.** Hermes prices from its `official_docs_snapshot` pricing version, which does not match codeburn's bundled LiteLLM data. When `cost_status = 'estimated'`, the provider trusts Hermes's `estimated_cost_usd` rather than recomputing, so reports reflect what the agent actually charged.
- **`glm-5.2` is priced via an alias.** Hermes stores its model id lowercased (`glm-5.2`); ZCode uses the capitalized `GLM-5.2`. LiteLLM lists neither, so both map to `glm-5p1` (GLM-5.1) in `BUILTIN_ALIASES` (`src/models.ts`). Reports therefore show the model as `glm-5p1`. Drop the aliases once LiteLLM adds GLM-5.2.
- **No tool/command text is stored per session.** `tool_call_count` and `api_call_count` are present as aggregates but individual tool names and bash commands are not, so `tools` and `bashCommands` are always empty.
- **Sub-agent / handoff sessions** are linked via `parent_session_id`, and `archived` flags sessions the user dismissed. The provider includes every session regardless of either flag, because each row carries its own aggregated usage and codeburn's stance is that spend is never dropped. (As of 2026-06-21 no real row sets `parent_session_id` or `archived`.)

## When fixing a bug here

1. Confirm the schema against a real Hermes install: `sqlite3 ~/.hermes/state.db '.schema sessions'`. Copy the db to a temp file before querying so you do not lock the live db.
2. If costs are $0 for sessions that should have them, check `cost_status`: only `unknown` (and missing/zero) rows fall through to `calculateCost`; `estimated`/`actual` rows honor the stored column. Verify the column is populated and positive.
3. If a `cost_status = 'unknown'` row still shows $0, check that the `model` resolves through `BUILTIN_ALIASES` to a priced model (e.g. `glm-5.2` -> `glm-5p1`).
4. If token counts look ~8x too high, do NOT add cache subtraction here. Hermes `input_tokens` is already fresh input; cached tokens live in `cache_read_tokens` / `cache_write_tokens`.
5. New fixtures go under the inline schema in `tests/providers/hermes.test.ts`.
