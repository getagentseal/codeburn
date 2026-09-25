# Command reference

Every CodeBurn command and keyboard shortcut, plus the report-focused flags for filtering, JSON output, and diagnosing detection.

Run `codeburn` for the dashboard, or use a subcommand below. Most commands also accept `--provider`, `--project` / `--exclude`, and a period flag (`-p today|week|30days|month|all|lifetime`).

**Dashboard & reports**

| Command | What it does |
|---------|--------------|
| `codeburn` | Interactive dashboard, today (falls back to the last 7 days when today is empty) |
| `codeburn today` | Today's usage |
| `codeburn month` | This calendar month's usage |
| `codeburn overview` | Plain-text monthly summary, copy-pasteable (`--no-color`, `--from`/`--to`) |
| `codeburn report -p 30days` | Rolling 30-day window |
| `codeburn report -p all` | Every recorded session |
| `codeburn report --from 2026-04-01 --to 2026-04-10` | An exact date range |
| `codeburn report --format json` | Full dashboard data as JSON, printed to stdout |
| `codeburn report --refresh 60` | Auto-refresh every 60s (the minimum and default; `--refresh 0` disables) |

**Status & export**

| Command | What it does |
|---------|--------------|
| `codeburn status` | Compact one-liner: today + month totals |
| `codeburn status --format json` | The same totals as JSON |
| `codeburn export` | CSV covering today, 7 days, and 30 days |
| `codeburn export -f json` | Export as JSON instead of CSV |
| `codeburn export -f json -o <dir>/` | Write the export inside a folder, as `codeburn-export-YYYY-MM-DD.json` |

**Sync (team telemetry)** _preview_

| Command | What it does |
|---------|--------------|
| `codeburn sync setup <url>` | One-time setup: OIDC login via browser, stores token securely |
| `codeburn sync push` | Push unsent usage to remote endpoint (default: last 7 days) |
| `codeburn sync push --since 30d` | Push a larger window |
| `codeburn sync status` | Show endpoint, auth state, last sync time |
| `codeburn sync logout` | Revoke token and remove credentials |
| `codeburn sync reset --confirm` | Clear sent-ledger (re-send all data on next push) |

Sync sends token counts, costs, models, and projects, never prompts or code. This feature is in preview; the protocol may change between releases. See [sync/](sync/) for details.

**Web & devices**

