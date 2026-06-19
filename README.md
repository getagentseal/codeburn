<p align="center">
  <a href="https://claude.com/open-source-max"><img src="https://img.shields.io/badge/Claude_for_Open_Source-Recipient-da7756?style=for-the-badge&labelColor=1a1a1a" alt="Claude for Open Source Recipient" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/providers.png" alt="CodeBurn" width="420" />
</p>

<p align="center"><strong>See where your AI spend goes.</strong></p>

<p align="center">
    <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/v/codeburn.svg?color=F97316" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/codeburn"><img src="https://img.shields.io/npm/dt/codeburn.svg?color=F97316" alt="total downloads" /></a>
    <a href="https://github.com/getagentseal/codeburn/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/codeburn.svg?color=F97316" alt="license" /></a>
    <a href="https://github.com/getagentseal/codeburn"><img src="https://img.shields.io/badge/node-%3E%3D22-F97316.svg" alt="node version" /></a>
    <a href="https://discord.gg/w2sw8mCqep"><img src="https://img.shields.io/badge/discord-join-F97316?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://github.com/sponsors/iamtoruk"><img src="https://img.shields.io/badge/sponsor-♥-F97316?logo=github" alt="Sponsor" /></a>
</p>

You pay for Claude, Codex, Cursor, and a stack of other AI coding tools. The bill tells you the total. It never tells you that half of it went to conversation instead of code, or that an expensive model burned your budget on work a cheaper one would have one-shot.

CodeBurn does. It reads the session files your tools already write to disk and breaks down every token and dollar by **task, model, tool, and project**, across **28 AI coding tools**.

