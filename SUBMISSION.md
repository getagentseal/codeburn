# Submission Statement

## Proposed title

Stabilize TUI refresh, scrolling, responsive layout, and dashboard data density

## Summary

This pull request repairs the terminal dashboard as one coherent rendering surface. Background refresh no longer replaces the active Optimize view or resets the viewport. The full application can scroll. The eight dashboard panels retain their order while reflowing through one, two, and three columns. Metric headings and values remain visible before labels are shortened, and Daily Activity grows to match the relevant neighboring panels.

The branch is rebased on upstream `main` at `2c3319b`. The implementation reuses Ink and the existing dashboard state rather than adding a dependency or a second layout engine.

## Maintainer review reconciliation

The maintainer review identified a Windows ConPTY risk in the branch's custom synchronized-update write. A maintainer supplied a narrower escape-chunk fix in `7716f95`; this reconciliation preserves its intended Windows safety while removing the application-owned terminal protocol entirely:

- `src/ink-win.ts` is restored to the upstream implementation.
- The dashboard emits no manual begin/end synchronized-update sequence and no manual clear-and-home write.
- Ink remains the sole owner of terminal synchronization.
- CodeBurn's prepended resize handler only captures the new column count and rerenders React before Ink's ordinary resize listener paints.

This removes the reviewed ConPTY failure path instead of maintaining another platform-specific escape protocol. The Windows filter was checked with a mocked `win32` source-path test, and the pull request's AppX job remains the authoritative Windows package gate because no physical Windows host was available locally.

The same reconciliation restored the existing heavy-period refresh policy and made the CLI help truthful: Today, 7 Days, and concrete-day views may refresh automatically; 30 Days, Month, All, and Lifetime remain static between deliberate navigation changes. Every enabled interval is clamped to at least 60 seconds, and `--refresh 0` disables it.

## User-visible behavior

### Stable refresh and navigation

- A background result cannot replace the Optimize view after the user enters it.
- Background work retains the current frame instead of replacing it with a loading or blank screen.
- Refresh and resize rerenders preserve the application scroll offset.
- Up and down move one application row, Page Up and Page Down move one viewport, and Home and End jump to the bounds.
- Deliberate navigation to a different view, period, provider, or day begins at the top.

### Responsive dashboard

- The eight panels retain source order through one column at 89 characters or fewer, two columns from 90 through 134, and three columns from 135 upward.
- Three-column rows use the requested 3/3/2 arrangement.
- All three panels in a row widen equally by one character for every three additional terminal characters.
- Growth stops at the lesser of 256 characters or the widest row the current source data can render.
- Windows wider than 256 characters retain a populated capped dashboard.
- Colored bars remain at the left edge of every data section; Daily Activity places its bar before the date.

### Complete, compact data rows

- Metric widths are derived from their full headings and rendered values.
- Adjacent metric cells use exactly one separating character.
- `Tok/s` and every other metric column always render; unavailable values display `-`.
- Costs, including the estimated-cost `~` marker, render in full whenever the panel can hold them.
- The project heading spells out `session`.
- Project labels yield space before any heading or metric. Shortening removes the parent-folder prefix first, then the year in a date folder, and only then truncates the project title with a macOS-style ellipsis.

### Adaptive Daily Activity history

- One-column layout displays 10 dates.
- Two-column layout displays `MAX(10, visible By Project rows)`.
- Three-column layout displays `MAX(10, visible By Project rows, visible By Activity rows)`.
- Day mode remains one date, and available history remains the upper bound.
- Rendering, `j`/`k`, Space paging, `g`/`G`, final-page clamping, and the `Showing X-Y of Z` status share the same page-size calculation.
- By Activity row counting and rendering share the same aggregation, so the calculated height cannot drift from the displayed panel.

## TDDRGR and post-implementation bug-fix rounds

The adaptive-row contract first failed for the intended reason: a two-column lifetime fixture with 14 visible projects rendered 10 dates. The smallest production change introduced one shared page-size calculation. After the first green run, the refactor reused the existing project-row limit and Activity aggregation, and the focused contract stayed green.

The maintainer reconciliation also began red. Tests proved that the maintainer head still contained application-owned synchronized writes, scheduled refreshes for four heavy periods, and advertised a 30-second interval in three CLI help surfaces. Removing the writes, restoring the period gate, and updating the help produced 59 passing focused tests.

Dedicated bug-fix rounds then repeated the relevant regression checks and real user path:

1. Daily Activity paging and bounds used the calculated 10/14/18-row sizes.
2. Full-application End scrolling remained at the bottom after a live 89-to-100-column resize.
3. Optimize remained mounted across live 100-to-89-column reflow, while its fake-timer refresh regression retained the view with no loading frame.
4. An unsuccessful `incrementalRendering` experiment was removed after measurement showed no improvement; the smaller Ink-owned design remained.

Correctness review found no issue in the final production diff. Ponytail review concluded: `Lean already. Ship.`

## Validation

### Deterministic and build gates

- Focused refresh, resize, layout, scrolling, metric, and CLI-help matrix: **59/59**.
- Relevant dashboard, model, overview, and CLI-help matrix: **72/72**.
- Complete dashboard suite: **56/56**.
- Desktop application suite: **462/462**.
- Root `tests/` suite: **2,481 passed**, **3 failed**, and **5 skipped**. The same three failures reproduce at unmodified upstream `2c3319b`: two Copilot durable-orphan assertions and one provider-filter durable-total assertion. None touches this dashboard diff.
- TypeScript checks for the CLI and desktop application: passed.
- CLI, browser dashboard, and desktop application production builds: passed. The existing Vite warning for a browser chunk above 500 KB is unchanged.
- `git diff --check`: passed.

Running root Vitest without limiting it to `tests/` also discovers the nested desktop tests under the root configuration. That unsupported combined invocation lacks the desktop setup and produces matcher/environment failures; the canonical desktop command above passes all 462 tests.

### Native Ghostty inspection

- **241** deterministic width frames from 60 through 300 columns confirmed the 89/90 and 134/135 breakpoints, symmetric three-column growth, the 256-character cap, and populated frames above the cap.
- **40** window-bounded Ghostty captures covered two font zoom levels, multiple window shapes, top, scrolled, and Optimize states, with most captures below 260 columns as requested.
- **105** final settled captures shrank one column at a time from 146 through 42. All contained rendered content; no settled frame was blank.
- **20** repeated 120-to-110-column shrink cycles rendered successfully.
- Final live screenshots confirmed scroll-position preservation across a one-to-two-column resize and Optimize preservation across the reverse breakpoint.

All visual evidence used the Ghostty window ID with native `screencapture -l`; no full-display capture and no Computer Use session was used. The user's Ghostty shell was returned to its original `~` prompt, size, and position after validation.

## Deliberate non-changes

- Compare keeps its existing two-column composition; redesigning it is outside this dashboard repair.
- The status/help bar remains part of the scrollable content, as requested during review.
- Existing aggregation memoization and viewport-measurement behavior remain unchanged where the accepted design did not require them.

## Reviewer focus

The highest-value review is the interaction among the shared metric row, the calculated Daily Activity page size, and existing scroll state. Acceptance requires that background refresh never changes the active view or position, supported widths never lose a metric, each settled resize preserves panel order and content, and Daily Activity navigation uses the same page size shown on screen.
