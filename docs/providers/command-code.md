# Command Code

Command Code (`cmd`) — the coding agent CLI that learns your taste. Sessions it runs locally are read from the on-disk transcripts.

- **Source:** `src/providers/command-code.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/command-code.test.ts`

## Where it reads from

| Source | Path |
|---|---|
| Command Code CLI | `<root>/projects/<project-slug>/<session-uuid>.jsonl` |

`root` is `$CODEBURN_COMMANDCODE_DIR` when set, otherwise `~/.commandcode`. Each project gets a slug directory (the working directory with separators replaced), and each session is one JSONL transcript.

Discovery walks `projects/<slug>/*.jsonl` and **skips every `*.checkpoints.jsonl`** sibling — those files hold rewind checkpoints, not API usage.

## Storage format

JSONL, one record per line:

- A leading `session` record: `{type:"session", version, id, timestamp, cwd}` — carries the session id and starting cwd.
- `message` records: `{type:"message", id, parentId, timestamp, message:{role, content, meta}, model?, usage?}`. Assistant messages carry `model` and a `usage` block; user messages carry the prompt text and `tool_result` blocks.

`usage` fields: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd`.

## Parser

One call per `message` line whose `message.role` is `assistant` **and** that carries a `usage` object (the exact line that also carries `model`). Parser-generated "Loaded N tool schema(s)" user lines and every tool result are ignored. `content[].type === "tool_use"` blocks become tool calls.

## Cost

The tool records its own per-call `costUsd`. It is treated as a metered cost: `costIsEstimated: false`, and `costFromBilling: true` on the `ParsedProviderCall` so `parser.ts` stores it verbatim through the session cache instead of re-pricing from tokens. It is a **presence** check, not a truthiness check — a metered `0` (free/cached call) stays reported. When `costUsd` is absent, the call is priced from tokens via `calculateCost` and flagged `costIsEstimated: true`.

Adding this provider bumps its `PROVIDER_PARSE_VERSIONS` entry (`reported-cost-v1`) so any earlier cached entries re-parse.

## Caching

Standard per-provider session cache. `PROVIDER_ENV_VARS['command-code'] = ['CODEBURN_COMMANDCODE_DIR']` so an override moves the corpus fingerprint.

## Deduplication key

`command-code:<sessionId>:<messageId>` — `sessionId` from the `session` record (file basename fallback), `messageId` from the line's `id`.

## Quirks

- The project name shown is the **basename of the first cwd** seen in the transcript, falling back to the discovery slug directory.
- Tool names are Command Code's native snake_case ids (`shell_command`, `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `read_directory`, `todo_write`, `activate_skill`, `agent`, `web_search`, `web_fetch`, `ask_user_question`). They are mapped to CodeBurn-canonical names in `command-code.ts`; `mcp__*` ids pass through unchanged.
- `timestamp` is an ISO string in practice; `isoTimestamp` still promotes an epoch value (seconds→milliseconds) and rejects anything implausible.

## When fixing a bug here

1. Confirm whether the bug is **discovery** (sessions not picked up) or **parsing** (sessions found but data wrong).
2. Discovery lives in `createCommandCodeProvider().discoverSessions` — verify the `projects/<slug>/` layout against what `cmd` writes today.
3. Parsing lives in `createParser` — check the record shape the installed `cmd` version emits (it can change between releases).
4. Add a fixture under `tests/providers/command-code.test.ts`. Do not mock the filesystem.
