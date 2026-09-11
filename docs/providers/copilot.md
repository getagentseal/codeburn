# Copilot

GitHub Copilot Chat (CLI, VS Code core chat sessions, VS Code extension transcripts, and JetBrains IDE sessions).

- **Source:** `src/providers/copilot.ts`
- **Loading:** eager (`src/providers/index.ts:3`)
- **Test:** `tests/providers/copilot.test.ts`

## Where it reads from

Three JSONL locations plus two optional SQLite sources (see the OTel and session-store
sections). OTel is preferred when present; chatSessions are only discovered when no OTel
source is found. Other discovered sources are walked on every run; results merge and
dedupe.

1. **Legacy CLI sessions:** `~/.copilot/session-state/`
2. **VS Code core chat sessions:** `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` plus `~/Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl` and equivalents on Windows / Linux
3. **VS Code transcripts:** `~/Library/Application Support/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/` and equivalents on Windows / Linux
4. **OTel SQLite store:** VS Code Copilot Chat's `agent-traces.db` (see the OTel section). Preferred when present because it carries full input / output / cache token counts; legacy JSONL sources only record output tokens.
5. **CLI session store:** `~/.copilot/session-store.db` (see the session-store section). One `assistant_usage_events` row per API request — the authoritative input/cache source for CLI and GitHub desktop-app sessions.
6. **JetBrains IDE sessions:** `~/.config/github-copilot/<ide>/<kind>/<storeId>/copilot-*-nitrite.db` (see the JetBrains section). Covers IntelliJ IDEA, PyCharm, RubyMine, etc.

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
  month-to-date totals do not drop as the DB rotates. Orphaned entries age out after
  90 days; sources still present in discovery remain cached regardless of call age.
- **Upgrade note.** The first run after upgrading to the OTel version bumps the copilot
  parse version, which discards the prior copilot cache. Spans already pruned from the DB
  before the upgrade cannot be recovered, so monotonicity starts from the upgrade point,
  not retroactively.

## Session store (CLI / GitHub desktop app)

