# Submission Statement

## Proposed title

Fix TUI refresh stability and responsive dashboard layout

## Summary

- Keep the active Optimize view mounted during background refreshes, prevent loading-frame flashes, and limit automatic data refreshes to no more than once per minute.
- Render dashboard panels in a stable 3/2/1-column order, with left-aligned bars, justified metric columns, readable headings, and ten visible Daily Activity rows.
- Reflow on the first resize frame at the 135/134 and 90/89 breakpoints, preserve the dashboard above 256 terminal columns, and cap its width at the lesser of 256 columns or the current data's renderable width.

## Testing

- [x] Tested against real CodeBurn data in Ghostty at 135, 134, 90, 89, 256, 300, and 342 columns.
- [x] `npm test -- --run tests/dashboard.test.ts`: 36 tests passed.
- [x] `npx tsc --noEmit`
- [x] `npm run build:cli`
- [x] `git diff --check`
- [ ] `npm test`: the affected dashboard suite passes, but the full run retains two unrelated Copilot parser failures and 26 missing-`jsdom` environment errors. Five full-run timeout failures passed when rerun individually.
- [ ] `npm run build` was not run. The CLI production bundle succeeds with `npm run build:cli`.

## Evidence

Live Ghostty captures verify immediate 3→2 and 2→1 breakpoint reflow and a populated, capped dashboard at 342 columns. Attach `live-controlled-boundaries-contact-sheet.png` to the pull request.