| Command | What it does |
|---------|--------------|
| `codeburn web` | Local browser dashboard with charts (http://localhost:4747) |
| `codeburn share --pair` | Share this device's usage to your other devices (PIN pairing) |
| `codeburn devices add` | Find and pair a nearby device |
| `codeburn devices` | Combined usage totals across your paired devices |

**Analysis**

| Command | What it does |
|---------|--------------|
| `codeburn quota` | Live provider capacity: quota windows for each signed-in coding tool |
| `codeburn quota --format json` | The same capacity readings as JSON |
| `codeburn gateway-totals` | Show whether Vercel AI Gateway spend counts toward totals (`include`, `exclude`) |
| `codeburn doctor` | Per-provider detection status: paths probed, sessions found, parse health (`--json`, `--provider`) |
| `codeburn audit` | Per provider-model token source table: where every number comes from |
| `codeburn context` | What fills a session's context window: interactive browser (Claude Code and Codex) |
| `codeburn context <id> --json` | The same context tree, scriptable |
| `codeburn optimize` | Scan for waste and print copy-paste fixes (last 30 days) |
| `codeburn optimize -p week` | Scope the waste scan to the last 7 days |
| `codeburn compare` | Side-by-side model comparison |
| `codeburn yield` | Productive vs reverted/abandoned spend, correlated against git |
| `codeburn yield -p 30days` | Yield analysis for the last 30 days |

**Fix & control**

| Command | What it does |
|---------|--------------|
| `codeburn optimize --apply` | Interactively apply config-class fixes (`--yes`, `--dry-run`, `--only <ids>`) |
| `codeburn act list` | Every change CodeBurn has applied, newest first |
| `codeburn act undo <id>` | Roll a change back (`--last` for the most recent, `--force` if files drifted) |
| `codeburn act report` | Realized vs estimated savings for applied fixes |
| `codeburn guard install` | Budget-cap hooks for Claude Code (`--global`, `--statusline`) |
| `codeburn guard status` | Show caps, install locations, and flagged projects |
| `codeburn guard allow` | Lift the hard cap for the current session |
| `codeburn mcp` | MCP server (stdio) exposing usage and savings to AI agents |

**Models**

| Command | What it does |
|---------|--------------|
| `codeburn models` | Per-model token + cost table (last 30 days) |
| `codeburn models --by-task` | Break each model into per-task-type rows |
| `codeburn models --by-agent` | Break each model into per-agent rows: which agent drove which model's spend (`(main)` covers non-agent sessions; `--min-cost 0` shows sub-cent agents) |
| `codeburn models --top 10` | Only the 10 most expensive models |
| `codeburn models --unpriced` | Only models with usage that currently price at $0 — the copyable form of the unpriced-models warning. Shows raw model IDs (not friendly names). Per-token gaps go to `model-alias`; subscription / flat-rate SKUs go to `model-flat-rate`. JSON keeps IDs exact |
| `codeburn models --format markdown` | Emit a paste-friendly markdown table |
| `codeburn models --task feature` | Filter to feature-development work |
| `codeburn models --provider claude` | Filter to a single provider |

Left/right arrow keys switch between Today, 7 Days, 30 Days, Month, 6 Months, and Lifetime (use `--from` / `--to` for an exact historical window). Up/down scroll the full dashboard one line, Page Up/Page Down move one screen, and Home/End jump to either end. The main Daily Activity panel shows at least 10 dates from scrollable full history: use `j`/`k` to move one day, Shift+Space/Space to page, and `g`/`G` to jump to either end. Panels flow in the same order across three columns at maximum width, two at medium width, and one when narrow. In the three-column layout, all panels widen equally by one character for every three additional terminal columns until the dashboard reaches the lesser of 256 characters or the widest renderable source row. Press `q` to quit, `1` `2` `3` `4` `5` `6` as period shortcuts, `c` to open model comparison, or `o` to open optimize. Mouse-wheel scrolling is off so that click and drag still selects text for copying; press `m` to turn the wheel on for the rest of the run. Today, 7 Days, and concrete-day views refresh in place at most once per minute by default (`--refresh 0` to disable) without changing the active view or scroll position. The heavier aggregate views remain static between deliberate navigation changes. The dashboard also shows average cost per session and the five most expensive sessions across all projects.

## Your month at a glance

```bash
codeburn overview                                    # this month, clean tables
codeburn overview --no-color                         # plain text, ready to paste
codeburn overview --from 2026-06-01 --to 2026-06-15  # any date range
codeburn overview -p all                             # last 6 months
codeburn overview -p lifetime                        # full history (uncapped)
codeburn overview --provider claude                  # one tool only
```

`codeburn overview` prints a copy-pasteable summary of where your AI spend went: totals (cost, tokens, cache hit), a breakdown by tool and by top model, your highest-value days, top projects, a per-day table, and activity and tool usage. Pipe it anywhere (into `pbcopy`, a PR, Slack, or a tweet); color drops automatically when the output is not a terminal, or pass `--no-color`.

```text
CodeBurn  June 2026

Totals
  Cost       $2,795.10
  Tokens     3.49B   in 23.9M / out 20.2M / cache-w 72.5M / cache-r 3.38B
  Calls      14,755   sessions 753
  Cache hit  99.3%

By tool
┌──────────┬───────────┬────────┬───────┐
│ Tool     │      Cost │ Tokens │ Share │
├──────────┼───────────┼────────┼───────┤
│ claude   │ $2,662.37 │  3.34B │   95% │
│ codex    │   $119.12 │ 128.1M │    4% │
└──────────┴───────────┴────────┴───────┘

(plus Top models, Highest-value days, Top projects, a per-day table, By activity, and Tools)
```

## Compare models

```bash
codeburn compare                        # interactive model picker (default: last 6 months)
codeburn compare -p week                # last 7 days
codeburn compare -p today               # today only
codeburn compare --provider claude      # Claude Code sessions only
```

Which model is actually better for *your* work? Press `c` in the dashboard, or run `codeburn compare`. Arrow keys switch periods, `b` to return.

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

## Filtering

```bash
codeburn report --project myapp                  # show only projects matching "myapp"
codeburn report --exclude myapp                  # show everything except "myapp"
codeburn report --exclude myapp --exclude tests  # exclude multiple projects
codeburn month --project api --project web       # include multiple projects
codeburn export --project inventory              # export only "inventory" project data
```

Filter by provider, project, or exact date range. The `--project` and `--exclude` flags work on every reporting command and can be combined with `--provider`. A plain word matches a project's name or path as a case-insensitive substring, so `--project my-company` also covers `my-company-kit` and its worktrees. An absolute path selects that one project and anything inside it, so `--exclude /Users/me/work/my-company` leaves the sibling `/Users/me/work/my-company-kit` alone. A leading `~` is expanded against your home directory, so a quoted `'~/work/my-company'` selects the same project as the path the shell would have expanded. An absolute POSIX path is case-sensitive, the same rule that decides project identity everywhere else (`/Users/me/Vault` and `/Users/me/vault` are two projects); a Windows drive or UNC path folds case. An absolute path that matches no project in the period you asked for is reported on stderr, since it would otherwise leave a total that looks right.

```bash
codeburn report --from 2026-04-01 --to 2026-04-10   # explicit window
codeburn report --from 2026-04-01                    # this date through today
codeburn report --to 2026-04-10                      # earliest data through this date
```

Either flag alone is valid. Inverted or malformed dates exit with a clear error. In the TUI, the custom range sets the initial load only; pressing `1` through `6` switches back to predefined periods.

## JSON output

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

For lighter output, use `status --format json` (today and month totals only), `optimize --format json` (setup health, findings, and copy-paste fixes), `yield --format json` (productive/reverted/abandoned/ambiguous spend), or file exports (`export -f json`).

## Diagnosing detection

When a tool shows zero (or a number that looks wrong), `codeburn doctor` explains why. It runs fully offline and read-only, and never writes to caches or config.

```bash
codeburn doctor                     # every provider, human-readable table
codeburn doctor --provider opencode # diagnose one provider
codeburn doctor --json              # machine-readable, pipe to jq
```

For each provider it shows the exact directories or databases probed (with any env override such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `OPENCODE_DATA_DIR` and whether the path exists), how many session files were found, how many of a bounded sample parsed cleanly, the cached file count, and a one-line verdict: `OK (n sessions)`, `NOTHING FOUND` with the likely cause (directory missing, override points at an empty dir, or the tool is not installed), or `ERRORS (n parse failures)`. A provider that throws is caught and reported as its own error row, never crashing the rest of the report.

