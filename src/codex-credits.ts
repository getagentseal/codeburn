// Codex credit pricing. ChatGPT/Codex subscription users consume *credits*, a
// separate unit from API dollars: usage is billed as "credits per million
// tokens" at per-model rates that differ from the API USD pricing CodeBurn uses
// for cost. This module computes credit consumption from token counts so the
// app can show usage in credits (issues #408 and #495).
//
// Rates are credits per 1,000,000 tokens, from
// https://developers.openai.com/codex/pricing#credits-overview
// (cached input is the cheaper rate applied to cache-read tokens).

export type CodexCreditRate = {
  input: number
  cachedInput: number
  output: number
}

const CREDITS_PER_MILLION: Record<string, CodexCreditRate> = {
  'gpt-5.5': { input: 125, cachedInput: 12.5, output: 750 },
  'gpt-5.4': { input: 62.5, cachedInput: 6.25, output: 375 },
  'gpt-5.4-mini': { input: 18.75, cachedInput: 1.875, output: 113 },
}

// Activity surfaces keep their product id on the call (display stays
// "Codex Auto Review"). Credits must follow the same underlying model
// BUILTIN_ALIASES uses for USD. Keep this table in lockstep with
// `codex-auto-review` in src/models.ts.
const ACTIVITY_CREDIT_MODELS: Record<string, string> = {
  'codex-auto-review': 'gpt-5.5',
}

/// Resolve the credit rate for a Codex model name, tolerating suffix variants
/// (e.g. "gpt-5.5-codex"). Returns null when the model has no known credit rate.
export function codexCreditRate(model: string): CodexCreditRate | null {
  const mapped = ACTIVITY_CREDIT_MODELS[model] ?? ACTIVITY_CREDIT_MODELS[model.toLowerCase()]
  const m = (mapped ?? model).toLowerCase()
  // Match the version only at a token boundary (start/'-' before, '-'/end
  // after) so a bare `includes('5.4')` can't catch a substring. The tokens
  // AFTER the version give the SKU tier: only the base and `-mini` SKUs have
  // credit rates, so a distinct sibling tier (gpt-5.4-pro, gpt-5.4-nano) must
  // fall through to the unknown fallback instead of billing at the base rate.
  const match = m.match(/(?:^|-)(5\.[45])(?:-|$)/)
  if (!match) return null
  const version = match[1]!
  const tierTokens = m.slice(match.index! + match[0].length).split('-')
  if (tierTokens.includes('pro') || tierTokens.includes('nano')) return null
  if (version === '5.4' && tierTokens.includes('mini')) return CREDITS_PER_MILLION['gpt-5.4-mini']!
  if (version === '5.4') return CREDITS_PER_MILLION['gpt-5.4']!
  return CREDITS_PER_MILLION['gpt-5.5']!
}

export type CodexCreditTokens = {
  /// Non-cached input tokens (CodeBurn normalizes Codex to Anthropic semantics,
  /// so this excludes cache-read tokens).
  inputTokens: number
  /// Cache-read (cached input) tokens, billed at the cheaper cached rate.
  cachedReadTokens: number
  /// Billable output tokens: reasoning is already included (billableOutputTokens
  /// in models.ts), so callers must not add it on top here.
  outputTokens: number
}

/// Credits consumed for one Codex usage record. Returns null when the model has
/// no known credit rate (caller decides how to surface "unknown").
export function codexCredits(model: string, tokens: CodexCreditTokens): number | null {
  const rate = codexCreditRate(model)
  if (!rate) return null
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
  const PER_MILLION = 1_000_000
  return (
    (safe(tokens.inputTokens) / PER_MILLION) * rate.input +
    (safe(tokens.cachedReadTokens) / PER_MILLION) * rate.cachedInput +
    (safe(tokens.outputTokens) / PER_MILLION) * rate.output
  )
}
