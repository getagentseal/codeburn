// Renderer-only daily budget setting (localStorage `codeburn.dailyBudget`).
// A 'usd' cap is raw-USD (compared against history.daily cost, then displayed
// via the currency-aware formatUsd); a 'tokens' cap counts input+output tokens.

export type DailyBudget = { kind: 'usd' | 'tokens'; value: number }

/** Parse the persisted budget, returning null when absent or malformed. */
export function readDailyBudget(): DailyBudget | null {
  let raw: string | null = null
  try { raw = globalThis.localStorage?.getItem('codeburn.dailyBudget') ?? null } catch { return null }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DailyBudget>
    if ((parsed.kind === 'usd' || parsed.kind === 'tokens') && typeof parsed.value === 'number' && Number.isFinite(parsed.value) && parsed.value > 0) {
      return { kind: parsed.kind, value: parsed.value }
    }
  } catch { /* malformed JSON */ }
  return null
}
