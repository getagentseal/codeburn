# Command Code

Command Code (`cmd`), Langbase's coding agent CLI ([commandcode.ai](https://commandcode.ai), npm `command-code`).

- **Source:** `src/providers/command-code.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/command-code.test.ts`, fixture `tests/fixtures/command-code/` (redacted real transcripts)

## Where it reads from

`~/.commandcode/projects/<project-slug>/<session-id>.jsonl`. `CODEBURN_COMMANDCODE_DIR` replaces `~/.commandcode`; the CLI itself has no override and follows `HOME`.

Only `<id>.jsonl` files are sessions. The CLI writes sidecars next to each one (`.checkpoints.jsonl`, `.prompts.jsonl`, `.meta.json`, `.share.json`), and discovery skips any file whose name has a second dot. `~/.commandcode/history.jsonl` is prompt history and is never read, nor is anything else outside `projects/`.

## Storage format

JSONL, session format v3:

- First line: `{type: "session", version, id, timestamp, cwd, parentSession?}`.
- Then `{type: "message", id, parentId, timestamp, message: {role, content, meta: {messageId}}, model?, usage?}`. `content` is a string or an array of `text`, `thinking`, `tool_use` and `tool_result` blocks.
- Assistant lines carry `model` (e.g. `moonshotai/Kimi-K3`, `deepseek/deepseek-v4-pro`) and `usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}`.

## Token model

One call per assistant `message` line with `usage`.

- **`usage.inputTokens` includes `cacheReadTokens`.** CodeBurn's input is fresh input, so it stores `inputTokens - cacheReadTokens` (never below 0). Taking `inputTokens` as is counts every cache read twice. Checked on real data: `inputTokens >= cacheReadTokens` on every call, and `costUsd` fits one set of per-token rates only when input is taken as cache-inclusive.
- `cacheReadTokens` and `cacheWriteTokens` map to cache read and cache write.
- `outputTokens` already includes reasoning (no separate count), so `reasoningTokens` is 0.

## Pricing

`costUsd` is the dollars Command Code charged for the call (its own rates, e.g. DeepSeek at the discounted price). When it is present, including `0` for free models, it is kept as is with `costFromBilling`. A call without it is priced from tokens through the shared catalog and marked `costIsEstimated`; a model id the catalog does not know shows up under `codeburn models --unpriced`.

## Deduplication

`command-code:<message.meta.messageId>`, a full uuid. The top-level `id` is only 8 hex characters and unique within one file, so sessions can collide on it; it is used only as a fallback and for `turnId`. Forking a session copies the parent's message lines verbatim into a new session file, so the key is not scoped to a session.

## Quirks

- Project is the last segment of the session header's `cwd`, falling back to the slug directory.
- Tool names are Command Code's own (`shell_command`, `read_file`, `grep`, `agent`, ...) and are mapped to CodeBurn's names. `agent` calls with a `subagent_type` count as subagents; `activate_skill` counts as a skill.

## When fixing a bug here

1. Discovery: the `projects/<slug>/<id>.jsonl` walk and the sidecar filter.
2. Accounting: the input/cache split above. Recheck it against `costUsd` if the CLI changes its usage block.
3. Add a case to `tests/providers/command-code.test.ts`; do not mock the filesystem.
