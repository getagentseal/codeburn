# How CodeBurn reads your data

## Pricing

Prices every API call using input, output, cache read, cache write, and web search token counts, with a fast mode multiplier for Claude. Prices are fetched from [LiteLLM](https://github.com/BerriAI/litellm) and cached locally for 24 hours at `~/.cache/codeburn/`. Hardcoded fallbacks for all Claude and GPT-5 models prevent fuzzy-matching mispricing. Routing-gateway model ids are priced as the model they wrap: [OrcaRouter](https://www.orcarouter.ai) fusion route ids peel to their current upstream (`openai/gpt-oss-120b`), `orcarouter/auto` stays unpriced until a live probe pins the rotating target, and a nested upstream spelling (`orcarouter/deepseek/deepseek-v4-pro`) prices at that exact row, so a gateway-routed session reports real spend instead of $0. Codex sessions routed through [codex-cliproxy-gateway](https://github.com/aceHubert/codex-cliproxy-gateway) record `cliproxy/<model>` ids — including CLIProxyAPI provider paths like `cliproxy/zcode/glm-5.3-flash` — and the wrapper and the known provider segment peel the same way.

## Task categories

13 categories classified from tool usage patterns and user message keywords. No LLM calls, fully deterministic.

| Category | What triggers it |
|---|---|
| Coding | Edit, Write tools |
| Debugging | Error/fix keywords + tool usage |
| Feature Dev | "add", "create", "implement" keywords |
| Refactoring | "refactor", "rename", "simplify" |
| Testing | pytest, vitest, jest in Bash |
| Exploration | Read, Grep, WebSearch without edits |
| Planning | EnterPlanMode, TaskCreate tools |
| Delegation | Agent tool spawns |
| Git Ops | git push/commit/merge in Bash |
| Build/Deploy | npm build, docker, pm2 |
| Brainstorming | "brainstorm", "what if", "design" |
| Conversation | No tools, pure text exchange |
| General | Skill tool, uncategorized |

## Breakdowns

Daily cost chart, per-project, per-model (Opus, Sonnet, Haiku, GPT-5, GPT-4o, Gemini, Kiro, and more), per-activity with one-shot rate, core tools, shell commands, and MCP servers.

## One-shot rate

For categories that involve code edits, CodeBurn tracks file-aware retry cycles. A retry is when the same file is re-edited after a shell command in between (Edit foo.ts, Bash, Edit foo.ts). Editing different files across shell steps is not a retry. The one-shot column shows the percentage of edit turns that succeeded without retries. Coding at 90% means the AI got it right first try 9 out of 10 times. File-level tracking is available for Claude, Codex, and Goose; other providers fall back to tool-name-based detection.

## Per-tool data locations and parsing

| Provider | Data location | Notes |
|----------|---------------|-------|
| **Claude Code** | `~/.claude/projects/<sanitized-path>/<session-id>.jsonl` | Each assistant entry carries model name, token usage (input, output, cache read, cache write), `tool_use` blocks, and timestamps. |
| **Claude (multiple config dirs)** | Set via `CLAUDE_CONFIG_DIRS` (e.g. `~/.claude-work:~/.claude-personal`) | Scans every listed directory and merges sessions into one row per project so totals reflect all your Claude usage. Use `:` on POSIX, `;` on Windows; overrides `CLAUDE_CONFIG_DIR`. Missing or unreadable directories are skipped. |
| **Codex (OpenAI)** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/rollout-*.jsonl` | Reads `token_count` events (per-call and cumulative usage) and `function_call` entries for tool tracking; attributes cost by project working directory. `codeburn report --provider codex` views Codex alone. |
| **Cursor** | SQLite `state.vscdb` under `globalStorage`: macOS `~/Library/Application Support/Cursor/User/globalStorage/`, Linux `~/.config/Cursor/User/globalStorage/`, Windows `%APPDATA%/Cursor/User/globalStorage/`; results cached at `~/.cache/codeburn/cursor-results.v<n>.json` | Input tokens come from Cursor's own per-conversation context meter (`composerData.promptTokenBreakdown`), credited once per conversation on a stable anchor; tool calls and shell commands are read from the agent stream (`agentKv`), and Composer house models are priced from Cursor's published rates. Output is a reply-text estimate and cache tokens are server-side only, so figures are marked estimated and undercount the Cursor admin console for long conversations. The cache auto-invalidates when the database changes; the first run on a large database can take a minute. |
| **OpenCode** | SQLite `~/.local/share/opencode/opencode*.db` or file-based `~/.local/share/opencode/storage/` (respects `XDG_DATA_HOME`; `OPENCODE_DATA_DIR`/`OPENCODE_DB_PREFIX` for renamed/forked builds) | Queries `session`, `message`, and `part` read-only and recalculates cost via LiteLLM (falling back to OpenCode's own cost field for unpriced models). Subtask sessions (`parent_id IS NOT NULL`) are excluded to avoid double counting; multiple channel databases are supported. |
| **Gemini CLI** | `~/.gemini/tmp/<project>/chats/session-*.json` | One JSON file per session with real token counts (input, output, cached, thoughts) per message, so no estimation is needed. Input is reported inclusive of cached, so CodeBurn subtracts cached before pricing to avoid double charging. |
| **Antigravity (CLI & IDE)** | Session files under `.gemini/` folders, plus the running language server | Pulls granular trajectory and pricing from the language server process. For the short-lived CLI, optionally install a status-line hook with `codeburn antigravity-hook install` so usage is captured between menubar refreshes. The IDE is detected via the `--app-data-dir antigravity-ide` flag on Windows. |
| **GitHub Copilot** | `~/.copilot/session-state/` (legacy CLI); VS Code/VSCodium `workspaceStorage/*` chat sessions, `GitHub.copilot-chat/transcripts/`, and the `agent-traces.db` OpenTelemetry store; JetBrains IDEs (IntelliJ, PyCharm, …) under `~/.config/github-copilot/<ide>/<kind>/<storeId>/copilot-*-nitrite.db` | The OTel SQLite store is preferred when present (it carries real input/output/cache token counts). Other sources carry no explicit counts, so tokens are estimated from content length and the model is inferred from tool call ID prefixes. JetBrains sessions read from a Nitrite (H2 MVStore) `.db`; project comes from the plugin's `projectName` field (else the `.git` root of a referenced file). See [providers/copilot.md](providers/copilot.md). |
| **Kiro** | `.chat` JSON files | Token counts are estimated from content length. The model is not exposed, so sessions are labeled `kiro-auto` and costed at Sonnet rates. |
| **Mistral Vibe** | `~/.vibe/logs/session/` (or `$VIBE_HOME/logs/session/`); each folder has `meta.json` + `messages.jsonl` | Reads cumulative prompt/completion totals and model pricing from `meta.json`, then the first user prompt and tool calls from `messages.jsonl`. Emits one record per session (source data is cumulative, not per turn); subagent sessions under `agents/` are counted separately. |
| **OpenClaw** | `~/.openclaw/agents/*.jsonl` (legacy `.clawdbot`, `.moltbot`, `.moldbot`) | Token usage comes from assistant message `usage` blocks; the model from `modelId` or `message.model`. |
| **OpenClaude** | `~/.openclaude/projects/<slug>/*.jsonl` (or `$CODEBURN_OPENCLAUDE_DIR/projects/`) | Claude Code fork routed to any LLM backend; transcripts are Claude-Code schema. Only usage-bearing assistant lines become calls; no cost field exists, so every call is priced from the shared tables and flagged estimated. Sidechain (subagent) lines are counted as real spend. |
| **Warp** | `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite` (Preview fallback) | Reads `agent_conversations`, `ai_queries`, and `blocks`, emitting one call per finalized exchange. Exchange token share is estimated from prompt-size weighting normalized to conversation totals; `run_command` blocks attach to the nearest preceding exchange by timestamp. |
| **Zed** | SQLite `~/Library/Application Support/Zed/threads/threads.db` (Linux `~/.local/share/zed/threads/`) | One row per agent thread; the blob is zstd-compressed JSON with per-request token usage (input, output, cache read, cache write) and the thread's model. Threads are topped up to the exact cumulative counter so totals match the store. Needs Node 22.15+ for built-in zstd. |
| **Forge** | SQLite `~/.forge/.forge.db` | Queries `conversations` read-only and parses `context.messages`. Assistant usage entries provide prompt, completion, and cached counts; CodeBurn subtracts cached from prompt for input pricing, emits one call per assistant message, and extracts tool calls plus shell commands. |
| **Pi / OMP** | `~/.pi/agent/sessions/<sanitized-cwd>/*.jsonl` (Pi), `~/.omp/agent/sessions/<sanitized-cwd>/*.jsonl` (OMP) | Each assistant message carries usage (input, output, cacheRead, cacheWrite) plus inline `toolCall` blocks. Tool names normalize to the standard set (`bash` → `Bash`, `dispatch_agent` → `Agent`); bash commands come from `toolCall.arguments.command`. |
| **Codebuff** (formerly Manicode) | `~/.config/manicode/projects/<project>/chats/<chatId>/chat-messages.json` (honors `CODEBUFF_DATA_DIR`; walks `manicode-dev` / `manicode-staging`) | Bills in credits, so each completed assistant message is costed at the public rate of $0.01/credit via `msg.credits`. When an upstream provider's stashed RunState records token-level usage (`message.metadata.runState.sessionState.mainAgentState.messageHistory[*].providerOptions`), the real tokens and LiteLLM cost take precedence. Native tool names (`read_files`, `str_replace`, `run_terminal_command`, `spawn_agents`) normalize to `Read`, `Edit`, `Bash`, `Agent`. |
| **Cline / KiloCode** | VS Code `globalStorage` across VS Code, VS Code Insiders, and VSCodium (Cline at `saoudrizwan.claude-dev`, plus `~/.cline/data`) | Cline-family agents. CodeBurn reads `ui_messages.json` from each task directory, extracting token counts from `type: "say"` entries with `say: "api_req_started"`. |
| **Cline CLI** | `~/.cline/data/sessions/<session-id>/` (honors `CLINE_SESSION_DATA_DIR`, `CLINE_DATA_DIR`, `CLINE_DIR`) | The Cline command-line agent, whose layout is unrelated to the VS Code extension's. Reads `<session-id>.json` for session metadata and the rolled-up `usage`, and `<session-id>.messages.json` for the per-message `metrics` block (input, output, cacheRead, cacheWrite, cost) that becomes one call each. |
| **CodeWhale** | `~/.codewhale/sessions/*.json` plus unmigrated legacy `~/.deepseek/sessions/*.json`; `$CODEWHALE_HOME/sessions` is an exact override | Emits one cumulative record per saved session. CodeWhale exposes only `total_tokens`, so CodeBurn preserves that aggregate in the input column rather than inventing an input/output split. Cost is the exact stored parent-session plus subagent USD total; model pricing is used only when the cost snapshot is absent. Tool blocks, shell commands, skills, and subagent types are retained. |
| **DeepSeek Harness** (`dsh`) | `~/.dsh/sessions/--<slug>--/<session-id>/session.jsonl.zstd` (or `session.jsonl` when compression is off); `DSH_HOME` relocates the root | DeepSeek's open-source agent harness, unrelated to the CodeWhale desktop app. The `.zstd` log is a concatenation of independent zstd frames (one per write batch), decoded frame by frame; needs Node 22.15+. One call per `(turn, step)`, with usage from the step's `assistant/message` (the streamed `assistant/chunk` sample is a draft of the same call, never a second one). DSH records tokens but no cost, so calls are priced from the shared tables with reasoning billed at the output rate. |
| **IBM Bob** | `User/globalStorage/ibm.bob-code/tasks/<task-id>/` (GA `IBM Bob` and preview `Bob-IDE` app folders) | Reads `ui_messages.json` for API request token/cost records and `api_conversation_history.json` for the selected model. |
| **Kimi Code CLI** | `$KIMI_SHARE_DIR/sessions/<workdir-hash>/<session-id>/` or `~/.kimi/sessions/<workdir-hash>/<session-id>/` | Reads `wire.jsonl` `StatusUpdate.token_usage` records, mapping `input_other`, `input_cache_read`, `input_cache_creation`, and `output` into the standard token columns; includes subagents under each session's `subagents/` folder. |
| **LingTai TUI** | `~/.lingtai/<agent>/logs/token_ledger.jsonl` plus project homes from `~/.lingtai-tui/registry.jsonl` (`<project>/.lingtai/<agent>/logs/token_ledger.jsonl`); honors `LINGTAI_HOME` / `LINGTAI_TUI_HOME` | Reads LingTai's append-only token ledger, mapping `input - cached` to fresh input, `cached` to cache reads, `output` to output, and `thinking` to reasoning. Nested daemon ledgers are skipped because parent ledgers already mirror daemon usage with `source`/`run_id` tags. |
| **Vercel AI Gateway** | [Vercel AI Gateway reporting API](https://vercel.com/docs/ai-gateway/capabilities/custom-reporting) (cloud, not local logs) | Set `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` (from `vercel env pull` / `vercel dev`); requires a Vercel plan with Custom Reporting. Without credentials, it's skipped silently in the combined dashboard. Rows are **daily aggregates per model** with no request identity, so they may duplicate spend the local tools you pointed at the gateway already report — gateway spend is shown as its own row but **excluded from totals by default**. Include it with `codeburn gateway-totals include`. |

CodeBurn deduplicates messages (by API message ID for Claude, by cumulative token cross-check for Codex, by conversation/timestamp for Cursor, by session ID for Gemini, by session+message ID for OpenCode, by responseId for Pi/OMP, by chat folder + message ID for Codebuff, by session+message ID for Kimi), filters by date range per entry, and classifies each turn.

## Reading the dashboard

CodeBurn surfaces the data; you read the story. A few patterns worth knowing:

| Signal you see | What it might mean |
|---|---|
| Cache hit < 80% | System prompt or context is not stable, or caching is not enabled |
| Lots of `Read` calls per session | Agent re-reading same files, missing context |
| Low 1-shot rate (Coding 30%) | Agent struggling with edits, retry loops |
| Opus 4.8 dominating cost on small turns | Overpowered model for simple tasks |
| `dispatch_agent` / `task` heavy | Sub-agent fan-out, expected or excessive |
| No MCP usage shown | Either you don't use MCP servers, or your config is broken |
| Bash dominated by `git status`, `ls` | Agent exploring instead of executing |
| Conversation category dominant | Agent talking instead of doing |

These are starting points, not verdicts. A 60% cache hit on a single experimental session is fine. A persistent 60% cache hit across weeks of work is a config issue.

