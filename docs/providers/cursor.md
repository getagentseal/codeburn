# Cursor

Cursor IDE chat history.

- **Source:** `src/providers/cursor.ts`
- **Loading:** lazy (`src/providers/index.ts:44-57`). The `node:sqlite` import is the heavy dependency that justifies lazy loading.
- **Test:** `tests/providers/cursor.test.ts` (77 lines), `tests/providers/cursor-bubble-dedup.test.ts` (176 lines)

## Where it reads from

A single SQLite database per platform:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |
| Linux | `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`, falling back to `~/.config/Cursor/User/globalStorage/state.vscdb` |

Windows honors `APPDATA`, falling back to `AppData/Roaming` under the home directory when it is unset or empty. Workspace mappings come from the database's sibling `workspaceStorage` folder, so they follow the same redirected root. Explicit database overrides take precedence. Changes to `APPDATA` or `XDG_CONFIG_HOME` invalidate Cursor's session-cache fingerprint.

The result cache also checks the resolved database path, so a different data root cannot reuse the previous database's calls just because its size and modification time match. The daily-cache migration backfills historical usage found under corrected editor roots.

## Storage format

SQLite. Two parallel sources within the same db:

1. **Bubbles** (`cursor.ts:201-331`): per-message rows. The richer source.
2. **agentKv** (`cursor.ts:350-460`): per-conversation key-value blobs. The fallback for older sessions.

The parser tries both and dedupes via `seenKeys`.

## Caching

`src/cursor-cache.ts` writes `~/.cache/codeburn/cursor-results.v<n>.json` (override with `$CODEBURN_CACHE_DIR`). The unsuffixed `cursor-results.json` is left for older binaries; a matching-version copy is adopted once and never overwritten. Cache identity includes the resolved database path and the combined modification time and size of `state.vscdb` and its WAL, when present. Atomic write via temp + rename.

## Deduplication

- Bubbles: per `bubbleId` (`cursor.ts:282`).
- agentKv: per `requestId` (`cursor.ts:429`).

## Quirks

- **180-day lookback.** The bubbles query bounds itself to the trailing 180 days (`cursor.ts:205`). Older history is ignored. If a user reports "Cursor data missing", confirm the date range first.
- **250 000 bubble cap.** Power users with massive history are capped to prevent unbounded memory. If you need to raise this, also raise the cache size budget.
- **Per-conversation user-message queue.** The parser caches the user-message stream per conversation to avoid an O(n) shift on every turn (`cursor.ts:171-191`).
- **agentKv has no per-message timestamp.** The DB file's mtime is used as the timestamp for every agentKv-derived call (`cursor.ts:358-363`). This is wrong but consistent.
- **Cursor v3 reports zero token counts.** The parser falls back to char-counting (`CHARS_PER_TOKEN = 4`) for those rows (`cursor.ts:265-272`).

## Importing Cursor's own usage export

The local database carries no per-turn token counts and none of the cache reads Cursor re-sends on every request, so local figures are estimates and run far below Cursor's dashboard. When a period still holds local Cursor or Cursor Agent dollars that no import covers, `codeburn overview` says so in one dim line under the bottom line (`includes $X of Cursor priced from local files, not Cursor's bill`) instead of letting the estimate read as the bill (#1545). Cursor's dashboard exports every usage event with the token split it billed:

```
codeburn import cursor ~/Downloads/usage-events-2026-09-25.csv --from 2026-08-27 --to 2026-09-25
codeburn import cursor --remove
```

- **Where it lives.** Events are stored in `~/.cache/codeburn/imports/cursor-usage.v1.json` (or `$CODEBURN_CACHE_DIR`), beside the daily cache, and never swept. Re-importing merges: each row is keyed by a hash of all its fields, so an overlapping export adds only rows not seen before. Nothing is uploaded.
- **Coverage.** The export has no range of its own. Pass the range you exported with `--from`/`--to` (a date, an ISO time, or the epoch milliseconds in the export URL's `startDate`/`endDate`); a bare `--from`/`--to` date is a whole local day, the same day reports bucket by. Without them the import covers the local days of its first and last event. Either way coverage ends no later than the CSV file's modification time, so usage after the export keeps its local estimate. Events outside `--from`/`--to` are refused. Coverage from several imports is merged.
- **Replacement.** Inside coverage, local `cursor` (IDE) and `cursor-agent` (CLI) calls are dropped at serve time and the imported events stand for them; outside it the local estimates stay. The export is the account's usage, which includes the Agent CLI. When the export holds Grok Bot events (`grok-bot-*`), the local `grokbot` mirror estimates are replaced the same way: Grok Bot bills the same account. The cached local calls are never touched, so `--remove` restores them.
- **Rows.** IDE events show under provider Cursor, project `Cursor (imported)`; `grok-bot-*` events under provider Grok Bot, project `Grok Bot (imported)`. Tokens: `Input (w/o Cache Write)` is input, `Input (w/ Cache Write)` cache write, `Cache Read` cache read, `Output Tokens` output. Model `auto` is `cursor-auto` (Cursor (auto), priced as Sonnet 4.5 like the local parser), `cursor-grok-*` drops its prefix, and `grok-bot-*` prices at the grok-4.6 rate like the local Grok Bot provider.
- **Cost.** A dollar amount in `Cost` is kept as billed (`costFromBilling`, billing `metered`). `Included` and `Free` rows are priced from their tokens at API rates, the same API-equivalent value every local Cursor call gets, and carry billing `subscription`.
- **Daily cache.** An import or removal drops the Cursor, Cursor Agent and Grok Bot slices of the local days it covers and pulls the watermark back, so the next run re-derives those days.

## Automatic sync

`src/cursor-sync.ts` downloads the same export itself, so nobody has to click Export CSV: `GET https://cursor.com/api/dashboard/export-usage-events-csv?startDate=<ms>&endDate=<ms>&strategy=tokens` with the session cookie the quota adapter builds from the Cursor app's access token (`src/quota/cursor.ts`). The rows are byte-identical to a manual export, so they dedupe with manual imports by the same hash. Nothing is uploaded.

