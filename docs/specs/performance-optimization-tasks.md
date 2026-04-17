# Tasks: CLI Performance Optimization

**Generated from**: docs/specs/performance-optimization.md
**Total tasks**: 10
**Parallel groups**: 3
**Estimated total effort**: 18h
**Max parallel agents**: 3

---

## File Conflict Matrix

| Task | Files Modified | Conflicts With |
|------|---------------|----------------|
| T1 | src/providers/index.ts, tests/provider-registry.test.ts | -- |
| T2 | src/cli.ts | T3b, T6b |
| T3a | src/parser.ts | T4, T5, T6a |
| T3b | src/cli.ts | T2, T6b |
| T3c | tests/filter-by-date-range.test.ts | -- |
| T4 | src/parser.ts | T3a, T5, T6a |
| T5a | src/parser.ts | T3a, T4, T6a |
| T5b | tests/parser.test.ts | T6c |
| T6a | src/parser.ts, src/types.ts | T3a, T4, T5a |
| T6b | src/cli.ts, src/dashboard.tsx | T2, T3b |
| T6c | tests/parser.test.ts | T5b |

---

## Task Graph

```
T1 ─────────────────────────────────────────────┐
T2 ──→ T3b ──→ T6b                              │
T3a ──→ T3b                                     ├──→ (done)
T3a ──→ T3c                                     │
T4 ──→ T5a ──→ T5b                              │
T4 ──→ T6a ──→ T6b                              │
                T6a ──→ T6c                      │
                                                 │
T1 ─────────────────────────────────────────────┘
T2 ─────────────────────────────────────────────┘

Dependency summary:
  T1: no deps
  T2: no deps
  T3a: no deps (parser-only, no call site changes)
  T3b: depends on T2, T3a
  T3c: depends on T3a
  T4: no deps
  T5a: depends on T4 (builds on T4's streaming loop)
  T5b: depends on T5a
  T6a: depends on T4 (modifies parser.ts after streaming is in)
  T6b: depends on T3b, T6a (rewrites cli.ts call sites after both are stable)
  T6c: depends on T6a
```

---

## Parallel Group 1: Independent Foundation (no dependencies)

- [P] **T1**: Cache discovery results in providers/index.ts
  - **Validates**: R1
  - **Files**: src/providers/index.ts, tests/provider-registry.test.ts
  - **Complexity**: low
  - **Effort**: 1h
  - **Depends on**: --
  - **What to do**:
    1. Add module-level `Map<string, SessionSource[]>` cache in src/providers/index.ts
    2. In `discoverAllSessions` (line 29), check cache before running provider discovery; store result after
    3. Cache key: `providerFilter ?? 'all'`
    4. Export `clearDiscoveryCache()` that calls `discoveryCache.clear()`
    5. Call `clearDiscoveryCache()` at top of refresh handler in src/dashboard.tsx (line ~565)
  - **Tests**:
    - In tests/provider-registry.test.ts: call `discoverAllSessions` twice, assert same reference (`toBe`)
    - Call `clearDiscoveryCache` between calls, assert different reference
    - Verify different `providerFilter` values are cached independently
  - **AC**: AC-1a, AC-1b, AC-1c, AC-1d

- [P] **T2**: Move loadCurrency() out of preAction hook
  - **Validates**: R6
  - **Files**: src/cli.ts
  - **Complexity**: low
  - **Effort**: 1h
  - **Depends on**: --
  - **What to do**:
    1. Remove `program.hook('preAction', ...)` block at src/cli.ts:65-67
    2. Add `await loadCurrency()` as first line of action handler for: `status`, `report`, `today`, `month`, `export`
    3. Verify `currency` command's action handler already calls `loadCurrency()` in its display branch
  - **Tests**:
    - `npx vitest run` passes
    - Manual: `codeburn status --format json` output unchanged
    - Manual: `codeburn currency` displays current currency code
  - **AC**: AC-2a, AC-2b, AC-2c, AC-2d

- [P] **T4**: Stream JSONL files with readline in parseSessionFile
  - **Validates**: R4
  - **Files**: src/parser.ts
  - **Complexity**: medium
  - **Effort**: 2h
  - **Depends on**: --
  - **What to do**:
    1. In src/parser.ts `parseSessionFile` (line 262), replace `readFile` + `split('\n')` with `readline.createInterface` + `for await`
    2. Import `createReadStream` from `fs` and `createInterface` from `readline`
    3. Wrap readline loop in `try/finally` that calls `rl.close()`
    4. Preserve existing error handling: wrap `createReadStream` in try/catch, return `null` on file-not-found
    5. Remove `readFile` import from parser.ts only if no longer used elsewhere in the file
  - **Tests**:
    - `npx vitest run` passes (existing integration tests cover parseSessionFile)
    - Manual: `codeburn status --format json` output unchanged vs baseline
    - Manual: check RSS with `process.memoryUsage().rss` log at exit
  - **Invariants**:
    - `parseSessionFile` must remain `async`
    - `try/finally` around `rl.close()` must execute even on exception
    - Files that don't exist must still return `null`
  - **AC**: AC-4a, AC-4b

