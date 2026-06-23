# CodeBurn Restore Verification

Date: 2026-06-23
Branch: `codex/please-implement-this-plan-codeburn`
Repo: `/Users/vadimirrosman/.codex/worktrees/codeburn/codex-please-implement-this-plan-codeburn`

## Scope

- Restore and verify the existing native macOS CodeBurn menubar indicator.
- Verify real Codex token data through the existing CLI contract:
  `codeburn status --format menubar-json`.
- Do not add a duplicate widget, fake data, release tag, `npm publish`, or
  installed app replacement.

## Data Checks

CLI data check was run against `node dist/cli.js status --format menubar-json
--no-optimize` after `npm run build`.

| Payload | Label | Calls | Cost USD | Input tokens | Output tokens | Codex chats | Codex chat tokens | Status |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Today | Today (2026-06-23) | 4 | 7.633333333333333 | 123728 | 23815 | 6 | 19065473 | finite, non-empty |
| Last 7 Days | Last 7 Days | 144 | 61.066666666666634 | 1095704 | 115595 | 6 | 19065473 | finite, non-empty |
| Month | June 2026 | 144 | 175.56666666666666 | 1095704 | 115595 | 6 | 19065473 | finite, non-empty |
| Codex Today | Today (2026-06-23) | 4 | 7.633333333333333 | 123728 | 23815 | 6 | 19065473 | finite, non-empty |

Codex chat totals are read from `current.codexChats48h`, which reported
`totalChats: 6`, `returnedChats: 6`, `totals.totalTokens: 19065473`, and an
empty duplicate project list in the smoke report.

## Automated Checks

| Check | Command | Result |
|---|---|---|
| Targeted tests | `npm test -- tests/menubar-json.test.ts tests/providers/codex.test.ts tests/usage-aggregator.test.ts tests/minimax.test.ts` | Passed: 48 tests |
| Full tests | `npx vitest --testTimeout 30000` | Passed: 89 files, 1173 tests |
| Build | `npm run build` | Passed |
| Swift build | `cd mac && swift build` | Passed |
| Swift tests | `cd mac && swift test` | Blocked locally: `no such module 'Testing'` |

## Menubar Smoke

Command: `CODEBURN_MENUBAR_SMOKE_OUTPUT=... mac/Scripts/smoke-popover.sh`

The script wrote its own output directory:
`/tmp/codeburn-menubar-smoke-20260623-135827`.

| Smoke field | Value |
|---|---:|
| `ok` | `true` |
| `selectedProvider` | `All` |
| `selectedPeriod` | `Today` |
| `selectedInsight` | `Trend` |
| `currentCalls` | 4 |
| `currentInputTokens` | 123728 |
| `currentOutputTokens` | 23815 |
| `chatTotalChats` | 6 |
| `chatReturned` | 6 |
| `chatTotalTokens` | 19065473 |
| `chatDuplicateProjectNames` | `[]` |

Smoke screenshot:
`/tmp/codeburn-menubar-smoke-20260623-135827/popover-today-trend.png`.

## Pending Final Evidence

- `git diff --check`, staged diff review, commit, push, and deploy-status.
