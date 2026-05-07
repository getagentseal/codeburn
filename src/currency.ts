import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { readConfig } from './config.js'

type CurrencyState = {
  code: string
  rate: number
  symbol: string
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD&to='
// Defensive bounds on any fetched FX rate. Outside this band the rate is either a parser bug
// or a tampered Frankfurter response, and we refuse to multiply it into displayed costs.
const MIN_VALID_FX_RATE = 0.0001
const MAX_VALID_FX_RATE = 1_000_000

function isValidRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_VALID_FX_RATE
    && value <= MAX_VALID_FX_RATE
}

let active: CurrencyState = { code: 'USD', rate: 1, symbol: '$' }

const USD: CurrencyState = { code: 'USD', rate: 1, symbol: '$' }

// Intl.NumberFormat throws on invalid ISO 4217 codes, so we use it as a validator
export function isValidCurrencyCode(code: string): boolean {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code })
    return true
  } catch {
    return false
  }
}

function resolveSymbol(code: string): string {
  const parts = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'symbol',
  }).formatToParts(0)
  return parts.find(p => p.type === 'currency')?.value ?? code
}

function getFractionDigits(code: string): number {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
  }).resolvedOptions().maximumFractionDigits ?? 2
}

function getCacheDir(): string {
  return join(homedir(), '.cache', 'codeburn')
}

function getRateCachePath(): string {
  return join(getCacheDir(), 'exchange-rate.json')
}

async function fetchRate(code: string): Promise<number> {
  const response = await fetch(`${FRANKFURTER_URL}${code}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json() as { rates?: Record<string, unknown> }
  const rate = data.rates?.[code]
  if (!isValidRate(rate)) throw new Error(`Invalid rate returned for ${code}`)
  return rate
}

async function loadCachedRate(code: string): Promise<number | null> {
  try {
    const raw = await readFile(getRateCachePath(), 'utf-8')
    const cached = JSON.parse(raw) as Partial<{ timestamp: number; code: string; rate: number }>
    // Validate every field -- a tampered cache file could set rate to a string, null, or
    // Infinity and break downstream math silently.
    if (typeof cached.code !== 'string' || cached.code !== code) return null
    if (typeof cached.timestamp !== 'number' || !Number.isFinite(cached.timestamp)) return null
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
    if (!isValidRate(cached.rate)) return null
    return cached.rate
  } catch {
    return null
  }
}

async function cacheRate(code: string, rate: number): Promise<void> {
  await mkdir(getCacheDir(), { recursive: true })
  await writeFile(getRateCachePath(), JSON.stringify({ timestamp: Date.now(), code, rate }))
}

async function getExchangeRate(code: string): Promise<number> {
  if (code === 'USD') return 1

  const cached = await loadCachedRate(code)
  if (cached) return cached

  let rate: number
  try {
    rate = await fetchRate(code)
  } catch {
    return 1
  }
  // Persist the rate, but never let a cache-write failure (disk full, no
  // permissions, etc.) cause us to return the USD-equivalent fallback.
  // The original code wrapped fetch + cacheRate in one try/catch, so a
  // disk-full at write time would discard a perfectly good rate and silently
  // make every cost render as if the user had selected USD.
  cacheRate(code, rate).catch(() => {})
  return rate
}

export async function loadCurrency(): Promise<void> {
  const config = await readConfig()
  if (!config.currency) return

  const code = config.currency.code.toUpperCase()
  const rate = await getExchangeRate(code)
  const symbol = config.currency.symbol ?? resolveSymbol(code)

  active = { code, rate, symbol }
}

export function getCurrency(): CurrencyState {
  return active
}

export async function switchCurrency(code: string): Promise<void> {
  if (code === 'USD') {
    active = USD
    return
  }
  const rate = await getExchangeRate(code)
  const symbol = resolveSymbol(code)
  active = { code, rate, symbol }
}

export function getCostColumnHeader(): string {
  return `Cost (${active.code})`
}

export function convertCost(costUSD: number): number {
  // Return the unrounded converted cost. Rounding here meant zero-fraction
  // currencies (JPY, KRW, CLP) clamped every per-session cost to the nearest
  // whole unit before aggregation; a project with 1000 sessions averaging
  // ¥0.4 each would aggregate to ¥0 instead of ¥400 because each row was
  // rounded independently. formatCost (and the export rowsToCsv path) round
  // at the display boundary instead.
  return costUSD * active.rate
}

export function formatCost(costUSD: number): string {
  const { rate, symbol, code } = active
  const cost = costUSD * rate
  const digits = getFractionDigits(code)

  if (digits === 0) return `${symbol}${Math.round(cost)}`

  if (cost >= 1) return `${symbol}${cost.toFixed(2)}`
  if (cost >= 0.01) return `${symbol}${cost.toFixed(3)}`
  if (cost >= 0.0001) return `${symbol}${cost.toFixed(4)}`
  return `${symbol}${cost.toFixed(2)}`
}
