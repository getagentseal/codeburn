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

## Quirks

- Requires Pro/Enterprise Custom Reporting on your Vercel account.
- Data can lag by a few minutes after requests complete.
- Rows are daily aggregates per model, not per chat session.
- `total_cost` is used as `costUSD`; token fields map directly when present.

## When fixing a bug here

1. Confirm env vars are set in the same shell running `codeburn`.
2. Reproduce with `codeburn report --provider vercel-gateway -p week --format json`.
3. Compare totals to the Vercel dashboard AI Gateway usage view.
