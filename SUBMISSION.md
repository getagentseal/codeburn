# Submission Statement

## Proposed title

Fix TUI refresh stability, scrolling, and responsive dashboard layout

## Summary

- Keep the active Optimize view mounted during background refreshes, prevent loading-frame flashes, and limit automatic data refreshes to no more than once per minute.
- Pin the dashboard to the top of a terminal-sized viewport, support line and page scrolling across the full application, and preserve the scroll position through refreshes and resize rerenders.
- Render dashboard panels in a stable 3/2/1-column order, with left-aligned bars, justified metric columns, readable headings, and ten visible Daily Activity rows.
- Spell out the project `session` heading and render full model costs whenever the panel has enough space.
- Reflow on the first resize frame at the 135/134 and 90/89 breakpoints, preserve the dashboard above 256 terminal columns, and cap its width at the lesser of 256 columns or the current data's renderable width.

## Testing

- Ghostty: tested real CodeBurn data at 135, 134, 90, 89, 256, 300, and 342 columns.
- Dashboard suite: 39 tests passed, including one-, two-, and three-column viewport scrolling.
- Typecheck: `npx tsc --noEmit` passed.
- Production build: `npm run build` passed.
- Live PTY: at 160 columns, Page Down revealed the lower panels and Page Up restored the pinned header.
- Diff hygiene: `git diff --check` passed.
- Full suite: 2,495 tests passed. The run retains two unrelated Copilot parser failures, one unrelated durable-total parity failure, and 26 missing-`jsdom` environment errors.

## Evidence

Live Ghostty captures verify immediate 3→2 and 2→1 breakpoint reflow and a populated, capped dashboard at 342 columns. Attach `live-controlled-boundaries-contact-sheet.png` to the pull request.
