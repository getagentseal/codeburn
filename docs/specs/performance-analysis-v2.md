# Performance Analysis v2: Post-Optimization

Date: 2026-04-17
Baseline reference: `docs/specs/performance-analysis.md` (2026-04-15)

## Context

This report measures performance after implementing all 10 tasks from `docs/specs/performance-optimization-tasks.md`. Changes applied:

| Optimization | Files Changed |
|-------------|---------------|
| Discovery result caching | `src/providers/index.ts` |
| Widen-then-filter (parse once, derive subranges) | `src/cli.ts` |
| JSONL streaming via readline (replaces readFile) | `src/parser.ts` |
| Date pre-filter before JSON.parse | `src/parser.ts` |
| Conditional bash extraction (extractBash flag) | `src/parser.ts`, `src/types.ts` |
| filterProjectsByDateRange with aggregate recompute | `src/parser.ts` |
| loadCurrency() moved out of preAction hook | `src/cli.ts` |

Data volume: 21 projects, 129 sessions, ~57MB total JSONL (27MB CLI + 30MB desktop app), 6504 lines.

## Results: Wall-Clock Time

Built bundle (`node dist/cli.js`), median of 3 runs:

| Command | Before | After | Change |
|---------|--------|-------|--------|
| `status --format json` | 900ms | **589ms** | -34% |
| `status --format terminal` | ~1000ms | **587ms** | -41% |
| `status --format menubar` | ~2500ms | **597ms** | -76% |
| `export -f json` | N/A | **785ms** | -- |
| `status --format json` (tsx) | 1500ms | **1243ms** | -17% |

The menubar command saw the largest improvement (76%) because it previously made 6 separate parseAllSessions calls. It now makes 1 call and derives subranges with filterProjectsByDateRange.

## Results: RSS Memory

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Peak RSS (`status --format json`) | ~150MB | **185MB** | +23% |

RSS increased slightly. The readline streaming approach uses comparable memory to readFile for this data volume since entries are accumulated in an array before processing. The cache also retains parsed results in memory. At 57MB of JSONL data, this is acceptable -- the spec target was RSS under 100MB for the `status --format json` path, which is not met.

## CPU Profile: `status --format json` (built)

Top functions by self-time (node --cpu-prof):

| Self-time | Before | After | Function |
|-----------|--------|-------|----------|
| 66ms | 138ms | **66ms** | `parseJsonlLine` (JSON.parse) |
| 47ms | 49ms | **47ms** | `write` (string_decoder) |
| 26ms | -- | **26ms** | readline newline regex |
| 18ms | 22ms | **18ms** | `compileSourceTextModule` |
| 14ms | 13ms | **14ms** | GC |
| 13ms | -- | **13ms** | `extractTimestampFromLine` |
| 6ms | 57ms | **6ms** | `parseSessionFile` |
| 0ms | 171ms | **0ms** | bash separator regex |

Key observations:
- **Bash regex eliminated**: 171ms -> 0ms. `extractBash: false` for the status command means the regex never runs.
- **JSON.parse halved**: 138ms -> 66ms. The date pre-filter skips JSON.parse for lines with timestamps outside the month range.
- **parseSessionFile collapsed**: 57ms -> 6ms. Streaming + single-pass parsing is more efficient than readFile + split + map.
- **extractTimestampFromLine overhead**: 13ms for the string index scan. Acceptable tradeoff for the 72ms JSON.parse saving.

## Phase Breakdown (instrumented probe)

| Phase | Before | After | Change |
|-------|--------|-------|--------|
| Load pricing (cache hit) | 2ms | **2ms** | -- |
| Load currency | 0ms | **0ms** | -- |
| Parse month (cold, no bash) | 365ms | **281ms** | -23% |
| Filter today (in-memory) | N/A | **0.4ms** | new |
| Parse month (cached) | 343ms | **0.0ms** | -100% |
| Parse month (with bash) | N/A | **387ms** | -- |

The cache eliminates the second parse entirely (343ms -> 0ms). filterProjectsByDateRange runs in under 1ms for the in-memory filter.

## Spec Target Assessment

| Target | Status | Measured |
|--------|--------|----------|
| `status --format json` under 400ms (spec R1) | **NOT MET** | 589ms median |
| RSS under 100MB (spec R5) | **NOT MET** | 185MB |
| `filterProjectsByDateRange` cost invariant (spec R3) | **MET** | 7 tests pass |
| No mutation of input data (spec R3) | **MET** | test verified |
| Conditional bash extraction (spec R7) | **MET** | 0ms bash regex for status |
| Discovery cache (spec R2) | **MET** | 0ms second call |

The 400ms target was set for the built bundle. Current 589ms is 34% faster than the 900ms baseline but still 47% above target. Remaining bottleneck is the ~280ms single-pass parse of all month JSONL data.

## Remaining Bottlenecks

### 1. Parse time still dominates (~280ms)

Even with streaming and date pre-filter, parsing ~6500 JSONL lines with JSON.parse takes 280ms. The date pre-filter helps most when querying narrow ranges (today) against large datasets, but for month range it skips very few lines.

Possible next steps:
- **Lazy content parsing**: Parse only the fields needed (model, usage, timestamp) instead of full JSON.parse. Would require a custom lightweight parser or regex extraction.
- **SQLite result cache**: Persist parsed session summaries to disk. Subsequent runs would only parse new/modified files.

### 2. RSS is high (~185MB)

The full parsed dataset (21 projects, all turns with content blocks) is held in memory. The readline streaming doesn't reduce peak memory because entries are collected into an array.

Possible next steps:
- **Drop content blocks after classification**: After classifying turns and extracting costs, discard the raw message content to free memory.
- **Two-pass parsing**: First pass extracts only metadata (cost, model, timestamp). Second pass (on demand) extracts tool details.

### 3. Node.js startup (~50-70ms)

Module loading and JIT compilation contribute ~18ms (compileSourceTextModule) plus ~50ms of assorted startup. This is a Node.js baseline cost that cannot be reduced without switching runtimes.

## Summary

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| `status --format json` | 900ms | 589ms | 34% faster |
| `status --format menubar` | 2500ms | 597ms | 76% faster |
| Bash regex CPU | 171ms | 0ms | eliminated |
| JSON.parse CPU | 138ms | 66ms | 52% faster |
| Cache hit parse | 343ms | 0ms | eliminated |
| In-memory filter | N/A | 0.4ms | new capability |

The optimizations delivered the largest gains on multi-period commands (menubar: 76%, terminal: 41%) where widen-then-filter and discovery caching compound. The `status --format json` target of 400ms is not yet met -- reaching it would require either a lightweight JSON parser or persistent result caching.
