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

Transcript root is a JSON object following the [ATIF-v1.7 trajectory schema][atif],
with Devin-specific additions such as per-step `metadata` and `extra`. The
parser does not validate `schema_version`; it only requires a parseable object
with `steps[]`.

Core fields include `session_id`, `agent.model_name`, `agent.extra` (Devin
backend/permission info), `final_metrics`, and `steps[]`.

Steps now support two metric sources. The parser checks `step.metrics` first
(the standard ATIF location) and falls back to `step.metadata.metrics` (the
legacy Devin location). Similarly, ACU cost is read from
`step.metadata.committed_acu_cost` first, falling back to
`step.extra.committed_acu_cost`.

Messages can be a plain string or an array of `ContentPart` objects (text or
image), following the ATIF v1.6+ multimodal content model. The parser
normalises both forms when extracting user messages.

Each counted step can provide:

- `step_id`
- `metadata.committed_acu_cost` (or `extra.committed_acu_cost`)
- `metrics.prompt_tokens` (or `metadata.metrics.input_tokens`)
- `metrics.completion_tokens` (or `metadata.metrics.output_tokens`)
- `metrics.extra.cache_creation_input_tokens` (or `metadata.metrics.cache_creation_tokens`)
- `metrics.cached_tokens` (or `metadata.metrics.cache_read_tokens`)
- `metadata.created_at`
- `metadata.generation_model` (or `extra.generation_model`)
- `metadata.request_id`
- `tool_calls[].function_name`
- `observation.results[]` (tool output; not parsed for usage)

User-input steps (`metadata.is_user_input === true`) are skipped. Non-user
steps are included only if they have positive ACU usage or positive token usage.

## Pricing

ACU cost is per step, not cumulative. The provider reads
`metadata.committed_acu_cost` first, falling back to
`extra.committed_acu_cost`, then converts with:

```text
costUSD = committed_acu_cost * devin.acuUsdRate
```

Token-only steps are still included when they have positive token metrics, but
their `costUSD` is `0` if `committed_acu_cost` is absent from both locations.

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
- `committed_acu_cost` is per-generation/per-step ACU usage. Never treat it as cumulative. It can appear in `metadata` (legacy) or `extra` (ATIF v1.7); the provider checks both.
- Token metrics can live in `step.metrics` (standard ATIF) or `step.metadata.metrics` (legacy Devin). The provider checks `step.metrics` first, falling back to `metadata`.
- Step messages can be a plain string or an array of `ContentPart` objects (text/image). The parser normalises both when extracting user messages.
- There is no default ACU-to-USD rate. Missing config intentionally hides Devin.
- Hidden sessions from `sessions.db` are skipped in discovery and parsing.
- Tool names come directly from `tool_calls[].function_name`; the provider assumes valid ATIF tool-call records.
- If SQLite is unavailable or `sessions.db` cannot be opened, the provider still parses transcripts without enrichment.

## When fixing a bug here

1. First check whether `~/.config/codeburn/config.json` contains a valid
   `devin.acuUsdRate`. Without it, no Devin sessions should appear.
2. For usage total bugs, compare against (ACU cost can live in `metadata` or `extra`):

   ```bash
   jq '[.steps[] | select(.metadata.is_user_input != true) | (.metadata.committed_acu_cost // .extra.committed_acu_cost // 0)] | add' ~/.local/share/devin/cli/transcripts/<session>.json
   ```

3. If project/model/timestamp metadata is wrong, inspect `sessions.db`, not the transcript.
4. If a hidden session appears, check the `hidden` column. Discovery can only
   hide sessions whose transcript filename matches `sessions.id`; parsing uses
   the transcript `session_id` when present.
5. Run `tests/providers/devin.test.ts` after parser changes. It covers ACU conversion, disabled-until-configured behavior, timestamp parsing, deduplication, hidden sessions, `sessions.db` enrichment, ATIF v1.7 multimodal messages, `step.metrics` vs `metadata.metrics` priority, and `extra.committed_acu_cost` fallback.

[atif]: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
