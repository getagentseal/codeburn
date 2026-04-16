# Specification: CLI Performance Optimization

**Status**: Draft
**Date**: 2026-04-16
**Version**: 1.1.0

---

## 1. Overview

CodeBurn's `status --format json` command takes ~900ms (built bundle) on a machine with 18 projects, 76 sessions, and ~20MB of JSONL data. The interactive `report` TUI takes 5-8s to first render. RSS peaks at ~150MB.

These times make the menu bar widget feel sluggish and undermine trust in the tool. This spec defines four targeted, independently shippable optimizations that together bring `status --format json` under 400ms (built) and reduce RSS to approximately 80-100MB, without changing any user-visible behavior.

**Perspective**: This spec is written with an edge-case and defensive design lens. Every optimization task specifies its invariants, what can go wrong during the change, and how to verify correctness after the change.

---

## 2. Success Criteria

| Metric | Baseline | Target | Measurement Method |
|--------|----------|--------|-------------------|
| `status --format json` wall time (built) | 900ms | < 400ms | `hyperfine --warmup 2 'codeburn status --format json'`, median of 10 runs |
| `status --format menubar` wall time (built) | 2500ms | < 800ms | `hyperfine --warmup 2 'codeburn status --format menubar'`, median of 10 runs |
| `report` TUI time-to-first-render (built) | 5000-8000ms | < 2000ms | Stopwatch from invocation to first Ink frame, 3 runs |
| RSS at peak | ~150MB | < 100MB | `node --max-old-space-size=256 dist/cli.js status --format json` + `process.memoryUsage().rss` instrumented log |
| Output correctness | baseline | identical | byte-for-byte diff of JSON output before and after (see AC-C1) |

---

## 3. Requirements

### R1 -- Discovery result cache
`discoverAllSessions` in `src/providers/index.ts` must cache its result for the lifetime of the process. Multiple calls with the same `providerFilter` argument within a single CLI invocation must return the same array instance without re-running any `readdir` or `stat` calls.

### R2 -- Widen-then-filter parse strategy
The `status` command must compute all required date-range results by parsing the widest required date range exactly once, then filtering the in-memory `ProjectSummary[]` data for narrower ranges. No path in `status` may call `parseAllSessions` with overlapping or nested date ranges more than once.

### R3 -- Conditional bash extraction
`extractBashCommandsFromContent` in `src/parser.ts` must be skipped when the caller does not need bash command data. A boolean parameter `extractBash: boolean` must be threaded from `parseAllSessions` down through `parseSessionFile` and `parseApiCall`. When `extractBash` is `false`, the `bashCommands` field on `ParsedApiCall` must be an empty array and no call to `extractBashCommands` in `src/bash-utils.ts` may be made.

### R4 -- Streaming JSONL reads
`parseSessionFile` in `src/parser.ts` must read JSONL files using Node.js `readline` streaming instead of loading the entire file into memory with `readFile`. Each line must be processed and either kept or discarded before the next is read. The entire file contents must not be held in a single string variable at any point during parsing.

### R5 -- Date pre-filter before JSON.parse
Within `parseSessionFile`, lines that can be determined to fall outside the requested `dateRange` from a raw string scan must be skipped before calling `JSON.parse`. The raw string scan must search for a `"timestamp":"` prefix in the line and extract the ISO 8601 date string without parsing the full JSON object. Lines that do not contain a parseable timestamp string must proceed to full `JSON.parse` (conservative: never skip a line that might contain in-range data).

### R6 -- Currency load deferred to cost-rendering commands
`loadCurrency()` must be removed from the `preAction` hook in `src/cli.ts`. It must be called explicitly only inside the action handlers for commands that display currency-converted costs: `status`, `report`, `today`, `month`, `export`. The `currency` management command must continue to call `loadCurrency()` when displaying current state.

### R7 -- Correct output for all formats
The output of `status --format json`, `status --format terminal`, and `status --format menubar` must be byte-for-byte identical to baseline output for the same dataset before and after all optimizations are applied. Token counts, costs, turn counts, and category breakdowns must not change.

### R8 -- No regression in test suite
`npx vitest run` must pass with zero failures after each task is committed.

---

## 4. Acceptance Criteria

### Phase 1: Discovery Cache + Currency Deferral (Tasks T1, T2)

**AC-1a** (R1) -- Given `status --format menubar` is invoked; when the command runs; then `discoverAllSessions` is called at most once per unique `providerFilter` value across the entire process lifetime, regardless of how many times `parseAllSessions` is called internally.

