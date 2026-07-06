# ZCode

ZCode CLI coding agent (z.ai), running GLM-5.2 over the z.ai start-plan.

- **Source:** `src/providers/zcode.ts`
- **Loading:** lazy (`src/providers/index.ts`). Lazy because we read ZCode's SQLite database with `node:sqlite`.
- **Test:** `tests/providers/zcode.test.ts` (3 tests, fixture-based)

## Where it reads from

ZCode keeps a single global SQLite database for the CLI.

| Source | Path |
|---|---|
| ZCode CLI db | `~/.zcode/cli/db/db.sqlite` |

The desktop app dir (`~/Library/Application Support/ZCode`) only holds Electron runtime state, and the JSONL activity log (`~/.zcode/cli/log/*.jsonl`) redacts token counts, so neither is used.

## Storage format

SQLite. Schema verified against CLI db v0.14.8. Three tables matter:

```sql
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  ...
);

CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  ...
);

CREATE TABLE tool_usage (
  session_id TEXT NOT NULL,
  turn_id TEXT,
  tool_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ...
);
```

## Caching

None at the provider level.

## Deduplication

Per `zcode:<model_usage.id>` (`zcode.ts`). `model_usage.id` is the row primary key, unique per request.

## What we extract

| codeburn field | ZCode source |
|---|---|
| `inputTokens` | `model_usage.input_tokens` minus cached + created (see quirks) |
| `outputTokens` | `model_usage.output_tokens` |
| `reasoningTokens` | `model_usage.reasoning_tokens` |
| `cacheCreationInputTokens` | `model_usage.cache_creation_input_tokens` |
| `cacheReadInputTokens` | `model_usage.cache_read_input_tokens` |
| `costUSD` | computed by `calculateCost` (ZCode stores no cost) |
| `model` | `model_usage.model_id` (e.g. `GLM-5.2`) |
| `timestamp` | `model_usage.completed_at` if set, otherwise `started_at` (epoch ms) |
| `tools` | `tool_usage.tool_name` for the turn, attached to one request per turn |

## Quirks worth knowing

- **Cached tokens are folded into `input_tokens` (OpenAI-style).** The row's `input_tokens` is the full prompt size including cache reads/writes, and `provider_total_tokens = input_tokens + output_tokens`. The parser subtracts `cache_read_input_tokens` and `cache_creation_input_tokens` from `input_tokens` so fresh input bills at the input rate and cached at the cache-read rate. Confirmed against the nested Anthropic usage in `provider_metadata_json` (e.g. 100 input = 36 fresh + 64 cached).
- **No cost is stored anywhere.** GLM-5.2 runs on z.ai's `start-plan` subscription, so ZCode logs tokens only. CodeBurn computes a notional cost from the pricing table.
- **GLM-5.2 is priced via an alias.** LiteLLM does not list GLM-5.2 yet, so `GLM-5.2` maps to `glm-5p1` (GLM-5.1) in `BUILTIN_ALIASES` (`src/models.ts`). Reports therefore show the model as `glm-5p1`, the same way any aliased model displays as its priced-as target. Drop the alias once LiteLLM adds GLM-5.2.
- **Timestamps are milliseconds.** Unlike Crush (seconds), ZCode stores epoch ms; the parser passes them straight to `Date`.
- **Tools are attached per turn, not per request.** `tool_usage` links to a turn, not a specific `model_usage` row, so each turn's tools are attached to its first request to avoid double-counting. Bash command text is not stored, so `bashCommands` is always empty.

## When fixing a bug here

1. Confirm the schema against a real ZCode install; copy `~/.zcode/cli/db/db.sqlite` to a temp file before querying so you do not lock the live db.
2. If costs are $0, check that `GLM-5.2` (or the current model id) still resolves through `BUILTIN_ALIASES` to a priced model.
3. If tokens look ~8x too high, someone likely removed the cache-subtraction in the input normalization; the row's `input_tokens` already includes cached tokens.
4. New fixtures go under the inline schema in `tests/providers/zcode.test.ts`.
