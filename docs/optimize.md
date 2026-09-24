# optimize

`codeburn optimize` scans your Claude Code sessions and your `~/.claude/` setup, reports what is
costing tokens without earning them, and grades the setup A to F.

## What it scans

- **Session transcripts** for the selected period: tool calls, per-call token usage, turn retries,
  per-session cost, and the block each session opens with. This is where re-reads, junk directory
  reads, low read:edit ratios, warmup overhead, retries, context pasted into session after session,
  and expensive or context-heavy sessions come from.
- **Your configuration**: `~/.claude.json`, user and project `settings.json` / `settings.local.json`,
  `.mcp.json`, `CLAUDE.md` (including `@`-imports), and the `skills/`, `agents/`, `commands/`
  directories. This is where unused MCP servers, MCP deferral gaps, ghost skills/agents/commands,
  the bash output cap, and oversized `CLAUDE.md` files come from.

Nothing is written during a scan. Only `--apply` writes.

## The three classes

Every finding carries a `class`, and both the CLI and the apps group by it:

| Class | Header | Meaning |
|---|---|---|
| `fix` | Fix now (apply-able) | CodeBurn can make this change for you: `codeburn optimize --apply` |
| `nudge` | Habits | Behavioural. Nothing to edit; the fix is how you drive the next session |
| `keep` | FYI | Informational. The cost may well be justified; decide for yourself |

A finding is `fix` only when a plan can actually be built for that instance. The same detector can
report a `fix` in one run and a `nudge` in another: `mcp-deferral-off` is appliable when the cause is
an `ENABLE_TOOL_SEARCH` override in a settings file, but manual when the cause is Vertex AI policy,
an outdated Claude Code, or an override that lives in your shell profile.

## What `--apply` may write

`--apply` builds a plan per finding, shows you the exact files it will touch, and asks before
writing. `--dry-run` prints the plan and stops.

| Finding | File it edits |
|---|---|
| `unused-mcp`, `mcp-low-coverage` | `~/.claude.json`, project `.mcp.json` / `settings.json` (removes the server entry) |
| `mcp-project-scope` | moves a global server entry into the keeper project's `.mcp.json` |
| `mcp-deferral-off` | the settings file carrying the `ENABLE_TOOL_SEARCH` override |
| `mcp-alwaysload-hygiene` | the config files carrying `"alwaysLoad": true` |
| `mcp-defer-threshold` | the settings file carrying the `auto:N` threshold |
| `unused-agents`, `unused-skills`, `unused-commands` | moves the files into `~/.claude/<kind>/.archived/` |
| `bash-output-cap` | appends a marker block to `~/.zshrc` / `~/.bashrc` |
| `read-edit-ratio`, `build-folder-reads` | appends a marker block to the current project's `CLAUDE.md` |

Every write is backed up and journaled first:

```bash
codeburn act list             # every change CodeBurn has made
codeburn act undo <id>        # restore the original files
codeburn act undo --last
```

Undo refuses if a file changed after the apply, unless you pass `--force`.

### The `--yes` CLAUDE.md guardrail

`--apply --yes` skips the prompt for every plan except `CLAUDE.md` rule blocks. Those land in the
`CLAUDE.md` of whatever directory you happen to be in, so a blanket `--yes` from an unrelated
directory would write advice into the wrong project. To apply one anyway, use the interactive picker
or name it explicitly:

```bash
codeburn optimize --apply --only read-edit-ratio
```

## After you apply

Applying a fix is a claim, so CodeBurn checks it. Every `codeburn optimize` run re-measures the
fixes still in place and prints them under `Applied fixes`, one line each:

| Line | Verdict | Meaning |
|---|---|---|
| `✓ unused-skills (7d ago): est. 300.0K -> measured 280.0K` | worked | at least 70% of the estimate showed up in your sessions |
| `~ mcp-defer-threshold (5d ago): est. 600.0K -> measured 420.0K (-30% vs estimate)` | partial | it helped, but under its estimate |
| `✗ bash-output-cap (6d ago): est. 41.0K -> measured 0 - did not help. Revert: codeburn act undo 3f2a1c04` | no-effect | no measured reduction at all |
| `… mcp-remove (1d ago): measuring, check back after 3 days` | measuring | too young, or the change has not taken effect in a session yet |