**AC-1b** (R1) -- Given `discoverAllSessions` has been called once; when it is called again with the same filter before the process exits; then it returns without executing any `readdir` or `stat` filesystem calls.

**AC-1c** (R1) -- Given the `--provider` flag is set to `cursor`; when `discoverAllSessions` is called; then only the Cursor provider's `discoverSessions()` runs, and the cached result is scoped to `cursor`, not shared with a subsequent call using `--provider all`.

**AC-1d** (R1) -- Given the interactive dashboard is running; when the user triggers a refresh (press `r` or auto-refresh timer fires); then `clearDiscoveryCache()` is called before `parseAllSessions`, so new session files created since the last refresh are discovered.

**AC-2a** (R6) -- Given `status --format json` is invoked; when the command runs; then no exchange rate file read and no network fetch to `api.frankfurter.app` occurs.

**AC-2b** (R6) -- Given the `currency` command is invoked with no subcommand (display mode); when the command runs; then `loadCurrency()` is called and the current rate is displayed correctly.

**AC-2c** (R6) -- Given `status --format json` output; when compared to baseline output captured before this change; then the JSON structure and all numeric values are identical (currency rate is 1 for USD, so output is unaffected).

**AC-2d** (R6) -- Given a non-USD currency is configured (e.g., `codeburn currency GBP`); when `report`, `today`, or `month` is invoked; then costs are displayed in the configured currency with the correct exchange rate (verifying `loadCurrency()` is called before rendering).

### Phase 2: Widen-then-Filter (Task T3)

**AC-3a** (R2) -- Given `status --format menubar` is invoked; when the command runs; then `parseAllSessions` (or its internal JSONL reads) is called once for a date range that encompasses today, week, and month; and today/week results are derived by filtering that single parsed result in memory.

**AC-3b** (R2) -- Given `status --format json` is invoked; when the command runs; then JSONL files are read at most once per file path across all date-range computations.

**AC-3c** (R2, R7) -- Given the same dataset; when `status --format menubar` output is compared before and after this change; then the rendered output is byte-for-byte identical.

**AC-3d** (R2) -- Given a session file containing turns from both today and last month; when `menubar` format is rendered; then the today-period total reflects only turns within today's date boundaries (00:00:00 to 23:59:59.999 local time), and the month-period total reflects all turns within the calendar month.

### Phase 3: Streaming JSONL + Date Pre-filter (Tasks T4, T5)

**AC-4a** (R4) -- Given a JSONL session file of 5MB or larger; when `parseSessionFile` processes it; then the peak RSS contribution of that single file's read does not exceed 2x the file size (i.e., streaming prevents loading the entire file plus a split array simultaneously).

**AC-4b** (R4) -- Given a JSONL file with 10,000 lines; when it is parsed; then the resulting `SessionSummary` is identical to the one produced by the pre-streaming implementation for the same file.

**AC-4c** (R5) -- Given a JSONL file where 80% of lines have timestamps outside the requested date range; when `parseSessionFile` runs with that date range; then `JSON.parse` is called on at most 25% of lines (lines outside the range and lines with no parseable timestamp prefix are both eligible for skip, but the implementation must never skip an in-range line).

**AC-4d** (R5) -- Given a JSONL line that does not contain a `"timestamp":"` string literal; when the date pre-filter runs; then the line proceeds to full `JSON.parse` without being skipped.

**AC-4e** (R5, R7) -- Given the same dataset used for baseline measurements; when `status --format json` output is compared before and after streaming+pre-filter; then the JSON output is byte-for-byte identical.

### Phase 4: Conditional Bash Extraction (Task T6)

**AC-6a** (R3) -- Given `status --format json` is invoked; when sessions are parsed; then the bash separator regex in `bash-utils.ts:16` (`separatorRegex.exec`) is not called at all during the parse.

**AC-6b** (R3) -- Given `status --format terminal` is invoked; when sessions are parsed; then the bash separator regex in `bash-utils.ts:16` is not called (terminal format via `renderStatusBar` does not use `bashBreakdown`).

**AC-6c** (R3) -- Given `report` is invoked; when the dashboard renders the bash command panel; then bash command counts are accurate and match the baseline for the same dataset.

**AC-6d** (R3) -- Given `extractBash: false` is passed to `parseAllSessions`; when the resulting `ProjectSummary` is inspected; then every `SessionSummary.bashBreakdown` is an empty object `{}`.

### End-to-End Acceptance

