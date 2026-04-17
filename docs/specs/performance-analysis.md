# Performance Analysis: CodeBurn CLI

Date: 2026-04-15

## Baseline

| Metric | Value |
|--------|-------|
| `status --format json` (built) | **0.9s** wall, 0.77s CPU |
| `status --format json` (tsx) | **1.5s** wall |
| `status --format terminal` (built) | ~1.0s |
| `status --format menubar` (built) | ~2.5s (6 parse calls) |
| `report` (interactive TUI, tsx) | ~5-8s startup |
| RSS memory | ~150MB |
| Data volume | 18 projects, 76 sessions, 225 turns, ~20MB JSONL, 58MB Cursor DB |

**Target**: CLI startup under 500ms for `status --format json` (built bundle). Interactive `report` under 2s.

## Phase Breakdown

Measured via instrumented probe, median of 3 runs:

| Phase | Time |
|-------|------|
| Imports | 9ms |
| Load pricing (disk cache hit) | 2ms |
| Load currency | 0ms |
| Parse sessions (today, cold) | 222ms |
| Parse sessions (month, cold) | 365ms |
| Parse sessions (week, after month) | 343ms |
| **Total (app-level)** | **940ms** |

Key observation: each `parseAllSessions` call with a different date range is a cache miss and triggers a full re-discovery + re-parse cycle.

## CPU Profile (built bundle, `status --format json`)

Generated via `node --cpu-prof`. Top functions by self-time:

| Self-time | Function | Location |
|-----------|----------|----------|
| 171ms | Bash separator regex | `bash-utils.ts:14` |
| 138ms | `parseJsonlLine` (JSON.parse) | `parser.ts:27` |
| 57ms | `parseSessionFile` | `parser.ts:262` |
| 49ms | `write` (string_decoder) | Node internals |
| 22ms | `compileSourceTextModule` | Node module loading |
| 13ms | GC | -- |
| 98ms | idle (I/O wait) | -- |

Total sampled: ~800ms.

## Filesystem Profile

Desktop app session discovery (`findDesktopProjectDirs`):

| Metric | Value |
|--------|-------|
| `readdir` calls | 427 |
| `stat` calls | 879 |
| Directories traversed | 450 |
| JSONL files found | 15 |
| Time | 36ms |

Claude CLI session discovery:

| Metric | Value |
|--------|-------|
| `readdir` calls | 16 |
| `stat` calls | 5 |
| Time | 1ms |

## Bottlenecks (ranked by impact)

### 1. Bash regex on every JSONL entry -- 171ms (21% of CPU)

**Evidence**: CPU profile shows the bash separator regex at 171ms self-time -- the single hottest function.

**Root cause**: `bash-utils.ts:14` -- the separator regex runs with `exec` in a while-loop over every bash command string in every JSONL entry. Called from `extractBashCommandsFromContent` in `parser.ts:48` on every assistant message content block.

**Fix**: Skip bash extraction when not needed (e.g., `status --format json` does not render bash breakdown). Alternatively, pre-scan for `tool_use` blocks with bash tool names before running the regex.

**Estimated gain**: 100-150ms

### 2. JSON.parse all JSONL lines -- 138ms (17% of CPU)

**Evidence**: CPU profile shows `parseJsonlLine` at 138ms self-time. Parsing ~6000 JSONL entries (many large with full content blocks) is inherently expensive.

**Root cause**: Every JSONL line is fully parsed with `JSON.parse` in `parser.ts:27`, even lines outside the date range (date filtering happens after parsing). Lines contain full assistant message content blocks with tool inputs, which can be very large.

**Fix**:
- **Date pre-filter**: Extract timestamp with a simple string scan (e.g., regex on raw line) before full `JSON.parse`. Lines with timestamps outside the range can be skipped entirely.
- **Lazy parsing**: For commands that do not need tool content or bash commands, a lightweight parse that skips content blocks would be faster.

**Estimated gain**: 50-100ms (depends on how many lines fall outside the date range)

### 3. Redundant session discovery -- ~37ms per call, multiplied

**Evidence**: `parseAllSessions` calls `discoverAllSessions` on every cache miss. The `status --format menubar` command calls `parseAllSessions` 6 times (today + week + month + per-provider today), each triggering a full discovery including the desktop app recursive walk.

**Root cause**: No caching of discovery results in `providers/index.ts`. The desktop app walk (`findDesktopProjectDirs` in `providers/claude.ts:35`) recursively walks up to depth 8 from `~/Library/Application Support/Claude/local-agent-mode-sessions/`, hitting 879 `stat` calls to find 15 files.

**Fix**: Cache discovery results for the lifetime of the process. Session paths do not change during a single CLI invocation. A simple module-level variable would eliminate all repeated walks.

**Estimated gain**: 30-180ms depending on command (menubar saves ~180ms; json saves ~37ms)

### 4. Full re-parse for overlapping date ranges

**Evidence**: `status` terminal format calls `parseAllSessions` once for month. But `menubar` format calls it 3 times with today/week/month -- ranges that are subsets of each other. Each cache miss triggers a full re-read and re-parse of all files.

**Root cause**: The cache key in `parser.ts:448` is based on start+end+provider, so different date ranges never share results, even when month's data is a superset of today's.

**Fix**: Parse the widest range once (e.g., month or 30 days), then filter the in-memory results by narrower date ranges. This is effectively what the dashboard already does when switching periods with arrow keys.

**Estimated gain**: 200-400ms for `menubar`/`export` commands that query multiple periods

### 5. `npx tsx` overhead -- ~600ms

**Evidence**: Built bundle (0.9s) vs tsx (1.5s) = 600ms tsx overhead per invocation.

**Root cause**: `npx tsx` resolves the package, loads the TypeScript transpiler, and JIT-compiles all imports. This is a development convenience, not a production concern (users install the published npm package which runs `node dist/cli.js`).

**Impact on users**: None (published CLI uses the built bundle). Only affects development iteration.

## Summary

| Bottleneck | Self-time | Fix | Estimated Gain |
|-----------|-----------|-----|----------------|
| Bash regex on every entry | 171ms | Skip when not rendering bash panel | 100-150ms |
| JSON.parse all JSONL lines | 138ms | Date pre-filter, lazy parse | 50-100ms |
| Repeated session discovery | 37ms x N | Cache discovery per process | 30-180ms |
| Overlapping date range re-parse | 200-400ms | Parse widest range, filter in-memory | 200-400ms |
| npx tsx overhead | 600ms | N/A (dev only) | N/A |

## Recommended Priority

1. **Cache discovery results** -- trivial change (add module-level cache in `providers/index.ts`), prevents the expensive desktop walk from running multiple times per invocation
2. **Parse widest range once, filter in-memory** -- biggest gain for `menubar`/`export` commands, moderate code change in `cli.ts`
3. **Date pre-filter before JSON.parse** -- scan for timestamp string before full parse in `parser.ts`, moderate gain
4. **Lazy bash extraction** -- skip the regex when the result will not be displayed, change in `parser.ts`

Combined, these optimizations could bring `status --format json` from ~900ms to ~400ms and `menubar` from ~2.5s to under 1s.
