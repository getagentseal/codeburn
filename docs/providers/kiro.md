# Kiro

Kiro IDE and CLI chat history.

- **Source:** `src/providers/kiro.ts`
- **Loading:** eager (`src/providers/index.ts:7`)
- **Test:** `tests/providers/kiro.test.ts`

## Where it reads from

### Kiro IDE

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

### Kiro CLI

JSONL session files at:

| Platform | Path |
|---|---|
| macOS / Linux / WSL | `~/.kiro/sessions/cli/` |
| Windows | `%USERPROFILE%\.kiro\sessions\cli\` |

Each session has two files:
- `<session-id>.json` — metadata (session_id, cwd, timestamps, model info)
- `<session-id>.jsonl` — conversation (one JSON object per line: Prompt, AssistantMessage, ToolResults)

Project name is derived from the `cwd` field in the metadata file.

## Storage format

Kiro has three known formats:

- Legacy `.chat` files with `{ chat, metadata, executionId }`
- Modern extensionless execution files with identifiers/timestamps at the top level plus conversation fields such as `messages`, `conversation`, `chat`, `transcript`, `entries`, `events`, or direct prompt/response fields
- CLI JSONL files with line-delimited entries: `{ version, kind: "Prompt"|"AssistantMessage"|"ToolResults", data: { content: [...] } }`

Session index files with `{ executions: [...] }` are discovered but skipped during parsing because they do not contain conversation content.

## MCP tool detection (CLI)

The CLI parser distinguishes built-in tools (`read`, `write`, `shell`, `grep`, `glob`, `web_search`, `web_fetch`, `code`, `subagent`, `knowledge`, `todo_list`, `introspect`, `summary`, `switch_to_execution`, `dummy`) from MCP tools. Any tool name not in the built-in set is prefixed as `mcp__<server>__<tool>`. The MCP server name is read from `~/.kiro/settings/mcp.json`.

## Caching

None.

## Deduplication

- Modern IDE files deduplicate per session/execution pair.
- Legacy `.chat` files deduplicate per workflow/execution pair.
- CLI sessions deduplicate per session ID.

## Quirks

- **Workspace hash resolution** is non-trivial. The parser tries `workspace.json` first; if that fails, it base64-decodes the directory name to recover the workspace path.
- **Model ID normalization.** Kiro stores models like `claude-1.2`; the parser rewrites the dot to a hyphen so they match `claude-1-2` in the pricing snapshot. Add new versions here when Kiro ships them.
- **Tool name extraction accepts text and structured calls.** Kiro can embed tool calls inside message text as `<tool_use><name>...</name>` or expose structured `toolCalls` / `tool_calls` / `tools` entries.
- **CLI model is always `auto`.** The CLI does not expose the underlying model, so sessions are labeled `kiro-auto` and costed at Sonnet rates.
- Token counts are estimated via char count (`CHARS_PER_TOKEN = 4`).

## When fixing a bug here

1. If the bug is "wrong workspace", check the base64 fallback path. Some users name their workspaces with characters that are not valid base64.
2. If the bug is "missing model in pricing", add the model to the normalization map and verify against `tests/providers/kiro.test.ts`.
3. If the bug is "tools missing", check both text-envelope extraction and structured tool-call extraction. Kiro changes its envelope occasionally.
4. If the bug is "CLI sessions not found", verify `~/.kiro/sessions/cli/` exists and contains `.jsonl` files with matching `.json` metadata files.
5. If the bug is "MCP tools not detected from CLI", check `~/.kiro/settings/mcp.json` and the `CLI_BUILTIN_TOOLS` set.
