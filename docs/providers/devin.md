# Devin

Cognition Devin CLI local usage tracking.

- **Source:** `src/providers/devin.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/devin.test.ts`, `tests/providers/devin-sessions-db.test.ts`

## Where it reads from

Devin CLI data lives under:

```text
~/.local/share/devin/cli/
```

The usage source is the CLI's SQLite store, opened read-only:

```text
~/.local/share/devin/cli/sessions.db
```

Transcript JSON is an export-only snapshot of a subset of that store:

```text
~/.local/share/devin/cli/transcripts/*.json
```

When `sessions.db` opens and has a `message_nodes` table, transcripts are not
read at all, so the two never double count. Transcripts are parsed only when the
database is missing or unusable (no SQLite, older build without
`message_nodes`); `sessions.db` then still enriches them when it can.

## sessions.db usage

One source per non-hidden session: `<sessions.db path>:<session id>`. The
parser reads `message_nodes` for that session in `node_id` keyset batches and
pulls only the JSON fields it needs, so tool output never reaches JS.

Each assistant node's `chat_message.metadata` supplies `request_id`,
`generation_model`, `created_at` (the call time; the row's `created_at` is not)
and `metrics`. `metrics.input_tokens` already excludes cache reads, so nothing
is carved out. `cache_read_tokens` and `cache_creation_tokens` may be null.

Devin stores each retry of a request as a sibling node with the same
`request_id` and identical metrics, so the request id is the dedup key. Nodes
off `sessions.main_chain_id` are distinct requests and count. `compactor` and
`cache_keepalive` requests are real calls and count too.

Tools come from `chat_message.tool_calls[].name`. The task text is the nearest
ancestor user node with `metadata.is_user_input = true` (a `cache_keepalive`
"continue" is not one), then `sessions.title`, then the first `prompt_history`
row. A locked database (`SQLITE_BUSY`) is rethrown so the refresh retries
instead of reading the store as empty.

## Configuration

None. Devin is priced from per-step tokens like every other provider, so it
needs no config to appear in CLI/UI results.

## Storage format

Transcript root is a JSON object following the [ATIF-v1.7 trajectory schema][atif],
with Devin-specific additions such as per-step `metadata` and `extra`. The
parser does not validate `schema_version`; it only requires a parseable object
with `steps[]`.

Core fields include `session_id`, `agent.model_name`, `agent.extra` (Devin
backend/permission info), `final_metrics`, and `steps[]`.

Steps now support two metric sources. The parser checks `step.metrics` first
(the standard ATIF location) and falls back to `step.metadata.metrics` (the
legacy Devin location). `committed_acu_cost` is ignored wherever it appears.

Messages can be a plain string or an array of `ContentPart` objects (text or
image), following the ATIF v1.6+ multimodal content model. The parser
normalises both forms when extracting user messages.

Each counted step can provide:

- `step_id`
- `metrics.prompt_tokens` (or `metadata.metrics.input_tokens`)
- `metrics.completion_tokens` (or `metadata.metrics.output_tokens`)
- `metrics.extra.cache_creation_input_tokens` (or `metadata.metrics.cache_creation_tokens`)
- `metrics.cached_tokens` (or `metadata.metrics.cache_read_tokens`)
- `metadata.created_at`
- `metadata.generation_model` (or `extra.generation_model`)
- `metadata.request_id`
- `tool_calls[].function_name`
- `observation.results[]` (tool output; not parsed for usage)

User steps (`source === "user"` or `metadata.is_user_input === true`) are skipped. Non-user
steps are included only if they have positive token usage.

## Pricing

Per step, from tokens and the model id, through `calculateCost()` — the same
pricing tables every other provider uses. The pricing id is
`metadata.generation_model` (or `extra.generation_model`), falling back to
`step.model_name`, `agent.model_name`, then `sessions.model`; a `MODEL_*`
placeholder is never used for pricing. `gpt-5-3-codex` style ids are rewritten
to `gpt-5.3-codex` before lookup, so they hit their own row instead of
collapsing to the base `gpt-5` price.

Transcript `metrics.prompt_tokens` is OpenAI-style, with the cached tokens
counted inside it, so the cached share is subtracted from input rather than
billed twice. Devin's own `metadata.metrics.input_tokens` (in `sessions.db` and
legacy transcripts) excludes cache reads and is used as is.

