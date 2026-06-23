# Copilot

GitHub Copilot Chat (CLI, VS Code core chat sessions, and VS Code extension transcripts).

- **Source:** `src/providers/copilot.ts`
- **Loading:** eager (`src/providers/index.ts:3`)
- **Test:** `tests/providers/copilot.test.ts`

## Where it reads from

Three JSONL locations plus an optional OpenTelemetry SQLite source (see below). OTel is
preferred when present; chatSessions are only discovered when no OTel source is found.
Other discovered sources are walked on every run; results merge and dedupe.

1. **Legacy CLI sessions:** `~/.copilot/session-state/`
2. **VS Code core chat sessions:** `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` plus `~/Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl` and equivalents on Windows / Linux
3. **VS Code transcripts:** `~/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/` and equivalents on Windows / Linux
4. **OTel SQLite store:** VS Code Copilot Chat's `agent-traces.db` (see the OTel section). Preferred when present because it carries full input / output / cache token counts; legacy JSONL sources only record output tokens.

## Storage format

JSONL in the first three locations (schemas differ; the parser switches by source type / event shape), and a SQLite DB for the OTel source. VS Code core chat sessions use a delta journal: `kind:0` sets the root object, `kind:1` writes a value at path `k`, and `kind:2` appends items to an array path.

## OpenTelemetry (OTel) source

When VS Code Copilot Chat's `agent-traces.db` exists, the parser reads per-LLM-call token
breakdowns (input, output, cache-read, cache-creation) from it, which the JSONL sources do
not record. Discovery is skipped with `CODEBURN_COPILOT_DISABLE_OTEL=1`, and the DB path
can be overridden with `CODEBURN_COPILOT_OTEL_DB`.

If OTel discovery finds at least one source, workspace `chatSessions/*.jsonl` and
`emptyWindowChatSessions/*.jsonl` are skipped. Those journals can mirror the same Copilot
turns under IDs that do not match OTel turn IDs, so CodeBurn prefers the richer OTel data
instead of trying to dedupe across stores.

- **Requires Node 22+.** The OTel source uses the built-in `node:sqlite` module (the same
  backend as Cursor / OpenCode). On Node 20, or if the DB is missing / locked / corrupt /
  wrong-schema, OTel is skipped and the JSONL/transcript sources are used as a fallback.
- **Durable cache (monotonic totals).** Copilot is marked `durableSources`: OTel-derived
  cache entries are never evicted when VS Code prunes old spans from the DB, so
  month-to-date totals do not drop as the DB rotates. Entries age out after 90 days.
- **Upgrade note.** The first run after upgrading to the OTel version bumps the copilot
  parse version, which discards the prior copilot cache. Spans already pruned from the DB
  before the upgrade cannot be recovered, so monotonicity starts from the upgrade point,
  not retroactively.

## Caching

None for the JSONL sources. The OTel source uses a durable cache (see above).

## Deduplication

Legacy JSONL and transcript sessions dedupe per `messageId`. Core chat sessions dedupe per `copilot-chatsession:<sessionId>:<requestId>`, and are not discovered when an OTel source is present.

If a workspace hash contains at least one `chatSessions/*.jsonl` file, the provider skips that hash's legacy `GitHub.copilot-chat/transcripts/` directory. The core chat session journal is the modern token-bearing source for the same conversations, so reading both would inflate call counts.

## Model inference

Copilot does not always tag the model on each message. The parser infers it from the tool-call ID prefix:

| Prefix | Inferred model family |
|---|---|
| `toolu_bdrk_`, `toolu_vrtx_`, `tooluse_`, `toolu_` | Anthropic |
| `call_` | OpenAI |

See `copilot.ts:176-213`.

## Quirks

- `toolRequests` can be missing or non-array on older sessions; the parser guards against that (`copilot.ts:126`, `:260`).
- When `outputTokens` is missing the parser falls back to char-counting (`CHARS_PER_TOKEN = 4`, `copilot.ts:252-254`).
- A single chat may be mirrored across both legacy and transcript paths if the user upgraded; the dedup `messageId` collision handles this.

## When fixing a bug here

1. Determine which schema reproduces the bug. The two parsers share little code on purpose; do not unify them unless you understand both formats.
2. If the model is misidentified, look at the tool-call ID prefix list and consider whether a new prefix should be added.
3. New fixtures go under `tests/fixtures/copilot/` and are referenced from `tests/providers/copilot.test.ts`.
