# SDLC Toolkit Journal

Tracks every sdlc-toolkit interaction: value delivered, limitations found, self-corrections observed.
Summerizes the advances on improving the repository of Codeburn with the toolkit help.
The purpose of this Journal is to give a well detailed, but still readble, feedback about the tool.

---

## 2026-04-15 -- security-scan (Claude Cowork, Opus 4.6)

**Action**: Full security audit of the codebase. Produced `docs/specs/security-audit-report.md`.
**Value**: Confirmed zero user data leakage. Identified 2 outbound read-only HTTP requests (LiteLLM pricing, Frankfurter exchange rates) and verified neither transmits user data. Flagged 5 low-risk items (symlink following, JSONL prototype pollution, export path traversal) with clear reasoning for why each is acceptable.
**Limitations**: None.
**Self-correction**: N/A.

---

## 2026-04-15 -- full audit (Claude Cowork, Opus 4.6)

**Action**: Comprehensive project audit covering architecture, implementation, security, testing, strengths, and weaknesses. Produced `docs/specs/codeburn-full-audit.md` (415 lines).
**Value**: Rated 8 areas (architecture: Strong, privacy: Excellent, test coverage: Weak). Identified 8 specific weak points with actionable recommendations. Produced a complete architecture diagram in Mermaid and a module-level responsibility map.
**Limitations**: Could not run `npm audit` due to sandbox network restrictions.
**Self-correction**: N/A.

---

## 2026-04-15 -- learn-codebase (Claude Cowork, Opus 4.6)

**Action**: Generated `docs/specs/codebase-overview.md` -- full module map, architecture description, provider system analysis, caching strategy, and test coverage gaps.
**Value**: Mapped all 18 source files with line counts and roles. Identified the key architectural asymmetry: Claude sessions use a legacy JSONL codepath while Codex/Cursor use the async generator `SessionParser` interface. Documented deduplication strategies per provider.
**Limitations**: None.
**Self-correction**: N/A.

---

## 2026-04-15 -- performance-analysis

**Action**: Profiled CLI startup with CPU profiling and filesystem instrumentation. Produced `docs/specs/performance-analysis.md`.
**Value**: Identified 4 ranked bottlenecks with exact self-times: bash regex (171ms/21% CPU), JSON.parse all lines (138ms/17%), redundant discovery (37ms x N), overlapping date range re-parse (200-400ms). Set concrete targets: `status --format json` under 500ms, `report` under 2s.
**Limitations**: None.
**Self-correction**: N/A.

---

## 2026-04-16 14:00 -- architect

**Action**: Evaluated whether CodeBurn should be rewritten in Rust, Go, Python, or Swift instead of TypeScript.
**Value**: Produced a structured comparison across 10 dimensions (startup, memory, TUI ecosystem, SQLite, migration cost, etc.). Concluded: don't rewrite -- 4 targeted TypeScript fixes (~100-200 lines) can achieve 80% of the performance gains. Identified Go as the strongest rewrite candidate if TypeScript optimizations fail.
**Limitations**: Analysis was thorough but long. The agent produced a very detailed response that could have been more concise for decision-making.
**Self-correction**: N/A.

---

## 2026-04-16 15:00 -- spec-writer

**Action**: Wrote `docs/specs/performance-optimization.md` (v1.0.0) -- a 580-line spec defining 6 tasks (T1-T6) to fix all identified performance bottlenecks.
**Value**: Produced production-grade spec with 8 requirements, 15 acceptance criteria, 5 design decisions, risk analysis, and traceability matrix. Each task is independently shippable with its own branch, testing strategy, and invariants. Defensive design lens caught Risk-1 (filterProjectsByDateRange invariant) proactively.
**Limitations**: None apparent at writing time -- issues found later by verify-spec.
**Self-correction**: N/A.

---

## 2026-04-16 16:00 -- verify-spec

**Action**: Structural and alignment verification of performance-optimization.md against the actual codebase.
**Value**: Caught 2 errors and 3 warnings that would have caused bugs during implementation. Key find: T6 set `extractBash: false` for the `export` command, but `export.ts:buildBashRows()` reads `bashBreakdown` -- this would have silently emptied bash data in CSV/JSON exports. Also caught AC-6b contradicting T6 Step 4 for terminal format.
**Limitations**: Pre-implementation verification only (Level 1-2 depth). Cannot verify code alignment since no code exists yet.
**Self-correction**: verify-spec caught spec-writer's mistakes. The spec-writer did not check whether `export.ts` uses `bashBreakdown` before setting `extractBash: false` for exports.

---

## 2026-04-16 16:30 -- spec fixes (follow-up to verify-spec)

