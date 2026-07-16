# Copilot

GitHub Copilot Chat (CLI, VS Code core chat sessions, VS Code extension transcripts, and JetBrains IDE sessions).

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
5. **JetBrains IDE sessions:** `~/.config/github-copilot/<ide>/<kind>/<storeId>/copilot-*-nitrite.db` (see the JetBrains section). Covers IntelliJ IDEA, PyCharm, RubyMine, etc.

## Storage format

JSONL in the first three locations (schemas differ; the parser switches by source type / event shape), a SQLite DB for the OTel source, and a Nitrite (H2 MVStore) `.db` for the JetBrains source. VS Code core chat sessions use a delta journal: `kind:0` sets the root object, `kind:1` writes a value at path `k`, and `kind:2` appends items to an array path.

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

## JetBrains IDEs (IntelliJ, PyCharm, …)

The JetBrains Copilot plugin does **not** write to any of the VS Code or CLI
locations above. It persists chat/agent sessions under the shared GitHub Copilot
config root, in one store directory per session store:

```
~/.config/github-copilot/<ide>/<kind>/<storeId>/
  copilot-*-nitrite.db     # Nitrite (H2 MVStore) — the session content
  blobs/
```

`<ide>` is a per-IDE dir (`iu` for IntelliJ IDEA Ultimate, `intellij` for the
community edition, `PyCharm2025.2`, …). `<kind>` ∈ `chat-agent-sessions`,
`chat-sessions`, `chat-edit-sessions` (agent / ask / edit mode). The root follows
XDG rules: `$XDG_CONFIG_HOME/github-copilot` when set, else
`~/.config/github-copilot` (macOS / Linux) or `%LOCALAPPDATA%\github-copilot`
(Windows).

**Storage: the Nitrite `.db`.** An H2 MVStore file (header
`H:2,block:9,…format:3`) of Java-serialized Nitrite documents (`NtAgentSession`,
`NtAgentTurn`). It is read as `latin1` (byte-offset-stable, lossless) and scanned
— no Java deserializer, no new deps, and it is **not** SQLite so `node:sqlite` is
not used. Each assistant reply is a `{"__first__":{"type":"Subgraph",…}}` blob.
`extractResponseText` recovers the reply by unescaping one level at a time and,
at the first depth where the record markers appear bare, reading the reply
**structurally** (the payload is parsed as a delimited JSON-string literal, so a
reply containing its own quotes is never truncated).

**Two turn shapes, both handled** (a blob is one or the other — verified across
every observed store that they never coexist):

- **Ask mode** — the reply is a `Markdown` record's `text`.
- **Agent / plan mode** (agent sessions, `/plan …`, e.g. in PyCharm) — the reply
  is the `reply` field of an `AgentRound` record; here the `Markdown` records
  hold the *user's* prompt instead. The mode is decided by the **presence** of an
  `AgentRound` record, and only its `reply` is read — so an agent turn with an
  empty reply (a failed turn or a pure tool-call round) is billed **$0** rather
  than falling back to the prompt. A multi-round blob contributes every non-empty
  round's reply.

Sidecar records that plan/agent mode also writes — `Thinking` (chain-of-thought),
`PendingChanges` (proposed code diff, stored under `content` not `data`),
`AskQuestion`, `Notification`, `SubTurn`, and file-read `text` results — are
**not** billable assistant output and are deliberately skipped. User prompts are
the simpler `{"<uuid>":{"type":"Value",…}}` value-maps.

