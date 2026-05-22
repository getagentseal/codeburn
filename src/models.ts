import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import snapshotData from './data/litellm-snapshot.json'

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

type SnapshotEntry = [number, number, number | null, number | null]

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WEB_SEARCH_COST = 0.01
const ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE = 1.6

const FAST_MULTIPLIERS: Record<string, number> = {
  'claude-opus-4-7': 6,
  'claude-opus-4-6': 6,
}

function loadSnapshot(): Map<string, ModelCosts> {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(snapshotData as unknown as Record<string, SnapshotEntry>)) {
    const [input, output, cacheWrite, cacheRead] = raw
    map.set(name, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheWriteCostPerToken: cacheWrite ?? input * 1.25,
      cacheReadCostPerToken: cacheRead ?? input * 0.1,
      webSearchCostPerRequest: WEB_SEARCH_COST,
      fastMultiplier: FAST_MULTIPLIERS[name] ?? 1,
    })
  }
  return map
}

let pricingCache: Map<string, ModelCosts> = loadSnapshot()
let sortedPricingKeys: string[] | null = null

function getSortedPricingKeys(): string[] {
  if (sortedPricingKeys === null) {
    sortedPricingKeys = Array.from(pricingCache.keys()).sort((a, b) => b.length - a.length)
  }
  return sortedPricingKeys
}

function getCacheDir(): string {
  if (process.env['CODEBURN_CACHE_DIR']) return process.env['CODEBURN_CACHE_DIR']
  return join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), 'litellm-pricing.json')
}

/// Clamp a per-token rate to a sane non-negative value. Defense in depth
/// against a tampered LiteLLM JSON shipping a negative `input_cost_per_token`,
/// which would otherwise produce negative costs that subtract from totals.
/// We use Number.isFinite to also reject NaN/Infinity, and cap at $1/token
/// (well above the most expensive frontier model) so a stray decimal-place
/// shift in the upstream JSON can't wildly inflate spend numbers either.
function safePerTokenRate(n: number | undefined): number | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null
  if (n > 1) return 1
  return n
}