**AC-E1** (R7, R8) -- Given the full test suite (`npx vitest run`); when run after all four phases are committed; then all tests pass with zero failures.

**AC-E2** (Success Criteria) -- Given the machine used for baseline measurements; when `hyperfine --warmup 2 --runs 10 'codeburn status --format json'` is run on the built bundle; then the reported median is under 400ms.

**AC-E3** (Success Criteria) -- Given the same machine; when `hyperfine --warmup 2 --runs 10 'codeburn status --format menubar'` is run; then the reported median is under 800ms.

---

## 5. Design Decisions

### D1 -- Discovery cache is process-scoped, not TTL-based

**Decision**: Cache `discoverAllSessions` results in a module-level `Map<string, SessionSource[]>` that is never expired during the process lifetime.

**Rationale**: Session files are written to disk by the IDE (Claude Code, Codex, Cursor) asynchronously while the CLI runs. However, within a single CLI invocation (always < 10 seconds), no new session file will be discovered that was not present at the start. A TTL adds complexity without benefit. The existing parse-result TTL in `parser.ts` (60 seconds) is orthogonal and remains.

**Risk**: If a future command runs in a long-lived daemon mode (e.g., `--watch`), stale discovery results could miss new session files. **Mitigation**: Add a `clearDiscoveryCache()` export that the auto-refresh code in `dashboard.tsx` must call at the start of each refresh cycle. If no daemon mode exists today, this export costs nothing.

**Alternatives considered**: (a) TTL of 5 seconds -- adds time-dependency to tests. (b) Invalidation on file-system watch -- far too complex for the gain.

### D2 -- Widen-then-filter in cli.ts, not in parseAllSessions

**Decision**: The `menubar` and `export` command actions in `cli.ts` are rewritten to call `parseAllSessions` once with the widest needed range, then pass the result to a new pure function `filterByDateRange(projects: ProjectSummary[], range: DateRange): ProjectSummary[]`.

**Rationale**: `parseAllSessions` already accepts a `DateRange` and filters at the entry level. Making it smarter about subrange caching would require it to know about the caller's intent, violating single responsibility. The simpler fix is at the call site: the commands in `cli.ts` know they need multiple periods and can request the superset once.

`filterByDateRange` must filter `SessionSummary.turns` by `turn.timestamp` within the range, then recompute `totalCostUSD`, `totalApiCalls`, `totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`, `totalCacheWriteTokens` from the filtered turns. It must not mutate the input `ProjectSummary[]`.

**Risk**: The existing `buildSessionSummary` aggregates values during the single parse pass. `filterByDateRange` re-aggregates from the stored `turns` array. The invariant that `sessionSummary.totalCostUSD === sum(turn.assistantCalls[].costUSD)` must hold. If this invariant is broken anywhere in the codebase, `filterByDateRange` will produce different results. **Mitigation**: Add a test that constructs a `SessionSummary` via both paths and asserts equality.

**Alternatives considered**: (a) Modify `parseAllSessions` to cache a "wide" result and serve subsets -- complex, harder to reason about. (b) Parse once and re-run all date-range queries in-memory inside `parseAllSessions` -- conflates concerns.

### D3 -- extractBash flag threads through as a boolean parameter, not an options object

**Decision**: Add `extractBash: boolean` as a named parameter in a new `ParseOptions` object passed to `parseAllSessions`, `parseSessionFile`, and `parseApiCall`. Do not use a global module-level flag.

**Rationale**: A global flag is invisible at the call site and creates implicit coupling. A `ParseOptions` object at `parseAllSessions` is explicit, typed, and follows the existing pattern (dateRange and providerFilter already flow as plain parameters). An object wrapper is preferred over a bare boolean because it allows future options (e.g., `extractMcp`, `extractModels`) without changing function signatures again.

The `ParseOptions` type:
```
type ParseOptions = {
  dateRange?: DateRange
  providerFilter?: string
  extractBash?: boolean  // defaults to true for backward compatibility
}
```

**Risk**: Callers that call `parseAllSessions` without specifying `extractBash` must default to `true` (extract bash) to preserve existing behavior. This is the safe default. Any caller that adds `extractBash: false` is explicitly opting into the optimization.

**Alternatives considered**: (a) Bare boolean positional parameter -- breaks callers on parameter count change; worse readability. (b) Module-level `setBashExtraction(false)` -- global state, hard to test in isolation.

### D4 -- Streaming uses readline, not a line-splitting stream transform

