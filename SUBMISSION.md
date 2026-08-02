# Submission Statement

## Proposed title

Stabilize TUI refresh, scrolling, responsive layout, and dashboard data density

## Summary

- Keep the active view and vertical position stable during background work, eliminate refresh blanking, and enforce a one-minute minimum automatic refresh interval.
- Make the complete dashboard scrollable and render its panels in a stable one-, two-, or three-column order, with immediate breakpoint reflow and a safe width cap.
- Preserve every metric and its heading, shorten project paths in meaningful stages, and size Daily Activity to the tallest relevant sibling panel without weakening navigation or day mode.

## Why the dashboard failed

Three independent behaviors combined into the visible failures. A background result could replace state after the user had entered Optimize. Ink could paint once with the previous terminal width before React received a resize. Because the alternate screen removed terminal scrollback, content taller than the viewport became unreachable. At narrow widths, the shared row renderer also gave labels enough space to displace metric headings or values.

The repair keeps view, width, viewport, and row-density decisions inside the existing dashboard state and rendering path. It adds no dependency or parallel layout system.

## User-visible behavior

### Stable refresh and navigation

- Optimize remains mounted when dashboard data refreshes in the background.
- Automatic data refresh runs no more than once per minute; `--refresh 0` remains fully static.
- Background work keeps the current frame visible instead of showing a loading or blank frame.
- Refresh and resize rerenders preserve the application scroll offset.
- Up and down move one application row, Page Up and Page Down move one viewport, and Home and End jump to the bounds.
- Deliberate navigation to another view, period, provider, or day begins at the top.

### Responsive dashboard

- The eight panels retain source order in every layout: one column through 89 terminal columns, two columns from 90 through 134, and three columns from 135 upward.
- Three-column rows follow the standard 3/3/2 arrangement and grow symmetrically by one panel character for every three additional terminal characters.
- The dashboard stops growing at the lesser of 256 terminal columns or the width the current data can usefully render.
- Resize state is captured before Ink's next paint, so 89/90 and 134/135 transitions do not show a stale intermediate arrangement.
- Terminals wider than 256 columns retain a populated dashboard rather than clearing the frame.
- Colored bars remain at the left edge of every data section; Daily Activity places its bar before the date.

### Complete, compact data rows

- Metric widths come from their headings and rendered values. Adjacent metric cells use exactly one column of separation.
- `Tok/s` and every other metric column always render. Unavailable values display `-` instead of removing a column.
- Costs, including the estimated-cost `~` marker, render in full whenever the panel can hold them.
- The project heading spells out `session`.
- Project labels yield space before any heading or metric does. Shortening removes the folder prefix first, then the year in a date folder, and only then truncates the project title with a macOS-style ellipsis.

### Adaptive Daily Activity history

- One-column layout displays 10 dates.
- Two-column layout displays `MAX(10, visible By Project rows)`.
- Three-column layout displays `MAX(10, visible By Project rows, visible By Activity rows)`.
- Day mode remains one date, and available history remains the upper bound.
- The same calculated page size controls rendering, `j`/`k`, Space paging, `g`/`G`, final-page clamping, and the `Showing X-Y of Z` status.
- By Activity row counting and rendering share the same aggregation, preventing the calculated Daily Activity height from drifting away from the panel it matches.

## TDDRGR and bug-fix rounds

The adaptive-row regression first failed for the intended behavioral reason: a two-column lifetime view with 14 visible projects rendered 10 dates instead of 14. The smallest production change introduced one shared page-size calculation. After the test passed, existing project-row limits and Activity aggregation were reused rather than duplicated, and the focused tests remained green.

Two post-implementation bug-fix rounds then exercised independent real user paths. After each round, the relevant 70-test regression matrix and live Ghostty path were rerun:

1. Two-column paging showed `1-14`, Space advanced to `15-28`, and `g` returned to `1-14`. Accessibility bounds confirmed the entire app frame when a native Ghostty layer capture omitted window chrome; the misleading partial captures were discarded.
2. Live resizing produced 10 rows in one column, 14 in two columns, and 18 in three columns. The 18-row result matched the rendered By Activity data. No new defect was found in either round.

Correctness review was clean. Ponytail review found the implementation already lean and did not recommend another abstraction.

## Validation

- Real-data Ghostty validation across one-, two-, and three-column layouts, breakpoint transitions, paging, scrolling, refresh preservation, and widths above 256 columns.
- Twenty window-bounded Ghostty views covering 73 through 283 terminal columns, followed by dedicated adaptive-row and post-fix captures.
- Focused Daily Activity tests: 9/9.
- Complete dashboard suite: 48/48.
- Relevant layout, model, and overview regression matrix: 70/70.
- TypeScript compilation, CLI production build, and browser dashboard build. The existing Vite warning for a JavaScript chunk above 500 KB remains unchanged.
- `git diff --check`.
- Installed CLI version/help smoke checks. The installed `dist/main.js`, `dist/cli.js`, and dashboard HTML hashes match the repository build.
- GitHub checks exercised by the pull request: Semgrep, co-author guard, Firstlook, and Windows package build.

In the full repository run, **2,507 tests passed**, **2 failed**, and **5 were skipped**, with **26 missing-`jsdom` environment errors**. Both failures are pre-existing Copilot durable-cache assertions in `tests/parser.test.ts`; they do not exercise this dashboard work. A durable-total assertion that failed in an earlier run passed in the final run.

Native Shift-Space could not be distinguished from Space in synthesized terminal input because both arrive as the same byte. Reverse page-cursor behavior remains covered deterministically, and `g` was validated in Ghostty as the reliable first-page return path.

## Reviewer focus

The highest-value review is the interaction among the shared row renderer, the calculated Daily Activity page size, and the existing scroll state. The acceptance criteria are that no view or scroll position changes because of background refresh, no metric disappears at supported widths, each resize immediately preserves panel order, and Daily Activity navigation uses the same page size shown on screen.
