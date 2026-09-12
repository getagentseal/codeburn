# Drill-through: from aggregates to the sessions behind them

CodeBurn Desktop can open any aggregate — a day in the Overview chart, an
expensive session, a project, a model, a task category, a pull request — as a
session list that explains exactly what composes it, without losing your
place.

## Using it

- **Click a day bar** in Overview's Daily spend chart. Sessions opens with a
  `Day` chip and shows the sessions that were active that day — including
  sessions started earlier that were still working on it, within the source's
  day granularity.
- **Click a session** in Overview's "Most expensive sessions" to land on the
  sessions list with the drawer already open on that exact session (matched by
  provider + id, so a duplicate id or title under another provider never
  opens the wrong one).
- **Click a model name** (Overview's models table or the Models report), a
  **task category** (Overview's Top activities or the Models by-task rows), a
  **project** (Spend → By project → expand → "View sessions"), or a **pull
  request** (Pull requests → expand → "View sessions").
- While an investigation is active, clicking another aggregate **adds** to it:
  same-dimension values union (two days, two models), different dimensions
  intersect (day AND category).

## Reading the numbers

The destination's summary always separates two figures:

- **in selection** — the spend the listed sessions contribute to the pressed
  value. A session that spent $100 overall but only $20 in the selected
  category contributes $20 to the selection sum.
- **full cost of these sessions** — the whole cost of the listed sessions,
  labeled separately so the two can never be confused. Rows show their
  contribution first (`$20 of $100`), and the side drawer shows both next to
  each other.

Pull requests keep the by-PR report's attribution semantics: turns split
across a multi-PR set contribute their share to each, so PR rows are not an
exclusive partition. A session's spend that is tied to no selected PR is
labeled "Not tied to a specific PR". When older transcripts cannot be
attributed per turn, the rows carry the by-PR report's `~` even-split marker.

Sessions that cannot be attributed to the selection (no per-turn detail
survived for them) are excluded and counted in the summary ("N sessions could
not be attributed") instead of being silently dropped or zero-valued.
The same disclosure applies to ambiguous session identities and old cached
reports without per-model usage when a model filter is active.

Days follow each call's timestamp, so a turn crossing midnight contributes to
both days. Model filters use the model's actual calls and tokens, independently
of its cost; free models retain their usage. Supplementary accounting retains
cost and tokens without adding requests.

## Drawer, history, and focus

- Clicking a session row opens the side drawer: metadata, full totals next to
  the in-selection figures, and the per-model / per-category / per-branch /
  per-day / per-PR breakdowns. PR URLs open outside the app. `Escape` closes
  the drawer and focus returns to the row that opened it.
- The top bar's ‹ / › (or `⌘[` / `⌘]` on macOS, `Alt+←` / `Alt+→` elsewhere)
  walk the in-app history: filters, sort, list depth, and the open drawer are
  all restored, and Back returns you to the exact chart you left.
- A data refresh keeps the drawer open while its session still exists in the
  refreshed population; if the session is gone (or the provider/project scope
  changed), the drawer closes rather than showing a session that no longer
  reconciles.
- Reloading the app restores the last position (section, selection, drawer);
  the restored drawer revalidates against the fresh report.

## Data path

The renderer stays a pure view over CLI JSON. The drill-through report is
`codeburn sessions --format json --contributions` — the same session rows and
the same `--project`/`--exclude`/`--provider` filtering semantics as the plain
report, plus per-session `contributions.segments` (call-day slices with
category, git branch, model costs and usage, and active PR set) and canonical identities
(`projectId`, `provider`, `sessionId`). Transcripts never cross the IPC
boundary; the report is fetched only while a selection is active, and every
chip combination is computed client-side over the full fetched population.