**Decision**: Use Node.js built-in `readline.createInterface({ input: fs.createReadStream(filePath) })` with `for await (const line of rl)` to stream lines.

**Rationale**: `readline` is a stable Node.js built-in with no additional dependencies. It handles partial-line buffering correctly at chunk boundaries. The `for await` async iterator pattern is consistent with the existing `async generator` pattern in `providers/codex.ts` and `providers/cursor.ts`. No new npm dependency is needed.

**Risk**: The `readline` interface does not auto-close on early exit. If `parseSessionFile` returns early (e.g., all lines are outside the date range), the file stream must be explicitly closed to prevent handle leaks. **Mitigation**: Wrap the `readline` loop in a `try/finally` that calls `rl.close()` unconditionally.

**Alternatives considered**: (a) `split2` npm package -- adds a dependency; no advantage over `readline` for this use case. (b) Manually chunking the stream -- more code, same result.

### D5 -- Date pre-filter uses a simple string index scan, not a regex

**Decision**: To pre-filter a raw JSONL line, use `line.indexOf('"timestamp":"')` and then extract 24 characters starting at the offset + 14 (the length of `"timestamp":"`). Parse the extracted string as a `Date` and compare to `dateRange`. If `indexOf` returns -1, proceed to full `JSON.parse`.

**Rationale**: A regex like `/\"timestamp\":\"([^"]+)\"/` is more readable but runs a full NFA on every line. `indexOf` is a single linear scan with no backtracking. For lines that are 500-5000 characters long and contain `"timestamp":` near the beginning (as Claude JSONL entries do), `indexOf` will find the match in fewer iterations. The timestamp itself is always ISO 8601 and can be parsed with `new Date(str)` safely.

**Risk**: If a JSONL entry has `"timestamp"` as a nested key inside another object (e.g., inside `message.content[]`), the pre-filter might match the wrong timestamp. **Mitigation**: The `"timestamp":"` string is only matched at the top level by convention in the Claude JSONL format (`entry.timestamp`), and the 24-character extraction produces a valid ISO date. If the extracted string is not a valid date (i.e., `isNaN(date.getTime())`), the line must proceed to full `JSON.parse`. This is the conservative fallback already specified in R5.

**Alternatives considered**: (a) JSON streaming parser (e.g., `jsonstream`) -- adds a dependency; overkill for single-key extraction. (b) Regex -- functional but slower for this pattern.

---

## 6. Constraints

### C1 -- No change to output format
The text and JSON output of all existing commands must be unchanged. Any optimization that would alter a displayed token count, cost figure, turn count, model name, or date range label is out of scope for this spec and must not be included.

### C2 -- No new npm dependencies (runtime)
All four optimizations must be implemented using Node.js built-ins and existing package.json dependencies. `readline` (built-in), `fs` (built-in), and existing modules are available. Adding a new runtime dependency requires a separate decision record.

### C3 -- TypeScript strict mode
All new code must pass `tsc --strict` with no `any` types and no `@ts-ignore` suppressions.

### C4 -- Existing test suite must pass
`npx vitest run` must pass after each individual task commit, not only after all tasks are complete. Each task must be a shippable increment.

### C5 -- No changes to `types.ts` domain types
`ParsedApiCall.bashCommands` remains a `string[]` field. Adding `ParseOptions` is a new type addition, not a modification to existing domain types.

### C6 -- No behavioral change to `report` or `today` or `month` commands
These commands already call `parseAllSessions` once with a single date range. They must not be refactored as part of this spec. Only `status` and `export` are affected by the widen-then-filter change.

---

## 7. Tasks

Tasks are ordered by impact-to-effort ratio. Each task is independently mergeable and must leave the test suite green.

---

### T1 -- Cache discovery results in providers/index.ts

**Branch**: `fix/discovery-cache`
**Effort**: ~20 lines changed
**Requirements**: R1
**Estimated gain**: 30-180ms depending on command

**What to implement**:

In `src/providers/index.ts`, add a module-level cache:

```typescript
const discoveryCache = new Map<string, SessionSource[]>()
```

In `discoverAllSessions`, before running provider discovery, check `discoveryCache.get(providerFilter ?? 'all')`. If present, return the cached array directly. After collecting results, store them in `discoveryCache`.

Export a `clearDiscoveryCache(): void` function that calls `discoveryCache.clear()`. Call this function at the top of the refresh handler in `src/dashboard.tsx` (the function that runs when the user presses `r` or the auto-refresh timer fires).

