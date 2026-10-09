/// Currency formatting that mirrors the macOS app's Double.asCurrency / asCompactCurrency.
/// The Rust backend hands us { code, symbol, rate } so the frontend stays dumb about FX --
/// it just multiplies and renders.

export type CurrencyState = {
  code: string
  symbol: string
  rate: number
}

export const USD: CurrencyState = { code: 'USD', symbol: '$', rate: 1 }

/// SupportedCurrency in mac/.../AppStore.swift, in its order.
export const CURRENCY_CODES = [
  'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'NZD', 'JPY', 'CNY', 'CHF', 'INR',
  'BRL', 'SEK', 'SGD', 'HKD', 'KRW', 'MXN', 'ZAR', 'DKK', 'RON',
] as const

/// Only the settings window spells the currency out; the footer picker stays on the code.
export const CURRENCY_NAMES: Record<string, string> = {
  USD: 'US Dollar',
  GBP: 'British Pound',
  EUR: 'Euro',
  AUD: 'Australian Dollar',
  CAD: 'Canadian Dollar',
  NZD: 'New Zealand Dollar',
  JPY: 'Japanese Yen',
  CNY: 'Chinese Yuan',
  CHF: 'Swiss Franc',
  INR: 'Indian Rupee',
  BRL: 'Brazilian Real',
  SEK: 'Swedish Krona',
  SGD: 'Singapore Dollar',
  HKD: 'Hong Kong Dollar',
  KRW: 'South Korean Won',
  MXN: 'Mexican Peso',
  ZAR: 'South African Rand',
  DKK: 'Danish Krone',
  RON: 'Romanian Leu',
}

const SUB_CENT = 0.005

/// Wider format with thousands separators. Used for the hero value.
export function formatCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  const parts = converted.toFixed(2).split('.')
  const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${currency.symbol}${whole}.${parts[1]}`
}

/// Compact form (no thousands separators) used in dense tables where the monospace font
/// already gives visual grouping.
export const ESTIMATED_COST_LEGEND = '~ estimated cost (priced from estimated tokens)'

/// Same rule as the CLI (src/format.ts isEstimatedCost): `~` once the estimated
/// portion is at least 1% of the figure, unless `shown` reads as zero.
export function isEstimatedCost(cost: number, estimatedCostUSD: number | undefined, shown: string): boolean {
  const estimated = estimatedCostUSD ?? 0
  return estimated > 0 && estimated >= cost * 0.01 && /[1-9]/.test(shown)
}

export function formatCompactCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  return `${currency.symbol}${converted.toFixed(2)}`
}

/// For savings and other tiny amounts: never print a misleading "$0.00".
export function formatSmallCurrency(usdAmount: number, currency: CurrencyState): string {
  const converted = usdAmount * currency.rate
  if (converted > 0 && converted < SUB_CENT) return `<${currency.symbol}0.01`
  return formatCompactCurrency(usdAmount, currency)
}

/// Token compaction shared by every surface (the mac app rounds K to whole numbers).
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return `${Math.round(n)}`
}

const BADGE_THOUSAND = 1_000
const BADGE_MILLION = 1_000_000

/// The spend string drawn into the tray icon. Budget is a 16px-wide pixel grid, so at most
/// four glyph slots: "$9.5", "$87", "142", "1.2K", "12K", "0.1M". The `$` only fits when
/// there are two digits or fewer, and only USD has a glyph in the icon font.
export function trayBadgeText(usdAmount: number, currency: CurrencyState): string {
  const v = Math.max(0, usdAmount * currency.rate)
  const symbol = currency.code === 'USD' ? '$' : ''
  // Thresholds sit at the rounding boundary of the format above them, so "9.96" becomes
  // "$10" rather than "$10.0" and "999.7" becomes "1.0K" rather than "1000".
  if (v < 9.95) return `${symbol}${v.toFixed(1)}`
  if (v < 99.5) return `${symbol}${Math.round(v)}`
  if (v < 999.5) return `${Math.round(v)}`
  if (v < 9_950) return `${(v / BADGE_THOUSAND).toFixed(1)}K`
  if (v < 999_500) return `${Math.round(v / BADGE_THOUSAND)}K`
  return `${(v / BADGE_MILLION).toFixed(1)}M`
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}
