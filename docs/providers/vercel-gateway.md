# Vercel AI Gateway

Cloud usage for [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) via the reporting API.

- **Source:** `src/providers/vercel-gateway.ts`
- **Loading:** lazy (`src/providers/index.ts`)
- **Test:** `tests/providers/vercel-gateway.test.ts`

## Where it reads from

Not local disk. CodeBurn calls:

```
GET https://ai-gateway.vercel.sh/v1/report?start_date=...&end_date=...&date_part=day&group_by=model
```

See [Custom Reporting](https://vercel.com/docs/ai-gateway/capabilities/custom-reporting).

## Authentication

Set one of:

- `AI_GATEWAY_API_KEY`
- `VERCEL_OIDC_TOKEN` (from `vercel env pull` when using `vercel dev`)

## Caching

None. Each parse issues one API request for the requested date range.

## Deduplication

Per `vercel-gateway:<day>:<model>`.

## Not counted in totals by default

A report row is a **daily aggregate per model**: one cost, one token count and
one `request_count` for a whole day, with no request ids, timestamps or
attribution. Nothing in it can be matched against the local tools you pointed at
the gateway — Claude Code (`ANTHROPIC_BASE_URL`), Codex, OpenCode,
Cline/Kilo, Cursor — which already record those same requests from their own
session files. Counting both double counts the same spend.

So gateway spend is:

- **always shown** as its own provider row (marked "not in total" in the app),
  and as `overview.excludedGatewayCost` in `--format json`;
- **excluded** from every headline total, per-model row, daily row and history
  point by default;
- **unaffected** under `--provider vercel-gateway`, which reports the full
  amount so you can inspect it.

The exclusion is one rule in one place (`parseAllSessions`), so every surface
follows it: the report, the interactive dashboard, the menubar payload, `models`,
`sessions`, `export`, `compare`, `compare-periods`, `spend`, `yield`, `audit`,
`budget`, and the Teams sync push (which would otherwise hand the backend the
same double count). The session cache and the daily cache are the deliberate
exception — they keep storing the gateway slice, because a past day's aggregate
row can never be fetched again.

To include it in totals instead:

```
codeburn gateway-totals include     # codeburn gateway-totals exclude to undo
codeburn gateway-totals             # show the current setting
```

The setting is read-side only. The daily cache always stores the gateway slice,
so flipping it applies retroactively to sealed days without re-fetching.

## Quirks

- Requires Pro/Enterprise Custom Reporting on your Vercel account.
- Data can lag by a few minutes after requests complete.
- Rows are daily aggregates per model, not per chat session (see above).
- `request_count` is used as the row's call count, so one row can stand for many
  requests while carrying a single cost and token figure.
- `total_cost` is used as `costUSD`; token fields map directly when present.

## When fixing a bug here

1. Confirm env vars are set in the same shell running `codeburn`.
2. Reproduce with `codeburn report --provider vercel-gateway -p week --format json`.
3. Compare totals to the Vercel dashboard AI Gateway usage view.