A model with no pricing row (today: `swe-2-high`, `swe-2-max`, `swe-2-medium`,
`compactor`) costs `$0` and warns once,
like any other unpriced model. It is never silently priced off a neighbouring
row.

`src/parser.ts` preserves Devin's provider-supplied `costUSD` instead of
re-pricing it, because the call carries Devin's display model name.

## sessions.db session columns

The provider reads these columns from `sessions`:

| Column              | Use                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                | source key; for transcripts, joined with `session_id` (discovery uses the filename before `.json`)          |
| `working_directory` | `projectPath` and derived project name                                                                      |
| `model`             | model fallback                                                                                              |
| `title`             | task text; project name fallback (falls back to the session's first `prompt_history` row when empty)         |
| `created_at`        | timestamp fallback                                                                                          |
| `last_activity_at`  | preferred session timestamp fallback                                                                        |
| `hidden`            | skip hidden sessions                                                                                        |

`prompt_history` supplies the task text for a session Devin has not titled yet.
`tool_call_state` is not parsed.

## Timestamps

Step timestamps come from `metadata.created_at`, falling back to
`sessions.last_activity_at`, then `sessions.created_at`.

Transcript step timestamps are passed through as ATIF string timestamps.
Numeric normalization is only applied to `sessions.db` timestamps:

- less than `10_000_000_000`: seconds
- otherwise: milliseconds

## Model Resolution

Model names (display and pricing) resolve in this order:

1. `step.metadata.generation_model`
2. `step.model_name`
3. `transcript.agent.model_name`
4. `sessions.model`
5. `devin`

## Caching

No provider-level cache.

A `sessions.db` source is fingerprinted with its `-wal` sibling, so any write
to the store reparses every session (about a second for 85 sessions). A
transcript source is always reparsed by `src/parser.ts`, because `sessions.db`
can change without the transcript JSON fingerprint changing.

## Deduplication

`devin:<sessionId>:<request_id>` for `sessions.db` (`node-<node_id>` when a
node has no request id), `devin:<sessionId>:<step.step_id>` for transcripts.

The provider name is part of the key via the `devin:` prefix.

## Quirks

- `committed_acu_cost` is null in current Devin builds and is ignored; cost comes from tokens.
- Token metrics can live in `step.metrics` (standard ATIF) or `step.metadata.metrics` (legacy Devin). The provider checks `step.metrics` first, falling back to `metadata`.
- Step messages can be a plain string or an array of `ContentPart` objects (text/image). The parser normalises both when extracting user messages.
- Real transcripts mark the user turn with `source: "user"`; older ones set `metadata.is_user_input`. Either marks a step as the user's, so it is skipped and used as task text.
- Hidden sessions from `sessions.db` are skipped in discovery and parsing.
- Tool names come directly from `tool_calls[].function_name`; the provider assumes valid ATIF tool-call records.
- If SQLite is unavailable or `sessions.db` cannot be opened, the provider still parses transcripts without enrichment.

## When fixing a bug here

1. For usage total bugs, compare against the store's distinct requests:

   ```bash
   sqlite3 -readonly ~/.local/share/devin/cli/sessions.db "SELECT count(DISTINCT json_extract(chat_message,'$.metadata.request_id')) FROM message_nodes WHERE json_extract(chat_message,'$.role')='assistant'"
   ```

2. For cost bugs, check which pricing row the step's `generation_model` hits;
   an unpriced model costs $0 by design.

3. If project/model/timestamp metadata is wrong, inspect `sessions.db`, not the transcript.
4. If a hidden session appears, check the `hidden` column. Discovery can only
   hide sessions whose transcript filename matches `sessions.id`; parsing uses
   the transcript `session_id` when present.
5. Run `tests/providers/devin.test.ts` and `tests/providers/devin-sessions-db.test.ts` after parser changes. It covers token pricing against the pricing tables, timestamp parsing, deduplication, hidden sessions, `sessions.db` enrichment, ATIF v1.7 multimodal messages, and `step.metrics` vs `metadata.metrics` priority.

[atif]: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
