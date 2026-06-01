# Windsurf

Windsurf is the AI-powered code editor from Codeium/Cognition AI that treats artificial intelligence as a first-class collaborator.

## Status — placeholder

**This provider is currently a placeholder.**  Windsurf stores session data in encrypted protobuf files (`~/.codeium/windsurf/cascade/*.pb`) and does **not** expose a local API that third-party tools can read.  The `codeburn` CLI will therefore report `"No usage data found"` when `--provider windsurf` is used.

We will revisit this provider once Windsurf exposes local session data in an accessible format (e.g. SQLite, JSONL, or an RPC endpoint).

## Data Location

Windsurf stores session data in the following paths:

### macOS
```
~/Library/Application Support/Windsurf/
├── User/
│   ├── globalStorage/
│   │   └── state.vscdb          # UI state only (no session data)
│   └── workspaceStorage/        # Per-workspace UI state
│       └── <hash>/
│           ├── workspace.json   # Workspace folder mapping
│           └── state.vscdb      # UI state only
```

### Linux
```
~/.config/Windsurf/
├── User/
│   ├── globalStorage/
│   │   └── state.vscdb
│   └── workspaceStorage/
```

### Windows
```
%APPDATA%\Windsurf\
├── User\
│   ├── globalStorage\
│   │   └── state.vscdb
│   └── workspaceStorage\
```

**Actual conversations** are stored in encrypted protobuf files at:
```
~/.codeium/windsurf/cascade/<uuid>.pb
```
These files are not human-readable and there is no documented decryption method.

## Models

When Windsurf does expose session data, the following model names are expected:

| Model | Display Name |
|-------|-------------|
| swe-1.6 | SWE-1.6 |
| swe-1.5 | SWE-1.5 |
| swe-grep | SWE-Grep |
| swe-1 | SWE-1 |
| windsurf-auto | Windsurf Auto |
| claude-4.5-opus-high-thinking | Opus 4.5 (Thinking) |
| claude-4-sonnet-thinking | Sonnet 4 (Thinking) |
| claude-4.6-sonnet | Sonnet 4.6 |

## Tool Mapping

When session data becomes available, Windsurf tools map to CodeBurn's standard names as follows:

| Windsurf Tool | CodeBurn Tool |
|---------------|---------------|
| read_file | Read |
| write_file | Edit |
| edit_file | Edit |
| run_command | Bash |
| bash | Bash |
| browser_search | WebSearch |
| web_search | WebSearch |
| mcp_tool | MCP |
| agent_spawn | Agent |
| think | Think |
| planning | Plan |

## Environment Variables

- `WINDSURF_HOME`: Override Windsurf data directory (default: platform-specific)

## Troubleshooting

### No Sessions Found
This is expected behaviour until Windsurf exposes a local API for session data.  The provider is registered so that it will work automatically once that happens.
