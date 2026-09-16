import { billableOutputTokens, modelRowKey } from './models.js'
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
export function modelBreakdownKey(call: { provider?: string; model?: string; route?: string }): string | undefined {
  if (!call.model) return undefined
  return call.provider === 'devin' ? call.model : modelRowKey(call.model, call.route)
}

/**
 * Prefer a key that already exists on this session's modelBreakdown.
 * Parser sessions are keyed by modelRowKey. Fixtures and leftover
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
 * Per-model displayed output, keyed like this session's `modelBreakdown`.
 * Call usage wins while provider identity is known. Aggregate-only /
 * stub sessions fall back to each existing bucket so a finite
 * sessionBillableOutputTokens cannot leave model Output Tokens at 0.
 */
export function sessionModelBillableOutputTokens(session: SessionSummary): Record<string, number> {
  const breakdown = session.modelBreakdown ?? {}
  const out: Record<string, number> = {}
  let sawUsage = false
  for (const turn of session.turns ?? []) {
    for (const call of turn.assistantCalls ?? []) {
      if (!call.usage) continue
      sawUsage = true
      const key = resolveModelBreakdownKey(call, breakdown)
      if (!key) continue
      out[key] = (out[key] ?? 0) + callBillableOutputTokens(call)
    }
  }
  if (sawUsage) return out
  const provider = inferSessionProvider(session)
  for (const [model, d] of Object.entries(session.modelBreakdown ?? {})) {
    out[model] = billableOutputTokens(
      provider,
      d.tokens?.outputTokens ?? 0,
      d.tokens?.reasoningTokens ?? 0,
    )
  }
  return out
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
  let fromCalls = 0
  let sawUsage = false
  for (const turn of session.turns ?? []) {
    for (const call of turn.assistantCalls ?? []) {
      if (!call.usage) continue
      sawUsage = true
      fromCalls += callBillableOutputTokens(call)
    }
  }
  if (sawUsage) return fromCalls
  return billableOutputTokens(
    inferSessionProvider(session),
    session.totalOutputTokens ?? 0,
    session.totalReasoningTokens ?? 0,
  )
}
