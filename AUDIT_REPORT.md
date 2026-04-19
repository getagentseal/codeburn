# CodeBurn Audit Report (1.0.0)

Generated: 2026-04-19Branch: feat/auggie-only

## Executive Summary

CodeBurn 1.0.0 is in excellent health. The audit found 0 critical or high-severity issues. All 172 tests pass (168 TypeScript, 4 Swift), TypeScript type-checks cleanly, and npm audit reports 0 vulnerabilities across 178 dependencies. Two medium-severity performance findings relate to missing fetch timeouts in currency.ts and models.ts. The codebase follows defense-in-depth patterns throughout: symlink rejection, size caps on reads, regex allowlists for shell arguments, and prototype pollution guards.

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 6 |
| Info | 4 |

## Scope and Methodology

**Scope:** TypeScript CLI (src/), Vitest test suite (tests/), macOS menubar app (mac/), CI workflows (.github/workflows/)

**Methodology:**

1. Repository layout analysis and dependency audit
2. Full test suite execution (Vitest + Swift Testing)
3. TypeScript type-check (tsc --noEmit)
4. Security pattern search (hardcoded secrets, TLS bypass, bracket-assign, JSON.parse validation)
5. Performance review (sync I/O, unbounded reads, missing timeouts, cache eviction)
6. npm audit for dependency vulnerabilities

## Discovery

### Repository Layout

```
codeburn/
├── src/                    # TypeScript source (23 files)
│   ├── cli.ts              # CLI entry point (Commander.js)
│   ├── dashboard.tsx       # Ink/React TUI
│   ├── providers/          # Provider implementations
│   └── [other modules]
├── tests/                  # Vitest test suite (15 files)
│   ├── security/           # Security-focused tests
│   └── providers/          # Provider tests
├── mac/                    # macOS menubar app (Swift)
│   ├── Sources/CodeBurnMenubar/
│   │   ├── Security/       # SafeFile, CodeburnCLI
│   │   └── Data/           # DataClient, SubscriptionClient
│   └── Tests/
└── .github/workflows/      # CI configuration
```

### Key Entry Points

| Entry | File | Description |
| --- | --- | --- |
| CLI | src/cli.ts | Commander.js binary |
| Dashboard | src/dashboard.tsx | Ink/React TUI |
| Mac App | mac/Sources/CodeBurnMenubar/CodeBurnApp.swift | SwiftUI menubar |

### Version Requirements

- Node.js >= 22
- Swift 6.0
- macOS >= 14

## Test Coverage

**TypeScript (Vitest):** 168 tests, 15 files, 773ms**Swift (swift test):** 4 tests, 1 suite

**Total:** 172 tests passing, 0 failed, 0 skipped

### Test Categories

| Category | Tests | Coverage |
| --- | --- | --- |
| Security (installer, prototype pollution) | 21 | Host allowlist, SHA-256 verify, pollution guards |
| Provider (auggie) | 9 | Discovery, parsing, model aliasing |
| Export | 2 | CSV injection, symlink rejection |
| Dashboard | 4 | Top-5 selection, avg/session |
| Menubar JSON | 16 | Payload schema, rate calculations |
| Optimize | 11 | Bash bloat, JSONL scanning |
| Cache/FS | 16 | Daily cache, file streaming |
| Other | 93 | Bash commands, currency, etc. |

**Skipped/TODO:** None found

## Security Findings

| Location | Severity | Issue | Status |
| --- | --- | --- | --- |
| - | - | No hardcoded tokens/keys | OK |
| - | - | No TLS bypass patterns | OK |
| - | - | No token/session logging | OK |
| src/menubar-installer.ts | L | Uses spawn (not exec) | OK - no shell interpretation |
| src/providers/auggie.ts:97 | L | AUGMENT_HOME env override | OK - expected behavior |
| src/providers/auggie.ts:350 | L | Excludes session.json by name | OK - defense in depth |
| mac/Security/SafeFile.swift | - | lstat + symlink rejection | OK |
| mac/Security/CodeburnCLI.swift | - | Regex allowlist for argv | OK |
| All JSON.parse calls | - | try/catch + structure validation | OK |

**session.json Protection:** The CLI never reads credentials. The Mac app uses SafeFile.read() with symlink rejection and 64KB size limit.

## Performance and Stability Findings

| Location | Severity | Issue | Recommendation |
| --- | --- | --- | --- |
| src/currency.ts:66 | M | fetch() without timeout | Add AbortSignal.timeout(10000) |
| src/models.ts:77 | M | fetch() without timeout | Add AbortSignal.timeout(10000) |
| src/fs-utils.ts:53 | L | Sync fs in readSessionFileSync | Only used in tests |
| src/optimize.ts:3 | L | existsSync, statSync | Only used in optimize scans |
| src/cli.ts | L | No unhandledRejection handler | Consider adding for cleaner errors |

### Resource Caps

| File | Limit |
| --- | --- |
| src/fs-utils.ts | MAX_SESSION_FILE_BYTES = 128MB |
| mac/DataClient.swift | maxPayloadBytes = 20MB |
| mac/DataClient.swift | Per-array caps on decoded payload |

### Cache TTLs

| Cache | Strategy |
| --- | --- |
| currency.ts | 24h TTL |
| models.ts | 24h TTL |
| daily-cache.ts | ~365KB max (no eviction needed) |
| AppStore.swift | 5min TTL per period |

## Improvement Plan

### High Impact / Low Effort

| Issue | Branch | Effort |
| --- | --- | --- |
| Add fetch timeout to currency.ts | audit/performance-improvements | 1 line |
| Add fetch timeout to models.ts | audit/performance-improvements | 1 line |

### Medium Impact / Low Effort

| Issue | Branch | Effort |
| --- | --- | --- |
| Add unhandledRejection handler | audit/performance-improvements | 5 lines |

### Low Impact / Informational

| Issue | Branch | Notes |
| --- | --- | --- |
| Sync fs usage in tests | audit/test-coverage | Acceptable for fixtures |
| Sync fs in optimize.ts | - | Non-hot path, acceptable |

### Test Coverage Improvements

| Target | Branch | Notes |
| --- | --- | --- |
| CLI integration tests | audit/test-coverage | E2E for report, today, month |
| Mac app unit tests | audit/test-coverage | Expand beyond DataClient bounds |

## Appendix: Raw Test Output

```
RUN  v3.2.4 /Users/jaydave/intent/workspaces/immense-tyrannosaurus/codeburn

 Test Files  15 passed (15)
      Tests  168 passed (168)
   Start at  12:20:40
   Duration  773ms

Swift Tests:
 Test run with 4 tests in 1 suite passed after 0.001 seconds.
```

## Appendix: npm audit

```json
{
  "vulnerabilities": {
    "critical": 0,
    "high": 0,
    "moderate": 0,
    "low": 0,
    "total": 0
  },
  "dependencies": {
    "prod": 42,
    "dev": 137,
    "optional": 52,
    "total": 178
  }
}
```