# Devin

Cognition Devin CLI local usage tracking.

- **Source:** `src/providers/devin.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/devin.test.ts`

## Where it reads from

Devin CLI data lives under:

```text
~/.local/share/devin/cli/
```

Usage comes from transcript JSON:

```text
~/.local/share/devin/cli/transcripts/*.json
```

The provider also reads:

```text
~/.local/share/devin/cli/sessions.db
```

`sessions.db` is enrichment only. It supplies project path/name, model fallback,
timestamp fallback, and hidden-session filtering. It is not the source of usage
or billing.

## Configuration

Devin reports spend in ACUs. CodeBurn reports provider cost through `costUSD`,
so Devin stays disabled until a positive finite ACU-to-USD rate is configured:

```json
{
  "devin": {
    "acuUsdRate": 2.25
  }
}
```

The config file is:

```text
~/.config/codeburn/config.json
```

The macOS Settings window writes this value from the Devin tab. There is no
environment-variable override and no default rate. Do not hardcode a universal
ACU price; Devin ACU pricing is account/contract dependent.

When the rate is missing or invalid, `discoverSessions()` returns `[]` and the
parser yields no calls. Devin remains registered as a provider, but it does not
appear in CLI/UI results until configured.

## Storage format

CodeBurn supports ATIF transcript variants used by Devin across **ATIF-v1.5**, **ATIF-v1.6**, and **ATIF-v1.7** (and remains backward-compatible with older Devin transcripts that still use v1.4-style field names).

The parser does not hard-fail on `schema_version`; it parses any object root
with a `steps[]` array.

### Field normalization

The provider normalizes equivalent usage fields across versions:

- **Cost inputs (ACU before conversion to USD):**
  - `metadata.committed_acu_cost`
  - `extra.committed_acu_cost`
  - `metadata.committed_credit_cost / 10000`
  - `extra.committed_credit_cost / 10000`
- **Input tokens:**
  - legacy: `metadata.metrics.input_tokens`
  - newer prompt-style: `metrics.prompt_tokens - cache_read - cache_creation`
- **Output tokens:**
  - `metrics.output_tokens` or `metrics.completion_tokens`
- **Cache write tokens:**
  - `metrics.cache_creation_tokens`
  - `metrics.cache_creation_input_tokens`
  - `metrics.extra.cache_creation_input_tokens`
- **Cache read tokens:**
  - `metrics.cache_read_tokens`
  - `metrics.cache_read_input_tokens`
  - `metrics.cached_tokens`
  - `metrics.extra.cache_read_input_tokens`

### User/agent step detection

- User steps are skipped when either:
  - `metadata.is_user_input === true` (older exports)
  - `source === "user"` (ATIF step source)
- Non-user steps are included only when they contain positive ACU usage or
  positive token usage.

### Session, model, and timestamp fallback

- **sessionId:** `session_id` -> `trajectory_id` -> transcript filename
- **model:** `step.extra.generation_model` -> `step.metadata.generation_model` -> `step.model_name` -> `agent.model_name` -> `sessions.model` -> `devin`
- **timestamp:** `step.metadata.created_at` -> `step.timestamp` -> `sessions.last_activity_at` -> `sessions.created_at`

## Pricing

`costUSD` is always provider-supplied and uses configured ACU conversion:

```text
costUSD = committed_acu_cost * devin.acuUsdRate
```

If a step only has `committed_credit_cost`, CodeBurn converts credits to ACU
using Devin's current export convention:

```text
committed_acu_cost = committed_credit_cost / 10000
```

Token-only steps are still included when they have positive token metrics, but
their `costUSD` is `0` if no committed cost is present.

`src/parser.ts` preserves Devin's provider-supplied `costUSD` instead of
re-pricing it through LiteLLM.

## sessions.db enrichment

The provider reads these columns from `sessions`:

| Column              | Use                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `id`                | join key with transcript session id during parsing; discovery uses transcript filename before `.json`      |
| `working_directory` | `projectPath` and derived project name                                                                       |
| `model`             | model fallback                                                                                               |
| `title`             | project name fallback                                                                                        |
| `created_at`        | timestamp fallback                                                                                           |
| `last_activity_at`  | preferred session timestamp fallback                                                                         |
| `hidden`            | skip hidden sessions                                                                                         |

## Deduplication

`devin:<sessionId>:<step.step_id>`

When `step_id` is missing, parser falls back to 1-based step index.

## Quirks

- Transcript JSON is the usage source; `sessions.db` only enriches metadata.
- There is no default ACU-to-USD rate. Missing config intentionally hides Devin.
- Hidden sessions from `sessions.db` are skipped in discovery and parsing.
- Tool names are taken from either `tool_calls[].function_name` or
  `tool_calls[].function.name`.
- If SQLite is unavailable or `sessions.db` cannot be opened, transcript parsing
  still works without enrichment.

## When fixing a bug here

1. Confirm `~/.config/codeburn/config.json` contains a valid positive
   `devin.acuUsdRate`.
2. Validate a transcript step's raw usage fields first (cost + token fields).
3. If project/model/timestamp metadata is wrong, inspect `sessions.db`.
4. Run `tests/providers/devin.test.ts` after parser changes.

[atif]: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
