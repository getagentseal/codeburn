# Implementation Notes

## 2026-06-23 CodeBurn Menubar Restore Verification

- Scope: restore and verify the existing native macOS menubar path and Codex
  data contract; no duplicate widget, fake data source, release tag, or installed
  app replacement is in scope.
- Evidence plan: compare `codeburn status --format menubar-json` for Today,
  Last 7 Days, Month, and Codex-specific payloads against the macOS smoke
  `report.json`; record the screenshot path and data table in
  `docs/verification/codeburn-restore-verification.md`.
- Workflow note: the source branch was already dirty before this continuation,
  so this worktree stages only task-relevant CodeBurn source, tests, and
  verification docs after checks.

## 2026-06-11 Codex Live Token Refresh Window

- Root cause: active Codex chats can update `~/.codex/state_5.sqlite`
  `threads.tokens_used` before the JSONL parser sees the same latest usage, so
  Chats could display stale token totals even while the Codex state database was
  already current.
- Fix: Codex Chats now uses fresh sqlite `tokens_used` as a display-only total
  when the thread row was updated within the last five minutes and the sqlite
  value is higher than the parsed JSONL total.
- Menubar cadence: the background payload refresh interval is now five minutes;
  manual refresh, wake recovery, and settings-triggered refreshes still bypass
  that passive timer.
- Scope: displayed input/total token counters only; API-equivalent cost,
  subscription cost, calls, and parsed session spend remain based on parsed
  provider calls.
- Stale guard: sqlite rows older than five minutes are ignored for live token
  replacement, so historical chats keep the parser-derived totals.

## 2026-06-11 Codex Reasoning Token Totals

- Root cause: Codex parsing preserved `reasoningTokens` on individual provider calls and used them for pricing, but `SessionSummary`, menubar top-project totals, Codex Chats totals, and CLI session JSON totals did not include reasoning in their displayed `totalTokens`.
- Fix: session summaries now carry `totalReasoningTokens`; model breakdowns preserve reasoning/cached/web-search counters; menubar/Chats/CLI JSON expose `reasoningTokens` separately and include it in `totalTokens`.
- Compatibility: aggregation uses `?? 0` for `totalReasoningTokens` so older in-memory fixtures or historical summaries without the new field do not produce `NaN`.
- Scope: token reporting only; API-equivalent/subscription cost logic and Codex `token_count` parsing/dedup semantics are unchanged.

## 2026-06-11 CodeBurn Chats Time Window

- Root cause: the menubar passed `--chat-hours`, but `buildMenubarPayloadForRange`
  parsed Codex with a turn-level `chatRange`, so Chats was not selecting whole
  chats by their last message timestamp.
- Fix: `buildCodexChatsReport` now filters parsed Codex sessions by
  `session.lastTimestamp` and sqlite-only rows by `threads.updated_at`; the
  payload builder feeds it the full Codex session set so tokens, cost, calls,
  input/output/cache totals all recalculate from the chats included in the
  selected 24h/48h/3d/7d window.
- Follow-up after live testing: the standalone `codeburn chats` command had the
  same range-parse bug and now also parses the full Codex session set before
  filtering by last message time.
- Smoke coverage: menubar smoke can now set `CODEBURN_MENUBAR_SMOKE_CHAT_WINDOW`
  and writes chat hours, chats, calls, cost, and token totals into `report.json`.
- Scope: CLI/menubar JSON aggregation only; Swift UI and public payload shape
  remain unchanged.

## 2026-06-10 CodeBurn Chats Cleanup

- Assumption: user confirmation "исправляй" applied to the cleanup candidates reported after the Chats smoke verification.
- Deleted only the six previously inventoried untracked cleanup paths: .tmp_worktree_write_test, _from_allowed.txt, tmp-write-test, and three mac/Sources/CodeBurnMenubar/**/.codex-backups directories.
- Kept code changes additive: no tracked source files were reverted while cleaning untracked diagnostics/backups.
- Verification target: git status should no longer list those cleanup candidates; existing CodeBurn functional changes remain for review.
## 2026-06-10 Installed App Update

- Root cause after user report: source and local smoke were fixed, but the real installed CLI was still /Users/vadimirrosman/.bun/bin/codeburn -> /Users/vadimirrosman/.local/bin/codeburn at version 0.9.11, and the running menubar app was /Users/vadimirrosman/Applications/CodeBurnMenubar.app.
- Installed the local CodeBurn package into the existing ~/.local global prefix; installed CLI now reports 0.9.12.
- Universal package script could not run because xcbuild is missing; used swift build -c release for the current machine and replaced the installed app executable.
- Backed up the previous installed app to /Users/vadimirrosman/Applications/codex-backups/CodeBurnMenubar.app.20260610145515.bak before replacement.
- Re-signed the installed app ad-hoc, ran installed-app smoke with CODEBURN_MENUBAR_SMOKE_INSIGHT=Chats, and reopened the app.
- Installed-app smoke result: selectedInsight Chats, chatDuplicateProjectNames empty, four project rows, screenshot /tmp/codeburn-installed-smoke-chats/popover-today-chats.png shows v0.9.12 and visible Baza/chat titles.
- After installed smoke, relaunched /Users/vadimirrosman/Applications/CodeBurnMenubar.app without smoke environment; pgrep confirmed the normal menubar process is running.