**Action**: Applied all 6 findings from verify-spec to the spec. Updated to v1.1.0.
**Value**: Fixed 2 errors (extractBash for export, AC-6b contradiction), 3 warnings (missing ACs for currency loading, ProjectSummary recompute, clearDiscoveryCache), and 1 info (added widen-then-filter for `status --format json`). Traceability matrix and changelog updated.
**Limitations**: None.
**Self-correction**: This is the self-correction cycle: spec-writer produced a spec with latent bugs -> verify-spec found them -> fixes applied. The plugin caught its own output within one iteration.

---

### 2026-04-17 -- generate-tasks

**Action**: Generated `docs/specs/performance-optimization-tasks.md` from the performance-optimization spec.
**Value**: Decomposed 6 spec tasks into 10 right-sized tasks with file conflict matrix, dependency graph, and 5 execution phases (max parallelism: 3). Split T3 into T3a/T3b/T3c and T6 into T6a/T6b/T6c by concern. Surfaced hidden serialization constraints (T3b and T6b both touch src/cli.ts).
**Limitations**: None.
**Self-correction**: N/A.

---

### 2026-04-17 -- performance-analysis (v2, post-optimization)

**Action**: Measured performance after implementing all 10 optimization tasks. Produced `docs/specs/performance-analysis-v2.md`.
**Value**: Quantified every bottleneck fix with before/after numbers. Key results: `status --format menubar` 2500ms -> 597ms (76% faster), bash regex eliminated (171ms -> 0ms), JSON.parse halved (138ms -> 66ms), cache hit cost 343ms -> 0ms. Identified two unmet spec targets: `status --format json` still 589ms vs 400ms target, RSS 185MB vs 100MB target. Explained the remaining gap (full-month JSON.parse is the floor).
**Limitations**: Could not measure before/after on the same dataset - data volume grew from 18 to 21 projects between measurements.
**Self-correction**: N/A.

---

### 2026-04-17 -- code-review (performance-optimization implementation)

**Action**: Five-axis review of all implementation changes from the performance-optimization tasks (166 lines of logic, 7 source files, 16 new tests).
**Value**: Found 2 HIGH findings, 2 MEDIUM, 3 LOW/NIT. Key bug: menubar provider cost over-counts when a project has mixed providers (H1) -- the rewrite from per-provider `parseAllSessions` to `filterProjectsByDateRange` broke provider cost attribution by attributing full project cost to each provider that appears. Also found a fragility in H2 (non-user entries without timestamps silently dropped). Duplicate `filterProjectsByDateRange` call at cli.ts:129,132 (M2). Verdict: APPROVE with comments -- H1 must be fixed before merge.
**Limitations**: Did not run the menubar format to visually verify the provider cost bug in practice.
**Self-correction**: N/A.

---

### 2026-04-17 -- create-pr

**Action**: Generated `gh pr create` command for `fix/performance-optimization`. Fixed H1 (menubar provider cost over-count: was using `proj.totalCostUSD` for all providers, now sums per-provider `assistantCalls`) and M2 (duplicate `filterProjectsByDateRange` call) before committing. Two commits: implementation+tests, then docs+journal. All 56 tests pass.
**Value**: Caught uncommitted changes before PR creation. Fixed H1 correctness bug. Produced filled PR description with before/after performance table and conventional commit title.
**Limitations**: Branch must be pushed before `gh pr create` runs (`git push -u origin fix/performance-optimization`).
**Self-correction**: N/A.

---

### 2026-04-17 -- implement (performance-optimization tasks)

**Action**: Implemented all 10 tasks from the performance-optimization task breakdown across 5 phases.
**Value**: All 8 spec requirements (R1-R8) implemented. Key changes: discovery caching in `providers/index.ts` (T1), `loadCurrency()` moved out of preAction hook (T2), `filterProjectsByDateRange` reusing `buildSessionSummary` for correct aggregates (T3a), widen-then-filter in status/export commands (T3b), JSONL streaming via readline (T4), `extractTimestampFromLine` date pre-filter before JSON.parse (T5a), `ParseOptions` with conditional bash extraction threaded through all call sites (T6a/T6b). Wrote 16 new tests across 3 files covering filter logic, timestamp extraction, and discovery cache. All 56 tests pass.
**Limitations**: Did not measure actual wall-clock improvement (spec targets: `status --format json` under 400ms, RSS under 100MB) -- would require before/after benchmarking on a machine with real session data at scale.
**Self-correction**: N/A.
---

## 2026-04-17 -- generate-spec (performance-optimization-v2)

