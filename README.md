<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/getagentseal/codeburn@main/assets/logo.png" alt="CodeBurn" width="120" />
</p>

<h1 align="center">CodeBurn</h1>

<p align="center">See where your AI coding tokens go.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/v/codeburn.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/dt/codeburn.svg" alt="total downloads" /></a>
  <a href="https://github.com/getagentseal/codeburn/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/codeburn.svg" alt="license" /></a>
  <a href="https://github.com/getagentseal/codeburn"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="node version" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/dashboard.jpg" alt="CodeBurn TUI dashboard" width="620" />
</p>

By task type, tool, model, MCP server, and project. Supports **Claude Code**, **Codex** (OpenAI), **Cursor**, **OpenCode**, **Pi**, and **GitHub Copilot** with a provider plugin system. Tracks one-shot success rate per activity type so you can see where the AI nails it first try vs. burns tokens on edit/test/fix retries. Interactive TUI dashboard with gradient charts, responsive panels, and keyboard navigation. Native macOS menubar app in `mac/`. CSV/JSON export.

Works by reading session data directly from disk. No wrapper, no proxy, no API keys. Pricing from LiteLLM (auto-cached, all models supported).

## Install

```bash
npm install -g codeburn
```

Or run without installing:

```bash
npx codeburn
```

### Requirements