**Old plugin format (≤1.5.x, e.g. 1.5.59-243).** Older plugins do not write
per-turn `__first__`/Subgraph blobs at all — they store the whole session as ONE
binary-framed outer Nitrite document of UUID-keyed `Value` entries, with the
`AgentRound` records one escaping level deeper. When the Subgraph scan finds no
turns but the raw file contains `AgentRound` text, a fallback locates that outer
document (`extractJetBrainsDbTurns`), runs it through the same
`extractResponseText` depth-unescape, and emits **one session-level call** per
document (all rounds' replies joined). Cost and tokens are correct; only the
per-turn call-count granularity is coarser than the new format — an accepted
tradeoff for legacy data. The fallback is gated on the new-format scan yielding
nothing, so current sessions are never affected or double-counted.

(Store dirs may also contain a legacy `00000000000.xd` Xodus log from older
plugin versions. On every installation observed it is either empty or shadowed
by the `.db`, so CodeBurn reads only the `.db`. If a real `.xd`-only session ever
surfaces, add a reader with a captured fixture.)

- **No token accounting.** No store records token counts. Output tokens are
  **estimated** from the reply text via `estimateTokens` (`CHARS_PER_TOKEN = 4`,
  as for Cursor and legacy Copilot JSONL); input tokens are 0; every JetBrains
  call is marked `costIsEstimated: true`.
- **Errored turns.** A failed generation ("Sorry, an error occurred …") is stored
  as an assistant blob with an error status and no reply text; it is detected and
  billed **$0** (not conflated with an empty success). In agent mode a failed turn
  has an empty `AgentRound` reply — the parser does not fall back to the prompt
  `Markdown`, so the user's words are never billed as the assistant's output.
- **Per-turn model.** The model varies per turn within one `.db`. It is recovered
  from inside the assistant blob when present, else a store-wide default, else a
  generic Copilot bucket. Dotted Claude names are normalised to canonical ids
  (`claude-opus-4.5` → `claude-opus-4-5`); GPT/Gemini names kept verbatim.
- **Duplicates.** The store keeps several byte-copies of each reply (original,
  lowercased, revisions); assistant turns are de-duplicated by reply content.
- **One `.db` holds many chat tabs.** A single store `.db` contains multiple
  conversations, each with an internal GUID and an evolving title
  (`New Agent Session` → auto-name → final title). CodeBurn recovers the
  `GUID → title` map (`extractJetBrainsConversations`, keeping the latest
  non-default title), attributes each turn to the nearest preceding conversation
  GUID, and emits **one session per conversation** (not one per `.db`). Reply
  content is de-duplicated per conversation.
- **Project.** Resolved in three tiers, most authoritative first:
  1. **`projectName` field (plugin 1.12+).** Recent plugins serialize the repo
     label directly on the session doc (`extractJetBrainsProjectName`) — the
     JetBrains analogue of the OTel source's `github.copilot.git.repository`.
     **Cross-kind join:** the billable turns live in `chat-agent-sessions`, but
     the `projectName` is usually written only into the sibling
     `chat-sessions` / `chat-edit-sessions` store. Discovery
     (`resolveJetBrainsProjectNames`) joins them by **store id** so the agent
     session inherits the label from whichever store recorded it. Read
     length-prefixed (Java `TC_STRING`) so an embedded quote/newline can't
     truncate it.
  2. **`.git` walk-up (older plugins / no `projectName`).** For each `file://`
     URI a chat referenced, walk UP the real filesystem to the nearest ancestor
     containing a `.git` and use that repo's basename (e.g. `pinot`).
  3. **`copilot-jetbrains`** bucket when neither signal exists (chat referenced
     no files and no `projectName` was recorded, or the repo no longer exists on
     disk).

  The conversation **title** is a chat-thread name, NOT a project — it is the
  session label (`userMessage`) and deliberately kept out of `project` so it does
  not pollute the By-Project view. Note that `bg-agent-sessions/` (a newer kind
  dir holding `copilot-agent-snapshots.db` / `copilot-session-metadata.db`) is
  **not** scanned: those DBs carry file snapshots and metadata, not billable
  turns, and the same session's turns are already read from
  `chat-agent-sessions`.
- **Override the root** with `CODEBURN_COPILOT_JETBRAINS_DIR`.

## Caching

None for the JSONL sources. The OTel source uses a durable cache (see above).

## Deduplication

Legacy JSONL and transcript sessions dedupe per `messageId`. Core chat sessions dedupe per `copilot-chatsession:<sessionId>:<requestId>`, and are not discovered when an OTel source is present. JetBrains `.db` turns dedupe per `copilot:jb:<conversationId>:<turnIndex>` (a per-conversation index, plus reply-content dedup within each conversation). These sources otherwise touch disjoint locations from the VS Code / CLI sources.

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
