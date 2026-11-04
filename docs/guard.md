# Guard your budget

```bash
codeburn guard install            # hooks into this project's .claude/settings.json
codeburn guard install --global   # or into ~/.claude/settings.json
codeburn guard status             # caps, install locations, flagged projects
codeburn guard uninstall          # removes cleanly, leaves your own hooks alone
```

Guard installs opt-in hooks into Claude Code that watch session cost while you work:

- **Soft cap** (default $5): a one-time in-session warning when a session passes it.
- **Hard cap** (default $15): stops the session.
- **Checkpoint** (default $3): if a session ends past this with no edits and no commits, a nudge suggests starting fresh with a named deliverable.
- **Loops** (default warn at 4, stop at 8): the same tool called with the same input that many times in a row gets a one-time warning, then the call is stopped. Any different call resets the count, which tops out at 17.
- **Retries** (default warn at 3, stop at 5): a shell command that already failed that many times in the session gets a one-time warning, then further runs of it are stopped. Successful runs do not reset it.
- `codeburn guard allow` lifts all three stops (hard cap, loops, retries) for that session only, for example when you poll a CI job on purpose.
- Loop and retry warnings reach both you and the agent. When one fired, the end-of-turn note says how many calls it was and what the calls after the warning cost.
- **Session openers**: projects where optimize found waste get a one-line flag at session start.

Caps are edited in `~/.config/codeburn/guard.json` as `softUSD`, `hardUSD`, `checkpointUSD`, `loopWarnAfter`, `loopStopAfter`, `retryWarnAfter` and `retryStopAfter` (set a value to `null` to disable it). Add `--statusline` to show session cost in the Claude Code status line. Installs go through the same journal as everything else, so `codeburn act undo` removes them too. Hooks fail open: a broken guard never blocks a session.