- Node.js 20+
- Claude Code (`~/.claude/projects/`), Codex (`~/.codex/sessions/`), Cursor, OpenCode, Pi (`~/.pi/agent/sessions/`), and/or GitHub Copilot (`~/.copilot/session-state/`)
- For Cursor/OpenCode support: `better-sqlite3` is installed automatically as an optional dependency

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
```

Arrow keys switch between Today / 7 Days / 30 Days / Month / All Time. Press `q` to quit, `1` `2` `3` `4` `5` as shortcuts, `c` to open model comparison. The dashboard auto-refreshes every 30 seconds by default (`--refresh 0` to disable). The dashboard also shows average cost per session and the five most expensive sessions across all projects.

### JSON output

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

For the lighter `status --format json` (today + month totals only) or file-based exports (`export -f json`), see above.

## Providers

CodeBurn auto-detects which AI coding tools you use. If multiple providers have session data on disk, press `p` in the dashboard to toggle between them.

```bash
codeburn report                      # all providers combined (default)
codeburn report --provider claude    # Claude Code only
codeburn report --provider codex     # Codex only
codeburn report --provider cursor    # Cursor only
codeburn report --provider opencode  # OpenCode only
codeburn report --provider pi        # Pi only
codeburn report --provider copilot   # GitHub Copilot only
codeburn today --provider codex      # Codex today
codeburn export --provider claude    # export Claude data only
```

The `--provider` flag works on all commands: `report`, `today`, `month`, `status`, `export`.

### Project filtering

Filter results by project name (case-insensitive substring match). Both flags are repeatable:

```bash
codeburn report --project myapp                  # show only projects matching "myapp"
codeburn report --exclude myapp                  # show everything except "myapp"
codeburn report --exclude myapp --exclude tests  # exclude multiple projects
codeburn month --project api --project web       # include multiple projects
codeburn export --project inventory              # export only "inventory" project data
```

The `--project` and `--exclude` flags work on all commands and can be combined with `--provider`.

### Date range filtering

Beyond the preset periods, specify an exact window with `--from` and `--to` (`YYYY-MM-DD`, local time):

```bash
codeburn report --from 2026-04-01 --to 2026-04-10   # explicit window
codeburn report --from 2026-04-01                    # this date through today
codeburn report --to 2026-04-10                      # earliest data through this date
codeburn report --from 2026-04-01 --to 2026-04-10 --format json
```

Either flag alone is valid. Inverted or malformed dates exit with a clear error. In the TUI, the custom range sets the initial load only -- pressing `1`-`5` switches back to predefined periods.

### Supported providers

| Provider | Data location | Status |
|----------|--------------|--------|
| Claude Code | `~/.claude/projects/` | Supported |
| Claude Desktop | `~/Library/Application Support/Claude/local-agent-mode-sessions/` | Supported |
| Codex (OpenAI) | `~/.codex/sessions/` | Supported |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | Supported |
| OpenCode | `~/.local/share/opencode/` (SQLite) | Supported |
| Pi | `~/.pi/agent/sessions/` | Supported |
| GitHub Copilot | `~/.copilot/session-state/` | Supported (output tokens only) |
| Amp | -- | Planned (provider plugin system) |

Codex tool names are normalized to match Claude's conventions (`exec_command` shows as `Bash`, `read_file` as `Read`, etc.) so the activity classifier and tool breakdown work across providers.

Cursor reads token usage from its local SQLite database. Since Cursor's "Auto" mode hides the actual model used, costs are estimated using Sonnet pricing (labeled "Auto (Sonnet est.)" in the dashboard). The Cursor view shows a **Languages** panel (extracted from code blocks) instead of Core Tools/Shell/MCP panels, since Cursor does not log individual tool calls. First run on a large Cursor database may take up to a minute; results are cached and subsequent runs are instant.

GitHub Copilot only logs output tokens in its session state, so Copilot cost rows sit below actual API cost. The model is tracked via `session.model_change` events; messages before the first model change are skipped to avoid silent misattribution.

### Adding a provider

The provider plugin system makes adding a new provider a single file. Each provider implements session discovery, JSONL parsing, tool normalization, and model display names. See `src/providers/codex.ts` for an example.

## Currency

By default, costs are shown in USD. To display in a different currency:

```bash
codeburn currency GBP          # set to British Pounds
codeburn currency AUD          # set to Australian Dollars
codeburn currency JPY          # set to Japanese Yen
codeburn currency              # show current setting
codeburn currency --reset      # back to USD
```

Any [ISO 4217 currency code](https://en.wikipedia.org/wiki/ISO_4217#List_of_ISO_4217_currency_codes) is supported (162 currencies). Exchange rates are fetched from [Frankfurter](https://www.frankfurter.app/) (European Central Bank data, free, no API key) and cached for 24 hours at `~/.cache/codeburn/`. Config is stored at `~/.config/codeburn/config.json`.

The currency setting applies everywhere: dashboard, status bar, menu bar widget, CSV/JSON exports, and JSON API output.

The menu bar widget includes a currency picker with 17 common currencies. For any currency not listed, use the CLI command above.

## Plans (subscription tracking)

If you're on Claude Pro, Claude Max, or Cursor Pro, set your plan so the dashboard shows subscription-relative usage:

```bash
codeburn plan set claude-max                                  # $200/month
codeburn plan set claude-pro                                  # $20/month
codeburn plan set cursor-pro                                  # $20/month
codeburn plan set custom --monthly-usd 150 --provider claude # custom
codeburn plan set none                                        # disable plan view
codeburn plan                                                 # show current
codeburn plan reset                                           # remove plan config
```

The progress bar shows API-equivalent cost vs subscription price. Presets use publicly stated plan prices (as of April 2026); they do not model exact token allowances, because vendors do not publish precise consumer-plan limits.

## Menu Bar

<img src="https://cdn.jsdelivr.net/gh/getagentseal/codeburn@main/assets/menubar-0.8.0.png" alt="CodeBurn macOS menubar app" width="420" />

```bash
npx codeburn menubar
```

One command: downloads the latest `.app`, installs into `~/Applications`, and launches it. Re-run with `--force` to reinstall. Native Swift + SwiftUI app lives in `mac/` (see `mac/README.md` for build details). Shows today's cost with a flame icon, opens a popover with agent tabs, period switcher (Today / 7 Days / 30 Days / Month / All), Trend / Forecast / Pulse / Stats / Plan insights, activity and model breakdowns, optimize findings, and CSV/JSON export. Refreshes live via FSEvents plus a 15-second poll.

## What it tracks

**13 task categories** classified from tool usage patterns and user message keywords. No LLM calls, fully deterministic.

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

**Breakdowns**: daily cost chart, per-project, per-model (Opus/Sonnet/Haiku/GPT-5/GPT-4o/Gemini), per-activity with one-shot rate, core tools, shell commands, MCP servers.

**One-shot rate**: For categories that involve code edits, CodeBurn detects edit/test/fix retry cycles (Edit -> Bash -> Edit patterns). The 1-shot column shows the percentage of edit turns that succeeded without retries. Coding at 90% means the AI got it right first try 9 out of 10 times.

**Pricing**: Fetched from [LiteLLM](https://github.com/BerriAI/litellm) model prices (auto-cached 24h at `~/.cache/codeburn/`). Handles input, output, cache write, cache read, and web search costs. Fast mode multiplier for Claude. Hardcoded fallbacks for all Claude and GPT-5 models to prevent fuzzy matching mispricing.

## Reading the dashboard

CodeBurn surfaces the data, you read the story. A few patterns worth knowing:

| Signal you see | What it might mean |
|---|---|
| Cache hit < 80% | System prompt or context isn't stable, or caching not enabled |
| Lots of `Read` calls per session | Agent re-reading same files, missing context |
| Low 1-shot rate (Coding 30%) | Agent struggling with edits, retry loops |
| Opus 4.6 dominating cost on small turns | Overpowered model for simple tasks |
| `dispatch_agent` / `task` heavy | Sub-agent fan-out, expected or excessive |
| No MCP usage shown | Either you don't use MCP servers, or your config is broken |
| Bash dominated by `git status`, `ls` | Agent exploring instead of executing |
| Conversation category dominant | Agent talking instead of doing |

These are starting points, not verdicts. A 60% cache hit on a single experimental session is fine. A persistent 60% cache hit across weeks of work is a config issue.

## Optimize

Once you know what to look for, `codeburn optimize` scans your sessions and your `~/.claude/` setup for the most common waste patterns and hands back exact, copy-paste fixes. It never writes to your files.

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/optimize.jpg" alt="CodeBurn optimize output" width="720" />
</p>

```bash
codeburn optimize                       # scan the last 30 days
codeburn optimize -p today              # today only
codeburn optimize -p week               # last 7 days
codeburn optimize --provider claude     # restrict to one provider
```

**What it detects**

- Files Claude re-reads across sessions (same content, same context, over and over)
- Low Read:Edit ratio (editing without reading leads to retries and wasted tokens)
- Wasted bash output (uncapped `BASH_MAX_OUTPUT_LENGTH`, trailing noise)
- Unused MCP servers still paying their tool-schema overhead every session
- Ghost agents, skills, and slash commands defined in `~/.claude/` but never invoked
- Bloated `CLAUDE.md` files (with `@-import` expansion counted)
- Cache creation overhead and junk directory reads

Each finding shows the estimated token and dollar savings plus a ready-to-paste fix: a `CLAUDE.md` line, an environment variable, or a `mv` command to archive unused items. Findings are ranked by urgency (impact weighted against observed waste) and rolled up into an A-F setup health grade. Repeat runs classify each finding as new, improving, or resolved against a 48-hour recent window.

You can also open it inline from the dashboard: press `o` when a finding count appears in the status bar, `b` to return.

## Compare

Side-by-side model comparison across any two models in your session data. Pick any pair and see how they stack up on real usage from your own sessions.

```bash
codeburn compare                        # interactive model picker (default: all time)
codeburn compare -p week                # last 7 days
codeburn compare -p today               # today only
codeburn compare --provider claude      # Claude Code sessions only
```

Or press `c` in the dashboard to enter compare mode. Arrow keys switch periods, `b` to return.

**Metrics compared**

| Section | Metric | What it measures |
|---------|--------|-----------------|
| Performance | One-shot rate | Edits that succeed without retries |
| Performance | Retry rate | Average retries per edit turn |
| Performance | Self-correction | Turns where the model corrected its own mistake |
| Efficiency | Cost / call | Average cost per API call |
| Efficiency | Cost / edit | Average cost per edit turn |
| Efficiency | Output tok / call | Average output tokens per call |
| Efficiency | Cache hit rate | Proportion of input from cache |

**Per-category one-shot rates.** Breaks down one-shot success by task category (Coding, Debugging, Feature Dev, etc.) so you can see where each model excels or struggles.

**Working style.** Compares delegation rate (agent spawns), planning rate (TaskCreate, TaskUpdate, TodoWrite usage), average tools per turn, and fast mode usage.

All metrics are computed from your local session data. No LLM calls, fully deterministic.

## How it reads data

**Claude Code** stores session transcripts as JSONL at `~/.claude/projects/<sanitized-path>/<session-id>.jsonl`. Each assistant entry contains model name, token usage (input, output, cache read, cache write), tool_use blocks, and timestamps.

**Codex** stores sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with `token_count` events containing per-call and cumulative token usage, and `function_call` entries for tool tracking.

**Cursor** stores session data in a SQLite database at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS), `~/.config/Cursor/User/globalStorage/state.vscdb` (Linux), or `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (Windows). Token counts are in `cursorDiskKV` table entries with `bubbleId:` key prefix. Requires `better-sqlite3` (installed as optional dependency). Parsed results are cached at `~/.cache/codeburn/cursor-results.json` and auto-invalidate when the database changes.

