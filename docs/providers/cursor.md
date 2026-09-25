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
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

## Storage format

SQLite. Two parallel sources within the same db:

1. **Bubbles** (`cursor.ts:201-331`): per-message rows. The richer source.
2. **agentKv** (`cursor.ts:350-460`): per-conversation key-value blobs. The fallback for older sessions.

The parser tries both and dedupes via `seenKeys`.

## Caching

`src/cursor-cache.ts` writes `~/.cache/codeburn/cursor-results.v<n>.json` (override with `$CODEBURN_CACHE_DIR`). The unsuffixed `cursor-results.json` is left for older binaries; a matching-version copy is adopted once and never overwritten. The fingerprint is `dbMtimeMs + dbSizeBytes` of `state.vscdb`. Atomic write via temp + rename.

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

The local database carries no per-turn token counts and none of the cache reads Cursor re-sends on every request, so local figures are estimates and run far below Cursor's dashboard. Cursor's dashboard exports every usage event with the token split it billed:

```
codeburn import cursor ~/Downloads/usage-events-2026-09-25.csv --from 2026-08-27 --to 2026-09-25
codeburn import cursor --remove
```

- **Where it lives.** Events are stored in `~/.cache/codeburn/imports/cursor-usage.v1.json` (or `$CODEBURN_CACHE_DIR`), beside the daily cache, and never swept. Re-importing merges: each row is keyed by a hash of all its fields, so an overlapping export adds only rows not seen before. Nothing is uploaded.
- **Coverage.** The export has no range of its own. Pass the range you exported with `--from`/`--to` (a date, an ISO time, or the epoch milliseconds in the export URL's `startDate`/`endDate`); a bare `--to` date runs to the end of that UTC day. Without them the import covers the UTC days of its first and last event. Either way coverage ends no later than the CSV file's modification time, so usage after the export keeps its local estimate. Events outside `--from`/`--to` are refused. Coverage from several imports is merged.
- **Replacement.** Inside coverage, local `cursor` (IDE) and `cursor-agent` (CLI) calls are dropped at serve time and the imported events stand for them; outside it the local estimates stay. The export is the account's usage, which includes the Agent CLI. When the export holds Grok Bot events (`grok-bot-*`), the local `grokbot` mirror estimates are replaced the same way: Grok Bot bills the same account. The cached local calls are never touched, so `--remove` restores them.
- **Rows.** IDE events show under provider Cursor, project `Cursor (imported)`; `grok-bot-*` events under provider Grok Bot, project `Grok Bot (imported)`. Tokens: `Input (w/o Cache Write)` is input, `Input (w/ Cache Write)` cache write, `Cache Read` cache read, `Output Tokens` output. Model `auto` is `cursor-auto` (Cursor (auto), priced as Sonnet 4.5 like the local parser), `cursor-grok-*` drops its prefix, and `grok-bot-*` prices at the grok-4.6 rate like the local Grok Bot provider.
- **Cost.** A dollar amount in `Cost` is kept as billed (`costFromBilling`, billing `metered`). `Included` and `Free` rows are priced from their tokens at API rates, the same API-equivalent value every local Cursor call gets, and carry billing `subscription`.
- **Daily cache.** An import or removal drops the Cursor, Cursor Agent and Grok Bot slices of the local days it covers and pulls the watermark back, so the next run re-derives those days.

## When fixing a bug here

1. **Always reproduce against a fixture, not a real db.** SQLite over the live db is racy; the user might be using Cursor while you read.
2. If the bug is "tokens are zero", check whether the row is a v3 zero-token bubble, in which case the char-fallback should kick in.
3. If the bug is "duplicate counts", check both `bubbleId` dedup and the cross-provider `seenKeys` dedup.
4. Cache poisoning is the most common failure mode after a Cursor schema change. Bump `CURSOR_CACHE_VERSION` in `src/cursor-cache.ts` so old caches are invalidated.