- **When.** `report`, `today`, `month`, `overview` and `status --format menubar-json` (the app's refresh) sync before they read, at most once an hour plus up to 5 minutes of random jitter, and for at most 45 seconds on an account's first month-long backfill and 15 seconds after that; a failure is silent and keeps the stored usage. A `--provider` filter that leaves out Cursor, Cursor Agent and Grok Bot skips the sync. `mcp`, `doctor` and `audit` stay offline and never sync. `codeburn import cursor --sync` syncs now and prints the import summary, ignoring the throttle, the backoff and the off switch.
- **Window.** An account's first sync reaches back to the earlier of the start of this month or 30 days ago, and happens once: every later one runs from the local day before the newest synced event to now, so a row Cursor posts late for the previous day is still picked up and older closed days are not downloaded again. Rows the server returns from before the window are ignored. A sync that finds nothing still leaves a (possibly empty) store and remembers the day, so a quiet account is not downloaded from scratch again; only a missing store starts over. Synced coverage ends at the newest event, so usage after it keeps its local estimate until the next sync.
- **Source and account tags.** Synced events and coverage ranges carry `source: "sync"` and `account`, a short hash of the token subject (never the subject itself), and are kept apart from manual imports and from other accounts. A sync replaces only its own account's synced events from its window start on (a row Cursor changed that day is replaced, not doubled); manually imported events and other accounts' events are never replaced. A manual import of a row a sync stored first turns it into a manual row. Manual coverage wins inside its range: a sync skips every row dated there, so a row Cursor later revised is not priced twice, and the sync fills everything outside it. After a sign-in to another account, the earlier account's usage stays, and the new account's window starts after the earlier coverage ends, so no stretch of local usage is replaced by two accounts.
- **History.** The store is never pruned by age, is outside the cache sweep and version bumps, and is written atomically (temp file and rename). Only `import cursor --remove` deletes it. Days the daily cache has sealed keep their synced figures even when a later sync fails or the store goes missing.
- **Failures.** No token or a token expiring within 60s makes no request. 401/403 backs off 6 hours or until the token changes, 429 for `Retry-After` (60s minimum, 300s default), and three failed requests in a row back off 6 hours; a success resets the count. A 5xx, a network error or a body that is not the export leaves the store untouched. State (`lastAttemptAt`, `nextAttemptAt`, `lastSuccessAt`, `backoffUntil`, `failures`, `lastError`, `account`, `through`) is in `imports/cursor-sync.v1.json` beside the store, so an attempt never moves the store's mtime.
- **Off switch.** `"cursorSync": false` in `~/.config/codeburn/config.json`, or `CODEBURN_CURSOR_SYNC=0`.
- **In the apps.** `status --format menubar-json` carries a `cursorSync` block (`enabled`, `state` of `ok`, `syncing-never`, `error`, `off` or `no-login`, `lastSuccessAt`, and on a failure an `errorCode` of `login`, `network` or `export` with a fixed `error` message), read from the sidecar, the config and the Cursor app's login without syncing. It is absent when Cursor is not signed in on this machine and has never synced, and it never carries the token, the account or server text. With the Cursor provider selected, the desktop overview, the macOS menu bar and the Windows tray show one line under the total: "Synced from cursor.com 12 min ago", or the error in a muted warning colour. The switch is **Sync Cursor usage from cursor.com**: Settings → Providers → Cursor on the desktop, Settings → Cursor on macOS and Windows. It writes the `cursorSync` key above; while `CODEBURN_CURSOR_SYNC=0` is set, the switch is disabled and says so.

## Exact or estimated

- **Exact (billed sync).** Inside synced or imported coverage, calls and tokens are Cursor's own billed events: one row per request, with the cache reads the local database never records. Rows with a dollar amount (`$1.25`) show that amount as is (`costFromBilling`). Plan rows say `Included`, `Free` or `-` instead, so CodeBurn prices their exact tokens at list rates and tags them `subscription`. `auto` and `grok-bot-*` rows never name the model that served them, so their list price is a stand-in and they stay `costIsEstimated`. Named models (`claude-opus-5-thinking-high`, `composer-2.5`, `cursor-grok-4.6-high`) are not.
- **Estimated (local).** Everything outside coverage is read from `state.vscdb` and is `costIsEstimated`: no bubble carries a real `tokenCount` (it stays `{0,0}`), and `composerData.usageData` is an empty object, so output is reply text / 4 and input is the context meter or prompt text / 4. On a real account over 30 days this ran far below the bill on tokens (no cache reads at all) and above it on calls (one bubble is not one request). Local estimates remain before the first sync's window, and after the newest synced event until the next sync, so today can mix both.
- **How to get exact.** Stay signed in to Cursor with the sync on (default), or run `codeburn import cursor --sync`. Older history: export the CSV at cursor.com/dashboard/usage and `codeburn import cursor <file.csv> --from ... --to ...`.

## When fixing a bug here

1. **Always reproduce against a fixture, not a real db.** SQLite over the live db is racy; the user might be using Cursor while you read.
2. If the bug is "tokens are zero", check whether the row is a v3 zero-token bubble, in which case the char-fallback should kick in.
3. If the bug is "duplicate counts", check both `bubbleId` dedup and the cross-provider `seenKeys` dedup.
4. Cache poisoning is the most common failure mode after a Cursor schema change. Bump `CURSOR_CACHE_VERSION` in `src/cursor-cache.ts` so old caches are invalidated.
