# Hermes

Hermes Agent, the Nous Research CLI agent (https://hermes-agent.nousresearch.com).

- **Source:** `src/providers/hermes.ts`
- **Loading:** lazy (`src/providers/index.ts`)
- **Test:** none directly. Verified manually against a real `~/.hermes/sessions/` directory; a dedicated fixture-based test is on the contributor's follow-up list.

## Where it reads from

`~/.hermes/sessions/` (`hermes.ts:60-66`). Three file prefixes live in that directory; only two are conversation data:

| Prefix | What it is | Parsed? |
|---|---|---|
| `session_YYYYMMDD_HHMMSS_<hex>.json` | Conversation transcript | yes |
| `session_bg_<HHMMSS>_<hex>.json` | Background-task session (same schema) | yes, tagged as the `hermes-background` project |
| `request_dump_*.json` | Captured failed HTTP request (no usage data) | no |

The `request_dump_*.json` skip is intentional. Those files can contain captured upstream request bodies, so reading them into the dashboard would be a privacy regression for users who run Hermes with sensitive prompts. They are also missing the conversation transcript structure, so they would only ever surface as zero-tool-call rows.

## Storage format

JSON, one object per file, per session (`hermes.ts:42-57`). Top-level fields used by the parser:

- `session_id`, `model`, `base_url`, `platform`
- `session_start`, `last_updated`
- `tools[]` (the agent's tool inventory — not per-turn)
- `messages[]` (the conversation; roles are `user`, `assistant`, `tool`)
- `message_count` (denormalized count; not relied on)

`messages[].tool_calls[]` carries:

```jsonc
{
  "id": "call_…",
  "type": "function",
  "function": {
    "name": "skill_view",                          // plaintext
    "arguments": "{\"name\":\"hermes-agent\"}"      // plaintext JSON-encoded string
  }
}
```

Tool-call arguments are plaintext JSON in every session sampled on 2026-06-10 across 9 files and 10 tool calls. (Adjacent `codex_reasoning_items[*].encrypted_content` blobs are reasoning text and are not touched by the parser.)

## Caching

None at the provider level. The daily aggregation cache (`src/daily-cache.ts`) reuses prior computed days.

## Deduplication

Per session: `hermes:<session.session_id>` (`hermes.ts:153`). Two files cannot collide because Hermes session IDs include a timestamp + 8-character hex suffix.

## What we extract

| codeburn field | Hermes source |
|---|---|
| `sessionId` | `session.session_id` |
| `model` | `session.model` (e.g. `gpt-5.5`, `openai/gpt-5.5-pro`, `gemma4:e4b`) |
| `timestamp` | `session.last_updated`, falling back to `session.session_start` |
| `userMessage` | First `user` message content, truncated to 500 chars |
| `tools` | Distinct tool names from `messages[].tool_calls[].function.name`, mapped via `toolNameMap` (`hermes.ts:11-37`) |
| `bashCommands` | `command` field of any Bash-mapped tool call, split by `extractBashCommands` |
| `project` | `hermes` (foreground) or `hermes-background` |

`inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, and `webSearchRequests` are all emitted as `0` because the source data does not contain them (see Quirks). `costUSD` is `0` except for models in `pricing-fallback.json` (e.g. `hermes-4-70b` and `hermes-4-405b`, which are already in the bundled LiteLLM snapshot as of v0.9.12).

## Quirks

- **No per-turn usage is persisted locally.** Hermes forwards each request to the upstream provider (OpenAI / Anthropic / OpenRouter / Ollama / etc.) and the response's `usage` block is consumed by the agent but not written back to `~/.hermes/sessions/`. As a result, every Hermes row in the dashboard shows `0 in / 0 out / 0 cached / $0 cost`, with `costIsEstimated: true` for models not in the pricing tables. This is an upstream gap, not a parser bug. For real Hermes spend, use the upstream provider's usage dashboard (OpenRouter → Activity; OpenAI → platform.openai.com/usage).
- **`request_dump_*.json` files are deliberately skipped.** They are captured failed HTTP requests, not conversations. They would skew the dashboard with error noise and, in some cases, contain captured upstream request bodies. They are skipped in `discoverInDir` (`hermes.ts:243-245`).
- **Background sessions are split into a separate project.** `session_bg_*.json` files are tagged as the `hermes-background` project in `discoverInDir` (`hermes.ts:255-260`) so that long-running background tasks do not mix with foreground sessions in the By Project and Daily Activity panels.
- **Encrypted reasoning is not parsed.** `messages[].codex_reasoning_items[*].encrypted_content` is a Hermes-internal encrypted reasoning blob and is intentionally not touched. The parser only reads `messages[].tool_calls[].function`, which is plaintext.
- **Timestamps are session-level, not message-level.** Hermes writes `session_start` and `last_updated` once per file; individual messages are not timestamped. All rows in a session are emitted with the same `timestamp`, which is correct for session-level analytics but means the `Daily Activity` chart is session-grained (not turn-grained).

## When fixing a bug here

1. If discovery returns no sessions, confirm `~/.hermes/sessions/` exists and that filenames start with `session_` (not `session_bg_` only, and not `request_dump_`).
2. If a session is found but shows no tool calls, check `messages[].tool_calls[]` in the raw file — Hermes encrypts `codex_reasoning_items` but does not encrypt tool-call arguments, so missing `tools` usually means the session ended before any tool was invoked.
3. If a model is mispriced, run `CODEBURN_VERBOSE=1 codeburn report --provider hermes --format json` to see which model names are missing from the pricing tables. Map unknown models to a known baseline with `codeburn model-alias "<hermes-model>" <baseline-model>`.
4. If a tool name shows up under "Other" in the Core Tools panel, add it to `toolNameMap` at the top of `hermes.ts`. Unmapped names pass through unchanged on purpose, but a mapping makes the dashboard grouping more useful.
