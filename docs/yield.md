# Track what shipped

```bash
codeburn yield                  # last 7 days (default)
codeburn yield -p today         # today only
codeburn yield -p 30days        # last 30 days
codeburn yield -p month         # this calendar month
codeburn yield --format json    # productive/reverted/abandoned/ambiguous spend as JSON
```

Did the spend actually ship? `codeburn yield` correlates AI sessions with git commits by timestamp:

| Category | Meaning |
|----------|---------|
| Productive | Commits from this session landed in main |
| Reverted | Commits were later reverted |
| Abandoned | No commits near session, or commits never merged |
| Ambiguous | Session ran parallel to another and its window's commits were attributed to the tighter one |

Attribution is timestamp-window based (heuristic): each commit is credited to at most one session, the tightest window containing it. The JSON report carries `methodology: "timestamp-window"`. A session the window heuristics would leave as abandoned or ambiguous is rescued to productive when a branch it was observed on demonstrably shipped through a squash merge: the branch carries commits of its own, its tip's tree hash matches a commit on main (the squashed tree is byte-identical to the branch tip), and at least one of those commits was made inside the session's own window — so the session contributed the work rather than merely having run on the branch. The rescue needs branch metadata in the session logs, which Claude Code records and most other providers do not.

Requires a git repository. Run from your project directory.

