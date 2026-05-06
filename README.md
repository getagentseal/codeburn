<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers.png" alt="CodeBurn" width="520" />
</p>

<p align="center"><strong>See where your AI coding tokens go.</strong></p>

<p align="center">                                                                                                                                                                          
    <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/v/codeburn.svg" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/dt/codeburn.svg" alt="total downloads" /></a>                                                       
    <a href="https://github.com/getagentseal/codeburn/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/codeburn.svg" alt="license" /></a>                                            
    <a href="https://github.com/getagentseal/codeburn"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="node version" /></a>                                        
    <a href="https://discord.gg/pJ2DMWvtAx"><img src="https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>                                     
    <a href="https://github.com/sponsors/iamtoruk"><img src="https://img.shields.io/badge/sponsor-♥-ea4aaa?logo=github" alt="Sponsor" /></a>                                                  
  </p> 

CodeBurn tracks token usage, cost, and performance across **18 AI coding tools**. It breaks down spending by task type, model, tool, project, and provider so you can see exactly where your budget goes.

Everything runs locally. No wrapper, no proxy, no API keys. CodeBurn reads session data directly from disk and prices every call using [LiteLLM](https://github.com/BerriAI/litellm).

<table>
<tr>
<td align="center"><strong>Dashboard</strong></td>
<td align="center"><strong>Menu Bar</strong></td>
</tr>
<tr>
<td><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/dashboard.jpg" alt="CodeBurn TUI dashboard" width="440" /></td>
<td><img src="https://cdn.jsdelivr.net/gh/getagentseal/codeburn@main/assets/menubar-0.8.0.png" alt="CodeBurn macOS menubar" width="440" /></td>
</tr>
<tr>
<td align="center"><strong>Optimize</strong></td>
<td align="center"><strong>Compare</strong></td>
</tr>
<tr>
<td><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/optimize.jpg" alt="CodeBurn optimize" width="440" /></td>
<td><img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/compare.jpg" alt="CodeBurn compare" width="440" /></td>
</tr>
</table>

## Requirements

- Node.js 20+
- At least one supported AI coding tool with session data on disk
- For Cursor and OpenCode support, `better-sqlite3` is installed automatically as an optional dependency

## Install

```bash
npm install -g codeburn
```

Or with Homebrew:

```bash
brew tap getagentseal/codeburn
brew install codeburn
```

Or run directly without installing:

```bash
npx codeburn
bunx codeburn
dx codeburn
```

## Usage

```bash
codeburn                        # interactive dashboard (default: 7 days)
codeburn today                  # today's usage
codeburn month                  # this month's usage
codeburn report -p 30days       # rolling 30-day window
codeburn report -p all          # every recorded session
codeburn report --from 2026-04-01 --to 2026-04-10  # exact date range
codeburn report --format json   # full dashboard data as JSON
codeburn report --refresh 60    # auto-refresh every 60s (default: 30s)
codeburn status                 # compact one-liner (today + month)
codeburn status --format json
codeburn export                 # CSV with today, 7 days, 30 days
codeburn export -f json         # JSON export
codeburn optimize               # find waste, get copy-paste fixes
codeburn optimize -p week       # scope the scan to last 7 days
codeburn compare                # side-by-side model comparison
codeburn yield                  # track productive vs reverted/abandoned spend
codeburn yield -p 30days        # yield analysis for last 30 days
```

Arrow keys switch between Today, 7 Days, 30 Days, Month, and 6 Months (use `--from` / `--to` for an exact historical window). Press `q` to quit, `1` `2` `3` `4` `5` as shortcuts, `c` to open model comparison, `o` to open optimize. The dashboard auto-refreshes every 30 seconds by default (`--refresh 0` to disable). It also shows average cost per session and the five most expensive sessions across all projects.

## Supported Providers

| Provider | Data Location | Supported |
|----------|--------------|-----------|
| Claude Code | `~/.claude/projects/` | Yes |
| Claude Desktop | `~/Library/Application Support/Claude/local-agent-mode-sessions/` | Yes |
| Codex (OpenAI) | `~/.codex/sessions/` | Yes |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | Yes |
| cursor-agent | `~/.cursor/projects/` | Yes |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/` | Yes |
| GitHub Copilot | `~/.copilot/session-state/` + VS Code `workspaceStorage/` | Yes |
| Kiro | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/` | Yes |
| OpenCode | `~/.local/share/opencode/` (SQLite) | Yes |
| OpenClaw | `~/.openclaw/agents/` (+ legacy `.clawdbot`, `.moltbot`, `.moldbot`) | Yes |
| Pi | `~/.pi/agent/sessions/` | Yes |
| OMP (Oh My Pi) | `~/.omp/agent/sessions/` | Yes |
| Droid | `~/.factory/projects/` | Yes |
| Roo Code | VS Code `globalStorage/rooveterinaryinc.roo-cline/tasks/` | Yes |
| KiloCode | VS Code `globalStorage/kilocode.kilo-code/tasks/` | Yes |
| Qwen | `~/.qwen/projects/<project>/chats/` | Yes |
| Goose | `~/.local/share/goose/sessions/sessions.db` (SQLite) | Yes |
| Antigravity | `~/.gemini/antigravity/conversations/` | Yes |

Paths shown are for macOS. Linux and Windows equivalents are detected automatically. If a path has changed or is wrong, please [open an issue](https://github.com/getagentseal/codeburn/issues).

CodeBurn auto-detects which AI coding tools you use. If multiple providers have session data on disk, press `p` in the dashboard to toggle between them.

The `--provider` flag filters any command to a single provider: `codeburn report --provider claude`, `codeburn today --provider codex`, `codeburn export --provider cursor`. Works on all commands: `report`, `today`, `month`, `status`, `export`, `optimize`, `compare`, `yield`.

### Provider Notes

**Cursor** reads token usage from its local SQLite database. Since Cursor's "Auto" mode hides the actual model used, costs are estimated using Sonnet pricing (labeled "Auto (Sonnet est.)" in the dashboard). The Cursor view shows a Languages panel instead of Core Tools/Shell/MCP panels, since Cursor does not log individual tool calls. First run on a large Cursor database may take up to a minute; results are cached and subsequent runs are instant.

**Gemini CLI** stores sessions as single JSON files. Each session embeds real token counts (input, output, cached, thoughts) per message, so no estimation is needed. Gemini reports input tokens inclusive of cached; CodeBurn subtracts cached from input before pricing to avoid double charging.

**Kiro** stores conversations as `.chat` JSON files. Token counts are estimated from content length. The underlying model is not exposed, so sessions are labeled `kiro-auto` and costed at Sonnet rates.

**GitHub Copilot** reads from both `~/.copilot/session-state/` (legacy CLI) and VS Code's `workspaceStorage/*/GitHub.copilot-chat/transcripts/`. The VS Code format has no explicit token counts; tokens are estimated from content length and the model is inferred from tool call ID prefixes.

**OpenClaw** reads JSONL agent logs from `~/.openclaw/agents/` and also checks legacy paths (`.clawdbot`, `.moltbot`, `.moldbot`).

**Roo Code and KiloCode** are Cline-family VS Code extensions. CodeBurn reads `ui_messages.json` from each task directory and extracts token usage from `api_req_started` entries.

Adding a new provider is a single file. See `src/providers/codex.ts` for an example.

## Features

### Cost Tracking

Prices every API call using input, output, cache read, cache write, and web search token counts. Fast mode multiplier for Claude. Pricing fetched from [LiteLLM](https://github.com/BerriAI/litellm) and cached locally for 24 hours. Hardcoded fallbacks for all Claude and GPT models to prevent mispricing.

### Task Categories

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

### Breakdowns

Daily cost chart, per-project, per-model (Opus, Sonnet, Haiku, GPT-5, GPT-4o, Gemini, Kiro, and more), per-activity with one-shot rate, core tools, shell commands, and MCP servers.

### One-Shot Rate

For categories that involve code edits, CodeBurn detects edit/test/fix retry cycles (Edit, Bash, Edit patterns). The one-shot column shows the percentage of edit turns that succeeded without retries. Coding at 90% means the AI got it right first try 9 out of 10 times.

### Pricing

Fetched from [LiteLLM](https://github.com/BerriAI/litellm) model prices (auto-cached 24 hours at `~/.cache/codeburn/`). Handles input, output, cache write, cache read, and web search costs. Fast mode multiplier for Claude. Hardcoded fallbacks for all Claude and GPT-5 models to prevent fuzzy matching mispricing.

### Optimize

```bash
codeburn optimize                       # scan the last 30 days
codeburn optimize -p today              # today only
codeburn optimize -p week               # last 7 days
codeburn optimize --provider claude     # restrict to one provider
```

Scans your sessions and your `~/.claude/` setup for waste patterns:

- Files Claude re-reads across sessions (same content, same context, over and over)
- Low Read:Edit ratio (editing without reading leads to retries and wasted tokens)
- Wasted bash output (uncapped `BASH_MAX_OUTPUT_LENGTH`, trailing noise)
- Unused MCP servers still paying their tool-schema overhead every session
- Ghost agents, skills, and slash commands defined in `~/.claude/` but never invoked
- Bloated `CLAUDE.md` files (with `@-import` expansion counted)
- Cache creation overhead and junk directory reads
- Context-heavy sessions where effective input/cache tokens swamp output
- Possibly low-worth expensive sessions with no edit turns or repeated retries
  when no `git`/`gh` delivery command is observed

Each finding shows the estimated token and dollar savings plus a ready-to-paste fix: a `CLAUDE.md` line, an environment variable, or a `mv` command to archive unused items. Findings are ranked by urgency (impact weighted against observed waste) and rolled up into an A to F setup health grade. Repeat runs classify each finding as new, improving, or resolved against a 48-hour recent window.

You can also open it inline from the dashboard: press `o` when a finding count appears in the status bar, `b` to return.

### Compare

```bash
codeburn compare                        # interactive model picker (default: last 6 months)
codeburn compare -p week                # last 7 days
codeburn compare -p today               # today only
codeburn compare --provider claude      # Claude Code sessions only
```

Or press `c` in the dashboard to enter compare mode. Arrow keys switch periods, `b` to return.

| Section | Metric | What it measures |
|---------|--------|-----------------|
| Performance | One-shot rate | Edits that succeed without retries |
| Performance | Retry rate | Average retries per edit turn |
| Performance | Self-correction | Turns where the model corrected its own mistake |
| Efficiency | Cost per call | Average cost per API call |
| Efficiency | Cost per edit | Average cost per edit turn |
| Efficiency | Output tokens per call | Average output tokens per call |
| Efficiency | Cache hit rate | Proportion of input from cache |

Also compares per-category one-shot rates, delegation rate, planning rate, average tools per turn, and fast mode usage.

### Yield

```bash
codeburn yield                  # last 7 days (default)
codeburn yield -p today         # today only
codeburn yield -p 30days        # last 30 days
codeburn yield -p month         # this calendar month
```

Correlates AI sessions with git commits by timestamp:

| Category | Meaning |
|----------|---------|
| Productive | Commits from this session landed in main |
| Reverted | Commits were later reverted |
| Abandoned | No commits near session, or commits never merged |

Requires a git repository. Run from your project directory.

### Plans

```bash
codeburn plan set claude-max                                  # $200/month
codeburn plan set claude-pro                                  # $20/month
codeburn plan set cursor-pro                                  # $20/month
codeburn plan set custom --monthly-usd 150 --provider claude  # custom
codeburn plan set none                                        # disable plan view
codeburn plan                                                 # show current
codeburn plan reset                                           # remove plan config
```

Subscription tracking for Claude Pro, Claude Max, and Cursor Pro. The dashboard shows a progress bar of API-equivalent cost against your plan price. Supports custom plans. Presets use publicly stated plan prices (as of April 2026); they do not model exact token allowances, because vendors do not publish precise consumer-plan limits.

### Currency

```bash
codeburn currency GBP          # set to British Pounds
codeburn currency AUD          # set to Australian Dollars
codeburn currency JPY          # set to Japanese Yen
codeburn currency              # show current setting
codeburn currency --reset      # back to USD
```

Any [ISO 4217 currency code](https://en.wikipedia.org/wiki/ISO_4217#List_of_ISO_4217_currency_codes) is supported (162 currencies). Exchange rates fetched from [Frankfurter](https://www.frankfurter.app/) (European Central Bank data, free, no API key) and cached for 24 hours. Config stored at `~/.config/codeburn/config.json`. The currency setting applies everywhere: dashboard, status bar, menu bar, CSV/JSON exports, and JSON API output.

### Model Aliases

If you see `$0.00` for some models, the model name reported by your provider does not match any entry in the LiteLLM pricing data. This commonly happens when using a proxy that rewrites model names.

```bash
codeburn model-alias "my-proxy-model" "claude-opus-4-6"   # add alias
codeburn model-alias --list                                # show configured aliases
codeburn model-alias --remove "my-proxy-model"             # remove alias
```

Aliases are stored in `~/.config/codeburn/config.json` and applied at runtime before pricing lookup. The target name can be anything in the [LiteLLM model list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) or a canonical name from the fallback table (e.g. `claude-sonnet-4-6`, `claude-opus-4-5`, `gpt-4o`). Built-in aliases ship for known proxy model name variants. User-configured aliases take precedence over built-ins.

### Filtering

```bash
codeburn report --project myapp                  # show only projects matching "myapp"
codeburn report --exclude myapp                  # show everything except "myapp"
codeburn report --exclude myapp --exclude tests  # exclude multiple projects
codeburn month --project api --project web       # include multiple projects
codeburn export --project inventory              # export only "inventory" project data
```

Filter by provider, project name (case-insensitive substring), or exact date range. The `--project` and `--exclude` flags work on all commands and can be combined with `--provider`.

```bash
codeburn report --from 2026-04-01 --to 2026-04-10   # explicit window
codeburn report --from 2026-04-01                    # this date through today
codeburn report --to 2026-04-10                      # earliest data through this date
```

Either flag alone is valid. Inverted or malformed dates exit with a clear error. In the TUI, the custom range sets the initial load only; pressing `1` through `5` switches back to predefined periods.

### JSON Output

`report`, `today`, and `month` support `--format json` to output the full dashboard data as structured JSON to stdout:

```bash
codeburn report --format json             # 7-day JSON report
codeburn today --format json              # today's data as JSON
codeburn month --format json              # this month as JSON
codeburn report -p 30days --format json   # 30-day window
```

The JSON includes all dashboard panels: overview (cost, calls, sessions, cache hit %), daily breakdown, projects (with `avgCostPerSession`), models with token counts, activities with one-shot rates, core tools, MCP servers, and shell commands. Pipe to `jq` for filtering:

```bash
codeburn report --format json | jq '.projects'
codeburn today --format json | jq '.overview.cost'
```

For lighter output, use `status --format json` (today and month totals only) or file exports (`export -f json`).

## Menu Bar

```bash
codeburn menubar
```

One command: downloads the latest `.app`, installs into `~/Applications`, and launches it. Re-run with `--force` to reinstall. Native Swift and SwiftUI app lives in `mac/` (see `mac/README.md` for build details).

The menubar icon always shows today's spend (so $0 is normal if you have not used AI tools today). Click to open a popover with agent tabs, period switcher (Today, 7 Days, 30 Days, Month, All), Trend, Forecast, Pulse, Stats, and Plan insights, activity and model breakdowns, optimize findings, and CSV/JSON export. Refreshes every 30 seconds.

**Compact mode** shrinks the menubar item to fit the text, dropping decimals (e.g. `$110` instead of `$110.20`):

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarCompact -bool true
```

Relaunch the app to apply. To revert: `defaults delete org.agentseal.codeburn-menubar CodeBurnMenubarCompact`.

## Reading the Dashboard

CodeBurn surfaces the data, you read the story. A few patterns worth knowing:

| Signal you see | What it might mean |
|---|---|
| Cache hit < 80% | System prompt or context is not stable, or caching not enabled |
| Lots of `Read` calls per session | Agent re-reading same files, missing context |
| Low 1-shot rate (Coding 30%) | Agent struggling with edits, retry loops |
| Opus 4.6 dominating cost on small turns | Overpowered model for simple tasks |
| `dispatch_agent` / `task` heavy | Sub-agent fan-out, expected or excessive |
| No MCP usage shown | Either you don't use MCP servers, or your config is broken |
| Bash dominated by `git status`, `ls` | Agent exploring instead of executing |
| Conversation category dominant | Agent talking instead of doing |

These are starting points, not verdicts. A 60% cache hit on a single experimental session is fine. A persistent 60% cache hit across weeks of work is a config issue.

## How It Reads Data

**Claude Code** stores session transcripts as JSONL at `~/.claude/projects/<sanitized-path>/<session-id>.jsonl`. Each assistant entry contains model name, token usage (input, output, cache read, cache write), tool_use blocks, and timestamps.

**Codex** stores sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with `token_count` events containing per-call and cumulative token usage, and `function_call` entries for tool tracking.

**Cursor** stores session data in a SQLite database at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS), `~/.config/Cursor/User/globalStorage/state.vscdb` (Linux), or `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (Windows). Token counts are in `cursorDiskKV` table entries with `bubbleId:` key prefix. Requires `better-sqlite3` (installed as optional dependency). Parsed results are cached at `~/.cache/codeburn/cursor-results.json` and auto-invalidate when the database changes.

**OpenCode** stores sessions in SQLite databases at `~/.local/share/opencode/opencode*.db`. CodeBurn queries the `session`, `message`, and `part` tables read-only, extracts token counts and tool usage, and recalculates cost using the LiteLLM pricing engine. Falls back to OpenCode's own cost field for models not in our pricing data. Subtask sessions (`parent_id IS NOT NULL`) are excluded to avoid double counting. Supports multiple channel databases and respects `XDG_DATA_HOME`.

**Pi / OMP** stores sessions as JSONL at `~/.pi/agent/sessions/<sanitized-cwd>/*.jsonl` (Pi) and `~/.omp/agent/sessions/<sanitized-cwd>/*.jsonl` (OMP). Each assistant message carries token usage (input, output, cacheRead, cacheWrite) plus inline `toolCall` content blocks. CodeBurn extracts token counts, normalizes tool names to the standard set (`bash` to `Bash`, `dispatch_agent` to `Agent`), and pulls bash commands from `toolCall.arguments.command` for the shell breakdown.

**Gemini CLI** stores sessions as single JSON files at `~/.gemini/tmp/<project>/chats/session-*.json`. Each session embeds real token counts (input, output, cached, thoughts) per message. Gemini reports input tokens inclusive of cached; CodeBurn subtracts cached from input before pricing to avoid double charging.

**OpenClaw** stores agent sessions as JSONL at `~/.openclaw/agents/*.jsonl`. Also checks legacy paths `.clawdbot`, `.moltbot`, `.moldbot`. Token usage comes from assistant message `usage` blocks; model from `modelId` or `message.model` fields.

**Roo Code / KiloCode** are Cline-family VS Code extensions. CodeBurn reads `ui_messages.json` from each task directory in VS Code's `globalStorage`, filtering `type: "say"` entries with `say: "api_req_started"` to extract token counts.

CodeBurn deduplicates messages (by API message ID for Claude, by cumulative token cross-check for Codex, by conversation/timestamp for Cursor, by session ID for Gemini, by session+message ID for OpenCode, by responseId for Pi/OMP), filters by date range per entry, and classifies each turn.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Override Claude Code data directory (default: `~/.claude`) |
| `CODEX_HOME` | Override Codex data directory (default: `~/.codex`) |
| `FACTORY_DIR` | Override Droid data directory (default: `~/.factory`) |
| `QWEN_DATA_DIR` | Override Qwen data directory (default: `~/.qwen/projects`) |

## Project Structure

```
src/
  cli.ts            Commander.js entry point
  dashboard.tsx     Ink TUI (React for terminals)
  parser.ts         JSONL reader, dedup, date filter, provider orchestration
  models.ts         LiteLLM pricing, cost calculation
  classifier.ts     13-category task classifier
  compare-stats.ts  Model comparison engine
  daily-cache.ts    Persistent daily cache with migration
  day-aggregator.ts Daily aggregation from session data
  types.ts          Type definitions
  format.ts         Text rendering (status bar)
  menubar-json.ts   Payload builder for the macOS menubar app
  export.ts         CSV/JSON multi-period export
  config.ts         Config file management (~/.config/codeburn/)
  currency.ts       Currency conversion, exchange rates
  sqlite.ts         SQLite adapter (lazy-loads better-sqlite3)
  optimize.ts       Waste pattern detection engine
  providers/
    types.ts        Provider interface definitions
    index.ts        Provider registry
    claude.ts       Claude Code session discovery
    codex.ts        Codex session discovery and JSONL parsing
    copilot.ts      GitHub Copilot session parsing
    cursor.ts       Cursor SQLite parsing, language extraction
    cursor-agent.ts cursor-agent CLI session parsing
    droid.ts        Droid session discovery
    gemini.ts       Gemini CLI session JSON parsing
    kilo-code.ts    KiloCode VS Code extension parsing
    kiro.ts         Kiro .chat JSON session parsing
    openclaw.ts     OpenClaw agent JSONL parsing
    opencode.ts     OpenCode SQLite session parsing
    pi.ts           Pi/OMP agent JSONL session parsing
    qwen.ts         Qwen CLI JSONL session parsing
    roo-code.ts     Roo Code VS Code extension parsing
    goose.ts        Goose SQLite session parsing
    antigravity.ts  Antigravity conversation parsing
```

## Star History

<a href="https://www.star-history.com/?repos=getagentseal%2Fcodeburn&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=getagentseal/codeburn&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=getagentseal/codeburn&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=getagentseal/codeburn&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT

## Credits

Inspired by [ccusage](https://github.com/ryoppippi/ccusage) and [CodexBar](https://github.com/nicobailon/codexbar). Pricing data from [LiteLLM](https://github.com/BerriAI/litellm). Exchange rates from [Frankfurter](https://www.frankfurter.app/).

Built by [AgentSeal](https://agentseal.org).
