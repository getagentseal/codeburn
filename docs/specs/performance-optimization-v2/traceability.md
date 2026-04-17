# Traceability: Performance Optimization v2

## Requirement -> AC -> Source

| Req | Description | ACs | Source File | Test File | Status |
|-----|-------------|-----|-------------|-----------|--------|
| R1 | Cache module (open/get/put) | AC1, AC2, AC19 | `src/session-cache.ts` | `tests/session-cache.test.ts` | done |
| R2 | Schema definition | AC3 | `src/session-cache.ts` | `tests/session-cache.test.ts` | done |
| R3 | Invalidation by mtime+size | AC4, AC5, AC6 | `src/session-cache.ts` | `tests/session-cache.test.ts`, `tests/parser-cache.test.ts` | done |
| R4 | parseSessionFile integration | AC4, AC7 | `src/parser.ts` | `tests/parser-cache.test.ts` | done |
| R5 | Cache opened once per invocation | AC8 | `src/parser.ts` | `tests/parser-cache.test.ts` | done |
| R6 | userMessage zeroed before cache write | AC11 | `src/parser.ts` | `tests/parser-cache.test.ts` | done |
| R7 | userMessage zeroing: Claude path | AC9 | `src/parser.ts` | `tests/parser-cache.test.ts` | done |
| R8 | userMessage zeroing: provider path | AC10 | `src/parser.ts` | `tests/parser-cache.test.ts` | done |
| R9 | Ordering invariant | AC9, AC10, AC11 | `src/parser.ts` | `tests/parser-cache.test.ts` | done |
| R10 | DEBUG log for cache hit/miss | AC16, AC17 | `src/session-cache.ts` | `tests/session-cache.test.ts` | done |
| R11 | Schema reset on error | AC18 | `src/session-cache.ts` | `tests/session-cache.test.ts` | done |
| R12 | Performance targets (400ms, 100MB) | AC12, AC15 | all | manual (built bundle) | pending-manual |
| R13 | Cold/warm benchmark thresholds | AC13, AC14 | all | `tests/bench/parse-performance.bench.ts` | done |
| R14 | No regression, output correctness | AC24, AC25 | all | `npx vitest run` (74 tests pass) | done |
| R15 | Automated benchmark suite | AC21, AC22, AC23 | `tests/bench/parse-performance.bench.ts` | `tests/fixtures/bench/` (510 lines, 5 files) | done |

## Constraint -> AC Coverage

| Constraint | Description | ACs | Status |
|------------|-------------|-----|--------|
| C7 | WAL mode, concurrent access | AC20 | done (`tests/parser-cache.test.ts`) |
| C9 | Benchmark excluded from vitest run | AC22 | done (`vitest.config.ts`) |
| C10 | better-sqlite3 dep model | AC2 | done (moved to `dependencies` in `package.json`) |

## Interview Decision Coverage

| Decision | Requirement(s) | Design Decision(s) |
|----------|---------------|--------------------|
| D-PERF-1: 400ms target | R12 | D5 |
| D-RSS-1: RSS < 100MB | R12 | D9 |
| D-CACHE-1: SQLite required | R1, R2, R15 | D1, D4 |
| D-CACHE-2: mtime+size invalidation | R3 | D3 |
| D-MEM-1: Drop userMessage | R6, R7, R8, R9 | D9 |
| D-BENCH-1: Automated benchmarks | R13, R15 | D5 |
| D-SCOPE-1: Startup out of scope | spec.md Out of Scope | -- |
