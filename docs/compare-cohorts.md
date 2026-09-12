# Cohort model comparison (Compare → Cohorts)

The classic Compare view answers "how do these two models differ across my whole
history?" by aggregating everything each model ever did. The **Cohorts** mode —
new in this change — answers a narrower question: **how do the two models behave
on the same kind of work, over a population you can inspect?**

## What an observation is (V1 definition)

* An observation is one **edit turn** (a turn that edited files) whose
  **behavioral calls** carry **exactly one model**. That model owns the
  observation. "Behavioral call" is CodeBurn's existing definition
  (`src/behavioral-weight.ts`): real requests, excluding supplementary
  accounting rows.
* The **cost attributed to the model** is the recorded cost of *that model's own
  calls inside the turn*. A session that used several models never transfers the
  cost of one model to another, and no session total is attributed to a
  "dominant" model.
* Edit turns whose behavioral calls span **two or more models** are excluded
  from both cohorts, counted, and shown with their combined cost.
* An edit turn with no behavioral model call at all is excluded the same way.
* A `$0` cost on a model the pricing rules do not declare free (local models,
  subscription SKUs, explicit zero-rate overrides) is **unknown cost, not zero**:
  such observations keep their retry/one-shot weight (which needs no pricing)
  and are counted separately, but stay out of cost percentiles.

The classic mode's formulas are untouched; both modes remain available.

## What the mode shows

In order, before any metric:

1. **Population** — included observations per model, the distinct sessions they
   come from, excluded turns that mix models (with their combined cost),
   excluded turns without a behavioral model, and the unknown-cost count.
2. **Inspect samples** — the declared population itself, one row per
   observation (timestamp, project, session, category, cost, input / output /
   context-proxy tokens, retries). Every number on the page is reproducible
   from this list. Activating a row also hands the sample to the shared
   navigation when one is registered (`app/renderer/lib/sampleNavigation.ts`);
   the section is fully usable without it.
3. **Cost per edit turn** — median, P90, mean over cost-known observations, the
   one-shot rate and retry rate over the declared population (zero *observed*
   retries never proves code correctness), and a compact cost histogram whose
   top bucket is open-ended so outliers are never dropped.
4. **Token volume** — median/P90 of output, input, and the **context proxy**
   (input + cache-read tokens — a proxy, never presented as a measured context
   window).

## Selection and the volume band

The selection covers model A, model B, the interval (a custom date range when
one is active, otherwise the selected period), one project, and one activity
category. On the CLI the same selection exists as:

```bash
codeburn compare --format cohort-json                       # facets: models, projects, categories
codeburn compare --format cohort-json \
  --model-a <model> --model-b <model> \
  [--period 30days | --from 2026-08-01 --to 2026-08-31] \
  [--project <name|path>]... [--exclude <name|path>]... \
  [--category coding]
```

The **volume band** narrows the population to observations inside a token range
(output, input, or the context proxy). A band explicitly excludes — and counts —
observations that fall outside it **and** observations that carry no token
measure at all (missing data is never read as "small"). Rates are recomputed
over the remaining declared population.

## Fixed conventions

* Percentiles use **linear interpolation at position (N-1)·p** — for costs
  [1, 2, 4, 8] the median is 3 and P90 is 6.8. Pinned by tests on both the core
  (`tests/compare-cohorts.test.ts`) and the renderer mirror
  (`app/renderer/lib/cohortStats.test.ts`).
* No outlier removal, no sample equalizing, no automatic winner: the mode is a
  descriptive comparison of your own history. N and variation are always shown.

## Population-first contract

The `cohort-json` payload embeds the full observation list per model, so any
statistic is reproducible from the payload (and from the Inspect samples list)
without re-running anything. Volume-band math runs in the renderer over that
list (`app/renderer/lib/cohortStats.ts`, a mirror of the core math with the same
pinned convention) so band changes are instant.
