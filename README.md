<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/AgentSeal/codeburn@main/assets/logo.png" alt="CodeBurn" width="120" />
</p>

<h1 align="center">CodeBurn</h1>

<p align="center">See where your AI coding tokens go.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/v/codeburn.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/dm/codeburn.svg" alt="npm downloads" /></a>
  <a href="https://github.com/agentseal/codeburn/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/codeburn.svg" alt="license" /></a>
  <a href="https://github.com/agentseal/codeburn"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="node version" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/AgentSeal/codeburn/main/assets/dashboard.jpg" alt="CodeBurn TUI dashboard" width="620" />
</p>

By task type, tool, model, MCP server, and project. Supports **Claude Code** and **Codex** (OpenAI) with a provider plugin system. Tracks one-shot success rate per activity type so you can see where the AI nails it first try vs. burns tokens on edit/test/fix retries. Interactive TUI dashboard with gradient charts, responsive panels, and keyboard navigation. macOS menu bar widget via SwiftBar. CSV/JSON export.

Works by reading session transcripts directly from disk. No wrapper, no proxy, no API keys. Pricing from LiteLLM (auto-cached, all models supported).

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
- Claude Code (`~/.claude/projects/`) and/or Codex (`~/.codex/sessions/`)

## Usage

```bash
codeburn                    # interactive dashboard (default: 7 days)
codeburn today              # today's usage
codeburn month              # this month's usage
codeburn report -p 30days   # rolling 30-day window
codeburn status             # compact one-liner (today + month)
codeburn status --format json
codeburn export             # CSV with today, 7 days, 30 days
codeburn export -f json     # JSON export
```

Arrow keys switch between Today / 7 Days / 30 Days / Month. Press `q` to quit, `1` `2` `3` `4` as shortcuts.

## Providers

CodeBurn auto-detects which AI coding tools you use. If both Claude Code and Codex have session data on disk, press `p` in the dashboard to toggle between them.

```bash
codeburn report                    # all providers combined (default)
codeburn report --provider claude  # Claude Code only
codeburn report --provider codex   # Codex only
codeburn today --provider codex    # Codex today
codeburn export --provider claude  # export Claude data only
```

The `--provider` flag works on all commands: `report`, `today`, `month`, `status`, `export`.

### Supported providers

| Provider | Data location | Status |
|----------|--------------|--------|
| Claude Code | `~/.claude/projects/` | Supported |
| Claude Desktop | `~/Library/Application Support/Claude/local-agent-mode-sessions/` | Supported |
| Codex (OpenAI) | `~/.codex/sessions/` | Supported |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) | Supported |
| Pi, Amp | -- | Planned (provider plugin system) |

Codex tool names are normalized to match Claude's conventions (`exec_command` shows as `Bash`, `read_file` as `Read`, etc.) so the activity classifier and tool breakdown work across providers.

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

## Menu Bar

<img src="https://cdn.jsdelivr.net/gh/AgentSeal/codeburn@main/assets/menubar.png" alt="CodeBurn SwiftBar menu bar widget" width="260" />

```bash
codeburn install-menubar    # install SwiftBar/xbar plugin
codeburn uninstall-menubar  # remove it
```

Requires [SwiftBar](https://github.com/swiftbar/SwiftBar) (`brew install --cask swiftbar`). Shows today's cost in the menu bar with a flame icon. Dropdown shows activity breakdown, model costs, token stats, per-provider cost breakdown, and a currency picker. Refreshes every 5 minutes.

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

## How it reads data

**Claude Code** stores session transcripts as JSONL at `~/.claude/projects/<sanitized-path>/<session-id>.jsonl`. Each assistant entry contains model name, token usage (input, output, cache read, cache write), tool_use blocks, and timestamps.

**Codex** stores sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with `token_count` events containing per-call and cumulative token usage, and `function_call` entries for tool tracking.

**OpenCode** stores sessions in a SQLite database at `~/.local/share/opencode/opencode.db`. CodeBurn queries the `session`, `message`, and `part` tables read-only, extracts token counts and tool usage, deduplicates by message ID, and recalculates cost using CodeBurn's pricing engine. Only top-level sessions are included (subtask sessions are excluded to avoid double-counting).

CodeBurn reads these files, deduplicates messages (by API message ID for Claude, by cumulative token cross-check for Codex), filters by date range per entry, and classifies each turn.

## Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Override Claude Code data directory (default: `~/.claude`) |
| `CODEX_HOME` | Override Codex data directory (default: `~/.codex`) |
| `XDG_DATA_HOME` | Override XDG data directory for OpenCode (default: `~/.local/share`) |

## Project structure

```
src/
  cli.ts          Commander.js entry point
  dashboard.tsx   Ink TUI (React for terminals)
  parser.ts       JSONL reader, dedup, date filter, provider orchestration
  models.ts       LiteLLM pricing, cost calculation
  classifier.ts   13-category task classifier
  types.ts        Type definitions
  format.ts       Text rendering (status bar)
  menubar.ts      SwiftBar plugin generator
  export.ts       CSV/JSON multi-period export
  config.ts       Config file management (~/.config/codeburn/)
  currency.ts     Currency conversion, exchange rates, Intl formatting
  providers/
    types.ts      Provider interface definitions
    index.ts      Provider registry
    claude.ts     Claude Code session discovery
    codex.ts      Codex session discovery and JSONL parsing
```

## License

MIT

## Credits

Inspired by [ccusage](https://github.com/ryoppippi/ccusage). Pricing data from [LiteLLM](https://github.com/BerriAI/litellm). Exchange rates from [Frankfurter](https://www.frankfurter.app/).

Built by [AgentSeal](https://agentseal.org).
