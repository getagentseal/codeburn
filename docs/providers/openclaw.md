# OpenClaw

OpenClaw, plus the older Clawdbot / Moltbot / Moldbot lineage.

- **Source:** `src/providers/openclaw.ts`
- **Loading:** eager (`src/providers/index.ts:8`)
- **Test:** `tests/providers/openclaw.test.ts`

## Where it reads from

Four directories, all checked on every run (`openclaw.ts`):

- `~/.openclaw/agents`
- `~/.clawdbot/agents`
- `~/.moltbot/agents`
- `~/.moldbot/agents`

The legacy directories are kept for users who upgraded from older builds.

## Storage format

Two eras, discovered side by side under each `<agents>/<agent>/` directory:

- **SQLite (since the 2026-09-01 migration, `2026.8.1`; #1259).** `agent/openclaw-agent.sqlite`, table `transcript_events(session_id, seq, event_json, created_at)`. Each row's `event_json` is the verbatim JSONL envelope, so both eras run the same event reducer; agent-schema 23 additionally allows a row to carry its event as a `event_zstd` BLOB instead (one zstd frame, decoded when `node:zlib` has zstd — Node 22.15+ — and skipped with a notice otherwise). Sessions are listed with a `GROUP BY session_id` and each parses in keyset batches of 2000 rows so a gigabyte store never loads whole.
- **JSONL (pre-migration, still read when present).** `sessions/sessions.json` index plus per-session `.jsonl` files, with a directory-scan fallback when the index is missing or stale. Post-migration the migration tool moves these to `session-sqlite-import-archive/` or renames them `*.jsonl.deleted.<ts>`, which the `.jsonl` filter naturally ignores.

The SQLite source path carries the session id after the database path (`<db>:<sessionId>`, the forge.ts convention), so each session parses — and dedups — on its own.

## Caching

None.

## Deduplication

Per `<sessionId>:<dedupId>`, identical keys across both storage eras because the migrated envelopes keep their original session and event ids. An envelope without an event id hashes its payload instead of falling back to its parse position, so the same id-less event hashes identically in either era while distinct ones never collide on an array index.

## Store authority

When a session id exists both as a legacy `.jsonl` file and in the store (a partial migration or a restored backup), discovery keeps only the store's source. Keeping both live would let the legacy file's cached turns suppress the store's first parse — the suppressed (empty) result becomes the store's session-cache entry, and once the legacy file is archived and its entry evicted, the imported history would be gone from every report until the store changed.

## Quirks

- **Cost is preferred from the provider when reported.** OpenClaw emits `costUSD` in `message.usage`; the parser uses it directly when present and only computes from tokens when it is missing.
- Tokens are reported across `input`, `output`, `cacheRead`, and `cacheWrite`. Anthropic semantics throughout, no normalization needed.
- **Timestamp fallback chain (SQLite):** envelope `timestamp` → row `created_at` (ms) → the store file's mtime. The retry on `created_at` also covers a present-but-unparseable envelope timestamp, which must not land the call on the store's mtime ("now" on a live gateway). The JSONL era uses envelope → file mtime, as before.

## When fixing a bug here

1. If the bug is "session not found", check the four legacy dirs first. A user might have a stray `~/.moltbot/` that the parser is reading instead of the real `~/.openclaw/`.
2. If the bug is "wrong cost", confirm whether `costUSD` is present in the source data; the parser trusts it over its own calculation.
3. The `sessions.json` index can drift when the user crashes mid-session. Make sure the directory-scan fallback triggers in those cases.
4. If a migrated install reports empty, confirm `agent/openclaw-agent.sqlite` exists and has a `transcript_events` table; a DB without that table is skipped silently (it is not an agent-schema store).
5. A live OpenClaw gateway keeps writing to the store; the parser opens it read-only per session and closes it when done, and the sqlite wrapper handles `-wal` sidecars.