**OpenCode** stores sessions in SQLite databases at `~/.local/share/opencode/opencode*.db`. CodeBurn queries the `session`, `message`, and `part` tables read-only, extracts token counts and tool usage, and recalculates cost using the LiteLLM pricing engine. Falls back to OpenCode's own cost field for models not in our pricing data. Subtask sessions (`parent_id IS NOT NULL`) are excluded to avoid double-counting. Supports multiple channel databases and respects `XDG_DATA_HOME`.

**Pi** stores sessions as JSONL at `~/.pi/agent/sessions/<sanitized-cwd>/*.jsonl`. Each assistant message carries token usage (input, output, cacheRead, cacheWrite) plus inline `toolCall` content blocks. CodeBurn extracts token counts, normalizes Pi's lowercase tool names to the standard set (`bash` -> `Bash`, `dispatch_agent` -> `Agent`), and pulls bash commands from `toolCall.arguments.command` for the shell breakdown.

CodeBurn reads these files, deduplicates messages (by API message ID for Claude, by cumulative token cross-check for Codex, by conversation/timestamp for Cursor, by session+message ID for OpenCode, by responseId for Pi), filters by date range per entry, and classifies each turn.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Override Claude Code data directory (default: `~/.claude`) |
| `CODEX_HOME` | Override Codex data directory (default: `~/.codex`) |

