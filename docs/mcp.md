# CodeBurn in your agent (MCP)

```bash
claude mcp add codeburn -- npx -y codeburn mcp
```

`codeburn mcp` runs a local MCP server over stdio, so Claude Code, Cursor, or any MCP client can ask "where did my tokens go this week?" or "how do I spend less?" mid-conversation. It exposes two tools:

| Tool | What it returns |
|------|-----------------|
| `get_usage` | Spend and usage with breakdowns by tool, model, project, and task (fast) |
| `get_savings` | Cost reductions: waste findings, retry tax, routing waste (slower, deeper analysis) |

Everything is read from local disk, same as the CLI. Project names are pseudonymized by default; the agent only sees real names if it asks with `include_project_names: true`. For other MCP clients, configure a stdio server with command `npx` and args `-y codeburn mcp`.

