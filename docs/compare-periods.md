# Compare periods

Compare two date ranges side by side and see exactly what drove the change in
usage and cost. CodeBurn computes every difference deterministically as
**B − A**: A is the *reference* period, B is the *analyzed* one.

## Where to find it

- **Overview → "Compare periods" card → Compare →**, or
- the **Compare periods** item in the sidebar (shortcut `9`).

The classic model-vs-model comparison in **Compare** is unchanged; period
comparison is its own screen.

## Choosing the two ranges

- **Last 7 vs prior 7** (default): B is the last seven *complete* calendar
  days (today is never complete), A is the seven before that.
- **Custom**: pick A and B independently from the calendar controls. Dates are
  local calendar days (the same `YYYY-MM-DD` convention every other CodeBurn
  range uses). **⇄ Swap** exchanges A and B.

The header always shows how many days each range spans, whether the durations
differ, and whether the ranges overlap (overlapping days count on **both**
sides). Your selection is remembered when you leave the screen and come back.

## Reading the report

**Summary** — one sentence built from the report numbers (how much B cost
against A, and whether sessions and cost per call moved together), then three
tiles: total cost, cost per 100 calls and sessions, each with its absolute and
relative change.

**Cost per day, both ranges side by side** — paired bars per day index, A in
the bar color and B in the accent color. Each pair is one day of A beside the
same-numbered day of B, so the two series line up by index, not by date; the
axis reads "Day 1" to "Day N", and hovering a day shows both sides' dates and
costs. The
per-day cost comes from the same sliced session trees as the totals (`daily.A`
/ `daily.B` in the JSON).

**What changed, biggest movers** — the five largest movers, by project or by
model, with a link to expand to the full list. Everything below lives in the
folded **All metrics** and **What is counted** sections.

**Totals** (under All metrics) — API-equivalent cost, calls, sessions, every token component, and
estimated-price cost, each with its absolute (B − A) and relative difference.
Where a percentage is undefined (the A component is zero) the cell shows `—`
rather than an invented number. API-equivalent cost is what the same usage
would have cost at API rates; it is **not** a subscription invoice.

**Normalized** (under All metrics) — the same difference per calendar day and per 100 API calls.
The denominators are printed under the table (A and B use *their own* day and
call counts). A zero or unknown denominator renders as `—`, never as zero.

The movers table lists the largest increases and decreases in each dimension,
sorted by absolute movement. The two lenses are two
*perspectives on the same global difference*; each complete lens alone sums to
the total difference. Never add the lenses together.

- A project or model that exists only in B is chipped **new this period** (no
  infinite percentage). One that exists only in A is **not used this period**.
- Click any row to inspect the sessions behind it: each session shows its cost
  in A and in B. A session that straddles the boundary appears once, with the
  part of its activity that falls inside each range — attribution follows each
  API call's own timestamp, not the session's start date.
- **Open A / B in Sessions** jumps to the Sessions screen scoped to that range
  and filtered to that contribution's project or model, so the drill-through
  lands on exactly the population the row describes.
- The **Raw / Per day / Per 100 calls** switch rescales the lens. Per-100-calls
  recomputes honestly: a period with zero calls has *no* cost per call (shown
  as `—`), and a period that spent more in total but less per call shows as a
  decrease.

**What is counted** — folded away at the foot of the screen; what the numbers
are made of:

- Pricing coverage per range, and any models with usage but no price data
  ("unknown", not zero).
- **Aggregate history without session detail**: when a day's session sources
  have aged off disk, its cost survives only in the durable daily history.
  Those days are listed here with their unexplained amount and are *not*
  folded into the totals or the lenses. The Totals card says so inline when
  either range has such a day, because on a machine with aged-off history the
  detail-only total can be far below what `codeburn report` shows for the same
  range (`report` and `status` read the durable daily history; `compare-periods`
  matches `sessions`, `models` and `spend`, which read session transcripts).

Every difference is a deterministic calculation over the full population of
both ranges (not a top-N sample). Nothing is AI-generated: a rise or drop can
always be traced from the totals to a lens row to the sessions behind it.

## CLI

The desktop feature is backed by the same engine the CLI exposes:

```bash
codeburn compare-periods --format json          # last 7 complete days vs prior 7
codeburn compare-periods --format json \
  --from-a 2026-03-01 --to-a 2026-03-07 \
  --from-b 2026-03-08 --to-b 2026-03-14
codeburn compare-periods --format sessions \
  --dimension project --key /work/my-app \
  --from-a 2026-03-01 --to-a 2026-03-07 \
  --from-b 2026-03-08 --to-b 2026-03-14
```

`--provider`, `--project`, and `--exclude` filter both ranges the same way
they filter every other command.