function parseLiteLLMEntry(entry: LiteLLMEntry): ModelCosts | null {
  const inputCost = safePerTokenRate(entry.input_cost_per_token)
  const outputCost = safePerTokenRate(entry.output_cost_per_token)
  if (inputCost === null || outputCost === null) return null
  const cacheWrite = safePerTokenRate(entry.cache_creation_input_token_cost) ?? inputCost * 1.25
  const cacheRead = safePerTokenRate(entry.cache_read_input_token_cost) ?? inputCost * 0.1
  return {
    inputCostPerToken: inputCost,
    outputCostPerToken: outputCost,
    cacheWriteCostPerToken: cacheWrite,
    cacheReadCostPerToken: cacheRead,
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

function mergeSnapshotFallbacks(pricing: Map<string, ModelCosts>): Map<string, ModelCosts> {
  for (const [name, costs] of loadSnapshot()) {
    if (!pricing.has(name)) pricing.set(name, costs)
  }
  return pricing
}

export async function loadPricing(): Promise<void> {
  const cached = await loadCachedPricing()
  if (cached) {
    pricingCache = mergeSnapshotFallbacks(cached)
    sortedPricingKeys = null
    return
  }

  try {
    pricingCache = mergeSnapshotFallbacks(await fetchAndCachePricing())
    sortedPricingKeys = null
  } catch {
    // snapshot already loaded at init; nothing more to do
  }
}

// Known model name variants that providers emit but LiteLLM/fallback don't index under.
// OMP emits 'anthropic--claude-4.6-opus' (double-dash, dot version, tier-last).
// getCanonicalName strips any 'provider/' prefix first, so only the post-strip
// forms need to be listed here.
const BUILTIN_ALIASES: Record<string, string> = {
  'anthropic--claude-4.6-opus':    'claude-opus-4-6',
  'anthropic--claude-4.6-sonnet':  'claude-sonnet-4-6',
  'anthropic--claude-4.5-opus':    'claude-opus-4-5',
  'anthropic--claude-4.5-sonnet':  'claude-sonnet-4-5',
  'anthropic--claude-4.5-haiku':   'claude-haiku-4-5',
  'claude-sonnet-4.6':             'claude-sonnet-4-6',
  'claude-sonnet-4.5':             'claude-sonnet-4-5',
  'claude-opus-4.7':               'claude-opus-4-7',
  'claude-opus-4.6':               'claude-opus-4-6',
  'claude-opus-4.5':               'claude-opus-4-5',
  'cursor-auto':                    'claude-sonnet-4-5',
  'cursor-agent-auto':             'claude-sonnet-4-5',
  'copilot-auto':                  'claude-sonnet-4-5',
  'copilot-openai-auto':           'gpt-5.3-codex',
  'copilot-anthropic-auto':        'claude-sonnet-4-5',
  'ibm-bob-auto':                  'claude-sonnet-4-5',
  'kiro-auto':                     'claude-sonnet-4-5',
  'cline-auto':                    'claude-sonnet-4-5',
  'openclaw-auto':                 'claude-sonnet-4-5',
  'warp-auto-efficient':           'gpt-5.3-codex',
  'warp-auto-powerful':            'claude-opus-4-6',
  'GPT-5.3 Codex (low reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (medium reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (high reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (extra high reasoning)': 'gpt-5.3-codex',
  'Claude Sonnet 4.6':             'claude-sonnet-4-6',
  'Claude Sonnet 4.5':             'claude-sonnet-4-5',
  'Claude Haiku 4.5':              'claude-haiku-4-5',
  'Claude Opus 4.6':               'claude-opus-4-6',
  'qwen-auto':                     'claude-sonnet-4-5',
  'kimi-auto':                     'kimi-k2-thinking',
  'kimi-code':                     'kimi-k2-thinking',
  'kimi-for-coding':               'kimi-k2-thinking',
  // Cursor emits dot-version tier-last names plus tier/reasoning suffixes
  // that LiteLLM does not index (`-high`, `-low`, `-medium`, `-thinking`,
  // `-high-thinking`, `-fast-mode`). Missing aliases here surface as $0 in
  // the dashboard for users on non-Auto models (issue #159). Sources: the
  // display map at `src/providers/cursor.ts:modelDisplayNames`, Cursor's
  // public model docs at https://cursor.com/docs/models, and forum bug
  // reports that quote literal slugs (e.g. forum.cursor.com/t/154933).
  'claude-4-sonnet':                'claude-sonnet-4',
  'claude-4-sonnet-1m':             'claude-sonnet-4',
  'claude-4-sonnet-thinking':       'claude-sonnet-4-5',
  'claude-4.5-sonnet':              'claude-sonnet-4-5',
  'claude-4.5-sonnet-thinking':     'claude-sonnet-4-5',
  'claude-4.6-sonnet':              'claude-sonnet-4-6',
  'claude-4.6-sonnet-high':         'claude-sonnet-4-6',
  'claude-4.6-sonnet-low':          'claude-sonnet-4-6',
  'claude-4.6-sonnet-thinking':     'claude-sonnet-4-6',
  'claude-4.6-sonnet-high-thinking':'claude-sonnet-4-6',
  'claude-4-opus':                  'claude-opus-4',
  'claude-4.5-opus':                'claude-opus-4-5',
  'claude-4.5-opus-high':           'claude-opus-4-5',
  'claude-4.5-opus-low':            'claude-opus-4-5',
  'claude-4.5-opus-medium':         'claude-opus-4-5',
  'claude-4.5-opus-high-thinking':  'claude-opus-4-5',
  'claude-4.6-opus':                'claude-opus-4-6',
  'claude-4.6-opus-fast-mode':      'claude-opus-4-6',
  'claude-4.6-opus-high':           'claude-opus-4-6',
  'claude-4.6-opus-low':            'claude-opus-4-6',
  'claude-4.6-opus-medium':         'claude-opus-4-6',
  'claude-4.6-opus-high-thinking':  'claude-opus-4-6',
  'claude-4.7-opus':                'claude-opus-4-7',
  // Dash form (NOT dot) seen in forum.cursor.com/t/158597.
  'claude-opus-4-7-thinking-high':  'claude-opus-4-7',
  'claude-4.5-haiku':               'claude-haiku-4-5',
  'claude-4.6-haiku':               'claude-haiku-4-5',
  // Cursor's house models have no LiteLLM pricing entry. composer-1 is
  // sonnet-4.5-class per Cursor docs; composer-2 is built on Sonnet 4.6
  // per cursor.com/blog/composer-2.
  'composer-1':                     'claude-sonnet-4-5',
  'composer-1.5':                   'claude-sonnet-4-5',
  'composer-2':                     'claude-sonnet-4-6',
  // Cursor's "fast" routing variant of GPT-5 is the same model behind a
  // lower-latency endpoint; price as base GPT-5 until LiteLLM tracks it.
  'gpt-5-fast':                     'gpt-5',
  'gpt-4.1':                        'gpt-4.1',
  'gpt-5.2-low':                    'gpt-5',
  'gpt-5.1-codex-high':             'gpt-5.3-codex',
  // Antigravity Gemini model IDs resolve to preview-priced entries.
  'gemini-3.1-pro':                 'gemini-3.1-pro-preview',
  'gemini-3-flash':                 'gemini-3-flash-preview',
  'gemini-3.1-pro-high':            'gemini-3.1-pro-preview',
  'gemini-3.1-pro-low':             'gemini-3.1-pro-preview',
  'gemini-3-flash-agent':           'gemini-3-flash-preview',
  'gemini-3.5-flash-high':          'gemini-3.5-flash',
  'gemini-3.5-flash-medium':        'gemini-3.5-flash',
  'gemini-3.5-flash-low':           'gemini-3.5-flash',
  'Gemini 3.5 Flash (High)':        'gemini-3.5-flash',
  'Gemini 3.5 Flash (Medium)':      'gemini-3.5-flash',
  'Gemini 3.5 Flash (Low)':         'gemini-3.5-flash',
  'gemini-3-pro':                   'gemini-3-pro-preview',
  'gemini-3.1-flash-image':         'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite':          'gemini-3.1-flash-lite-preview',
}

let userAliases: Record<string, string> = {}

// Called once during CLI startup after config is loaded.
// User aliases take precedence over built-ins.
export function setModelAliases(aliases: Record<string, string>): void {
  userAliases = aliases
}

function resolveAlias(model: string): string {
  if (Object.hasOwn(userAliases, model)) return userAliases[model]!
  if (Object.hasOwn(BUILTIN_ALIASES, model)) return BUILTIN_ALIASES[model]!
  return model
}
function getCanonicalName(model: string): string {
  return model
    .replace(/@.*$/, '')       // strip pin: claude-sonnet-4-6@20250929 -> claude-sonnet-4-6
    .replace(/-\d{8}$/, '')   // strip date: claude-sonnet-4-20250514 -> claude-sonnet-4
    .replace(/^[^/]+\//, '') // strip provider prefix: anthropic/foo -> foo
}

export function getModelCosts(model: string): ModelCosts | null {
  // Try with provider prefix preserved (azure/gpt-5.4, openrouter/anthropic/claude-opus-4.6)
  const withPrefix = model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
  if (pricingCache.has(withPrefix)) return pricingCache.get(withPrefix)!

  const canonical = resolveAlias(getCanonicalName(model))
  if (pricingCache.has(canonical)) return pricingCache.get(canonical)!

  // Iterate keys longest-first so a model id like `gpt-5-mini` matches the
  // `gpt-5-mini` entry rather than collapsing to the shorter `gpt-5` entry
  // due to dictionary insertion order.
  for (const key of getSortedPricingKeys()) {
    if (canonical.startsWith(key + '-') || canonical === key) {
      return pricingCache.get(key)!
    }
  }

  return null
}

// Warn at most once per unknown model name per process. Without this, a model
// missing from the pricing snapshot would silently price at $0 for every
// session that used it, hiding real spend until the user noticed.
const warnedUnknownModels = new Set<string>()

/// Heuristic for "this looks like a local model that will never be in LiteLLM's
/// pricing JSON". We suppress the unknown-model warning for these because the
/// "update codeburn" advice can't help — local Ollama models, llama.cpp tags,
/// LM Studio loads, etc. are billed locally and don't have public pricing.
/// Users still get $0 in cost reports for them (correct — local inference is
/// effectively free); the warning was just noise.
function looksLikeLocalModel(name: string): boolean {
  // Ollama and LM Studio tags include `:tag` (e.g. qwen3.6:35b-a3b-bf16).
  if (name.includes(':') && !name.startsWith('http')) return true
  // GGUF / quantized fingerprints commonly seen in local inference.
  if (/[-_](q[2-8](_[a-z0-9]+)?|bf16|fp16|gguf|f16|f32)$/i.test(name)) return true
  return false
}

function shouldWarnAboutUnknownModel(name: string): boolean {
  if (!name || name === '<synthetic>') return false
  if (warnedUnknownModels.has(name)) return false
  // Suppress for local/quantized models — the "update codeburn" hint is
  // actively misleading there. Users who need cost visibility for local
  // inference can still set an alias via `codeburn model-alias`.
  if (looksLikeLocalModel(name)) return false
  // The warning fired on every CLI invocation (including the default
  // dashboard) which made first launches look broken — three "no pricing
  // data" lines greet a user before the dashboard even draws. Now opt-in
  // via --verbose. The unknown model still costs $0 in reports; users who
  // suspect missing models run `codeburn --verbose` to see the list.
  if (process.env['CODEBURN_VERBOSE'] !== '1') return false
  return true
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  oneHourCacheCreationTokens = 0,
): number {
  const costs = getModelCosts(model)
  if (!costs) {
    if (shouldWarnAboutUnknownModel(model)) {
      warnedUnknownModels.add(model)
      // Strip control characters and cap length: model names come from JSONL
      // payloads written by external tools, so a hostile or corrupt file
      // could embed terminal escape sequences here.
      const safeName = model.replace(/[\x00-\x1F\x7F-\x9F]/g, '?').slice(0, 200)
      const aliasHint = `Map it with: codeburn model-alias "${safeName}" <known-model>`
      process.stderr.write(
        `codeburn: no pricing data for model "${safeName}" — costs for this model will show $0. ` +
        `${aliasHint}, or update with: npx codeburn@latest.\n`
      )
    }
    return 0
  }

  const multiplier = speed === 'fast' ? costs.fastMultiplier : 1

  // Clamp negative inputs to 0. A corrupt JSONL that emits a negative token
  // count would otherwise produce a negative cost that silently subtracts
  // from real spend in aggregate totals. NaN is also handled here; the
  // arithmetic below short-circuits to 0 when any operand is non-finite.
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
  const safeOneHourCacheCreation = safe(oneHourCacheCreationTokens)
  const safeCacheCreation = Math.max(safe(cacheCreationTokens), safeOneHourCacheCreation)
  const safeFiveMinuteCacheCreation = Math.max(0, safeCacheCreation - safeOneHourCacheCreation)

  return multiplier * (
    safe(inputTokens) * costs.inputCostPerToken +
    safe(outputTokens) * costs.outputCostPerToken +
    safeFiveMinuteCacheCreation * costs.cacheWriteCostPerToken +
    safeOneHourCacheCreation * costs.cacheWriteCostPerToken * ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE +
    safe(cacheReadTokens) * costs.cacheReadCostPerToken +
    safe(webSearchRequests) * costs.webSearchCostPerRequest
  )
}

const autoModelNames: Record<string, string> = {
  'cursor-auto': 'Cursor (auto)',
  'cursor-agent-auto': 'Cursor (auto)',
  'copilot-auto': 'Copilot (auto)',
  'copilot-openai-auto': 'Copilot (OpenAI)',
  'copilot-anthropic-auto': 'Copilot (Anthropic)',
  'ibm-bob-auto': 'IBM Bob (auto)',
  'kiro-auto': 'Kiro (auto)',
  'cline-auto': 'Cline (auto)',
  'openclaw-auto': 'OpenClaw (auto)',
  'qwen-auto': 'Qwen (auto)',
  'kimi-auto': 'Kimi (auto)',
}

const SHORT_NAMES: Record<string, string> = {
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
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5-pro': 'GPT-5.5 Pro',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-pro': 'GPT-5.4 Pro',
  'gpt-5.4-nano': 'GPT-5.4 Nano',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3': 'GPT-5.3',
  'gpt-5.2-pro': 'GPT-5.2 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5.1-codex': 'GPT-5.1 Codex',
  'gpt-5.1': 'GPT-5.1',
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-5-nano': 'GPT-5 Nano',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'kimi-k2-thinking-turbo': 'Kimi K2 Thinking Turbo',
  'kimi-k2-thinking': 'Kimi K2 Thinking',
  'kimi-thinking-preview': 'Kimi Thinking',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2p5': 'Kimi K2.5',
  'kimi-k2-instruct': 'Kimi K2 Instruct',
  'kimi-k2-0905': 'Kimi K2',
  'kimi-k2': 'Kimi K2',
  'kimi-latest': 'Kimi Latest',
  'moonshot-v1': 'Moonshot v1',
  'deepseek-v4-pro': 'DeepSeek v4 Pro',
  'deepseek-v4-flash': 'DeepSeek v4 Flash',
  'deepseek-coder-max': 'DeepSeek Coder Max',
  'deepseek-coder': 'DeepSeek Coder',
  'deepseek-r1': 'DeepSeek R1',
  'o4-mini': 'o4-mini',
  'o3': 'o3',
  'MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
  'MiniMax-M2.7': 'MiniMax M2.7',
}

// Sorted longest-first so more-specific prefixes match before shorter ones.
// Without this, `gpt-5-mini` could resolve to "GPT-5" (the entry for `gpt-5`)
// if it happened to be iterated before `gpt-5-mini`, hiding a distinct model
// behind the wrong display name and pricing tier.
const SORTED_SHORT_NAMES: [string, string][] = Object.entries(SHORT_NAMES)
  .sort((a, b) => b[0].length - a[0].length)

export function getShortModelName(model: string): string {
  if (autoModelNames[model]) return autoModelNames[model]
  const canonical = resolveAlias(getCanonicalName(model))
  for (const [key, name] of SORTED_SHORT_NAMES) {
    if (canonical.startsWith(key)) return name
  }
  return canonical
}