**Testing**:
- Add a test in `tests/provider-registry.test.ts` that calls `discoverAllSessions` twice with the same filter and verifies the second call returns the same array reference (use `toBe`, not `toEqual`).
- Verify `clearDiscoveryCache` resets the cache by calling it between the two calls and confirming the second call does not return the same reference.

**Invariants to verify**:
- Different `providerFilter` values (`'claude'`, `'cursor'`, `'all'`) are cached independently.
- The exported `providers` array (used by `getAllProviders`) is not affected.

---

### T2 -- Move loadCurrency() out of preAction

**Branch**: `fix/defer-currency-load`
**Effort**: ~15 lines changed
**Requirements**: R6
**Estimated gain**: 2-20ms (disk read + possible network fetch deferred for `status --format json`)

**What to implement**:

Remove the `program.hook('preAction', ...)` block entirely from `src/cli.ts`.

Add `await loadCurrency()` as the first line of the `action` handler for each of these commands: `report`, `today`, `month`, `status`, `export`.

The `currency` command's action handler already calls `loadCurrency()` in its display branch -- verify it remains there.

**Testing**:
- Manually run `codeburn status --format json` and confirm output is unchanged.
- Manually run `codeburn currency` (no subcommand) and confirm the current currency code is displayed.
- `npx vitest run` must pass.

**Invariants to verify**:
- `getCurrency()` is always called after `loadCurrency()` in any command that formats costs.
- The `currency set` subcommand (`codeburn currency GBP`) already calls `loadCurrency()` at the end of its action handler after saving -- this must remain.

---

### T3 -- Widen-then-filter for multi-period commands

**Branch**: `fix/widen-then-filter`
**Effort**: ~80 lines changed
**Requirements**: R2, R7
**Estimated gain**: 200-400ms for `status --format menubar`, ~150ms for `export`

**What to implement**:

**Step 1**: Add a new pure function in `src/parser.ts`:

```typescript
export function filterProjectsByDateRange(
  projects: ProjectSummary[],
  range: DateRange,
): ProjectSummary[]
```

This function must:
1. For each `ProjectSummary`, filter each `SessionSummary.turns` to only include turns where `turn.timestamp >= range.start && turn.timestamp <= range.end`.
2. For each filtered `SessionSummary`, recompute all aggregated numeric fields from the remaining turns: `totalCostUSD`, `totalApiCalls`, `totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`, `totalCacheWriteTokens`. Recompute `modelBreakdown`, `toolBreakdown`, `mcpBreakdown`, `bashBreakdown`, `categoryBreakdown` by iterating `turn.assistantCalls` for all surviving turns.
3. Exclude sessions where the filtered turn count is zero.
4. Exclude projects where all sessions are excluded.
5. Recompute `ProjectSummary.totalCostUSD` and `totalApiCalls` from the filtered sessions' values (mirroring `parser.ts:339-340`).
6. Return a new array; do not mutate the input.

Note: `firstTimestamp` and `lastTimestamp` on each `SessionSummary` must be recomputed from surviving turns.

**Step 2**: Rewrite the `status` command action handler for the `menubar` format in `src/cli.ts`:

Current code calls `parseAllSessions` up to 6 times (3 for periods + N for per-provider today). Replace with:
1. Call `parseAllSessions` once for `getDateRange('month').range` (the widest superset of today, week, and month).
2. Derive `todayData`, `weekData`, `monthData` by calling `filterProjectsByDateRange` on the result.
3. Derive per-provider today costs by calling `filterProjectsByDateRange` on the month result with the today range, then filtering by provider name in-memory.

**Step 2b**: Rewrite the `status --format json` path in `src/cli.ts`:

Current code at lines 142-143 calls `parseAllSessions` twice (today + month). Replace with:
1. Call `parseAllSessions` once for `getDateRange('month').range`.
2. Derive `todayData` by calling `filterProjectsByDateRange` with the today range.

**Step 3**: Rewrite the `export` command action handler:
1. Call `parseAllSessions` once for `getDateRange('30days').range`.
2. Derive the three periods (`today`, `week`, `30days`) using `filterProjectsByDateRange`.

**Testing**:
- Add a unit test in a new file `tests/filter-by-date-range.test.ts` that:
  - Constructs a `ProjectSummary` with turns spanning 3 days.
  - Calls `filterProjectsByDateRange` with a 1-day range.
  - Asserts that returned summary totals equal the sum of only the in-range turns.
  - Asserts that the input `ProjectSummary` is not mutated.
