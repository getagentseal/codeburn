# Crush

Charmbracelet's Crush TUI coding agent.

- **Source:** `src/providers/crush.ts`
- **Loading:** lazy (`src/providers/index.ts`). Lazy because Crush ships per-project SQLite databases and we use `node:sqlite` to read them.
- **Test:** `tests/providers/crush.test.ts` (12 tests, fixture-based)

## Where it reads from

Crush keeps a global registry that lists every project it has touched, and a separate SQLite database **per project**.

| File | Path |
|---|---|
| Registry (project list) | `$CRUSH_GLOBAL_DATA/projects.json`, otherwise `$XDG_DATA_HOME/crush/projects.json`, otherwise `~/.local/share/crush/projects.json` (Linux/macOS) or `%LOCALAPPDATA%/crush/projects.json` (Windows). |
| Per-project db | `<project.path>/<project.data_dir>/crush.db` where `data_dir` defaults to `.crush`. |

Current Crush writes an object with a `projects` array. The parser also accepts a bare array and an object keyed by project id for compatibility.

## Storage format

SQLite. Schema verified against `charmbracelet/crush` v0.66.1 (`internal/db/migrations/20250424200609_initial.sql` plus subsequent additive migrations).

Two tables matter for codeburn:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0.0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ...
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ...
);
```

## Caching

None at the provider level.

## Deduplication

Per `crush:<sessionId>` (`crush.ts`).

## What we extract

| codeburn field | Crush source |
|---|---|
| `inputTokens` | `sessions.prompt_tokens` |
| `outputTokens` | `sessions.completion_tokens` |
| `costUSD` | `sessions.cost` (already in dollars) |
| `model` | dominant value of `messages.model` for the session, picked by `GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`. Falls back to `unknown`. |
| `timestamp` | `sessions.updated_at` if set, otherwise `created_at` |

Cache tokens, reasoning tokens, web-search counts, tools, and bash commands are all left as zero / empty. Crush does not record per-message token data, so per-turn attribution is not available.

## Quirks worth knowing

- **Timestamps are seconds, not milliseconds.** The Crush schema *comments* in the upstream migration claim millisecond timestamps, but every actual `INSERT`/`UPDATE` in `internal/db/sql/{sessions,messages}.sql` uses `strftime('%s', 'now')`, which returns Unix seconds. The parser multiplies by 1000 before constructing a `Date`. **Tokscale's parser (junhoyeo/tokscale#346) gets this wrong and is off by 1000x.** Confirmed against Crush v0.66.1.
- **Cost is stored in dollars as a `REAL`.** No conversion needed.
- **Child sessions are skipped.** Only rows with `parent_session_id IS NULL` are surfaced. Crush sub-agents inherit cost into the parent.
- **Zero-spend rows are filtered.** Discovery skips sessions with `cost = 0 AND prompt_tokens = 0 AND completion_tokens = 0`.
- **Optimize detectors that depend on tools (`detectJunkReads`, `detectDuplicateReads`, `detectLowReadEditRatio`) will not flag Crush sessions.** That is correct: Crush does not log per-tool calls in a way we can read today.
- **`detectLowWorthSessions` may flag Crush sessions** because it looks for cost without edits. That is a known false positive; if it becomes noisy, we can branch the detector on provider.

## When fixing a bug here

1. Confirm the issue against a real Crush install (`brew install charmbracelet/tap/crush`) before assuming the schema has changed. Migrations in the last six months have only added columns to `sessions`/`messages`, never removed any of the ones we read.
2. If the bug is "Crush sessions show timestamps from 1970-something", check whether someone "fixed" the seconds-vs-milliseconds handling by removing the `* 1000`. The schema comment is wrong; the data is in seconds.
3. If the bug is "Crush model column shows `unknown`", the session has no messages with a non-null `model`. Some early Crush builds did not record provider on every message; add `LIKE` matching against `provider` if you want a stronger fallback.
4. If the bug is "no sessions discovered", the registry path probably has not been verified for the user's setup. Print `getRegistryPath()` and have them confirm the file exists at that location.
5. New fixtures go under the inline schema in `tests/providers/crush.test.ts`; keep the `CREATE TABLE` literal and synchronized with the upstream migration.