---

## Parallel Group 2: Filtering and Pre-filter (depends on Group 1 items)

- [P] **T3a**: Implement filterProjectsByDateRange in parser.ts
  - **Validates**: R2, R7
  - **Files**: src/parser.ts
  - **Complexity**: high
  - **Effort**: 3h
  - **Depends on**: --
  - **What to do**:
    1. Add `filterProjectsByDateRange(projects: ProjectSummary[], range: DateRange): ProjectSummary[]` in src/parser.ts
    2. For each project: filter each session's `turns` by `turn.timestamp >= range.start && turn.timestamp <= range.end`
    3. Recompute per-session: `totalCostUSD`, `totalApiCalls`, `totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`, `totalCacheWriteTokens`, `modelBreakdown`, `toolBreakdown`, `mcpBreakdown`, `bashBreakdown`, `categoryBreakdown`, `firstTimestamp`, `lastTimestamp`
    4. Exclude sessions with zero surviving turns; exclude projects with all sessions excluded
    5. Recompute `ProjectSummary.totalCostUSD` and `totalApiCalls` from filtered sessions
    6. Return new array; do not mutate input
  - **Invariant**: `sessionSummary.totalCostUSD === sum(turn.assistantCalls[].costUSD)` must hold
  - **AC**: AC-3c, AC-3d

