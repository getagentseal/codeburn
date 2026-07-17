type ActiveCurrency = { code: string; symbol: string; rate: number }

// Single source of truth for display currency. App.tsx sets it from the overview
// payload; every formatUsd/formatConverted call site then converts for free.
// Defaults to USD so the first render (before the payload arrives) is correct.
let activeCurrency: ActiveCurrency = { code: 'USD', symbol: '$', rate: 1 }

export function setActiveCurrency(currency: ActiveCurrency): void {
  activeCurrency = currency
}

/** Raw-USD input: multiplies by the active FX rate, then prefixes the symbol. */
export function formatUsd(n: number): string {
  return formatConverted(n * activeCurrency.rate)
}

/**
 * Already-converted input (CLI-side convertCost values, e.g. plan budgets): only
 * prefixes the active symbol and formats the magnitude — never re-applies the rate.
 */
export function formatConverted(n: number): string {
  return `${activeCurrency.symbol}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Shorten filesystem and CLI-mangled project paths to their useful trailing segments. */
export function shortenProjectPath(value: string, maxSegments = 3): string {
  const trimmed = value.trim()
  const pathDelimited = /[\\/]/.test(trimmed)
  const parts = trimmed.split(pathDelimited ? /[\\/]+/ : /-+/).filter(Boolean)
  let displayParts = parts.slice(-Math.max(1, maxSegments))

  // A tail rooted directly under a home directory starts with the user name,
  // which adds noise rather than useful project context.
  const precedingPart = parts.at(-(displayParts.length + 1))
  if (displayParts.length > 1 && /^(users?|home)$/i.test(precedingPart ?? '')) {
    displayParts = displayParts.slice(1)
  }

  if (/^(projects|src|config)$/i.test(displayParts[0] ?? '')) {
    displayParts[0] = displayParts[0].toLowerCase()
  }

  return displayParts.join('/') || trimmed
}

/** Compact token/count formatting: 1_842 → "1.8K", 184_000 → "184K", 1_200_000 → "1.2M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1_000) return String(Math.round(n))
  if (abs < 1_000_000) return `${trim(n / 1_000)}K`
  if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

// One decimal, but drop a trailing ".0" (184.0K → "184K", 1.2K stays "1.2K").
function trim(v: number): string {
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** "Jul 10" — short month + day, no year. */
export function formatDayShort(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** "Jul 10, 2026" — full date. */
export function formatDayLong(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "2h 14m" / "47m" / "38s" from a duration in ms. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return `${Math.round(ms / 1000)}s`
  if (totalMin < 60) return `${totalMin}m`
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`
}