The Copilot CLI and the GitHub Copilot desktop app both write
`~/.copilot/session-store.db` (SQLite/WAL) unconditionally. Its
`assistant_usage_events` table records one row per API request as it happens —
where the `session.shutdown` rollup in `events.jsonl` is written only on clean
shutdown (a crash loses the leg's input/cache accounting), lumps each leg into
one per-model total, and resets its counters at in-session compaction. Rows are
therefore authoritative for input / cache-read / cache-write / reasoning
tokens, with real per-request timestamps; per-turn output stays owned by the
`events.jsonl` `assistant.message` calls. `input_tokens` is cache-INCLUSIVE
(input + cache_read + cache_write), the same convention as the rollups; the
parser emits the uncached remainder. Override the path with
`CODEBURN_COPILOT_SESSION_STORE_DB` (deliberately NOT in the env fingerprint —
see the #927 ruling in `src/session-cache.ts`).

- **Rollup reconciliation happens at serve time, per (session, model), in
  `parseProviderSources`** — never in the parser. Both representations always
  parse and cache; wherever store rows exist for a pair, the rollup calls are
  dropped and each rollup leg's usage beyond the rows in its own interval
  serves once as a synthesized residual call at that leg's timestamp. Sessions
  with no rows (pre-store CLI builds) keep the rollup path unchanged.
- **The rollup's counters are CUMULATIVE across resume legs, and the parser
  emits per-leg deltas.** Measured on a real 3-leg session (CLI 1.0.80): every
  counter in a leg, billing and tokens alike, includes the legs before it, and
  the LAST leg of a complete session equals the session's store-row total
  exactly. So reading the journal directly makes it look as though summing legs
  would count a resumed session several times over - what is CACHED is already
  `cumulative - previous cumulative` per model, which is what the interval
  arithmetic below consumes. A leg reporting LESS than its predecessor is a
  fresh accounting epoch (an older per-leg CLI, or a counter reset) and is
  taken at face value rather than clamped to a negative delta, so its usage is
  never silently dropped.
- **A leg's interval starts at its last successful compaction, not at the
  previous leg.** In-session compaction resets the CLI's rollup counters, so a
  leg containing one describes only its post-compaction requests. Running the
  subtraction from the previous leg would cancel that leg's usage against the
  whole pre-compaction conversation and leave the residual short by exactly
  that much — invisible while the store is complete (the floor hides it),
  permanent once a partial snapshot is sealed into a day. Pre-compaction rows
  still serve; they just stop cancelling usage the rollup never claimed.
  Recognized events, from `@github/copilot` 1.0.80: `session.compaction_start`
  (nothing needed from it) and `session.compaction_complete`, whose `success`
  is read and every other field ignored. Only `success: true` anchors; a failed
  or absent compaction falls back to the previous-leg interval. Multiple
  compactions in one leg: the last wins. The stamp rides on the cached rollup
  call as `compactedAt`.
  *The summarization call, and what the `initiator` label buys.* The
  compaction's own summarization request DOES write an
  `assistant_usage_events` row — confirmed on a real store — and where the
  schema has an `initiator` column that row is labelled `'compaction'`. The
  label is read (schema-adaptively, alongside the billing columns) and used for
  exactly two things: the row is subtracted from the leg it belongs to even
  though it commits before the compaction stamp, and it is kept out of per-turn
  pairing, since there is no `assistant.message` for it to pair with.
  *Bounded over-serve where the label is absent:* the column is missing on
  older stores and NULL on many rows of newer ones (1,504 of 2,509 on one real
  store), and an unlabelled compaction row is indistinguishable from a user
  request — it falls outside the anchored interval while the post-reset rollup
  counts it, so one request per compaction serves twice. A timestamp heuristic
  cannot close that: the request that TRIGGERED the compaction completes
  immediately before it too, so any grace window wide enough to catch the
  summarization row also catches a real request and turns an over-serve into a
  loss.
- **Behavioral weight.** Rollups and residuals are aggregate accounting: tokens
  and cost count, but never api-call / model-call / turn weight. A store row
  pairs with its per-turn call by timestamp adjacency (2-minute window,
  computed over the full serve set); only unpaired rows — crash-recovered,
  store-only requests — count as calls.
- **Failure semantics.** True absence (ENOENT, no sqlite driver, `no such
  table/column` from pre-store CLI builds) reads as absent — no source, rollups
  rule. Every other failure (locked, EACCES, corrupt, mid-replace) emits the
  source anyway: its parse defers on the busy shape, previously cached rows
  keep serving, and the pass reports incomplete hydration so the daily
  backfill holds its watermark.
- **Read order.** The store is parsed AFTER every other copilot source in the
  same pass, and a store served from cache that moves during the pass marks
  the pass incomplete. Rows commit strictly before their leg's `session.shutdown`
  line, so reading the store last makes the row set a superset of anything a
  rollup we read can claim — a session that shuts down mid-pass can no longer
  leave a leg reconciled against rows that had not landed. What is left is the
  harmless direction: a row whose journal partner has not arrived yet serves
  its own tokens and pairs on the next pass.
- **Durable cache.** Rides the same `durableSources` union as OTel: still-
  discovered sources are never aged out, and orphans age out at 90 days. A
  deleted store's rows serve as orphans until then. Reconciliation reads only
  cached contents, so deleting or resetting the store never changes served
  totals. A parse-version bump carries every cached entry forward and re-reads
  the live source into it, because a DB that still exists is not a DB that can
  still re-derive its pruned rows.
- **Billing metadata.** Each row's `total_nano_aiu` and `request_multiplier`
  are captured onto the cached call when the store's schema has them (older
  stores parse identically without). Plan math sums finite `nanoAiu` into
  Copilot AI credits (`codeburn plan set copilot-pro`). Billing-grade cost
  rewrite of every report is still upstream #890.

  These CLI session-store rows are the **only** local source that carries an
  exact credit figure. VS Code chat sessions and transcripts, the OTel
  `agent-traces.db`, JetBrains stores and the CLI session-state JSONL never do,
  so on a typical machine most requests have no exact figure at all (#1199).
  Everything unrated is estimated instead: the request's tokens priced at the
  model's listed API rate, converted at 1 credit = $0.01. That is exactly how
  GitHub bills credits, verified against real session-store rows: list rate
  with the cache-read and cache-write split applied, and `request_multiplier`
  (the legacy premium-request weight) never touches the credit figure. So the
  estimate's accuracy hinges on the source: on Copilot CLI events, which carry
  the cache split, CodeBurn's token pricing landed within about 15% of the
  exact bill; VS Code chat sessions record prompt and output tokens only, so
  their estimate can land either side of the bill, and the numbers in #1199
  show the gap can reach roughly 2x. A session that carries any exact figure
  is never estimated on top of, because `total_nano_aiu` already bills that
  request's whole token set.

  `codeburn plan` says so on the headline whenever anything is estimated
  (`~9800 / 20000 AI Credits (estimated; 4 of 473 requests carry GitHub's exact
  figure)`), and `codeburn status --format json | jq .plans.copilot` carries
  `spentCredits` (exact only), `estimatedCredits` (exact plus estimate),
  `creditRatedCalls` / `creditUnratedCalls`, `creditsIncomplete` and a plain
  `creditsNote`. The bar and `percentUsed` follow `estimatedCredits` while any
  request is unrated, and the exact figure once every request carries one.
  For the live authoritative number, use the menubar's GitHub quota endpoint
  (separate system, PR #1200).
- **Sync.** `codeburn sync push` holds a copilot session until it has been
  quiet for 24 hours. The reconciliation output is mutable (a residual shrinks
  as rows land, a rollup is dropped once rows cover its leg, a row's pairing
  flips), and the sent-ledger is append-once, so a value sent mid-reconciliation
  could never be corrected at the receiver (#988). Nothing is dropped; the next
  push after the window sends it once, final. A day is conservative: on one
  real store no row ever landed after its session's shutdown (91 sessions,
  median -0.1s), so this can likely be seconds once a second machine agrees.
  Separately, a session is frozen
  into whichever of the two shapes it was FIRST synced in — the raw rollup, or
  rows plus residuals — because the receiver cannot be told to drop what it
  already holds. Both directions matter: a session synced by a pre-store
  version never sends rows, and a session synced as rows never sends the
  rollup that starts serving again once the 90-day age-out prunes them. That is
  a bounded under-count at the receiver in place of an unbounded over-count;
  `codeburn sync reset --confirm` re-pushes everything under the new breakdown
  for anyone who can clear the receiver too.
- **Requires Node 22+** (`node:sqlite`), same as the OTel source.

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

**Not available on the Linux Snap build.** `~/.config/github-copilot` also
holds the Copilot OAuth credential files (`hosts.json`, `apps.json`) directly
under that root, alongside the per-IDE nitrite stores at a variable
`<ide>/<kind>/<storeId>/` depth. The strict-confinement snap's personal-files
grant is a fixed list of literal paths, so it cannot reach the variable-depth
`.db` files without also granting the credential files sitting beside them.
JetBrains Copilot sessions are therefore not discovered when CodeBurn runs as
a snap; every other Copilot source (CLI, VS Code core chat, VS Code extension
transcripts, OTel) is unaffected.

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

## Live quota (Copilot subscription)

Separate from the log parser above: the macOS menubar reads live quota from
`GET https://api.github.com/copilot_internal/user` with a GitHub token — or from
the tenant's own host on GitHub Enterprise Cloud, see below. Usage tracking
never needs this token; only the quota bars do.

`mac/Sources/CodeBurnMenubar/Data/CopilotSubscriptionService.swift` walks an
ordered, read-only chain and takes the first token it finds. Every rung
tolerates an absent, locked, or malformed source and falls through:

1. `~/.config/github-copilot/hosts.json` (`github.com` preferred), then
   `apps.json`. Written only by the older editor plugins; modern VS Code keeps
   its GitHub login in encrypted secret storage, which CodeBurn deliberately
   does not touch.
2. `~/.copilot/config.json`, then `~/.copilot/settings.json` (the CLI moved
   settings there in 1.0.35). The key holding the token is not documented and
   has moved between releases, so instead of guessing key names the parser
   takes the first string value carrying a GitHub access-token prefix
   (`gho_`, `ghu_`, `ghp_`, `ghs_`, `github_pat_`). `ghr_` refresh tokens are
   skipped: the usage endpoint rejects them.
3. `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`, matching the
   Copilot CLI's own order. A GUI-launched app rarely inherits these.
4. `gh auth token`, which resolves keyring vs `~/.config/gh/hosts.yml` itself.
   The binary is located the same way `CodeburnCLI` locates codeburn.
5. A token the user pastes into Settings, stored in CodeBurn's own
   provider-scoped keychain item. A fine-grained personal access token with the
   `Plan: Read-only` permission is enough.

The Copilot CLI's own keychain item (generic password service `copilot-cli`)
is deliberately **not** read. It is written by a Node keyring library, so
`/usr/bin/security` is not in its partition list and every read would raise the
macOS "allow access?" dialog; a user who clicks Deny would see it again on each
refresh. Rung 4 reaches the same users anyway, because the Copilot CLI itself
falls back to gh.

Rung 4 costs a process spawn, so its answer is cached for `probeCacheTTL`
(5 minutes) and dropped on disconnect and before the one 401 re-read.
`hasCredential` is the cheap eligibility answer and never spawns: it
approximates rung 4 with an installed `gh` binary.

The Electron surface (`app/electron/quota/copilot.ts`) still implements only
rung 1.

### GitHub Enterprise Cloud hosts (`*.ghe.com`)

The endpoint is not fixed to dotcom. GitHub Enterprise Cloud with data
residency puts an enterprise on its own hostname, `<tenant>.ghe.com`, whose API
lives at `api.<tenant>.ghe.com`, and a token minted there is not valid on
api.github.com. So a credential carries the host it was read from —
`hosts.json` is keyed by host, and newer `apps.json` files key by
`<host>:<app id>` — and the request goes to
`https://api.<tenant>.ghe.com/copilot_internal/user` for an enterprise host and
to `https://api.github.com/copilot_internal/user` for `github.com` or for any
rung that carries no host of its own (an app-name `apps.json` key, the
environment variables, `gh auth token`, a pasted token). The token and the host
always come from the same entry: with several hosts signed in, `github.com`
wins, otherwise the first `.ghe.com` tenant in sorted order, so the pick is
stable across reads; with exactly one, that host is used. A host neither rule
can address — a self-hosted GitHub Enterprise Server install, which CodeBurn
does not support — fails with a message naming that host rather than falling
back to api.github.com, because dotcom would reject the credential anyway and
must never receive it. Unreachable-host and HTTP failures name the host tried,
so the symptom is no longer a bare "Temporarily unavailable". Settings shows
which host answered in the Copilot connection row. `CopilotHostEndpoint`
(macOS) and the exported helpers in `src/quota/copilot.ts` (CLI) hold the
derivation and the host pick.

## Caching

None for the JSONL sources. The OTel and session-store sources use the durable cache (see above).

## Deduplication

Legacy JSONL and transcript sessions dedupe per `messageId`. Core chat sessions dedupe per `copilot-chatsession:<sessionId>:<requestId>`, and are not discovered when an OTel source is present. Session-store rows dedupe per `copilot-store:<sessionId>:<rowId>:<hash>` (the hash covers `created_at`, token counts, and model, so a same-path DB reset reusing AUTOINCREMENT ids cannot alias a different request onto a cached key); shutdown rollups per `copilot:<sessionId>:shutdown:<model>:<n>`, with serve-time residuals synthesized (never cached) under `copilot:<sessionId>:shutdown-residual:<model>:<leg>`. JetBrains `.db` turns dedupe per `copilot:jb:<conversationId>:<turnIndex>` (a per-conversation index, plus reply-content dedup within each conversation). These sources otherwise touch disjoint locations from the VS Code / CLI sources.

If a workspace hash contains at least one `chatSessions/*.jsonl` file, the provider skips that hash's legacy `GitHub.copilot-chat/transcripts/` directory. The core chat session journal is the modern token-bearing source for the same conversations, so reading both would inflate call counts.

## Model inference

Copilot does not always tag the model on each message. The parser infers it from the tool-call ID prefix:

| Prefix | Inferred model family |
|---|---|
| `toolu_bdrk_`, `toolu_vrtx_`, `tooluse_`, `toolu_` | Anthropic |
| `call_` | OpenAI |

See `copilot.ts:176-213`.

## Sharp edges

- **A day sealed on a short store snapshot stays short.** Reconciliation
  converges — the residual retires as rows land — but the daily cache seals a
  finalized day once and only re-derives it on a version bump. The two
  realizable ways to seal a short snapshot are both closed: a session that
  shuts down mid-pass (the store is read after every journal, and a
  cache-served store that moves mid-pass holds the watermark) and a compacted
  leg (its interval now starts at the compaction). What remains is a store that
  is behind its journal with no local signal at all — rows pruned, a restore,
  a snapshot taken by something outside this process. There is no detector for
  it: `rollup > rows-in-interval` is exactly the shape of legitimate partial
  coverage (a store adopted mid-session has it permanently), so fencing on it
  would hold the watermark forever. Stated plainly: that day is a permanent
  under-report and the watermark advances past it. It is not a stall, and the
  next parse's larger derivation cannot reach back to fix it.
- **A compaction's own summarization call may serve twice.** See the interval
  anchor above; bounded at one request per compaction, direction is over-serve.
- **Pairing is ambiguous inside the 2-minute window.** A crash-only row within
  two minutes of a request whose own row is missing can pair against it,
  under-counting `apiCalls` by one. Tokens stay exact.
- **A model string that cannot match its rollup's** (the empty-model `unknown`
  key) is invisible to per-model reconciliation, so both representations serve:
  over-serve, never lose.

## Quirks

- `toolRequests` can be missing or non-array on older sessions; the parser guards against that (`copilot.ts:126`, `:260`).
- When `outputTokens` is missing the parser falls back to char-counting (`CHARS_PER_TOKEN = 4`, `copilot.ts:252-254`).
- A single chat may be mirrored across both legacy and transcript paths if the user upgraded; the dedup `messageId` collision handles this.

## When fixing a bug here

1. Determine which schema reproduces the bug. The two parsers share little code on purpose; do not unify them unless you understand both formats.
2. If the model is misidentified, look at the tool-call ID prefix list and consider whether a new prefix should be added.
3. New fixtures go under `tests/fixtures/copilot/` and are referenced from `tests/providers/copilot.test.ts`.
