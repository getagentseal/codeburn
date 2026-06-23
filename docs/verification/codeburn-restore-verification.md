# CodeBurn Menubar Restore Verification

Date: 2026-06-23
Branch: `codex/please-implement-this-plan-codeburn-rebased`

## Scope

Restore and verify the existing macOS menubar path without adding a second widget:

- preserve `codeburn status --format menubar-json`;
- keep Swift `MenubarPayload` backward-compatible;
- show real token/cost data in the menubar popover;
- prevent duplicate project rows when multiple sources resolve to the same project name.

## Data Checks

Run these commands after building:

```sh
npm run build
node dist/cli.js status --format menubar-json --period today --no-optimize
node dist/cli.js status --format menubar-json --period week --no-optimize
node dist/cli.js status --format menubar-json --period month --no-optimize
```

Expected:

- `current.cost`, `current.calls`, `current.inputTokens`, and `current.outputTokens` are numeric and not `NaN`;
- Codex-specific data appears through `current.providers.codex` and `current.codexCredits`;
- `current.topProjects` has no duplicate `name` values;
- each project row preserves `inputTokens`, `outputTokens`, `reasoningTokens`, cache token fields, and `totalTokens`.

## Smoke Check

```sh
CODEBURN_MENUBAR_SMOKE_OUTPUT=/tmp/codeburn-menubar-smoke mac/Scripts/smoke-popover.sh
```

Expected files:

- `/tmp/codeburn-menubar-smoke/report.json`;
- `/tmp/codeburn-menubar-smoke/popover-today-trend.png`.

Expected report values:

- `ok: true`;
- `selectedProvider: All`;
- `selectedPeriod: Today`;
- `currentCalls`, `currentInputTokens`, and `currentOutputTokens` are real numeric values;
- `topProjectDuplicateNames` is an empty array.

## Verification Log

Populate this table during final verification.

| Check | Result | Evidence |
| --- | --- | --- |
| Targeted tests | Pass | `npm test -- tests/menubar-json.test.ts tests/providers/codex.test.ts tests/usage-aggregator.test.ts`: 3 files, 38 tests passed |
| Full test suite | Pass with sequential rerun for known slow CLI tests | `npm test`: 102 files passed; 4 files timed out at 5000ms in parallel. `npx vitest tests/cli-export-date-range.test.ts tests/cli-json-daily.test.ts tests/cli-status-menubar.test.ts tests/parser-proxy-codex-only.test.ts --testTimeout 30000 --fileParallelism=false`: 4 files, 8 tests passed |
| Build | Pass | `npm run build`: passed; `openrouter skipped: fetch failed` and Vite chunk-size warning were non-fatal. Generated pricing snapshot drift was restored before commit |
| Swift build | Pass | `cd mac && swift build`: build complete |
| Swift tests | Blocked by local toolchain | `cd mac && swift test`: failed with `no such module 'Testing'` before exercising task changes |
| Menubar smoke | Pass | `mac/Scripts/smoke-popover.sh /Users/vadimirrosman/Documents/Codex/2026-06-23/new-chat-4/outputs/codeburn-menubar-smoke-rebased-20260623T1432Z`: `ok: true`, screenshot captured, `topProjectDuplicateNames: []` |
| CLI data check | Pass | `node dist/cli.js status --format menubar-json --period week --no-optimize`: cost `94.629252`, calls `138`, input `892306`, output `82204`, Codex credits `394.28855`, duplicate projects `[]`; `month` matched the same June 2026 data. `today` was valid but zero usage on 2026-06-23 |
| Final diff check | Pass | `git diff --check` |
