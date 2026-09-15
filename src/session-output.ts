import { billableOutputTokens, getShortModelName } from './models.js'
import type { SessionSummary } from './types.js'

type UsageLike = {
  outputTokens?: number
  reasoningTokens?: number
}

type CallLike = {
  provider?: string
  model?: string
  usage?: UsageLike
}

/** Same key the parser uses for non-Devin `modelBreakdown` buckets. */
export function modelBreakdownKey(call: { provider?: string; model?: string }): string | undefined {
  if (!call.model) return undefined
  return call.provider === 'devin' ? call.model : getShortModelName(call.model)
}

/**
 * Prefer a key that already exists on this session's modelBreakdown.
 * Parser sessions are keyed by getShortModelName. Fixtures and leftover
 * summaries may still use the raw id. Inventing the other spelling
 * creates a $0 / 0-call orphan that findUnpricedModels flags as Unpriced.
 */
export function resolveModelBreakdownKey(
  call: { provider?: string; model?: string },
  breakdown: Record<string, unknown> | undefined,
): string | undefined {
  const derived = modelBreakdownKey(call)
  if (derived && breakdown && Object.hasOwn(breakdown, derived)) return derived
  if (call.model && breakdown && Object.hasOwn(breakdown, call.model)) return call.model
  return derived ?? call.model
}

/**
 * One walk over the session's calls producing BOTH the session-level billable
 * output and the per-model split. The two were previously derived by separate
 * passes; every caller that wants both (the menubar period aggregation) would
 * otherwise traverse every assistant call twice for no extra information.
 *
 * The fallback is shared deliberately: whether calls carried usage decides the
 * total and the per-model map together, so they can never disagree about which
 * source they came from.
 */
export function sessionBillableOutput(session: SessionSummary): { total: number, byModel: Record<string, number> } {
  const breakdown = session.modelBreakdown ?? {}
  const byModel: Record<string, number> = {}
  let total = 0
  let sawUsage = false
  for (const turn of session.turns ?? []) {
    for (const call of turn.assistantCalls ?? []) {
      if (!call.usage) continue
      sawUsage = true
      const billable = callBillableOutputTokens(call)
      total += billable
      // A call whose model maps to no bucket still counts toward the session
      // total — dropping it there would under-report the headline — but it has
      // no row to land in, exactly as before.
      const key = resolveModelBreakdownKey(call, breakdown)
      if (!key) continue
      byModel[key] = (byModel[key] ?? 0) + billable
    }
  }
  if (sawUsage) return { total, byModel }

  const provider = inferSessionProvider(session)
  for (const [model, d] of Object.entries(breakdown)) {
    byModel[model] = billableOutputTokens(provider, d.tokens?.outputTokens ?? 0, d.tokens?.reasoningTokens ?? 0)
  }
  return {
    total: billableOutputTokens(provider, session.totalOutputTokens ?? 0, session.totalReasoningTokens ?? 0),
    byModel,
  }
}

/**
 * Per-model displayed output, keyed like this session's `modelBreakdown`.
 * Call usage wins while provider identity is known. Aggregate-only /
 * stub sessions fall back to each existing bucket so a finite
 * sessionBillableOutputTokens cannot leave model Output Tokens at 0.
 */
export function sessionModelBillableOutputTokens(session: SessionSummary): Record<string, number> {
  return sessionBillableOutput(session).byModel
}

/** First on-call provider, then a model-name fallback. Sessions are usually one provider. */
export function inferSessionProvider(session: SessionSummary): string {
  for (const turn of session.turns ?? []) {
    const provider = turn.assistantCalls?.[0]?.provider
    if (provider) return provider
  }

  const models = Object.keys(session.modelBreakdown ?? {})
  const model = models[0]?.toLowerCase() ?? ''
  if (model.startsWith('claude')) return 'claude'
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex'
  if (model.startsWith('gemini')) return 'gemini'
  if (model.includes('/')) return model.split('/', 1)[0] || 'unknown'
  return 'unknown'
}

/** Per-call displayed output. Missing usage/fields are 0 so aggregate-only and stub calls cannot crash. */
export function callBillableOutputTokens(call: CallLike): number {
  const usage = call.usage
  if (!usage) return 0
  return billableOutputTokens(
    call.provider ?? 'unknown',
    usage.outputTokens ?? 0,
    usage.reasoningTokens ?? 0,
  )
}

/** Display/report output: exclusive providers add reasoning; inclusive ones do not. */
export function sessionBillableOutputTokens(session: SessionSummary): number {
  return sessionBillableOutput(session).total
}