## Project structure

```
src/
  cli.ts          Commander.js entry point
  dashboard.tsx   Ink TUI (React for terminals)
  parser.ts       JSONL reader, dedup, date filter, provider orchestration
  models.ts       LiteLLM pricing, cost calculation
  classifier.ts   13-category task classifier
  compare-stats.ts Model comparison engine (metrics, category breakdown, working style)
  types.ts        Type definitions
  format.ts       Text rendering (status bar)
  menubar-json.ts Payload builder consumed by the native macOS menubar app in mac/
  export.ts       CSV/JSON multi-period export
  config.ts       Config file management (~/.config/codeburn/)
  currency.ts     Currency conversion, exchange rates, Intl formatting
  sqlite.ts       SQLite adapter (lazy-loads better-sqlite3)
  cursor-cache.ts Cursor result cache (file-based, auto-invalidating)
  providers/
    types.ts      Provider interface definitions
    index.ts      Provider registry (lazy-loads Cursor, OpenCode)
    claude.ts     Claude Code session discovery
    codex.ts      Codex session discovery and JSONL parsing
    cursor.ts     Cursor SQLite parsing, language extraction
    opencode.ts   OpenCode SQLite session discovery and parsing
    pi.ts         Pi agent JSONL session discovery and parsing
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

Inspired by [ccusage](https://github.com/ryoppippi/ccusage) and [CodexBar](https://github.com/nicklama/codexbar). Pricing data from [LiteLLM](https://github.com/BerriAI/litellm). Exchange rates from [Frankfurter](https://www.frankfurter.app/).

Built by [AgentSeal](https://agentseal.org).
