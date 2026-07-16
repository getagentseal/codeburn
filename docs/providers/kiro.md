# Kiro

Kiro IDE chat history.

- **Source:** `src/providers/kiro.ts`
- **Loading:** eager (`src/providers/index.ts:7`)
- **Test:** `tests/providers/kiro.test.ts`

## Where it reads from

VS Code-style globalStorage at `kiro.kiroagent`:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent` |
| Windows | `%APPDATA%/Kiro/User/globalStorage/kiro.kiroagent` |
| Linux | `~/.config/Kiro/User/globalStorage/kiro.kiroagent` and `~/.kiro-server/data/User/globalStorage/kiro.kiroagent` (remote dev boxes / Cloud Desktop) |

On Linux both the local and remote-server globalStorage paths are scanned when present.

Two more stores live outside globalStorage, under `~/.kiro/sessions` (honors `KIRO_HOME`):

- **CLI store:** `~/.kiro/sessions/cli/<id>.jsonl` (+ companion `<id>.json`)
- **IDE v2 store:** `~/.kiro/sessions/<workspace-hash>/sess_<id>/` (see below)

Sessions in globalStorage are under hash-named workspace subdirectories. Discovery keeps backward compatibility with legacy `.chat` files and also scans the post-February 2026 extensionless format:

- `<workspace-hash>/<execution-id>.chat` legacy session files
- `<workspace-hash>/<session-hash>` extensionless session index files
- `<workspace-hash>/<session-hash>/<execution-hash>` extensionless execution files inside session directories
- `workspace-sessions/<base64url(path)>/<uuid>.json` v1 session records, a sibling of the workspace-hash directories at the `kiro.kiroagent` root (conversation spine; execution-backed stubs are skipped to avoid double-counting the execution files)

## Storage format

Kiro has several known formats across generations:

- **Legacy `.chat`** files with `{ chat, metadata, executionId }`
- **Modern extensionless execution files** with identifiers/timestamps at the top level plus conversation fields such as `messages`, `conversation`, `chat`, `transcript`, `entries`, `events`, `context.messages`, or direct prompt/response fields. In v1 these are the *content* half; the paired `workspace-sessions/<uuid>.json` record is the *spine* (linked by `executionId` ⇄ `chatSessionId`).
- **CLI** JSONL: one `{ version, kind, data }` event per line + a companion `<id>.json` with `session_state` metering (`metering_usage` gives real per-turn cost in credits).
- **IDE v2** (`sess_<id>/`): a self-contained, event-sourced session directory — `session.json` (metadata incl. the real `modelId`, `title`, `workspacePaths`) + `messages.jsonl` (append-only `{ id, timestamp, payload:{ type, ... } }` events) + `publish.cursor` + `snapshots/`. Assistant content is inline (no separate execution files). Usage is billed in **credits** via `usage_summary.promptTurnSummaries` (no token counts): cost comes from credits at the public overage rate ($0.04/credit, `USD_PER_KIRO_CREDIT`), while token counts are estimated from transcript text.

Session index files with `{ executions: [...] }` are discovered but skipped during parsing because they do not contain conversation content.

## Caching

None.

## Deduplication

Modern files deduplicate per session/execution pair. Legacy `.chat` files deduplicate per workflow/execution pair. CLI turns key on `kiro-cli:<sessionId>:<turnIndex>`. v2 turns key on `kiro-v2:<sessionId>:<executionId>`.

The stores are disjoint (v2 sessions use `sess_`-prefixed IDs in a separate directory), so no session is counted twice today. Migration from v1 workspace-sessions to v2 is currently detect-only; if it begins moving records, add a guard preferring v2 when the same logical session appears in both.

## Quirks

- **Workspace hash resolution** is non-trivial. The parser tries `workspace.json` first; if that fails, it base64-decodes the directory name to recover the workspace path.
- **Model ID normalization.** Kiro stores models like `claude-1.2`; the parser rewrites the dot to a hyphen so they match `claude-1-2` in the pricing snapshot. Add new versions here when Kiro ships them.
- **Tool name extraction accepts text and structured calls.** Kiro can embed tool calls inside message text as `<tool_use><name>...</name>` or expose structured `toolCalls` / `tool_calls` / `tools` entries.
- Token counts are estimated via char count (`CHARS_PER_TOKEN = 4`).
- **Credits are the cost source; tokens stay estimated.** Kiro bills in credits ($20/mo for 1,000; overage $0.04/credit). CLI (`metering_usage`), v1 executions (`usageSummary[].usage`), and v2 (`usage_summary.promptTurnSummaries[].usage`) turns record real credits, converted to USD at `USD_PER_KIRO_CREDIT = 0.04` (the public overage rate — the same never-understate approach as Codebuff). Turns without credit data fall back to token-estimated cost (`costIsEstimated: true`); legacy `.chat` and workspace-session records carry no usage data, so they are always token-estimated. Note: an earlier CLI implementation summed credit values directly as dollars, overstating cost 25×. Token *counts* remain char-estimated everywhere (input undercounts: only visible transcript text is seen, not the full resent context; v2's `session_metadata.contextUsage.usagePercentage` × context window is a better input proxy if ever needed). v2 does keep the real `modelId`, so unlike the v1 execution-file path it is not mislabeled `kiro-auto`.
- **Cost is frozen at parse time.** Kiro is on the `costUSD` pass-through allowlist in `providerCallToCachedCall` (alongside mistral-vibe, devin, hermes, …), so its credit-based cost survives the session cache instead of being re-priced from estimated tokens — token re-pricing understated/overstated real kiro spend by up to 16× per model. The tradeoff, shared with all allowlisted providers: `codeburn price-override` and `model-alias` do not affect kiro dollar amounts (token *counts* are unaffected). Historical caches from before this change re-parse via the `CACHE_VERSION` bump to 5.

## When fixing a bug here

1. If the bug is "wrong workspace", check the base64 fallback path. Some users name their workspaces with characters that are not valid base64.
2. If the bug is "missing model in pricing", add the model to the normalization map and verify against `tests/providers/kiro.test.ts`.
3. If the bug is "tools missing", check both text-envelope extraction and structured tool-call extraction. Kiro changes its envelope occasionally.
