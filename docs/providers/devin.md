# Devin

Cognition Devin CLI local usage tracking.

- **Source:** `src/providers/devin.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/devin.test.ts` (336 lines)

## Where it reads from

Devin CLI data lives under:

```text
~/.local/share/devin/cli/
```

The MVP usage source is transcript JSON:

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

Transcript root is a JSON object following the [ATIF-v1.4 trajectory schema][atif],
with Devin-specific additions such as per-step `metadata`. The parser does not
validate `schema_version`; it only requires a parseable object with `steps[]`.

Core fields include `session_id`, `agent.model_name`, and `steps[]`.

Each counted step can provide:

- `step_id`
- `metadata.committed_acu_cost`
- `metadata.metrics.input_tokens`
- `metadata.metrics.output_tokens`
- `metadata.metrics.cache_creation_tokens`
- `metadata.metrics.cache_read_tokens`
- `metadata.created_at`
- `metadata.generation_model`
- `metadata.request_id`
- `tool_calls[].function_name`

User-input steps (`metadata.is_user_input === true`) are skipped. Non-user
steps are included only if they have positive ACU usage or positive token usage.

## Pricing

`metadata.committed_acu_cost` is per step, not cumulative. The provider converts
each step with:

```text
costUSD = committed_acu_cost * devin.acuUsdRate
```

Token-only steps are still included when they have positive token metrics, but
their `costUSD` is `0` if `committed_acu_cost` is absent.

`src/parser.ts` preserves Devin's provider-supplied `costUSD` instead of
re-pricing it through LiteLLM.

## sessions.db enrichment

The provider currently reads these columns from `sessions`:

| Column              | Use                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                | join key with transcript `session_id` during parsing; discovery uses the transcript filename before `.json` |
| `working_directory` | `projectPath` and derived project name                                                                      |
| `model`             | model fallback                                                                                              |
| `title`             | project name fallback                                                                                       |
| `created_at`        | timestamp fallback                                                                                          |
| `last_activity_at`  | preferred session timestamp fallback                                                                        |
| `hidden`            | skip hidden sessions                                                                                        |

`message_nodes`, `prompt_history`, and `tool_call_state` are not parsed yet.

## Timestamps

Step timestamps come from `metadata.created_at`, falling back to
`sessions.last_activity_at`, then `sessions.created_at`.

Transcript step timestamps are passed through as ATIF string timestamps.
Numeric normalization is only applied to `sessions.db` timestamps:

- less than `10_000_000_000`: seconds
- otherwise: milliseconds

## Model Resolution

Model names resolve in this order:

1. `step.metadata.generation_model`
2. `step.model_name`
3. `transcript.agent.model_name`
4. `sessions.model`
5. `devin`

## Caching

No provider-level cache.

The normal session cache stores parsed provider calls, but Devin is always
reparsed by `src/parser.ts` because `sessions.db` can change without the
transcript JSON fingerprint changing.

## Deduplication

`devin:<sessionId>:<step.step_id>`

The provider name is part of the key via the `devin:` prefix.

## Quirks

- The transcript directory has usage; `sessions.db` is enrichment only.
- `committed_acu_cost` is per-generation/per-step ACU usage. Never treat it as cumulative.
- There is no default ACU-to-USD rate. Missing config intentionally hides Devin.
- Hidden sessions from `sessions.db` are skipped in discovery and parsing.
- Tool names come directly from `tool_calls[].function_name`; the provider assumes valid ATIF tool-call records.
- If SQLite is unavailable or `sessions.db` cannot be opened, the provider still parses transcripts without enrichment.

## When fixing a bug here

1. First check whether `~/.config/codeburn/config.json` contains a valid
   `devin.acuUsdRate`. Without it, no Devin sessions should appear.
2. For usage total bugs, compare against:

   ```bash
   jq '[.steps[] | select(.metadata.committed_acu_cost != null) | .metadata.committed_acu_cost] | add' ~/.local/share/devin/cli/transcripts/<session>.json
   ```

3. If project/model/timestamp metadata is wrong, inspect `sessions.db`, not the transcript.
4. If a hidden session appears, check the `hidden` column. Discovery can only
   hide sessions whose transcript filename matches `sessions.id`; parsing uses
   the transcript `session_id` when present.
5. Run `tests/providers/devin.test.ts` after parser changes. It covers ACU conversion, disabled-until-configured behavior, timestamp parsing, deduplication, hidden sessions, and `sessions.db` enrichment.

[atif]: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