- [P] **T5a**: Add date pre-filter before JSON.parse in parseSessionFile
  - **Validates**: R5
  - **Files**: src/parser.ts
  - **Complexity**: medium
  - **Effort**: 2h
  - **Depends on**: T4 (builds on T4's streaming loop structure)
  - **What to do**:
    1. Add `extractTimestampFromLine(line: string): Date | null` helper in src/parser.ts
    2. Uses `line.indexOf('"timestamp":"')`, extracts date string, parses with `new Date()`, returns null if invalid
    3. In the streaming line loop (from T4), add guard before `parseJsonlLine`: if `dateRange` exists and extracted timestamp is valid and out of range, `continue`
    4. If `extractTimestampFromLine` returns null, always proceed to full `JSON.parse` (conservative path per R5)
    5. Remove the post-parse date filter that currently runs after building entries array
  - **AC**: AC-4c, AC-4d, AC-4e

- [P] **T3c**: Add unit tests for filterProjectsByDateRange
  - **Validates**: R2, R7
  - **Files**: tests/filter-by-date-range.test.ts (new)
  - **Complexity**: medium
  - **Effort**: 2h
  - **Depends on**: T3a
  - **What to do**:
    1. Create tests/filter-by-date-range.test.ts
    2. Construct a `ProjectSummary` with turns spanning 3 days
    3. Call `filterProjectsByDateRange` with a 1-day range
    4. Assert returned totals equal sum of only in-range turns
    5. Assert input `ProjectSummary` is not mutated
    6. Test: session with all turns outside range is excluded entirely
    7. Test: project with all sessions excluded is excluded from result
    8. Test: full epoch-to-now range returns result equal to input
    9. Verify invariant: `totalCostUSD === turns.flatMap(t => t.assistantCalls).reduce((s, c) => s + c.costUSD, 0)`
  - **AC**: AC-3c, AC-3d

---

## Sequential Group 3: Call Site Rewrites (depends on Group 2)

- **T3b**: Rewrite status and export command handlers to use widen-then-filter
  - **Validates**: R2, R7
  - **Files**: src/cli.ts
  - **Complexity**: high
  - **Effort**: 3h
  - **Depends on**: T2, T3a
  - **What to do**:
    1. **menubar format** (src/cli.ts status handler): replace up to 6 `parseAllSessions` calls with one call using `getDateRange('month').range`, then derive `todayData`, `weekData`, `monthData` via `filterProjectsByDateRange`
    2. **json format** (src/cli.ts:142-143): replace 2 `parseAllSessions` calls with one call using month range, derive `todayData` via `filterProjectsByDateRange`
    3. **export command**: replace multiple `parseAllSessions` calls with one call using `getDateRange('30days').range`, derive `today`, `week`, `30days` via filter
    4. Per-provider today costs: filter month result with today range, then filter by provider name in-memory
  - **Tests**:
    - `npx vitest run` passes
    - Manual: diff `codeburn status --format menubar` output against baseline (byte-for-byte)
    - Manual: diff `codeburn status --format json` output against baseline
  - **AC**: AC-3a, AC-3b, AC-3c

- **T5b**: Add unit tests for extractTimestampFromLine
  - **Validates**: R5
  - **Files**: tests/parser.test.ts (new or extend)
  - **Complexity**: low
  - **Effort**: 1h
  - **Depends on**: T5a
  - **What to do**:
    1. Test with valid ISO timestamp line
    2. Test with line without a timestamp (returns null)
    3. Test with malformed timestamp (returns null)
    4. Test with `"timestamp"` only inside a nested object value (returns a Date, must not throw)
  - **AC**: AC-4d

- **T6a**: Add ParseOptions type and thread extractBash through parser
  - **Validates**: R3
  - **Files**: src/parser.ts, src/types.ts
  - **Complexity**: medium
  - **Effort**: 2h
  - **Depends on**: T4 (parser.ts must have streaming in place first)
  - **What to do**:
    1. Add `ParseOptions` type: `{ dateRange?: DateRange, providerFilter?: string, extractBash?: boolean }`
    2. Change `parseAllSessions` signature from `(dateRange?, providerFilter?)` to `(opts?: ParseOptions)`
    3. Update cache key to include `extractBash` (cached no-bash result must not be returned to bash-needing caller)
    4. Thread `extractBash` down through `parseSessionFile` and `parseApiCall`
    5. When `extractBash: false`, set `bashCommands: []` without calling `extractBashCommandsFromContent`
    6. Default `extractBash` to `true` for backward compatibility
  - **AC**: AC-6d

- **T6b**: Update all parseAllSessions call sites to use ParseOptions
  - **Validates**: R3
  - **Files**: src/cli.ts, src/dashboard.tsx
  - **Complexity**: medium
  - **Effort**: 1.5h
  - **Depends on**: T3b, T6a
  - **Cannot parallelize**: modifies src/cli.ts which T3b also modifies
  - **What to do**:
    1. Verify all call sites with `grep -r 'parseAllSessions' src/`
    2. `status --format json`: pass `{ extractBash: false }`
    3. `status --format terminal`: pass `{ extractBash: false }`
    4. `status --format menubar`: pass `{ extractBash: false }`
    5. `report` (dashboard): pass `{ extractBash: true }` (bash panel displayed in dashboard.tsx:381)
    6. `export`: pass `{ extractBash: true }` (export.ts:105 uses bashBreakdown)
    7. `today`, `month`: pass `{ extractBash: false }`
  - **AC**: AC-6a, AC-6b, AC-6c

- **T6c**: Add tests for conditional bash extraction
  - **Validates**: R3
  - **Files**: tests/parser.test.ts
  - **Complexity**: low
  - **Effort**: 1h
  - **Depends on**: T6a
  - **What to do**:
    1. Create synthetic JSONL fixture with Bash tool_use block containing `command: "git status && npm install"`
    2. Parse with `extractBash: true`: assert `session.bashBreakdown` contains `{ git: { calls: 1 }, npm: { calls: 1 } }`
    3. Parse with `extractBash: false`: assert `session.bashBreakdown` is `{}`
  - **AC**: AC-6c, AC-6d

---

## Execution Order (recommended)

```
Phase 1 (parallel):  T1, T2, T4        -- independent foundation
Phase 2 (parallel):  T3a, T5a          -- parser additions (after T4 merges)
Phase 3 (parallel):  T3b, T3c, T5b     -- call site rewrite + tests (after T2, T3a, T5a)
Phase 4 (sequential): T6a              -- ParseOptions type + threading (after T4)
Phase 5 (parallel):  T6b, T6c          -- call site update + tests (after T3b, T6a)
```

---

## Traceability

| Requirement | Tasks |
|-------------|-------|
| R1 (Discovery cache) | T1 |
| R2 (Widen-then-filter) | T3a, T3b, T3c |
| R3 (Conditional bash) | T6a, T6b, T6c |
| R4 (Streaming JSONL) | T4 |
| R5 (Date pre-filter) | T5a, T5b |
| R6 (Currency deferral) | T2 |
| R7 (Output correctness) | T3a, T3b, T3c, T5a, T5b |
| R8 (Test suite green) | All |