The estimate shown is the at-apply estimate scaled to the measured window, so the two numbers are
comparable. Both come from the same reconciliation `codeburn act report` prints — there is one set of
numbers, not two — and they are **measured**: provider-counted usage over the post-apply window.
Anything that cannot be measured (no baseline captured, a fix you reverted by hand, a
correlation-only kind like `guard-install`) stays on the `measuring` line with the reason, never a
claimed saving.

`--format json` carries the same list as `appliedFixes[]`, and the section appears in the dashboard
TUI and the desktop app.

### `--auto-revert`

```bash
codeburn optimize --auto-revert
```

Off by default. It undoes exactly the fixes whose verdict is `no-effect`, through the same code path
as `codeburn act undo` (backups restored, drift check applied, the revert journaled). It never
touches a `partial` or still-measuring fix, and it never auto-reverts a `claude-md-rule` — those land
in whatever project directory you were in, the same reason `--yes` skips them, so it prints the undo
command and leaves the file alone.

## measured vs estimated

Each finding also carries a `basis`, printed next to its savings and summarised in the header as
`N measured · M estimated`:

- **measured** — the token number is summed from provider-counted usage on your own calls. Today
  that is `context-heavy-sessions` and `cost-outliers`.
- **estimated** — the token number comes from a model: a per-tool schema size, a per-line `CLAUDE.md`
  cost, an average read size, a recovery fraction applied to real turn tokens. A detector that mixes
  counted tokens with a model counts as estimated.

Sessions whose cost the provider never reported (Kiro, Cursor, some Cline sessions price from
modelled token counts) are kept out of the `cost-outliers` peer comparison, so a modelled cost is
never called an outlier against provider-reported ones. When a provider only ever estimates, the
comparison falls back to those sessions and the finding reports itself as `estimated`.

In `--format json`, `summary.measuredSavingsUSD` is the share of `summary.potentialSavingsCostUSD`
that comes from measured findings.

## Reading the health grade

Health starts at 100 and loses points per finding: 15 for a high-impact one, 7 for medium, 3 for low.
The total penalty is capped at 80, so a long tail of small findings cannot sink the score to zero on
its own. The grade is a band over that score:

| Grade | Score |
|---|---|
| A | 90-100 |
| B | 75-89 |
| C | 55-74 |
| D | 30-54 |
| F | below 30 |

The grade rates your setup, not your spending: an expensive month with a clean configuration still
scores an A.

## Usage

```bash
codeburn optimize                       # scan the last 30 days
codeburn optimize -p today              # today only
codeburn optimize -p week               # last 7 days
codeburn optimize --provider claude     # restrict to one provider
codeburn optimize --format json         # setup health + findings as JSON
```

## Claude Code session population

For Claude Code, the optimize session count, the per-session findings, coaching,
and model-default recommendations use user-started (main) sessions. Subagent
sidechain transcripts are excluded from that population because their delegated
context and delivery behavior are structurally different, and so is the re-read
finding, since a subagent starts on a fresh context. Findings about how Claude
uses tools (junk reads, read:edit ratio) and every spend, MCP, and
configuration-overhead finding keep counting them.

## More waste patterns

- Wasted bash output (uncapped `BASH_MAX_OUTPUT_LENGTH`, trailing noise)
- Cache creation overhead and junk directory reads
- Context-heavy sessions where effective input/cache tokens swamp output
- Possibly low-worth expensive sessions with no edit turns or repeated retries
  when no `git`/`gh` delivery command is observed

## Ranking and repeat runs

Findings are ranked by urgency (impact weighted against observed waste) and rolled up into an A to F setup health grade. Repeat runs classify each finding as new, improving, or resolved against a 48-hour recent window.

## Dashboard shortcut

You can also open it inline from the dashboard: press `o` when a finding count appears in the status bar, `b` to return.

## When results get checked

The loop closes on honesty: once an applied fix is at least 3 days old, `codeburn act report` compares its estimated savings against what your sessions actually did, and every later `codeburn optimize` run lists it under `Applied fixes` with a plain verdict — worked, under its estimate, or did not help, with the undo command for that last case.
