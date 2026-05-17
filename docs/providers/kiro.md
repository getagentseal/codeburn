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
| Linux | `~/.config/Kiro/User/globalStorage/kiro.kiroagent` |

Sessions are under hash-named workspace subdirectories. Discovery keeps backward compatibility with legacy `.chat` files and also scans the post-February 2026 extensionless format:

- `<workspace-hash>/<execution-id>.chat` legacy session files
- `<workspace-hash>/<session-hash>` extensionless session index files
- `<workspace-hash>/<session-hash>/<execution-hash>` extensionless execution files inside session directories

## Storage format

Kiro has two known JSON formats:

- Legacy `.chat` files with `{ chat, metadata, executionId }`
- Modern extensionless execution files with identifiers/timestamps at the top level plus conversation fields such as `messages`, `conversation`, `chat`, `transcript`, `entries`, `events`, or direct prompt/response fields

Session index files with `{ executions: [...] }` are discovered but skipped during parsing because they do not contain conversation content.

## Caching

None.

## Deduplication

Modern files deduplicate per session/execution pair. Legacy `.chat` files deduplicate per workflow/execution pair.

## Quirks

- **Workspace hash resolution** is non-trivial. The parser tries `workspace.json` first; if that fails, it base64-decodes the directory name to recover the workspace path.
- **Model ID normalization.** Kiro stores models like `claude-1.2`; the parser rewrites the dot to a hyphen so they match `claude-1-2` in the pricing snapshot. Add new versions here when Kiro ships them.
- **Tool name extraction accepts text and structured calls.** Kiro can embed tool calls inside message text as `<tool_use><name>...</name>` or expose structured `toolCalls` / `tool_calls` / `tools` entries.
- Token counts are estimated via char count (`CHARS_PER_TOKEN = 4`).

## When fixing a bug here

1. If the bug is "wrong workspace", check the base64 fallback path. Some users name their workspaces with characters that are not valid base64.
2. If the bug is "missing model in pricing", add the model to the normalization map and verify against `tests/providers/kiro.test.ts`.
3. If the bug is "tools missing", check both text-envelope extraction and structured tool-call extraction. Kiro changes its envelope occasionally.
