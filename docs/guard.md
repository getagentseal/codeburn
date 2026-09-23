# Guard your budget

```bash
codeburn guard install            # hooks into this project's .claude/settings.json
codeburn guard install --global   # or into ~/.claude/settings.json
codeburn guard status             # caps, install locations, flagged projects
codeburn guard uninstall          # removes cleanly, leaves your own hooks alone
```

Guard installs opt-in hooks into Claude Code that watch session cost while you work:

- **Soft cap** (default $5): a one-time in-session warning when a session passes it.
- **Hard cap** (default $15): stops the session; `codeburn guard allow` lifts it for that session only.
- **Checkpoint** (default $3): if a session ends past this with no edits and no commits, a nudge suggests starting fresh with a named deliverable.
- **Session openers**: projects where optimize found waste get a one-line flag at session start.

Caps are edited in `~/.config/codeburn/guard.json` (set a value to `null` to disable it). Add `--statusline` to show session cost in the Claude Code status line. Installs go through the same journal as everything else, so `codeburn act undo` removes them too. Hooks fail open: a broken guard never blocks a session.

