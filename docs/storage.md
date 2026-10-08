# Storage footprint

`codeburn storage` reports logical file bytes under known provider storage roots
and the CodeBurn cache directory. `codeburn storage --json` returns the same
measurement as structured JSON (`schemaVersion: 1`). Use `--provider codex` (or
another provider name) to limit source roots; the CodeBurn cache is always shown.

The report includes regular-file counts, bytes by provider, the ten largest
source files and available space per measured filesystem. It uses filesystem
metadata only: no prompt bodies, usage parsing, database attachment or SQL
queries. Existing SQLite `-wal` and `-shm` sidecars are included. Configured
paths use the existing provider root resolvers, including environment overrides
and CodeBurn's Claude-directory configuration.

This is **partial storage coverage**, not a session count or a cleanup plan.
All regular files inside the reported roots count, including auxiliary files;
other locations can remain outside the report. Copilot's broad shared editor
roots, Crush's project registry, LingTai's registry, QuickDesk's profile index
and network-only Vercel Gateway are excluded in this version. The JSON lists
excluded/unavailable providers explicitly, including modules that fail to load.

Overlapping roots, shared stores and hard links count once. Files claimed by
multiple providers appear in a separate shared row; provider rows plus shared
rows sum to the source total. Files inside a nested CodeBurn cache count solely
as cache. Deduplication uses device/inode identity when available, otherwise the
resolved absolute path. Logical bytes can differ from allocated/compressed disk
space. A live scan is not an atomic snapshot: growing or disappearing files can
change while it runs.

Configured root symlinks are resolved once, allowing homes relocated to another
disk. Nested symlinks and special files are skipped and reported, preventing
cycles and traversal into unrelated trees. Missing, unreadable, busy or
disappearing paths are reported as omissions; other roots still finish.
Unavailable disk-space values are `null` in JSON and explicitly unavailable in
text. No files are deleted or modified, retention is unchanged, and the report
does not mark anything as safe to remove.
