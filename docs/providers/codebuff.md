# Codebuff

Codebuff (formerly Manicode) local chat history and usage.

- **Source:** `src/providers/codebuff.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/codebuff.test.ts`

## Where it reads from

`$CODEBUFF_DATA_DIR` when set, otherwise all three local channels:

```text
~/.config/manicode/projects/<project>/chats/<chat-id>/
~/.config/manicode-dev/projects/<project>/chats/<chat-id>/
~/.config/manicode-staging/projects/<project>/chats/<chat-id>/
```

Each chat directory must contain `chat-messages.json`. When present, `run-state.json` supplies the real working directory used for project grouping.

## Storage format

`chat-messages.json` is an array of user and assistant messages. Completed assistant messages can carry token usage in their metadata, credit usage, model information, nested tool blocks, and timestamps. CodeBurn prefers recorded token usage and LiteLLM pricing; when only credits are available, it uses Codebuff's public pay-as-you-go rate as a conservative cost estimate.

## Caching

No provider-specific cache. The shared session cache fingerprints the discovered chat data.

## Deduplication

Per chat directory and message id: `codebuff:<chat-dir>:<message-id>`. Session ids include the channel name so identical timestamp-based chat ids in stable, development, and staging stores stay distinct.

## Quirks

- The legacy `manicode` name remains in the on-disk paths.
- Tool names are normalized to CodeBurn's canonical tool set; nested agent blocks are traversed recursively.
- A message with neither tokens nor credits is treated as framing or in-progress data and skipped.
- The project folder name is only a fallback. `run-state.json` is preferred because sanitized folder names do not reliably identify the original worktree.

## When fixing a bug here

1. Reproduce the exact `chat-messages.json` and optional `run-state.json` shape with a sanitized fixture in `tests/providers/codebuff.test.ts`.
2. Exercise stable, development, and staging roots together when changing discovery or deduplication.
3. Preserve the token-first, credit-fallback cost behavior and recursive tool extraction.
