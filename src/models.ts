import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export type ModelCosts = {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheWriteCostPerToken: number
  cacheReadCostPerToken: number
  webSearchCostPerRequest: number
  fastMultiplier: number
}

type LiteLLMEntry = {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  provider_specific_entry?: { fast?: number }
}

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WEB_SEARCH_COST = 0.01

const FALLBACK_PRICING: Record<string, ModelCosts> = {
  'claude-opus-4-7': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 6 },
  'claude-opus-4-6': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 6 },
  'claude-opus-4-5': { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheWriteCostPerToken: 6.25e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4-1': { inputCostPerToken: 15e-6, outputCostPerToken: 75e-6, cacheWriteCostPerToken: 18.75e-6, cacheReadCostPerToken: 1.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4': { inputCostPerToken: 15e-6, outputCostPerToken: 75e-6, cacheWriteCostPerToken: 18.75e-6, cacheReadCostPerToken: 1.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4-6': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4-5': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-7-sonnet': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-5-sonnet': { inputCostPerToken: 3e-6, outputCostPerToken: 15e-6, cacheWriteCostPerToken: 3.75e-6, cacheReadCostPerToken: 0.3e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-haiku-4-5': { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6, cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.1e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-5-haiku': { inputCostPerToken: 0.8e-6, outputCostPerToken: 4e-6, cacheWriteCostPerToken: 1e-6, cacheReadCostPerToken: 0.08e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4o': { inputCostPerToken: 2.5e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 2.5e-6, cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4o-mini': { inputCostPerToken: 0.15e-6, outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.15e-6, cacheReadCostPerToken: 0.075e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-2.5-pro': { inputCostPerToken: 1.25e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.315e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.3-codex': { inputCostPerToken: 2.5e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 2.5e-6, cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.4': { inputCostPerToken: 2.5e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 2.5e-6, cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.4-mini': { inputCostPerToken: 0.4e-6, outputCostPerToken: 1.6e-6, cacheWriteCostPerToken: 0.4e-6, cacheReadCostPerToken: 0.2e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5': { inputCostPerToken: 2.5e-6, outputCostPerToken: 10e-6, cacheWriteCostPerToken: 2.5e-6, cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5-mini': { inputCostPerToken: 0.4e-6, outputCostPerToken: 1.6e-6, cacheWriteCostPerToken: 0.4e-6, cacheReadCostPerToken: 0.2e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1': { inputCostPerToken: 2e-6, outputCostPerToken: 8e-6, cacheWriteCostPerToken: 2e-6, cacheReadCostPerToken: 0.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1-mini': { inputCostPerToken: 0.4e-6, outputCostPerToken: 1.6e-6, cacheWriteCostPerToken: 0.4e-6, cacheReadCostPerToken: 0.1e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1-nano': { inputCostPerToken: 0.1e-6, outputCostPerToken: 0.4e-6, cacheWriteCostPerToken: 0.1e-6, cacheReadCostPerToken: 0.025e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o3': { inputCostPerToken: 10e-6, outputCostPerToken: 40e-6, cacheWriteCostPerToken: 10e-6, cacheReadCostPerToken: 2.5e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o4-mini': { inputCostPerToken: 1.1e-6, outputCostPerToken: 4.4e-6, cacheWriteCostPerToken: 1.1e-6, cacheReadCostPerToken: 0.275e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
}

let pricingCache: Map<string, ModelCosts> | null = null

function getCacheDir(): string {
  return join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), 'litellm-pricing.json')
}

function parseLiteLLMEntry(entry: LiteLLMEntry): ModelCosts | null {
  if (entry.input_cost_per_token === undefined || entry.output_cost_per_token === undefined) return null
  return {
    inputCostPerToken: entry.input_cost_per_token,
    outputCostPerToken: entry.output_cost_per_token,
    cacheWriteCostPerToken: entry.cache_creation_input_token_cost ?? entry.input_cost_per_token * 1.25,
    cacheReadCostPerToken: entry.cache_read_input_token_cost ?? entry.input_cost_per_token * 0.1,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: entry.provider_specific_entry?.fast ?? 1,
  }
}

async function fetchAndCachePricing(): Promise<Map<string, ModelCosts>> {
  const response = await fetch(LITELLM_URL)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json() as Record<string, LiteLLMEntry>
  const pricing = new Map<string, ModelCosts>()

  for (const [name, entry] of Object.entries(data)) {
    const costs = parseLiteLLMEntry(entry)
    if (!costs) continue
    pricing.set(name, costs)
    // Also index by stripped name so lookups work without provider prefix:
    // 'anthropic/claude-opus-4-6' is also queryable as 'claude-opus-4-6'.
    // First write wins so direct-provider entries take precedence over re-hosters.
    const stripped = name.replace(/^[^/]+\//, '')
    if (stripped !== name && !pricing.has(stripped)) pricing.set(stripped, costs)
  }

  await mkdir(getCacheDir(), { recursive: true })
  await writeFile(getCachePath(), JSON.stringify({
    timestamp: Date.now(),
    data: Object.fromEntries(pricing),
  }))

  return pricing
}

async function loadCachedPricing(): Promise<Map<string, ModelCosts> | null> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cached = JSON.parse(raw) as { timestamp: number; data: Record<string, ModelCosts> }
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
    return new Map(Object.entries(cached.data))
  } catch {
    return null
  }
}

export async function loadPricing(): Promise<void> {
  const cached = await loadCachedPricing()
  if (cached) {
    pricingCache = cached
    return
  }

  try {
    pricingCache = await fetchAndCachePricing()
  } catch {
    pricingCache = new Map(Object.entries(FALLBACK_PRICING))
  }
}

function getCanonicalName(model: string): string {
  return model
    .replace(/@.*$/, '')
    .replace(/-\d{8}$/, '')
}

export function getModelCosts(model: string): ModelCosts | null {
  const canonical = getCanonicalName(model)

  if (pricingCache?.has(canonical)) return pricingCache.get(canonical)!

  for (const [key, costs] of Object.entries(FALLBACK_PRICING)) {
    if (canonical === key || canonical.startsWith(key + '-')) return costs
  }

  for (const [key, costs] of pricingCache ?? new Map()) {
    if (canonical.startsWith(key)) return costs
  }

  for (const [key, costs] of Object.entries(FALLBACK_PRICING)) {
    if (canonical.startsWith(key)) return costs
  }

  return null
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
): number {
  const costs = getModelCosts(model)
  if (!costs) return 0

  const multiplier = speed === 'fast' ? costs.fastMultiplier : 1

  return multiplier * (
    inputTokens * costs.inputCostPerToken +
    outputTokens * costs.outputCostPerToken +
    cacheCreationTokens * costs.cacheWriteCostPerToken +
    cacheReadTokens * costs.cacheReadCostPerToken +
    webSearchRequests * costs.webSearchCostPerRequest
  )
}

export function getShortModelName(model: string): string {
  const canonical = getCanonicalName(model)
  const shortNames: Record<string, string> = {
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-opus-4-5': 'Opus 4.5',
    'claude-opus-4-1': 'Opus 4.1',
    'claude-opus-4': 'Opus 4',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-sonnet-4-5': 'Sonnet 4.5',
    'claude-sonnet-4': 'Sonnet 4',
    'claude-3-7-sonnet': 'Sonnet 3.7',
    'claude-3-5-sonnet': 'Sonnet 3.5',
    'claude-haiku-4-5': 'Haiku 4.5',
    'claude-3-5-haiku': 'Haiku 3.5',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4o': 'GPT-4o',
    'gpt-4.1-nano': 'GPT-4.1 Nano',
    'gpt-4.1-mini': 'GPT-4.1 Mini',
    'gpt-4.1': 'GPT-4.1',
    'gpt-5.4-mini': 'GPT-5.4 Mini',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.3-codex': 'GPT-5.3 Codex',
    'gpt-5-mini': 'GPT-5 Mini',
    'gpt-5': 'GPT-5',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'o4-mini': 'o4-mini',
    'o3': 'o3',
  }
  for (const [key, name] of Object.entries(shortNames)) {
    if (canonical.startsWith(key)) return name
  }
  return canonical
}