- Run `codeburn status --format menubar` and diff output against baseline.

**Edge cases**:
- A session with all turns outside the filter range must be excluded entirely.
- A project with all sessions excluded must be excluded from the returned array.
- The `'all'` period (range from epoch to now) used by the dashboard must not be broken; `filterProjectsByDateRange` with the full epoch-to-now range must return a result that equals the input.

---

### T4 -- Stream JSONL files with readline

**Branch**: `fix/streaming-jsonl`
**Effort**: ~40 lines changed
**Requirements**: R4
**Estimated gain**: 30-50% reduction in peak RSS

**What to implement**:

In `src/parser.ts`, replace the body of `parseSessionFile` from this pattern:

```typescript
const content = await readFile(filePath, 'utf-8')
const lines = content.split('\n').filter(l => l.trim())
const entries: JournalEntry[] = []
for (const line of lines) { ... }
```

with:

```typescript
import { createReadStream } from 'fs'
import { createInterface } from 'readline'

const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
const entries: JournalEntry[] = []
try {
  for await (const line of rl) {
    if (!line.trim()) continue
    // ... existing per-line logic
  }
} finally {
  rl.close()
}
```

The `readFile` import can be removed from `src/parser.ts` if it is no longer used elsewhere in the file. Verify before removing.

**Testing**:
- The existing behavior of `parseSessionFile` is fully covered by integration tests that run through `parseAllSessions`. Run `npx vitest run` and confirm all tests pass.
- Manually run `codeburn status --format json` and confirm output is unchanged.
- For the memory target: add a manual verification step: run `node --expose-gc dist/cli.js status --format json` with a console.log of `process.memoryUsage().rss` at exit and confirm it is below 100MB.

**Invariants to verify**:
- `parseSessionFile` is an `async function`. The `for await` loop requires it to remain `async`.
- The `try/finally` block around `rl.close()` must execute even if an exception is thrown inside the loop.
- Files that do not exist must still return `null` (the existing `try/catch` around the file open must be preserved -- wrap the `createReadStream` call, not the loop).

---

### T5 -- Date pre-filter before JSON.parse

**Branch**: `fix/timestamp-prefilter`
**Effort**: ~25 lines changed
**Requirements**: R5
**Estimated gain**: 50-100ms depending on what fraction of lines fall outside the date range

**What to implement**:

In `src/parser.ts`, within the line-reading loop in `parseSessionFile`, add a guard before calling `parseJsonlLine`:

```typescript
function extractTimestampFromLine(line: string): Date | null {
  const key = '"timestamp":"'
  const idx = line.indexOf(key)
  if (idx === -1) return null
  const start = idx + key.length
  const end = line.indexOf('"', start)
  if (end === -1) return null
  const d = new Date(line.slice(start, end))
  return isNaN(d.getTime()) ? null : d
}
```

In the line loop, before `parseJsonlLine(line)`:

```typescript
if (dateRange) {
  const ts = extractTimestampFromLine(line)
  if (ts !== null && (ts < dateRange.start || ts > dateRange.end)) continue
}
```

If `ts` is `null` (no valid timestamp found), do not skip the line -- proceed to full `JSON.parse`. This is the conservative path required by R5.

Remove the post-parse date filter that currently runs after building the `entries` array. The pre-filter replaces it for timestamped lines; non-timestamped lines (type `'user'`) still need to be included, which is why null-timestamp lines must not be skipped.

**Testing**:
- Add a unit test in `tests/parser.test.ts` (create this file if it does not exist) that:
  - Tests `extractTimestampFromLine` with a valid ISO timestamp line, a line without a timestamp, a line with a malformed timestamp, and a line where `"timestamp"` appears only inside a nested object value.
  - The nested-object case must return a `Date` (may be wrong) but must not throw.
- Run `codeburn status --format json` and diff output against baseline.

**Invariants to verify**:
- Lines of type `'user'` in Claude JSONL entries typically lack a top-level `"timestamp"` field in some older sessions. These must not be skipped (null return from `extractTimestampFromLine` prevents skip).
- The `entry.type === 'user'` check in the existing post-parse filter (`return e.type === 'user'`) was specifically preserving user entries without timestamps. This behavior must be preserved: when `extractTimestampFromLine` returns null, the line is always passed to `JSON.parse`.

---

### T6 -- Conditional bash extraction via ParseOptions

**Branch**: `fix/conditional-bash`
**Effort**: ~50 lines changed
**Requirements**: R3
**Estimated gain**: 100-150ms for commands that do not render the bash panel

