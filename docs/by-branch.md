# Spend by branch and worktree

The Spend view in CodeBurn Desktop has a **By branch** panel: pick a project and
see where its AI spend went — per git branch, with the recorded worktrees and
the individual sessions behind each branch.

## What each branch row shows

- **Cost** attributed turn by turn. A session that switched branches mid-way
  (for example `feat/auth` → `fix/parser`) contributes each turn's cost to the
  branch that was active when it happened — the same session appears on both
  rows with its own slice, never the whole cost twice.
- **Calls** (behavioral requests) and **tokens per component** (input, output,
  reasoning, cache read, cache write) summed from the same turns.
- **Distinct sessions** and the **activity window** (first–last attributed call
  in the selected range).
- Expanding a row shows the **recorded worktrees** (from the session's
  provider-recorded working directory — the worktree path itself, not today's
  checkout) and each session's contribution. Click a session to inspect its
  real detail: id, provider, working directory, models, tokens, activity.

## Coverage (the fine print, kept visible)

Branch metadata is captured per turn and, today, only Claude transcripts carry
it. The coverage note under the rows therefore splits the project's spend:

- **On branches** — spend attributed to named branches.
- **Unknown, before first branch** — spend inside a branch-bearing session that
  happened before its first recorded branch. A branch set before the selected
  range still carries forward into the range; only spend that genuinely
  predates every recorded branch lands here. It is *Unknown*, never relabeled
  as `main`.
- **No branch data** — spend from sessions that never recorded a branch
  (non-Claude sources). Listed with the providers and session count.

A session on several branch rows counts **once** in the distinct-session total
(rows overlap; they are not summed). Costs do reconcile: known + unknown +
no-branch-data equals the project's total in-range spend.

The lens always respects the period, provider, and calendar range selected at
the top of the window; the project picker narrows the display (choose *All
projects* to see every project's branches, labeled `project / branch`, so two
projects that both have a `main` never merge).

## CLI

The same report is available from the terminal:

```bash
codeburn spend --format branch-json                 # whole period default
codeburn spend --format branch-json --period week --provider claude
codeburn spend --format branch-json --from 2026-07-01 --to 2026-07-11 --project alpha
```

The JSON carries `projects[]` (canonical project id, branch rows, per-session
contributions, worktree evidence, coverage) and `totals` (identity-based
distinct sessions plus the same coverage split). It reuses the `--project` /
`--exclude` filtering introduced for the CLI in #1285.
