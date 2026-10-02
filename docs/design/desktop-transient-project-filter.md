# Desktop Transient Project Scope

**Status:** Approved design; implementation not started

**Date:** 2026-10-02

**Issue:** [#1585](https://github.com/getagentseal/codeburn/issues/1585)

## 1. Summary

CodeBurn Desktop will add a searchable, single-project selector beside the
provider selector in the top bar. The selector is a temporary report scope for
the current app session. It is not a replacement for the persistent Projects
settings.

`All projects` means the population permitted by the existing Settings
include/exclude filter. Selecting a project narrows that population to one
canonical project identity. The exact narrowing must happen before each report
aggregates its data.

This is a Desktop-only feature. Electron will use a hidden, exact-project
argument when invoking the local CodeBurn CLI. That argument is internal
Desktop plumbing and is not a new documented end-user CLI workflow.

## 2. Issue Evaluation

Issue #1585 is a valid cross-cutting feature request rather than a top-bar-only
UI change.

The repository already provides useful foundations:

- `TopBar` owns period, custom-range, provider, and Back/Forward controls.
- `AppMain` owns the app-level report query and passes it to each report
  section.
- Electron's main process reads the persistent project filter and adds its
  `--project`/`--exclude` arguments to report invocations.
- Reports aggregate in the CLI, while the renderer remains a view layer.
- Spend, cohort, branch, and session-contribution contracts already carry
  canonical project identity in some paths.
- Compare Periods already applies the persistent project filter to both ranges.

The current implementation cannot safely satisfy the issue by reusing those
pieces unchanged:

- Existing `--project` matching is intentionally rooted/substring matching;
  an absolute path can include descendants and a label can include siblings.
- The existing exact `--project-id` option is limited to cohort Compare and has
  a separate public meaning.
- Project scope is not part of all report bridge signatures or memo keys.
- Historical daily-cache data may outlive the source session files and cannot
  be selected safely unless its project identity is retained exactly.
- Combined-device payloads do not carry reliable local project identity.
- Some report paths need range/provider propagation and some Optimize/action
  data is global rather than project-attributable.

The feature therefore requires one exact project-scope contract across the
Desktop bridge, CLI report paths, durable history, and renderer cache
identities.

## 3. Goals And Non-goals

### Goals

- Let a developer inspect exactly one project without changing persistent
  Settings visibility.
- Apply the selection consistently to Overview, Sessions, Pull Requests,
  Spend, Models, Optimize, Compare, and Compare Periods.
- Intersect project, provider, period, and custom-date filters.
- Apply the same project scope to both ranges in Compare Periods.
- Preserve the selection through supported navigation, provider/period changes,
  custom ranges, and Back/Forward.
- Reset the selection to `All projects` when the app restarts.
- Prevent an unscoped or differently scoped cache entry from rendering under a
  selected project.
- Show only projects permitted by persistent Settings.
- Include retained historical projects only when their canonical identity and
  provenance are exact and trustworthy.

### Non-goals

- Persisting quick project scope across app restarts.
- Selecting multiple projects, a project subtree, or a loose name match.
- Changing the Settings Projects include/exclude filter.
- Adding the selector to Plans, Plugins, or Settings.
- Changing exports or making the Desktop transport a public CLI workflow.
- Filtering Combined-device payloads by local project identity.
- Showing global action or configuration findings as if they belonged to one
  project.

## 4. Terminology And Identity

### Persistent visibility filter

The existing Settings Projects include/exclude configuration. It is stored by
Electron's main process and becomes the CLI's `--project` and `--exclude`
arguments. It is the hard outer boundary for every supported report.

### Quick project scope

The new session-only top-bar selection. Its value is either `all` or one
canonical Desktop project ID. It is never written through `setProjectFilter`
and never stored in `localStorage`.

```ts
type QuickProjectScope =
  | { kind: 'all' }
  | { kind: 'project'; id: string; name: string; path: string | null }
```

### Desktop canonical project identity

The identity is discriminated so a path cannot collide with a pathless label:

- `path:<normalized-absolute-projectPath>` when an absolute path is available.
- `label:<source-project-label>` when no trustworthy path is available.

Normalization follows the existing project identity rules: slash
normalization, trailing-separator removal, and platform-appropriate path
folding. Display names are never identities. A path prefix, basename, or
substring never selects another project.

Two pathless records with the same source label are one identity. The source
data cannot prove they are separate projects, so the picker must not claim that
they are separately selectable.

### Project scope key

Cache keys use a collision-free representation:

- `all` for the unscoped population.
- `project:<base64url(UTF-8 Desktop-canonical-id)>` for a selected project.

The encoded form prevents a valid project ID such as `all` from colliding with
the unscoped sentinel.

## 5. User Experience

### Availability

The selector appears beside the provider selector on:

- Overview
- Sessions
- Pull Requests
- Spend
- Optimize
- Models
- Compare
- Compare Periods

Plans, Plugins, and Settings do not render it.

### Picker contents

The first option is always `All projects`. Remaining options are the projects
permitted by the persistent Settings filter and present in the trustworthy
catalog.

Each option contains a canonical ID, display name, and optional recorded path.
The collapsed trigger identifies the active project. The popup shows enough
path information to distinguish duplicate names. Truncated paths remain
available through the tooltip and accessible name. Pathless entries use an
explicit `Path unavailable` treatment.

Search matches display name and path only. Search does not determine report
membership; selecting an option always sends its exact canonical ID.

The catalog is loaded lazily on first open and cached for the current
persistent-filter revision. It is lifetime-based, so a project with no data in
the current provider/date slice remains selectable and shows the ordinary
empty report state.

The picker has explicit states:

- Loading leaves the current report scope unchanged.
- No permitted projects leaves `All projects` selected and explains that
  Settings currently permits no project.
- A load error disables new selection for that open attempt and offers retry.
- Retry reloads the catalog and its revision.

The control follows the existing `Dropdown` conventions: one labeled trigger,
keyboard list navigation, Enter/Space selection, Escape dismissal, and focus
restoration to the trigger. The full active name and path remain available to
assistive technology at compact top-bar breakpoints.

## 6. Scope Lifetime And Device Behavior

The quick scope is separate from `NavState` and the Sessions investigation
filters.

- Section changes do not clear it.
- Provider, period, and custom-range changes do not clear it.
- Back/Forward does not change it and selecting/clearing it does not create a
  Back/Forward history entry.
- Restart initializes it to `All projects`, even if scoped cache entries still
  exist on disk.
- The state lives above the locale-keyed `AppMain` subtree, or in a provider
  that survives that remount, so changing language does not reset it.

Selecting a project forces the effective device scope to Local. If the saved
device preference is Combined, the UI explains or disables Combined while the
project is selected, but does not overwrite the saved preference. Clearing the
project restores the saved preference when no other existing constraint
requires Local.

This is distinct from the existing persistent project-filter behavior, which
already forces and persists Local scope. A quick scope must not call that path
or mutate the saved device preference.

If a Settings change hides the active project, the app clears the quick scope
before issuing replacement requests. If the project remains permitted but has
no rows for the current slice, it stays selected.

## 7. Catalog Contract

The selector uses a dedicated typed bridge response rather than the existing
unfiltered Settings checklist response.

```ts
type ProjectScopeOption = {
  id: string
  name: string
  path: string | null
}

type ProjectScopeCatalog = {
  revision: string
  options: ProjectScopeOption[]
}
```

The main process obtains the catalog through a hidden lifetime report contract
that applies the current persistent Settings filter. The catalog combines:

- Live projects with an exact canonical identity.
- Retained daily-cache projects with exact identity and exact provenance.

Legacy or ambiguous cache entries are not offered. `getUnfilteredProjects`
continues to ignore the persistent filter because it is the Settings checklist
source; it is not reused as the quick-scope catalog without identity and
revision handling.

The catalog revision is an opaque deterministic fingerprint of the normalized
persistent filter and the catalog/cache generation. When the revision changes,
the renderer closes an open picker, discards its options, and disables
selection until the current catalog is loaded. The main process validates the
selected ID and expected revision against current Settings visibility before
accepting the selection. A mismatch fails closed, leaves the existing scope
unchanged, and reloads the catalog.

## 8. Report And IPC Contract

Electron uses a hidden Desktop-only report argument:

```text
--desktop-project-id=<canonical-id>
```

The argument is absent from public CLI documentation and help. It is accepted
only on report paths used by the Desktop app, including their resident `serve`
allowlist entries. The existing public, repeatable cohort-only
`compare --project-id` option keeps its current behavior.

Desktop report methods use one named query object so range, background priority,
device scope, and project identity cannot shift positionally as the bridge
evolves:

```ts
type DesktopReportQuery = {
  range?: DateRange
  background?: boolean
  deviceScope?: 'local' | 'combined'
  projectId?: string
}
```

The renderer derives effective device scope. The preload and main process
validate the query once. The main process rejects empty or NUL-containing IDs
and passes the ID as an attached option value so dash-leading identities remain
data rather than becoming flags.

The CLI and resident `serve` layer reject a Desktop project ID combined with
Combined scope. Electron normally prevents that combination, but lower-layer
validation protects against a stale or older renderer.

### Filter order

Every supported report applies filters in this order:

```text
all parsed or retained data
  -> persistent Settings include/exclude filter
  -> exact Desktop project ID, when selected
  -> provider and period/custom-range filters
  -> command-specific filters
  -> aggregation
```

The existing include list remains an OR set. The quick scope must not be
implemented by appending another `--project` pattern because that would widen
or ambiguously match the Settings population instead of intersecting it.

The exact predicate runs before aggregation. The renderer may not post-filter an
aggregate or use Sessions investigation filters as a substitute.

## 9. Report Coverage And Policies

| Surface | Required scope behavior |
| --- | --- |
| Overview | Status/menubar data is aggregated from the exact selected corpus. |
| Sessions | Plain rows and contribution rows receive the same exact project scope. |
| Pull Requests | PR rows are built from the already provider- and project-filtered corpus; a provider selection is never replaced by an all-provider aggregate. |
| Spend | Flow, timeline, and branch data receive the exact project ID before aggregation. |
| Models | Model and audit queries receive the exact project ID. |
| Optimize | Only evidence attributable to the selected project is rendered; the result cache is scope-partitioned. |
| Compare | Classic and cohort reports intersect the Desktop scope with their model/category selections. |
| Compare Periods | The same ID is applied independently to A and B, retained-history coverage, and session drill-downs. |

Plans, Plugins, Settings, exports, quota helpers, and the Settings project
catalog remain unscoped.

All supported reports must preserve provider and custom-range intersection.
Existing gaps where classic Compare or Yield drop a custom range are fixed as
part of this work rather than treated as exceptions.

### Compare Periods

The selected identity is applied to both ranges. The durable history/coverage
cross-check uses only exact project buckets. If retained history is legacy or
cannot be attributed exactly, that portion is reported as unavailable or
detail-only. An unscoped aggregate must never supplement a project-scoped
Compare Periods result.

### Optimize

An Optimize finding is rendered under a project scope only when its evidence is
derived from the selected canonical project corpus. File scans receive the
selected project identity/path before discovery or read only files proven to
belong to it. Global configuration findings, such as user-wide MCP, skill,
command, or tool configuration, are omitted unless safe attribution exists.

The Optimize result cache includes the project scope key. A global result may
not be reused under a selected project merely because its aggregate counts look
similar.

### Global applied actions

`act report` and applied-fix data currently come from global journal data without
trustworthy canonical project attribution. While a quick project scope is
active:

- Overview omits applied-action savings.
- Optimize omits its global applied-action header and applied-fix rows.
- Existing global action memo entries are not reused under the project label.

Showing less data is safer than labeling global data as project-specific.

## 10. Durable Historical Identity

The daily cache must preserve the same canonical identity used by live reports.
Each retained project/day/provider bucket records:

- Canonical Desktop project ID.
- Raw source label used by Settings matching.
- Display label.
- Optional recorded path.
- `exact` or `legacy` provenance.
- The full per-project basis required by scoped totals: cost, savings, calls,
  sessions, token fields, turn fields, model breakdowns, and category
  breakdowns, plus the equivalent provider-slice data.

Exact bucket keys are namespaced encodings of canonical IDs. Legacy label-keyed
records use a different namespace. Cache merge, migration, and provider-overlay
code compare bucket identity and provenance; they never merge a legacy label
bucket into an exact bucket because the strings happen to match.

Persistent Settings matching on retained data uses its preserved raw label and
path with the existing `makeProjectFilter` semantics. Quick scope then requires
exact provenance and canonical-ID equality.

The cache schema/version is bumped. Old label-keyed records migrate as Legacy
and remain usable for unscoped totals under existing fresh-versus-baseline
reconciliation rules. They are excluded from:

- The quick-project catalog.
- Quick-project report totals.
- Quick-project history and coverage calculations.

When fresh and retained data overlap the same day/provider, unscoped totals
choose one owner according to the existing reconciliation rule. They never sum
the overlapping streams twice. Scoped projections start empty and sum only
matching exact buckets; they never start with a global day and subtract other
projects.

If a scoped historical field cannot be reconstructed from exact buckets, the
payload marks it unavailable rather than reading a global or legacy fallback.

## 11. Cache, Refresh, And Stale Responses

The project scope key is added to:

- `overviewMemoKey` and overview headline snapshots.
- `reportMemoKey` for every section report and drill-down variant.
- Selected report timestamps and refresh labels.
- Warm/prefetch keys.
- Optimize disk snapshots.
- CLI status-snapshot query identity.
- In-flight request and stale-response guards.

The persistent Settings filter is a separate report-filter generation. A change
to that filter invalidates the catalog, report/headline memos, and applicable
prefetch entries. In-flight responses from the previous generation are stale.

A response may be stored or rendered only when its filter generation and
project scope key still match the current request. A selected project may keep
its own last-good snapshot visible while that same scope refreshes, but it may
never display an unscoped or different-project snapshot as a fallback.

Prefetch is allowed only when it uses the full project scope key. It must not
warm an unscoped response and later reuse it for a selected project.

For scoped Overview specifically:

| Field | Policy |
| --- | --- |
| Current totals, sessions, models, spend, and daily history | Recompute from the exact selected live/cache corpus. |
| Pull Requests and branches | Aggregate from the same filtered corpus. |
| `periodTotals` | Omit; it is an unscoped generation optimization. |
| Streak | Recompute from exact selected day buckets or show unavailable. |
| Applied-action savings | Omit because current action data is global. |
| Optimize findings | Include only findings that pass the attribution policy. |

## 12. Error Handling

- Malformed Desktop IDs fail in the main process before argv construction.
- Catalog revision mismatches fail closed and reload; they never select a
  project hidden by a newer Settings revision.
- A selected project with zero rows is a valid empty result and does not clear
  the selection.
- CLI/IPC failures use existing report error states and never retry unfiltered.
- A missing or stale catalog entry is a catalog state, not evidence that a
  valid selected project has no report data.
- Historical data lacking exact identity is unavailable/detail-only for scoped
  reports, not supplemented from global aggregates.
- A selected project's same-scope last-good payload may remain visible while
  refreshing; a payload from another scope may not.

## 13. Code Boundaries

- `src/parser.ts` and shared identity helpers: compose persistent pattern
  filtering with exact Desktop-ID filtering.
- `src/day-aggregator.ts`, `src/daily-cache.ts`, and status snapshot code:
  store structured exact/legacy project buckets, preserve Settings-match
  metadata, define migration and reconciliation, and produce scoped history.
- `src/main.ts`, `src/serve.ts`, and period-diff code: accept the hidden Desktop
  argument on supported report paths, preserve both-range scope, add missing
  custom-range propagation, and keep the public cohort option unchanged.
- `src/optimize.ts`: restrict project evidence and scope result-cache identity.
- `app/electron/main.ts`: validate the Desktop query, build argv, retrieve the
  lifetime catalog, validate catalog revisions, and keep administrative calls
  unscoped.
- `app/electron/preload.ts` and `app/renderer/lib/types.ts`: expose the typed
  catalog and `DesktopReportQuery`.
- `app/renderer/App.tsx`: own session-only scope, derive effective device
  scope, react to Settings revisions, thread scope through supported reports,
  and update memo identities.
- `app/renderer/components/TopBar.tsx` and a focused project-picker component:
  render the accessible selector without changing unsupported sections.
- `app/renderer/lib/reportMemoKey.ts` and overview/prefetch helpers: include
  project scope and filter generation in cache identity.

## 14. Verification And Acceptance

### Core and CLI

- Exact matching distinguishes duplicate names and excludes path descendants,
  sibling prefixes, and label substrings.
- Persistent include/exclude filtering is applied first; the Desktop ID narrows
  rather than widens the population.
- `path:` and `label:` identities cannot collide.
- Hidden Desktop IDs validate safely, are accepted by supported `serve` paths,
  reject Combined scope, and preserve behavior when absent.
- The documented cohort `--project-id` remains repeatable and unchanged; when
  both exact mechanisms exist, they intersect rather than union.
- Cache migration preserves legacy provenance, avoids double counting, and
  excludes legacy data from scoped totals/catalogs.
- Compare Periods scopes both ranges, coverage/history, and session drill-down.

### Electron and renderer

- Every supported report bridge handler receives the exact scope; Plans,
  Plugins, Settings, exports, quota helpers, and catalog checklist calls do
  not.
- Scope-aware memo, prefetch, snapshot, and stale-response identities differ
  between `All projects` and every selected ID.
- A late response for one project cannot replace another project's data.
- Settings-filter changes invalidate the catalog and old responses.
- The scope survives section/provider/period/range navigation and Back/Forward,
  survives locale changes, and resets after restart.
- Selecting a project forces Local without changing the saved Combined
  preference; clearing restores it when permitted.
- Hiding the active project clears the scope; an empty current slice does not.
- The picker supports search, keyboard selection, Escape, focus restoration,
  duplicate-name path disambiguation, accessible naming, loading, empty, and
  error states.

### Report correctness

- Overview, Sessions, Pull Requests, Spend, Models, Optimize, Compare, and
  Compare Periods all derive totals from the same exact filtered corpus.
- Classic Compare and Yield retain custom ranges.
- Pull Requests honor provider and project scope.
- Scoped Overview omits unscoped generation fields and global action data.
- Scoped Optimize omits unprovable global configuration/action findings.
- A selected project with no current activity shows an honest empty state.

Relevant existing suites include `app/electron/main.test.ts`,
`app/renderer/App.test.tsx`, `app/renderer/sections/PeriodCompare.test.tsx`,
`app/renderer/lib/reportMemoKey.test.ts`,
`tests/cli-compare-cohort.test.ts`, and the project-filter command tests. New
exact-identity, catalog-revision, cache-provenance, bridge-contract, and
scope-race tests are required.

## 15. Decisions Made

| Decision | Rationale |
| --- | --- |
| Use an internal exact-project scope contract rather than renderer filtering. | Aggregates, Optimize evidence, durable history, and Compare Periods must be computed from the selected corpus before aggregation. |
| Use the hidden `--desktop-project-id` argument. | It provides one backend contract without changing the public cohort-only `--project-id` meaning or documenting a new CLI workflow. |
| Allow only `All projects` or one canonical project. | The issue requests one project at a time and does not require multi-project, subtree, or loose matching. |
| Use discriminated `path:`/`label:` canonical IDs. | A trustworthy path distinguishes duplicate names; the discriminator prevents pathless labels from colliding with path identities. |
| Include retained historical projects only with exact identity/provenance. | This preserves useful historical scope while omitting ambiguous legacy records that could misattribute spend. |
| Treat persistent Settings filtering as the outer boundary. | A quick scope must never make a hidden project selectable or visible. |
| Use a named `DesktopReportQuery`. | Range, priority, device scope, and project ID remain unambiguous as IPC evolves. |
| Keep quick scope outside `NavState` and localStorage. | It survives navigation and Back/Forward but reliably resets on restart. |
| Do not create Back/Forward entries for selecting or clearing the scope. | The scope is a shell-wide report context, not a destination or drill-through state. |
| Force effective Local while scoped without changing the saved device preference. | Combined payloads cannot be reliably filtered by local project identity. |
| Apply the exact ID before report aggregation. | Post-filtering rendered aggregates cannot guarantee correct totals or cache isolation. |
| Partition every scope-sensitive cache and snapshot identity. | Data from another project or `All projects` must never render under the selected project. |
| Track persistent-filter generation separately from project scope. | Settings changes invalidate both catalog eligibility and in-flight/report data. |
| Version daily-cache project buckets and preserve exact/legacy provenance. | Settings matching requires raw label/path metadata, while scoped totals require exact identity. |
| Never use legacy/global history to top up exact scoped history. | Historical ambiguity is safer as unavailable/detail-only than as misattributed spend. |
| Omit global applied-action and unprovable Optimize data while scoped. | Current sources do not provide trustworthy project attribution for those values. |
| Apply the same ID to Compare Periods A, B, history, and drill-down. | Both sides must derive from one consistent project corpus. |
| Keep Plans, Plugins, Settings, exports, quota, and the Settings catalog unscoped. | They are administrative or non-project report surfaces outside the issue's requested scope. |
| A Settings change that hides the active project clears it; an empty report does not. | Visibility policy must win, while no activity in a valid slice is an honest result. |