**What to implement**:

**Step 1**: Add to `src/types.ts` (or `src/parser.ts` if kept local to parsing):

```typescript
export type ParseOptions = {
  dateRange?: DateRange
  providerFilter?: string
  extractBash?: boolean
}
```

**Step 2**: Change the signature of `parseAllSessions` from:

```typescript
export async function parseAllSessions(dateRange?: DateRange, providerFilter?: string): Promise<ProjectSummary[]>
```

to:

```typescript
export async function parseAllSessions(opts?: ParseOptions): Promise<ProjectSummary[]>
```

Update the cache key function `cacheKey` to include `opts.extractBash` in the key so that a cached result with bash data is not returned to a caller that requested no bash data (which would be correct), but also a cached no-bash result is not returned to a caller that needs bash data (which would be incorrect).

**Step 3**: Thread `extractBash` down through `parseSessionFile` and into `parseApiCall` and `extractBashCommandsFromContent`. When `extractBash` is `false`, `parseApiCall` must set `bashCommands: []` without calling `extractBashCommandsFromContent`.

**Step 4**: Update call sites in `src/cli.ts`:
- `status --format json`: pass `extractBash: false`
- `status --format terminal`: pass `extractBash: false` (terminal format does not display bash breakdown -- confirmed: `src/format.ts:renderStatusBar` does not read `bashBreakdown`)
- `status --format menubar`: pass `extractBash: false` (menubar format does not display bash breakdown -- confirmed: `src/menubar.ts` does not read `bashBreakdown`)
- `report` (dashboard): pass `extractBash: true` (default -- bash panel is displayed in `src/dashboard.tsx:381`)
- `export`: pass `extractBash: true` (`src/export.ts:105` builds bash rows from `bashBreakdown` for CSV/JSON output)
- `today`, `month`: pass `extractBash: false` (these render the dashboard, which loads its own data with `extractBash: true` via `reloadData`)

**Step 5**: Update all existing `parseAllSessions` call sites in `src/cli.ts` to use the new `ParseOptions` object. Because T3 already rewrites `cli.ts` partially, this task must be sequenced after T3 is merged, or both tasks must be done in a single branch. The preferred sequence is T3 merged first, T6 second.

**Testing**:
- Add a test in `tests/parser.test.ts` that:
  - Parses a synthetic JSONL fixture containing a Bash tool_use block with `command: "git status && npm install"`.
  - With `extractBash: true`: asserts `session.bashBreakdown` contains `{ git: { calls: 1 }, npm: { calls: 1 } }`.
  - With `extractBash: false`: asserts `session.bashBreakdown` is `{}`.
- Confirm `npx vitest run` passes.
- Run `codeburn status --format json` and diff against baseline.

**Invariants to verify**:
- Existing callers of `parseAllSessions(dateRange, providerFilter)` that use positional arguments will be broken by the signature change. There must be no call sites outside `src/cli.ts` and `src/dashboard.tsx` -- verify with `grep -r 'parseAllSessions' src/`.
- The cache key must distinguish `extractBash: true` from `extractBash: false`. A cached result without bash data must never be returned to a caller that requested bash data.

---

## 8. Testing Strategy

### Unit tests (new)
- `tests/filter-by-date-range.test.ts` -- covers T3's `filterProjectsByDateRange`
- `tests/parser.test.ts` -- covers T5's `extractTimestampFromLine` and T6's bash extraction flag
- `tests/provider-registry.test.ts` -- extend existing file to cover T1's discovery cache

### Integration verification (manual, per task)
Each task must be verified with `hyperfine --warmup 2 --runs 5 'codeburn status --format json'` before merging. Record the median time in the commit message.

### Regression gate
`npx vitest run` must pass with zero failures after each task commit. This is the only automated gate. The CI equivalent for this project is the CLAUDE.md verification checklist.

### Output correctness check (AC-C1)
Before starting any work, capture baseline output:
```bash
codeburn status --format json > /tmp/baseline-json.txt
codeburn status --format terminal > /tmp/baseline-terminal.txt
```
After each task, run:
```bash
diff /tmp/baseline-json.txt <(codeburn status --format json)
diff /tmp/baseline-terminal.txt <(codeburn status --format terminal)
```
Both diffs must be empty.

---

## 9. Risks

### Risk-1: filterProjectsByDateRange produces different totals than parseAllSessions

