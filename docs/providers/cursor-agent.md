# Cursor Agent

Cursor's background agent transcripts (separate from the regular chat).

- **Source:** `src/providers/cursor-agent.ts`
- **Loading:** lazy (`src/providers/index.ts:62-87`)
- **Test:** `tests/providers/cursor-agent.test.ts` (243 lines)

## Where it reads from

`~/.cursor/projects/<projectId>/agent-transcripts/`. Inside each project, two layouts coexist:

1. **Legacy:** `*.txt` flat files.
2. **Composer 2:** UUID-named subdirectories, each containing JSONL.

Sessions with no exported transcript are read from `~/.cursor/chats/<hash>/<agentId>/store.db` (#986). A store whose `agentId` has a transcript is skipped at discovery, so a session is counted from one source only. `meta['0']` is hex JSON (`agentId`, `createdAt`, and a `blobEncryptionKey` that is never read); `blobs` holds JSON messages and protobuf conversation roots (field 1: message blob ids in order, 9: workspace URI, 26: ms stamp). Every root is merged in rowid order, because the latest root drops what Cursor summarized away. Turn time comes from the prompt's `<timestamp>` tag. Store turns are priced at the Cursor (auto) rate, like transcripts, so a session does not change price when Cursor writes its transcript at the end.

Subagents (delegated runs) live in `subagents/` subdirectories under the parent (`cursor-agent.ts:479-490`). They are picked up too.

## Storage format

- Legacy: free-form text transcripts. The parser does line-based heuristic parsing (`cursor-agent.ts:219-314`).
- Composer 2: JSONL (`cursor-agent.ts:167-217`).

## Caching

None at the provider level. Conversation metadata is read from `~/.cursor/ai-tracking/ai-code-tracking.db`, table `conversation_summaries`. A transcript turn is dated by the latest prompt `<timestamp>` tag before it, like store turns. A transcript with no tag (about a fifth of them) falls back to the summary's `updatedAt`, then the file mtime, which is the session's end.

## Deduplication

Per `<provider>:<conversationId>:<turnIndex>` (`cursor-agent.ts:379`).

## Quirks

- A file with a UUID-shaped name is treated as the conversation ID directly (`cursor-agent.ts:142-143`); other names are derived from the parent directory.
- Token counts are estimated from char count (`CHARS_PER_TOKEN = 4`, `cursor-agent.ts:35`, `:81-84`). The legacy text format never reports real tokens.
- Every assistant message counts as a turn: agentic loops emit dozens of assistant messages per user message, and each carries the last user message forward. Tool_use inputs are serialized into the output text; input tokens use the full user text, billed once on the first assistant message after it, while the displayed message stays truncated at 500 chars.
- The text parser is regex-driven and brittle. It is easier to fix a Composer 2 (JSONL) bug than a legacy (text) bug.

## Exact or estimated

- **Exact (billed sync).** Cursor's usage export (see [cursor.md](cursor.md)) includes Agent CLI requests: the CLI signs in to the same account and bills it. The export has no field that tells CLI from IDE, so inside synced or imported coverage local `cursor-agent` calls are dropped and the billed rows show under `cursor` (project `Cursor (imported)`). Expect far fewer calls there: Cursor bills one row per request, while the transcript holds one turn per assistant message (3 billed rows against 101 local turns on a real run).
- **Estimated (local).** Every local call is `costIsEstimated`: transcripts and `store.db` record no token counts, so tokens are characters / 4 priced at the Cursor (auto) rate. A prompt's turns all carry its minute, so once the prompt falls inside coverage they are all replaced, including steps that ran after the newest synced event, until the next sync brings those rows in. Untagged transcripts still date at the session's end and can sit past the coverage end until the next sync.
- **How to get exact.** Keep the Cursor app signed in with the sync on, or run `codeburn import cursor --sync`.

## When fixing a bug here

1. Check which format the failing transcript uses before opening a fix.
2. For text-format bugs, copy the redacted transcript verbatim into `tests/fixtures/cursor-agent/` so the regex change can be regression-tested.
3. If the bug is "wrong project", look at `cursor-agent.ts:46-50` and whether a `conversation_summaries` row exists for the conversation.
