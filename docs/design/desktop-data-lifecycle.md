# Desktop data lifecycle

Status: implementation contract for the quality/performance epic. This document
describes product behavior; it does not change the meaning of CodeBurn totals.

## User contract

CodeBurn is useful before historical classification is complete. On every launch:

1. Paint the last exact snapshot for the selected view immediately, when one
   exists for the same period, provider, range, configuration and calendar
   boundary.
2. Revalidate that snapshot in the background. Do not replace usable content
   with a skeleton while refreshing.
3. On a true first run, make Today the first useful result. Continue historical
   work in this order: Today, 7 days, 30 days, month, 6 months, lifetime.
4. Warm the first-click reports for the selected period only, once, and only
   while the window is visible. Interactive requests always run ahead of that
   queue, and a finished warm is kept across poll cycles rather than redone.
5. Stop polling while the window is hidden, and catch up immediately when it
   comes back. Only the headline runs at the live cadence: `act report` refreshes
   every 10 minutes, `yield` every 5, and the optimize scan at most once a day
   per query scope, shown with the time it was computed. On battery the live
   interval doubles.

Historical results are durable. A renderer restart is not a cache miss. Today
and Month snapshot identities include the local calendar boundary, so yesterday's
answer is never painted beneath today's label. Custom ranges are exact-keyed.

## Visible states and copy

| State | Content | Status copy |
| --- | --- | --- |
| Exact snapshot, refreshing | Keep the full snapshot visible | No banner: the hairline under the top bar lights and the icon beside `refreshed Ns ago` spins |
| Progressive first index | Show the exact indexed subset | `Indexing history · X/Y files · You can keep using CodeBurn; totals update as indexing completes.` |
| Source refresh failed | Keep indexed content visible | `Some sources could not be refreshed. Showing indexed data; recent activity may be missing.` |
| First run, no usable subset yet | Skeleton for that destination only | Specific work copy such as `Scanning sessions…` |
| Refresh failed after success | Keep last-good content | Existing stale/error affordance beside the content |

`X/X` is not indexing progress. A stale payload and an active progressive index
are different states even when both carry `hydration.complete = false`.

## Snapshot custody

Renderer snapshots contain report output only, never credentials. They are:

- versioned and generation-invalidated after pricing, currency, alias or plan
  mutations;
- synchronously compressed before browser storage;
- bounded per entry and by a least-recently-written eviction cap;
- treated as stale-while-revalidate after every renderer restart;
- cleared when the snapshot generation is invalidated.

The compact Overview headline remains a separate fallback. It must never be
written under a newly selected period until that exact period resolves.

## Plans and Menu Bar capability contract

Provider visibility is not provider capability. The icon/catalog work may know
dozens of agent brands; a live quota card is allowed only when a tested adapter
exists.

The currently implemented live quota set is six providers on both surfaces:
Claude, Codex, Gemini, Copilot, Antigravity and Kimi. Desktop and Menu Bar use
the same underlying CLI/local sources. For CodeBurn-owned Keychain caches:

- Codex Desktop already reads the native Menu Bar cache
  `org.agentseal.codeburn.menubar.codex.oauth.v1` / `default`.
- Claude Desktop reads the native Menu Bar cache
  `org.agentseal.codeburn.menubar.claude.oauth.v1` / `default`, then falls back
  to Claude Code's own credential store.
- Tokens never cross renderer IPC and are never included in durable snapshots.

The native app deliberately requires a user-initiated Connect before reading a
credential source that can raise a macOS Keychain prompt. Therefore "automatic
bidirectional authentication" is not a truthful claim yet: Desktop can consume
the native CodeBurn caches, while a first native import still requires that one
explicit consent action. Removing it requires a shared native credential broker
and a security/privacy decision; it must not be implemented by putting secrets
in process arguments, renderer storage or a new plaintext file.

## Architectural follow-up

This change fixes the user-visible lifecycle without replacing the aggregation
engine. The broader constraint remains: Electron orchestrates several expensive
report commands and stores their rendered results. The durable end-state is one
incremental local index with explicit coverage watermarks, followed by cheap
queries for period/provider/view slices. That work is justified when measurements
show background warming still consumes material CPU or a selected uncached query
misses the interaction budget; it is not required to preserve the snapshot UX.

## Acceptance gates

- Restart with a heavy corpus: selected last-known content paints without a
  skeleton and a fresh request runs behind it.
- Leave the app covered longer than one configured cadence: return to a snapshot
  no older than the cadence plus one request duration.
- First-run queue order is deterministic and background-priority; a click jumps
  ahead of queued work.
- Today and Month never reuse a prior calendar-boundary snapshot.
- Every major destination has a warm snapshot after the background pass.
- Genuine progressive and stale-source payloads show different, accurate copy.
- No credential or bearer token appears in renderer storage or logs.
- Claude and Codex native Keychain cache reads are exact-service, read-only and
  covered by malformed/access-denied/fallback tests.