**Likelihood**: Medium. The `buildSessionSummary` function aggregates values during the parse pass. `filterProjectsByDateRange` re-aggregates from `turns`. If any aggregated value on `SessionSummary` is not derivable from its `turns` array alone, the totals will diverge.

**Mitigation**: Before implementing T3, audit `buildSessionSummary` and confirm that `totalCostUSD === turns.flatMap(t => t.assistantCalls).reduce((s, c) => s + c.costUSD, 0)`. Add this as an assertion in the T3 unit test.

**Rollback**: If the invariant does not hold, T3 must be scoped to only `status --format menubar` and not `export`, and the per-provider today computation must remain as separate `parseAllSessions` calls.

### Risk-2: readline streaming changes error handling behavior

**Likelihood**: Low. The current implementation uses `readFile` and catches all errors by returning `null`. The streaming implementation must preserve this contract.

**Mitigation**: Wrap `createReadStream` in a try/catch at the point of creation. If the file does not exist or is not readable, return `null` immediately without entering the `readline` loop.

### Risk-3: Date pre-filter skips lines it should not

**Likelihood**: Low but high-impact. If a line is incorrectly skipped, tokens and costs are silently undercounted with no error.

**Mitigation**: The pre-filter is conservative by design (R5): any line where `extractTimestampFromLine` returns `null` must proceed to full `JSON.parse`. Only lines with a valid, parseable, out-of-range timestamp are skipped. Add a test with a line that has a nested `"timestamp"` key to verify it does not produce a false positive skip.

**Rollback**: This optimization can be disabled by removing the pre-filter guard and leaving the post-parse filter intact, with no other changes.

### Risk-4: ParseOptions signature change breaks call sites

**Likelihood**: Medium. `parseAllSessions` is called from `cli.ts` and `dashboard.tsx`. If the signature change is incomplete, TypeScript will catch it at compile time.

**Mitigation**: The build step (`npm run build`) must succeed with zero type errors before merging T6.

---

## 10. Implementation Order and Sequence

Tasks T1 and T2 are fully independent and can be implemented and merged in any order.

T3 must be merged before T6 because T6 modifies the `parseAllSessions` call sites that T3 rewrites.

T4 and T5 are independent of T3 and T6 and can be merged at any point. Merge T4 before T5 since T5 modifies code inside the loop body that T4 introduces.

Recommended sequence:
1. T2 (trivial, highest confidence, small diff)
2. T1 (trivial, high confidence)
3. T4 (streaming -- independent, good early RSS win)
4. T5 (pre-filter -- builds on T4's loop structure)
5. T3 (widen-then-filter -- largest correctness surface)
6. T6 (bash extraction -- depends on T3's call site rewrite)

---

## 11. Traceability Matrix

| Requirement | Tasks | Acceptance Criteria |
|-------------|-------|---------------------|
| R1 | T1 | AC-1a, AC-1b, AC-1c, AC-1d |
| R2 | T3 | AC-3a, AC-3b, AC-3c, AC-3d |
| R3 | T6 | AC-6a, AC-6b, AC-6c, AC-6d |
| R4 | T4 | AC-4a, AC-4b |
| R5 | T5 | AC-4c, AC-4d, AC-4e |
| R6 | T2 | AC-2a, AC-2b, AC-2c, AC-2d |
| R7 | T3, T4, T5, T6 | AC-3c, AC-4e, AC-E1 |
| R8 | All | AC-E1 |

---

## 12. Out of Scope

- `npx tsx` startup overhead (~600ms): this is a development tooling issue, not a production concern. Published builds use the compiled bundle.
- Reducing Node.js module load time (`compileSourceTextModule`: 22ms): this requires bundle splitting or deferred imports and is a separate optimization track.
- Cursor SQLite query optimization: the Cursor provider has its own cache (`cursor-cache.ts`) that is already keyed by DB mtime+size. This is not a bottleneck in the current profile.
- Parallelizing JSONL reads with `Promise.all`: while this could reduce I/O wait time, it increases memory pressure (multiple large files in memory simultaneously) and conflicts with the streaming goal in T4. Defer until after RSS targets are met.

---

## 13. Changelog

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2026-04-16 | Initial spec |
| 1.1.0 | 2026-04-16 | Verification fixes: T6 extractBash true for export (bashBreakdown used in export.ts), AC-6b updated to match T6 terminal skip, AC-2d added for currency in report/today/month, T3 ProjectSummary recompute explicit, AC-1d for clearDiscoveryCache on dashboard refresh, T3 Step 2b for status --format json widen-then-filter |