Everything runs locally. No wrapper, no proxy, no API keys, nothing leaves your machine. Pricing comes from [LiteLLM](https://github.com/BerriAI/litellm), refreshed daily.

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/dashboard.jpg" alt="CodeBurn TUI dashboard" width="760" />
</p>
<p align="center"><em>A week across every tool you use, in one screen.</em></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#find-and-fix-waste">Find waste</a> ·
  <a href="#compare-models">Compare models</a> ·
  <a href="#track-what-shipped">Track what shipped</a> ·
  <a href="#supported-tools">Supported tools</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-reads-your-data">How it reads data</a>
</p>

## Quick start

**Run it instantly**, no install needed:

```bash
npx codeburn
```

That opens the interactive dashboard (last 7 days by default). Arrow keys switch periods, `q` quits. That is the 30-second version. You now know where your AI budget goes.

**Install it** for a permanent `codeburn` command:

```bash
npm install -g codeburn
```

Also runs via `bunx codeburn` or `dx codeburn`, or `brew install codeburn` on macOS.

**Menu bar app** for macOS, with your spend always in the menu bar:

```bash
codeburn menubar
```

Requires **Node.js 22.13+** and at least one supported tool with session data on disk. For Cursor and OpenCode, `better-sqlite3` installs automatically.

## Find and fix waste

```bash
codeburn optimize                       # scan the last 30 days
codeburn optimize -p today              # today only
codeburn optimize -p week               # last 7 days
codeburn optimize --provider claude     # restrict to one provider
codeburn optimize --format json         # setup health + findings as JSON
```

`codeburn optimize` scans your sessions and your `~/.claude/` setup for waste patterns:

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

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/optimize.jpg" alt="CodeBurn optimize" width="760" />
</p>

Each finding shows the estimated token and dollar savings plus a ready-to-paste fix: a `CLAUDE.md` line, an environment variable, or a `mv` command to archive unused items. Findings are ranked by urgency (impact weighted against observed waste) and rolled up into an A to F setup health grade. Repeat runs classify each finding as new, improving, or resolved against a 48-hour recent window.

You can also open it inline from the dashboard: press `o` when a finding count appears in the status bar, `b` to return.

## Compare models

```bash
codeburn compare                        # interactive model picker (default: last 6 months)
codeburn compare -p week                # last 7 days
codeburn compare -p today               # today only
codeburn compare --provider claude      # Claude Code sessions only
```

Which model is actually better for *your* work? Press `c` in the dashboard, or run `codeburn compare`. Arrow keys switch periods, `b` to return.

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/compare.jpg" alt="CodeBurn compare" width="760" />
</p>

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

## Track what shipped

```bash
codeburn yield                  # last 7 days (default)
codeburn yield -p today         # today only
codeburn yield -p 30days        # last 30 days
codeburn yield -p month         # this calendar month
codeburn yield --format json    # productive/reverted/abandoned spend as JSON
```

Did the spend actually ship? `codeburn yield` correlates AI sessions with git commits by timestamp:

| Category | Meaning |
|----------|---------|
| Productive | Commits from this session landed in main |
| Reverted | Commits were later reverted |
| Abandoned | No commits near session, or commits never merged |

Requires a git repository. Run from your project directory.

## Menu bar

```bash
codeburn menubar
```

One command: downloads the latest `.app`, installs into `~/Applications`, and launches it. Re-run with `--force` to reinstall. Native Swift and SwiftUI app lives in `mac/` (see `mac/README.md` for build details).

<p align="center">
  <img src="https://raw.githubusercontent.com/getagentseal/codeburn/main/assets/menubar-0.9.11.png" alt="CodeBurn macOS menubar" width="440" />
</p>

The menubar icon shows the spend period selected in Settings (Today by default; Week, Month, and 6 Months are also available). Non-today periods add a short suffix such as `$42 / mo` so the menu bar value stays clear. Click to open a popover with agent tabs, period switcher (Today, 7 Days, 30 Days, Month, All), Trend, Forecast, Pulse, Stats, and Plan insights, activity and model breakdowns, optimize findings, and CSV/JSON export. Refreshes every 30 seconds.

You can also set the menubar status period from Terminal:

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarPeriod -string month
```

Allowed values are `today`, `week`, `month`, and `sixMonths`. Relaunch the app to apply external defaults changes.

**Compact mode** shrinks the menubar item to fit the text, dropping decimals (e.g. `$110` instead of `$110.20`):

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnMenubarCompact -bool true
```

Relaunch the app to apply. To revert: `defaults delete org.agentseal.codeburn-menubar CodeBurnMenubarCompact`.

## Supported tools

CodeBurn auto-detects which AI coding tools you use. Each logo links to its provider doc.

<p align="center">
  <a href="docs/providers/claude.md" title="Claude Code &amp; Claude Desktop"><img src="assets/providers/claude.jpg" alt="Claude Code &amp; Claude Desktop" height="34" /></a>
  <a href="docs/providers/cline.md" title="Cline"><img src="assets/providers/cline.svg" alt="Cline" height="34" /></a>
  <a href="docs/providers/codex.md" title="Codex (OpenAI)"><img src="assets/providers/codex.png" alt="Codex (OpenAI)" height="34" /></a>
  <a href="docs/providers/cursor.md" title="Cursor"><img src="assets/providers/cursor.jpg" alt="Cursor" height="34" /></a>
  <a href="docs/providers/cursor-agent.md" title="cursor-agent"><img src="assets/providers/cursor-agent.jpg" alt="cursor-agent" height="34" /></a>
  <a href="docs/providers/devin.md" title="Devin"><img src="assets/providers/devin.png" alt="Devin" height="34" /></a>
  <a href="docs/providers/forge.md" title="Forge"><img src="assets/providers/forge.png" alt="Forge" height="34" /></a>
  <a href="docs/providers/gemini.md" title="Gemini CLI"><img src="assets/providers/gemini.png" alt="Gemini CLI" height="34" /></a>
  <a href="docs/providers/mistral-vibe.md" title="Mistral Vibe"><img src="assets/providers/mistral-vibe.svg" alt="Mistral Vibe" height="34" /></a>
  <a href="docs/providers/copilot.md" title="GitHub Copilot"><img src="assets/providers/copilot.jpg" alt="GitHub Copilot" height="34" /></a>
  <a href="docs/providers/ibm-bob.md" title="IBM Bob"><img src="assets/providers/ibm-bob.svg" alt="IBM Bob" height="34" /></a>
  <a href="docs/providers/kiro.md" title="Kiro"><img src="assets/providers/kiro.png" alt="Kiro" height="34" /></a>
  <a href="docs/providers/opencode.md" title="OpenCode"><img src="assets/providers/opencode.png" alt="OpenCode" height="34" /></a>
  <a href="docs/providers/openclaw.md" title="OpenClaw"><img src="assets/providers/openclaw.jpg" alt="OpenClaw" height="34" /></a>
  <a href="docs/providers/pi.md" title="Pi"><img src="assets/providers/pi.png" alt="Pi" height="34" /></a>
  <a href="docs/providers/omp.md" title="OMP (Oh My Pi)"><img src="assets/providers/omp.svg" alt="OMP (Oh My Pi)" height="34" /></a>
  <a href="docs/providers/droid.md" title="Droid"><img src="assets/providers/droid.png" alt="Droid" height="34" /></a>
  <a href="docs/providers/roo-code.md" title="Roo Code"><img src="assets/providers/roo-code.png" alt="Roo Code" height="34" /></a>
  <a href="docs/providers/kilo-code.md" title="KiloCode"><img src="assets/providers/kilo-code.png" alt="KiloCode" height="34" /></a>
  <a href="docs/providers/qwen.md" title="Qwen"><img src="assets/providers/qwen.png" alt="Qwen" height="34" /></a>
  <a href="docs/providers/kimi.md" title="Kimi Code CLI"><img src="assets/providers/kimi.svg" alt="Kimi Code CLI" height="34" /></a>
  <a href="docs/providers/goose.md" title="Goose"><img src="assets/providers/goose.png" alt="Goose" height="34" /></a>
  <a href="docs/providers/antigravity.md" title="Antigravity"><img src="assets/providers/antigravity.png" alt="Antigravity" height="34" /></a>
  <a href="docs/providers/crush.md" title="Crush"><img src="assets/providers/crush.png" alt="Crush" height="34" /></a>
  <a href="docs/providers/warp.md" title="Warp"><img src="assets/providers/warp.jpg" alt="Warp" height="34" /></a>
  <a href="docs/providers/mux.md" title="Mux (coder)"><img src="assets/providers/mux.png" alt="Mux (coder)" height="34" /></a>
  <a href="docs/providers/vercel-gateway.md" title="Vercel AI Gateway"><img src="assets/providers/vercel-gateway.png" alt="Vercel AI Gateway" height="34" /></a>
</p>

If multiple providers have session data on disk, press `p` in the dashboard to toggle between them.

Each provider doc lists the exact data location, storage format, and known quirks. Linux and Windows paths are detected automatically. If a path has changed or is wrong, please [open an issue](https://github.com/getagentseal/codeburn/issues).

The `--provider` flag filters any command to a single provider: `codeburn report --provider claude`, `codeburn today --provider codex`, `codeburn export --provider cursor`. Works on all commands: `report`, `today`, `month`, `status`, `export`, `optimize`, `compare`, `yield`.

Adding a new provider is a single file. See `src/providers/codex.ts` for an example.

## Commands

Run `codeburn` for the dashboard, or use a subcommand below. Most commands also accept `--provider`, `--project` / `--exclude`, and a period flag (`-p today|week|30days|month|all`).

**Dashboard & reports**

| Command | What it does |
|---------|--------------|
| `codeburn` | Interactive dashboard, last 7 days (the default view) |
| `codeburn today` | Today's usage |
| `codeburn month` | This calendar month's usage |
| `codeburn report -p 30days` | Rolling 30-day window |
| `codeburn report -p all` | Every recorded session |
| `codeburn report --from 2026-04-01 --to 2026-04-10` | An exact date range |
| `codeburn report --format json` | Full dashboard data as JSON, printed to stdout |
| `codeburn report --refresh 60` | Auto-refresh every 60s (default 30s; `--refresh 0` disables) |

**Status & export**

| Command | What it does |
|---------|--------------|
| `codeburn status` | Compact one-liner: today + month totals |
| `codeburn status --format json` | The same totals as JSON |
| `codeburn export` | CSV covering today, 7 days, and 30 days |
| `codeburn export -f json` | Export as JSON instead of CSV |

**Analysis**

| Command | What it does |
|---------|--------------|
| `codeburn optimize` | Scan for waste and print copy-paste fixes (last 30 days) |
| `codeburn optimize -p week` | Scope the waste scan to the last 7 days |
| `codeburn compare` | Side-by-side model comparison |
| `codeburn yield` | Productive vs reverted/abandoned spend, correlated against git |
| `codeburn yield -p 30days` | Yield analysis for the last 30 days |

**Models**

| Command | What it does |
|---------|--------------|
| `codeburn models` | Per-model token + cost table (last 30 days) |
| `codeburn models --by-task` | Break each model into per-task-type rows |
| `codeburn models --top 10` | Only the 10 most expensive models |
| `codeburn models --format markdown` | Emit a paste-friendly markdown table |
| `codeburn models --task feature` | Filter to feature-development work |
| `codeburn models --provider claude` | Filter to a single provider |

Arrow keys switch between Today, 7 Days, 30 Days, Month, and 6 Months (use `--from` / `--to` for an exact historical window). Press `q` to quit, `1` `2` `3` `4` `5` as shortcuts, `c` to open model comparison, `o` to open optimize. The dashboard auto-refreshes every 30 seconds by default (`--refresh 0` to disable). It also shows average cost per session and the five most expensive sessions across all projects.

## Features

### Pricing

Prices every API call using input, output, cache read, cache write, and web search token counts, with a fast mode multiplier for Claude. Prices are fetched from [LiteLLM](https://github.com/BerriAI/litellm) and cached locally for 24 hours at `~/.cache/codeburn/`. Hardcoded fallbacks for all Claude and GPT-5 models prevent fuzzy-matching mispricing.

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

For categories that involve code edits, CodeBurn tracks file-aware retry cycles. A retry is when the same file is re-edited after a shell command in between (Edit foo.ts, Bash, Edit foo.ts). Editing different files across shell steps is not a retry. The one-shot column shows the percentage of edit turns that succeeded without retries. Coding at 90% means the AI got it right first try 9 out of 10 times. File-level tracking is available for Claude, Codex, and Goose; other providers fall back to tool-name-based detection.

### Plans

```bash
codeburn plan set claude-max                                  # $200/month
codeburn plan set claude-pro                                  # $20/month
codeburn plan set cursor-pro                                  # $20/month
codeburn plan set custom --monthly-usd 200 --provider codex   # ChatGPT Pro-style custom plan
codeburn plan reset --provider codex                          # remove one provider plan
codeburn plan set none                                        # disable plan view
codeburn plan                                                 # show configured plans
codeburn plan reset                                           # remove plan config
```

Subscription tracking for Claude Pro, Claude Max, Cursor Pro, and custom provider plans. Plans are stored per provider, so you can track Claude and Codex/Cursor subscriptions at the same time; the dashboard shows one overage line per active provider plan. A legacy/custom `all` plan remains a single aggregate plan and is replaced when you add a provider-specific plan, avoiding double-counted overage rows. Existing single-plan config is still read as a fallback. Presets use publicly stated plan prices (as of April 2026); they do not model exact token allowances, because vendors do not publish precise consumer-plan limits.

### Currency

```bash
codeburn currency GBP          # set to British Pounds
codeburn currency AUD          # set to Australian Dollars
codeburn currency JPY          # set to Japanese Yen
codeburn currency CNY          # set to Chinese Yuan
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

For lighter output, use `status --format json` (today and month totals only), `optimize --format json` (setup health, findings, and copy-paste fixes), `yield --format json` (productive/reverted/abandoned spend), or file exports (`export -f json`).

## Reading the dashboard

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

## How it reads your data

| Provider | Data location | Notes |
|----------|---------------|-------|
| **Claude Code** | `~/.claude/projects/<sanitized-path>/<session-id>.jsonl` | Each assistant entry carries model name, token usage (input, output, cache read, cache write), `tool_use` blocks, and timestamps. |
| **Claude (multiple config dirs)** | Set via `CLAUDE_CONFIG_DIRS` (e.g. `~/.claude-work:~/.claude-personal`) | Scans every listed directory and merges sessions into one row per project so totals reflect all your Claude usage. Use `:` on POSIX, `;` on Windows; overrides `CLAUDE_CONFIG_DIR`. Missing or unreadable directories are skipped. |
| **Codex (OpenAI)** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Reads `token_count` events (per-call and cumulative usage) and `function_call` entries for tool tracking; attributes cost by project working directory. `codeburn report --provider codex` views Codex alone. |
| **Cursor** | SQLite `state.vscdb` under `globalStorage`: macOS `~/Library/Application Support/Cursor/User/globalStorage/`, Linux `~/.config/Cursor/User/globalStorage/`, Windows `%APPDATA%/Cursor/User/globalStorage/`; results cached at `~/.cache/codeburn/cursor-results.json` | Token counts live in `cursorDiskKV` entries with a `bubbleId:` prefix; the cache auto-invalidates when the database changes. "Auto" mode hides the model, so cost is estimated at Sonnet rates (labeled "Auto (Sonnet est.)"), and a Languages panel replaces Core Tools/Shell/MCP since Cursor logs no individual tool calls. First run on a large database can take a minute, then results are cached. |
| **OpenCode** | SQLite `~/.local/share/opencode/opencode*.db` (respects `XDG_DATA_HOME`) | Queries `session`, `message`, and `part` read-only and recalculates cost via LiteLLM (falling back to OpenCode's own cost field for unpriced models). Subtask sessions (`parent_id IS NOT NULL`) are excluded to avoid double counting; multiple channel databases are supported. |
| **Gemini CLI** | `~/.gemini/tmp/<project>/chats/session-*.json` | One JSON file per session with real token counts (input, output, cached, thoughts) per message, so no estimation is needed. Input is reported inclusive of cached, so CodeBurn subtracts cached before pricing to avoid double charging. |
| **Antigravity (CLI & IDE)** | Session files under `.gemini/` folders, plus the running language server | Pulls granular trajectory and pricing from the language server process. For the short-lived CLI, optionally install a status-line hook with `codeburn antigravity-hook install` so usage is captured between menubar refreshes. The IDE is detected via the `--app-data-dir antigravity-ide` flag on Windows. |
| **GitHub Copilot** | `~/.copilot/session-state/` (legacy CLI) and VS Code/VSCodium `workspaceStorage/*/GitHub.copilot-chat/transcripts/` | Editor transcripts carry no explicit token counts, so tokens are estimated from content length and the model is inferred from tool call ID prefixes. |
| **Kiro** | `.chat` JSON files | Token counts are estimated from content length. The model is not exposed, so sessions are labeled `kiro-auto` and costed at Sonnet rates. |
| **Mistral Vibe** | `~/.vibe/logs/session/` (or `$VIBE_HOME/logs/session/`); each folder has `meta.json` + `messages.jsonl` | Reads cumulative prompt/completion totals and model pricing from `meta.json`, then the first user prompt and tool calls from `messages.jsonl`. Emits one record per session (source data is cumulative, not per turn); subagent sessions under `agents/` are counted separately. |
| **OpenClaw** | `~/.openclaw/agents/*.jsonl` (legacy `.clawdbot`, `.moltbot`, `.moldbot`) | Token usage comes from assistant message `usage` blocks; the model from `modelId` or `message.model`. |
| **Warp** | `~/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite` (Preview fallback) | Reads `agent_conversations`, `ai_queries`, and `blocks`, emitting one call per finalized exchange. Exchange token share is estimated from prompt-size weighting normalized to conversation totals; `run_command` blocks attach to the nearest preceding exchange by timestamp. |
| **Forge** | SQLite `~/.forge/.forge.db` | Queries `conversations` read-only and parses `context.messages`. Assistant usage entries provide prompt, completion, and cached counts; CodeBurn subtracts cached from prompt for input pricing, emits one call per assistant message, and extracts tool calls plus shell commands. |
| **Pi / OMP** | `~/.pi/agent/sessions/<sanitized-cwd>/*.jsonl` (Pi), `~/.omp/agent/sessions/<sanitized-cwd>/*.jsonl` (OMP) | Each assistant message carries usage (input, output, cacheRead, cacheWrite) plus inline `toolCall` blocks. Tool names normalize to the standard set (`bash` → `Bash`, `dispatch_agent` → `Agent`); bash commands come from `toolCall.arguments.command`. |
| **Codebuff** (formerly Manicode) | `~/.config/manicode/projects/<project>/chats/<chatId>/chat-messages.json` (honors `CODEBUFF_DATA_DIR`; walks `manicode-dev` / `manicode-staging`) | Bills in credits, so each completed assistant message is costed at the public rate of $0.01/credit via `msg.credits`. When an upstream provider's stashed RunState records token-level usage (`message.metadata.runState.sessionState.mainAgentState.messageHistory[*].providerOptions`), the real tokens and LiteLLM cost take precedence. Native tool names (`read_files`, `str_replace`, `run_terminal_command`, `spawn_agents`) normalize to `Read`, `Edit`, `Bash`, `Agent`. |
| **Cline / Roo Code / KiloCode** | VS Code `globalStorage`: Cline at `saoudrizwan.claude-dev` and `~/.cline/data`; Roo Code and KiloCode across VS Code, VS Code Insiders, and VSCodium | Cline-family agents. CodeBurn reads `ui_messages.json` from each task directory, extracting token counts from `type: "say"` entries with `say: "api_req_started"`. |
| **IBM Bob** | `User/globalStorage/ibm.bob-code/tasks/<task-id>/` (GA `IBM Bob` and preview `Bob-IDE` app folders) | Reads `ui_messages.json` for API request token/cost records and `api_conversation_history.json` for the selected model. |
| **Kimi Code CLI** | `$KIMI_SHARE_DIR/sessions/<workdir-hash>/<session-id>/` or `~/.kimi/sessions/<workdir-hash>/<session-id>/` | Reads `wire.jsonl` `StatusUpdate.token_usage` records, mapping `input_other`, `input_cache_read`, `input_cache_creation`, and `output` into the standard token columns; includes subagents under each session's `subagents/` folder. |
| **Vercel AI Gateway** | [Vercel AI Gateway reporting API](https://vercel.com/docs/ai-gateway/capabilities/custom-reporting) (cloud, not local logs) | Set `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` (from `vercel env pull` / `vercel dev`); requires a Vercel plan with Custom Reporting. Without credentials it's skipped silently in the combined dashboard. |

CodeBurn deduplicates messages (by API message ID for Claude, by cumulative token cross-check for Codex, by conversation/timestamp for Cursor, by session ID for Gemini, by session+message ID for OpenCode, by responseId for Pi/OMP, by chat folder + message ID for Codebuff, by session+message ID for Kimi), filters by date range per entry, and classifies each turn.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Override Claude Code data directory (default: `~/.claude`) |
| `CLAUDE_CONFIG_DIRS` | OS-delimited list of Claude data directories to scan together (e.g. `~/.claude-work:~/.claude-personal`). Sessions merge into one row per project. Overrides `CLAUDE_CONFIG_DIR` when set. |
| `CODEX_HOME` | Override Codex data directory (default: `~/.codex`) |
| `CODEBUFF_DATA_DIR` | Override Codebuff data directory (default: `~/.config/manicode`) |
| `FACTORY_DIR` | Override Droid data directory (default: `~/.factory`) |
| `KIMI_SHARE_DIR` | Override Kimi Code CLI share directory (default: `~/.kimi`) |
| `KIMI_MODEL_NAME` | Override Kimi model name when Kimi sessions do not record the model |
| `QWEN_DATA_DIR` | Override Qwen data directory (default: `~/.qwen/projects`) |
| `VIBE_HOME` | Override Mistral Vibe home directory (default: `~/.vibe`) |
| `WARP_DB_PATH` | Override Warp database path (default: Warp Stable, then Warp Preview) |

## Sponsoring CodeBurn

CodeBurn is free, runs entirely on your machine, and exists to cut your AI bill. If it has already saved you more than a sponsorship costs, consider sending a little of that back.

Keeping 28 integrations accurate is constant work. The tools underneath change every week: Cursor reshapes its database, Claude moves a config path, new models ship at new prices. Sponsorship keeps CodeBurn current with all of it, so the numbers you see are always the real ones.

Where your sponsorship goes:

- **Honest numbers.** New models and price changes mapped quickly, so your cost is the real cost, not a guess.
- **More tools.** Every one of the 28 providers started as a single file. Sponsorship funds the next one.
- **Fast fixes.** When a vendor breaks something, paid time is what gets it patched now instead of someday.

Sponsoring as a team or company? Your logo lands right here, in front of every developer who opens the repo. The first sponsor gets it to themselves until the next one shows up.

<p align="center">
  <a href="https://github.com/sponsors/iamtoruk"><img src="https://img.shields.io/badge/Sponsor_CodeBurn-♥-F97316?style=for-the-badge&logo=github&labelColor=1a1a1a" alt="Sponsor CodeBurn" /></a>
</p>

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
