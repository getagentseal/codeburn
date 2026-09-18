import { isBehavioralCall } from './behavioral-weight.js'
import { billableOutputTokens, fallbackRawModelDisplayName, getModelCosts, getShortModelName, sanitizeModelForDisplay, tieredCostsFor, type ModelCosts } from './models.js'
import { getProvider } from './providers/index.js'
import { formatCost, formatTokens } from './format.js'
import { renderTable, type TableColumn } from './text-table.js'
import type { ProjectSummary } from './types.js'

// One (provider, model) bucket, exposing both the raw token fields as recorded
// by the provider/transcript and the normalized totals codeburn actually
// prices, so a mismatch between the two is visible in one place.
export type AuditRow = {
  provider: string
  providerDisplayName: string
  model: string
  modelDisplayName: string
  calls: number
  // Summed straight from each call's usage, untouched.
  raw: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number // Anthropic vocab
    cachedInputTokens: number // OpenAI vocab
    webSearchRequests: number
  }
  // What the reports display: reasoning folds into output, and the two
  // cache-read vocabularies collapse to their max (providers fill one or both).
  displayed: {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
  }
  // Per-token rates used for pricing; null when the model has no pricing entry.
  rates: ModelCosts | null
  // Cost split by component (displayed tokens x rate), plus the recomputed
  // total. recomputedTotalUSD should track attributedCostUSD; a gap points at
  // fast-mode multipliers or the 1-hour cache rate that calculateCost applies.
  cost: {
    input: number
    output: number
    cacheWrite: number
    cacheRead: number
    webSearch: number
    recomputedTotalUSD: number
  }
  // The cost codeburn actually attributed to these calls (sum of call.costUSD).
  attributedCostUSD: number
}

export async function aggregateAudit(projects: ProjectSummary[]): Promise<AuditRow[]> {
  type Bucket = {
    provider: string
    model: string
    calls: number
    attributedCostUSD: number
    cacheReadDisplayed: number
    raw: AuditRow['raw']
    /** Per-call recomputed components, each priced with THAT call's tier swap —
     *  a (provider, model) bucket's summed tokens must never cross the
     *  per-call 272k threshold on their own (review: a $4,979 phantom gap). */
    recomputed: { input: number, output: number, cacheWrite: number, cacheRead: number, webSearch: number }
    /** Resolved rates for the bucket's model, fetched once per bucket. */
    rates: ModelCosts | null
  }
  const buckets = new Map<string, Bucket>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          const provider = call.provider || 'unknown'
          const model = call.model || 'unknown'
          const key = `${provider} ${model}`
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = {
              provider,
              model,
              calls: 0,
              attributedCostUSD: 0,
              cacheReadDisplayed: 0,
              recomputed: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0 },
              rates: null,
              raw: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                cachedInputTokens: 0,
                webSearchRequests: 0,
              },
            }
            bucket.rates = getModelCosts(bucket.model)
            buckets.set(key, bucket)
          }
          const u = call.usage
          bucket.raw.inputTokens += u.inputTokens
          bucket.raw.outputTokens += u.outputTokens
          bucket.raw.reasoningTokens += u.reasoningTokens
          bucket.raw.cacheCreationInputTokens += u.cacheCreationInputTokens
          bucket.raw.cacheReadInputTokens += u.cacheReadInputTokens
          bucket.raw.cachedInputTokens += u.cachedInputTokens
          bucket.raw.webSearchRequests += u.webSearchRequests
          // Per-call max (then summed) mirrors how the reports collapse the two
          // cache-read vocabularies, so the audit's displayed total matches.
          const cacheReadForCall = Math.max(u.cacheReadInputTokens, u.cachedInputTokens)
          bucket.cacheReadDisplayed += cacheReadForCall
          bucket.attributedCostUSD += call.costUSD
          // Recompute per call through the same tier swap calculateCost applies
          // (prompt tokens = input + cached input of THIS call), so a
          // long-context request shows the rates that priced it while a bucket
          // of small calls never crosses the threshold on the sum. Fast-mode
          // and the 1-hour cache-write rate remain visible gaps on purpose.
          if (bucket.rates) {
            const promptTokens = u.inputTokens + cacheReadForCall
            const tiered = tieredCostsFor(bucket.model, bucket.rates, promptTokens, bucket.provider)
            const outputForCall = billableOutputTokens(bucket.provider, u.outputTokens, u.reasoningTokens)
            bucket.recomputed.input += u.inputTokens * tiered.inputCostPerToken
            bucket.recomputed.output += outputForCall * tiered.outputCostPerToken
            bucket.recomputed.cacheWrite += u.cacheCreationInputTokens * tiered.cacheWriteCostPerToken
            bucket.recomputed.cacheRead += cacheReadForCall * tiered.cacheReadCostPerToken
            // Web search never participates in a tier; keep it on the base row.
            bucket.recomputed.webSearch += u.webSearchRequests * bucket.rates.webSearchCostPerRequest
          }
          // Supplementary accounting calls keep their tokens and cost above but are not
          // distinct requests, so they add no call weight (see behavioral-weight.ts).
          if (isBehavioralCall(call)) bucket.calls += 1
        }
      }
    }
  }

  const providerCache = new Map<string, { displayName: string; formatModel: (m: string) => string }>()
  async function resolveProvider(name: string) {
    const cached = providerCache.get(name)
    if (cached) return cached
    const p = await getProvider(name)
    const entry = {
      displayName: p?.displayName ?? name,
      formatModel: p
        ? (m: string) => sanitizeModelForDisplay(fallbackRawModelDisplayName(p.modelDisplayName(m), m))
        : (m: string) => sanitizeModelForDisplay(getShortModelName(m)),
    }
    providerCache.set(name, entry)
    return entry
  }

  const rows: AuditRow[] = []
  for (const bucket of buckets.values()) {
    const meta = await resolveProvider(bucket.provider)
    // Buckets are keyed by (provider, model), so this provider test covers every call in one.
    // Copilot reasoning tokens are already INSIDE outputTokens (same rule as cachedCallToApiCall
    // in parser.ts), so folding them in would display phantom output for its store rows/rollups.
    const displayed = {
      inputTokens: bucket.raw.inputTokens,
      outputTokens: billableOutputTokens(bucket.provider, bucket.raw.outputTokens, bucket.raw.reasoningTokens),
      cacheWriteTokens: bucket.raw.cacheCreationInputTokens,
      cacheReadTokens: bucket.cacheReadDisplayed,
    }
    const cost = {
      input: bucket.recomputed.input,
      output: bucket.recomputed.output,
      cacheWrite: bucket.recomputed.cacheWrite,
      cacheRead: bucket.recomputed.cacheRead,
      webSearch: bucket.recomputed.webSearch,
      recomputedTotalUSD: bucket.recomputed.input + bucket.recomputed.output + bucket.recomputed.cacheWrite + bucket.recomputed.cacheRead + bucket.recomputed.webSearch,
    }
    const rates = bucket.rates
    rows.push({
      provider: bucket.provider,
      providerDisplayName: meta.displayName,
      model: bucket.model,
      modelDisplayName: meta.formatModel(bucket.model),
      calls: bucket.calls,
      raw: bucket.raw,
      displayed,
      rates,
      cost,
      attributedCostUSD: bucket.attributedCostUSD,
    })
  }

  rows.sort((a, b) => b.attributedCostUSD - a.attributedCostUSD)
  return rows
}