**Action**: Multi-agent spec generation for Phase 2 performance optimization. Tier 2 (Feature) classification. 2-round interview (9 questions, 7 binding decisions). Researcher explored codebase. 2 parallel spec writers (simplicity lens + defensive lens). Codebase-blind evaluator scored both (57/90 vs 72/90). Consolidator merged into `docs/specs/performance-optimization-v2/` (6 files, 14 requirements, 20 ACs, 10 constraints, 9 design decisions).
**Value**: The multi-agent divergence caught critical gaps. Writer A (simplicity) had zero corruption handling, zero concurrent access protection, and no schema upgrade path. Writer B (defensive) caught all three but deviated from the interview measurement method (warmup-2/runs-10 instead of median-of-3). The evaluator identified 6 gaps both specs missed (cache observability, size bounds, directory creation, build-failure policy, baseline documentation, code-path constraint). The consolidated spec addresses all of them. The codebase research revealed `cursor-cache.ts` as an existing precedent for the mtime+size pattern, grounding the design decisions in existing code rather than invention.
**Limitations**: Consolidator missed 2 of 6 output files (constraints.md, traceability.md); had to be written manually. Total agent cost was high (5 agents, ~170K tokens across all).
**Self-correction**: Evaluator caught Spec B's measurement method deviation from interview decision D-PERF-1. Consolidated spec corrected to median-of-3. Evaluator also flagged Spec B's AC16 ("RSS drops after GC") as untestable; it was dropped from the final spec.

---

## 2026-04-17 -- spec-evaluator (performance-optimization-v2 review)

**Action**: Codebase-blind evaluator reviewed the consolidated spec at `docs/specs/performance-optimization-v2/`. Scored 63/100 across 10 dimensions. Found 6 blocking issues, 8 non-blocking. Applied all fixes, bumping spec to v1.1.0.
**Value**: Caught AC20 misassignment (mapped to R6 but tested perf ratio -- traceability broken), R5 with zero ACs, all 4 performance ACs non-deterministic ("Phase 1 baseline machine" undefined), D-BENCH-1 with no backing requirement, C7 (WAL/concurrent access) specifying 3 behaviors with zero tests, and a contradiction between "required dependency" and "graceful degradation." Fixes added R15 (benchmark suite), 8 new ACs (AC8, AC19-AC25), C10 (dep model clarification), and concrete benchmark thresholds. Also caught row-level data corruption gap (malformed summary_json in valid db) that both original writers missed.
**Limitations**: Evaluator is codebase-blind by design, so it could not verify that the spec's function signatures match the existing codebase patterns. The consolidator agent also missed 2 of 6 output files (constraints.md, traceability.md) which had to be written manually.
**Self-correction**: The evaluator caught the consolidator's traceability error (AC20 misassignment). The generate-spec pipeline produced a 63/100 spec on first pass; the evaluation+fix cycle raised it to address all blocking issues. This is the designed self-correction loop working as intended.

---

## 2026-04-17 -- generate-tasks (performance-optimization-v2)

**Action**: Generated `docs/specs/performance-optimization-v2/tasks.md` from the Phase 2 spec (15 requirements, 25 ACs, 11 constraints).
**Value**: Decomposed into 10 tasks across 5 groups (3 parallel groups, 2 sequential). File conflict matrix identified `src/parser.ts` as the serialization bottleneck (T3, T4, T5 must be sequential). T1 (cache module) and T7 (benchmark fixtures) are fully parallel with no shared files. Max parallel agents: 3. Total estimated effort: 18h. All 15 requirements traced; no orphan tasks. All 11 constraints mapped to covering tasks.
**Limitations**: None.
**Self-correction**: N/A.

---

## 2026-04-17 -- implement (performance-optimization-v2)

**Action**: Implemented all 10 tasks from the Phase 2 task breakdown (Epic + Parallel tier). Created `src/session-cache.ts`, integrated cache into `src/parser.ts`, zeroed `userMessage` in both parse paths, added 5 benchmark JSONL fixtures (510 lines), `vitest.config.ts` to exclude bench files, and 18 new tests across 2 new test files. Opened PR gosswi/codeburn#72.
**Value**: All 15 requirements implemented. Notable design decision during implementation: cache is keyed by `file_path + mtime_ms + file_size` only (no dateRange). Initial implementation skipped cache when `dateRange` was set to avoid caching partial results, but this caused 0 cache hits for the `status` command (which always passes `dateRange`). Fix: always cache the full unfiltered session, apply dateRange filter after cache read. This allows any dateRange query to benefit from warm cache. Warm cache result: `status --format json` 370ms median (target <400ms), RSS ~86MB (target <100MB), 74/74 tests pass.
**Limitations**: `better-sqlite3` was in `optionalDependencies` in `package.json` but C10 required `dependencies` -- caught during spec binding, fixed before first commit.
**Self-correction**: The `!dateRange` cache guard was a correctness-motivated design choice that made the performance target unreachable. Diagnosed during T10 verification (0 cache hits observed via DEBUG logging), root cause traced to how `status` calls `parseAllSessions`, fixed by restructuring to cache-full-then-filter.

---
