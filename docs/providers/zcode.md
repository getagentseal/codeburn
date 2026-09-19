# ZCode

ZCode CLI coding agent (z.ai), running GLM-5.2 over the z.ai start-plan.

- **Source:** `src/providers/zcode.ts` (usage), `src/quota/zcode.ts` + `app/electron/quota/zcode.ts` (plan quota)
- **Loading:** lazy (`src/providers/index.ts`). Lazy because we read ZCode's SQLite database with `node:sqlite`.
- **Test:** `tests/providers/zcode.test.ts` (usage, fixture-based), `tests/quota-zcode.test.ts` / `app/electron/quota/zcode.test.ts` (quota)

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

## Plan quota (live)

The Plans sidebar gauge reads the same usage endpoint the ZCode app's embedded
coding-plan browser calls — the sibling of the `zai` quota provider, which
serves the Pi CLI login; this one serves the ZCode desktop app's own login.

| Source | Path / endpoint |
|---|---|
| Login token | `…/ZCode/session/Partitions/zcode-coding-plan/Local Storage/leveldb/*.log`, key `oauth:zai:access_token` (`ZCODE_DATA_DIR` overrides the app-data root) |
| Quota | `GET https://api.z.ai/api/monitor/usage/quota/limit` with `Authorization: Bearer <token>` |

- **Journal scan, not a leveldb reader.** The token is a single-byte (latin-1)
  string run in the journal file(s): `key + varint length + 0x01 marker + value`.
  We scan `*.log` newest-first (journal names are zero-padded counters) and keep
  the last write of the key. Chromium owns the file's mode bits, so this is a
  plain capped read — `readSecureFile` would reject its group-readable mode.
- **No local expiry.** The stored JWT carries no `exp` claim; validity is
  enforced server-side. A body-level `code: 401/403` on an HTTP 200 is the
  expiry signal → `terminalFailure` with "Open the ZCode app and sign in
  again" guidance (only the app can mint a new login).
- **Compaction is the known blind spot.** When leveldb compacts the journal
  into `.ldb` the records are snappy-compressed and invisible to the raw scan;
  the gauge falls back to `disconnected` until the webview writes a fresh
  journal entry.
- **All surfaces.** The CLI reads it in `src/quota/zcode.ts`, the Electron app
  in `app/electron/quota/zcode.ts`, and the native macOS menubar mirrors both in
  `mac/Sources/CodeBurnMenubar/Data/ZcodeSubscriptionService.swift` (same journal
  scan, same endpoint; catalog id `zcode`, live Capacity Dock adapter).
- **Windows map** as in `zai.ts`: `unit 3 × number 5` → 5-hour,
  `unit 6 × number 1` → Weekly; `percentage` is used percent (fallback
  `currentValue / usage`); `data.level` is the plan label (`"pro"` → "Pro").

## When fixing a bug here

1. Confirm the schema against a real ZCode install; copy `~/.zcode/cli/db/db.sqlite` to a temp file before querying so you do not lock the live db.
2. If costs are $0, check that `GLM-5.2` (or the current model id) still resolves through `BUILTIN_ALIASES` to a priced model.
3. If tokens look ~8x too high, someone likely removed the cache-subtraction in the input normalization; the row's `input_tokens` already includes cached tokens.
4. New fixtures go under the inline schema in `tests/providers/zcode.test.ts`.
5. If the quota gauge shows `disconnected` while the app is logged in, check whether the journal was compacted into `.ldb` (no usable `*.log` entry) and whether the key is still `oauth:zai:access_token`.