export function renderAuditTable(rows: AuditRow[]): string {
  const columns: TableColumn[] = [
    { header: 'Provider' },
    { header: 'Model' },
    { header: 'Calls', right: true },
    { header: 'Input', right: true },
    { header: 'Output', right: true },
    { header: 'Reason', right: true },
    { header: 'Cache wr', right: true },
    { header: 'Cache rd', right: true },
    { header: 'Cost', right: true },
  ]

  const body = rows.map((r) => [
    r.providerDisplayName,
    r.modelDisplayName,
    r.calls.toLocaleString(),
    formatTokens(r.raw.inputTokens),
    formatTokens(r.raw.outputTokens),
    formatTokens(r.raw.reasoningTokens),
    formatTokens(r.raw.cacheCreationInputTokens),
    formatTokens(r.displayed.cacheReadTokens),
    formatCost(r.attributedCostUSD),
  ])

  const totals = rows.reduce(
    (a, r) => ({
      calls: a.calls + r.calls,
      input: a.input + r.raw.inputTokens,
      output: a.output + r.raw.outputTokens,
      reason: a.reason + r.raw.reasoningTokens,
      cacheWrite: a.cacheWrite + r.raw.cacheCreationInputTokens,
      cacheRead: a.cacheRead + r.displayed.cacheReadTokens,
      cost: a.cost + r.attributedCostUSD,
    }),
    { calls: 0, input: 0, output: 0, reason: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
  )
  body.push([
    'Total',
    '',
    totals.calls.toLocaleString(),
    formatTokens(totals.input),
    formatTokens(totals.output),
    formatTokens(totals.reason),
    formatTokens(totals.cacheWrite),
    formatTokens(totals.cacheRead),
    formatCost(totals.cost),
  ])

  const table = renderTable(columns, body, { boldRows: new Set([body.length - 1]) })
  const legend = [
    '',
    'Columns are the raw token fields each provider records. codeburn then normalizes for pricing:',
    '  - Reason folds into Output (priced output = output + reasoning), except copilot, whose reasoning is already inside its output',
    '  - Cache rd = max(Anthropic cacheReadInput, OpenAI cached), since providers fill one or both',
    '  - Cache wr is priced at 1.25x the input rate, Cache rd at 0.1x, when a model omits explicit cache rates',
    'Use --format json for per-component cost, the rates applied, and both raw cache-read fields.',
  ].join('\n')
  return table + '\n' + legend
}

export function renderAuditJson(rows: AuditRow[]): string {
  return JSON.stringify(rows, null, 2)
}
