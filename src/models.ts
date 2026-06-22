import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import snapshotData from './data/litellm-snapshot.json'
import fallbackData from './data/pricing-fallback.json'
import { fetchWithTimeout } from './fetch-utils.js'

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

// [input, output, cacheWrite, cacheRead, fastMultiplier]. The trailing fast
// multiplier is carried straight from LiteLLM's provider_specific_entry.fast so
// new models pick it up automatically — no hand-maintained per-model table.
type SnapshotEntry = [number, number, number | null, number | null, (number | null)?]

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WEB_SEARCH_COST = 0.01
const ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE = 1.6

// Assemble a ModelCosts, applying the cache-cost heuristics (write = 1.25x
// input, read = 0.1x input) when a source omits them. Shared by the bundled
// tuple path (tupleToCosts) and the live LiteLLM path (parseLiteLLMEntry) so the
// multipliers live in exactly one place.
function buildCosts(
  input: number,
  output: number,
  cacheWrite: number | null | undefined,
  cacheRead: number | null | undefined,
  fast: number | null | undefined,
): ModelCosts {
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheWriteCostPerToken: cacheWrite ?? input * 1.25,
    cacheReadCostPerToken: cacheRead ?? input * 0.1,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: fast ?? 1,
  }
}

function tupleToCosts(raw: SnapshotEntry): ModelCosts {
  const [input, output, cacheWrite, cacheRead, fast] = raw
  return buildCosts(input, output, cacheWrite, cacheRead, fast)
}

function loadSnapshot(): Map<string, ModelCosts> {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(snapshotData as unknown as Record<string, SnapshotEntry>)) {
    map.set(name, tupleToCosts(raw))
  }
  return map
}

// Gap-fill pricing from models.dev / OpenRouter, keyed lowercase. Consulted ONLY
// as the last-resort fallback in getModelCosts (never for exact/canonical/prefix
// matches), so a reseller variant name can't shadow a real canonical entry.
const fallbackCosts: Map<string, ModelCosts> = (() => {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(fallbackData as unknown as Record<string, SnapshotEntry>)) {
    const lk = name.toLowerCase()
    if (!map.has(lk)) map.set(lk, tupleToCosts(raw))
  }
  return map
})()

let pricingCache: Map<string, ModelCosts> = loadSnapshot()
let sortedPricingKeys: string[] | null = null
let lowercasePricingIndex: Map<string, ModelCosts> | null = null

function getSortedPricingKeys(): string[] {
  if (sortedPricingKeys === null) {
    sortedPricingKeys = Array.from(pricingCache.keys()).sort((a, b) => b.length - a.length)
  }
  return sortedPricingKeys
}

// Case-insensitive index, built lazily. Lets a session model like `MiniMax-M3`
// resolve to a gap-filled OpenRouter key like `minimax-m3` (lowercase slug).
// First key wins on a lowercase collision so it stays deterministic.
//
// Zero-priced entries are excluded: LiteLLM ships `[0,0]` stubs (e.g.
// `GigaChat-2-Max`) for models it lists but has no price for. Indexing those
// would let a case-mismatched query (`gigachat-2-max`) resolve to a silent $0
// instead of returning null, which suppresses the unknown-model warning and
// hides real spend. A case-EXACT query still finds the stub via the normal
// pipeline; only the fuzzy case-insensitive path skips them.
function getLowercasePricingIndex(): Map<string, ModelCosts> {
  if (lowercasePricingIndex === null) {
    lowercasePricingIndex = new Map()
    const priced = (c: ModelCosts) => c.inputCostPerToken > 0 || c.outputCostPerToken > 0
    // The live pricing data wins on any lowercase collision; the gap-fill only
    // fills names that resolve to nothing through the normal pipeline.
    for (const [key, costs] of pricingCache) {
      const lk = key.toLowerCase()
      if (priced(costs) && !lowercasePricingIndex.has(lk)) lowercasePricingIndex.set(lk, costs)
    }
    for (const [lk, costs] of fallbackCosts) {
      if (priced(costs) && !lowercasePricingIndex.has(lk)) lowercasePricingIndex.set(lk, costs)
    }
  }
  return lowercasePricingIndex
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
  return buildCosts(
    inputCost,
    outputCost,
    safePerTokenRate(entry.cache_creation_input_token_cost),
    safePerTokenRate(entry.cache_read_input_token_cost),
    entry.provider_specific_entry?.fast,
  )
}

async function fetchAndCachePricing(): Promise<Map<string, ModelCosts>> {
  // Bounded: runs on every CLI invocation (the menubar shells out and blocks on
  // it). Without a timeout a half-open network after wake-from-sleep makes
  // fetch() hang forever, wedging the menubar's loading spinner. On timeout the
  // caller's catch falls back to the bundled price snapshot.
  const response = await fetchWithTimeout(LITELLM_URL)
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
    lowercasePricingIndex = null
    return
  }

  try {
    pricingCache = mergeSnapshotFallbacks(await fetchAndCachePricing())
    sortedPricingKeys = null
    lowercasePricingIndex = null
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
  'grok-build':                    'grok-build-0.1',
  'GPT-5.3 Codex (low reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (medium reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (high reasoning)': 'gpt-5.3-codex',
  'GPT-5.3 Codex (extra high reasoning)': 'gpt-5.3-codex',
  'Claude Sonnet 4.6':             'claude-sonnet-4-6',
  'Claude Sonnet 4.5':             'claude-sonnet-4-5',
  'Claude Haiku 4.5':              'claude-haiku-4-5',
  'Claude Opus 4.6':               'claude-opus-4-6',
  'claude-4-6-sonnet-high':        'claude-sonnet-4-6',
  'claude-4-6-sonnet-low':         'claude-sonnet-4-6',
  'claude-4-6-sonnet-medium':      'claude-sonnet-4-6',
  'claude-4-6-sonnet-high-fast':   'claude-sonnet-4-6',
  'claude-4-7-opus-xhigh':         'claude-opus-4-7',
  'claude-4-7-opus-xhigh-fast':    'claude-opus-4-7',
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
  // ZCode runs GLM-5.2 through z.ai's start-plan subscription; it isn't in
  // LiteLLM yet. Price as the nearest released sibling (GLM-5.1) until it is.
  'GLM-5.2':                        'glm-5p1',
  // Hermes Agent stores the same model id lowercased (`glm-5.2`) in its
  // sessions table, so it misses the capitalized alias above and goes
  // unpriced. Map the lowercase spelling to the same sibling.
  'glm-5.2':                        'glm-5p1',
}

let userAliases: Record<string, string> = {}

// Called once during CLI startup after config is loaded.
// User aliases take precedence over built-ins.
export function setModelAliases(aliases: Record<string, string>): void {
  userAliases = aliases
}

// Local-model savings config. Kept separate from userAliases: a `modelAliases`
// entry rewrites a model's identity for actual cost; a `localModelSavings`
// entry keeps the model cost at $0 and reports the *avoided* spend against a
// paid baseline. Set during preAction from `config.localModelSavings`.
let userLocalModelSavings: Record<string, string> = {}

export function setLocalModelSavings(mappings: Record<string, string>): void {
  userLocalModelSavings = { ...mappings }
}

export function getLocalSavingsBaseline(rawModel: string): string | undefined {
  if (!rawModel || typeof rawModel !== 'string') return undefined
  // Defensive: bracket-accessing user-controlled keys on a plain object
  // exposes the prototype chain (`__proto__` would resolve to Object.prototype).
  // Use Object.hasOwn so a hostile JSONL model name cannot piggyback into
  // Object.prototype either through the alias map or here.
  if (!Object.hasOwn(userLocalModelSavings, rawModel)) return undefined
  return userLocalModelSavings[rawModel]
}

/// Compute the hypothetical baseline cost for a local call. The baseline
/// model is priced through the normal `calculateCost` pipeline (so it can
/// be aliased / canonicalized). Returns `null` when the source model has
/// no savings mapping, the baseline is unknown to the pricing snapshot, or
/// any input is unusable — callers should treat null as "no savings
/// recorded for this call" rather than a hard error.
export function calculateLocalModelSavings(
  rawModel: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  oneHourCacheCreationTokens = 0,
): { savingsUSD: number; baselineModel: string } | null {
  const baseline = getLocalSavingsBaseline(rawModel)
  if (!baseline) return null
  if (!getModelCosts(baseline)) return null
  const savingsUSD = calculateCost(
    baseline,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchRequests,
    speed,
    oneHourCacheCreationTokens,
  )
  return { savingsUSD, baselineModel: baseline }
}

/// Stable hash of the current savings config so the daily cache can detect
/// "user changed their baseline mapping" and rebuild instead of presenting
/// stale saved-spend numbers. Two configs with the same key→baseline pairs
/// in any order collapse to the same hash.
export function getLocalModelSavingsConfigHash(): string {
  const keys = Object.keys(userLocalModelSavings).sort()
  if (keys.length === 0) return ''
  const parts = keys.map(k => `${k}\u0001${userLocalModelSavings[k]}`)
  return parts.join('\u0002')
}

// Absolute directory prefixes whose sessions are routed through a
// subscription-backed proxy (config `proxyPaths`). Stored already-normalized so
// the per-project match is a cheap compare. Set during preAction. See
// CodeburnConfig.proxyPaths for the product rationale.
let userProxyPaths: string[] = []

/// Normalize a path for prefix comparison: backslashes -> forward slashes
/// (Windows configs / cwds), strip leading AND trailing slashes, fold case on
/// case-insensitive filesystems. Leading slashes are stripped because provider
/// project paths arrive in two forms — Claude keeps the absolute "/Users/x"
/// while Codex (sanitizeProject) and the unsanitizePath fallback drop the
/// leading slash to "Users/x". Folding both to a slashless form (mirroring
/// crossProviderKey) makes matching agnostic to which provider produced the
/// path, so the same directory is flagged whether or not a Claude session
/// happens to co-exist there. Case is folded only on macOS/Windows; on Linux
/// "/home/Me" and "/home/me" are different dirs, so folding would risk
/// crediting unrelated spend. A path that normalizes to empty (e.g. "/" or "")
/// is dropped by callers so it can never match everything. Exported so the CLI
/// dedupes with the same rule.
export function normalizeProxyPath(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return (process.platform === 'darwin' || process.platform === 'win32') ? s.toLowerCase() : s
}

export function setProxyPaths(paths: string[]): void {
  userProxyPaths = (Array.isArray(paths) ? paths : [])
    .filter((p): p is string => typeof p === 'string')
    .map(normalizeProxyPath)
    .filter(p => p !== '')
}

/// True when `cwd` is at or under a configured proxy path. Prefix match is
/// anchored to a path-segment boundary so "/a/proj" matches "/a/proj" and
/// "/a/proj/sub" but NOT "/a/project-x". Empty/undefined cwd or empty config
/// never matches (so a misconfig can't silently zero unrelated spend).
export function isProxiedPath(cwd: string | undefined | null): boolean {
  if (!cwd || typeof cwd !== 'string') return false
  if (userProxyPaths.length === 0) return false
  const c = normalizeProxyPath(cwd)
  if (c === '') return false
  return userProxyPaths.some(p => c === p || c.startsWith(p + '/'))
}

/// Stable hash of the active proxy-path config. Project-level proxy attribution
/// is computed live from this set and then cached in the in-memory session
/// cache, so the cache key must vary with it — otherwise a long-lived process
/// (menubar) that re-reads config could serve attribution from a stale set.
export function getProxyPathsConfigHash(): string {
  if (userProxyPaths.length === 0) return ''
  return [...userProxyPaths].sort().join('')
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
  const canonicalName = getCanonicalName(model)
  const canonical = resolveAlias(canonicalName)

  // An explicit alias for a bare (un-prefixed) model name is authoritative: it
  // must win over a coincidental stripped reseller key of the same name. LiteLLM
  // ships `snowflake/claude-4-opus` ($5), which the bundler strips to a bare
  // `claude-4-opus` key; without this, that would shadow the curated alias
  // `claude-4-opus -> claude-opus-4` ($15 official Anthropic price).
  if (canonical !== canonicalName && withPrefix === canonicalName && pricingCache.has(canonical)) {
    return pricingCache.get(canonical)!
  }

  if (pricingCache.has(withPrefix)) return pricingCache.get(withPrefix)!

  if (pricingCache.has(canonical)) return pricingCache.get(canonical)!

  // Iterate keys longest-first so a model id like `gpt-5-mini` matches the
  // `gpt-5-mini` entry rather than collapsing to the shorter `gpt-5` entry
  // due to dictionary insertion order.
  for (const key of getSortedPricingKeys()) {
    if (canonical.startsWith(key + '-') || canonical === key) {
      return pricingCache.get(key)!
    }
  }

  // Case-insensitive fallback: gap-filled keys from OpenRouter are lowercase
  // slugs (e.g. `minimax-m3`), but sessions report `MiniMax-M3`. Only consulted
  // after the exact/canonical/prefix attempts, so it never changes a match that
  // already resolved above.
  const lowerIndex = getLowercasePricingIndex()
  const byCanonical = lowerIndex.get(canonical.toLowerCase())
  if (byCanonical) return byCanonical
  const byPrefix = lowerIndex.get(withPrefix.toLowerCase())
  if (byPrefix) return byPrefix

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
      const aliasHint = `Map it with: codeburn model-alias "${safeName}" <known-model>, or track local-model savings with: codeburn model-savings "${safeName}" <baseline-model>`
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
  // claude-fable-5 and claude-mythos-5 are outside the opus/sonnet/haiku families deriveClaudeShortName covers.
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5': 'Mythos 5',
  // Modern claude-<family>-<major>-<minor> ids are derived in deriveClaudeShortName.
  // Only the legacy 3.x ids (family-last) need explicit mapping.
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
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
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
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
  // Grok (xAI) and GLM ids that otherwise surface raw or as a pricing key in
  // reports. grok-build and GLM-5.2 price via sibling aliases, so
  // getShortModelName resolves to the pricing key before this lookup; map each
  // back to the real model name. grok-composer has no alias, it just lacked an
  // entry.
  'glm-5p1': 'GLM-5.2',                               // ZCode/Hermes run GLM-5.2 (priced as the GLM-5.1 sibling)
  'grok-build-0.1': 'Grok Build',                     // Grok Build prices through the 0.1 sibling
  'grok-composer-2.5-fast': 'Grok Composer 2.5 Fast',
}

// Sorted longest-first so more-specific prefixes match before shorter ones.
// Without this, `gpt-5-mini` could resolve to "GPT-5" (the entry for `gpt-5`)
// if it happened to be iterated before `gpt-5-mini`, hiding a distinct model
// behind the wrong display name and pricing tier.
const SORTED_SHORT_NAMES: [string, string][] = Object.entries(SHORT_NAMES)
  .sort((a, b) => b[0].length - a[0].length)

// Anthropic's id scheme is `claude-<family>-<major>[-<minor>]`, so every new
// version is derivable — no hand-maintained entry per release. (Legacy 3.x ids
// put the family last, e.g. `claude-3-5-sonnet`, and stay in SHORT_NAMES.)
const CLAUDE_FAMILY: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
function deriveClaudeShortName(canonical: string): string | undefined {
  const m = canonical.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/)
  if (!m) return undefined
  const [, family, major, minor] = m
  return `${CLAUDE_FAMILY[family]} ${major}${minor ? `.${minor}` : ''}`
}

export function getShortModelName(model: string): string {
  if (autoModelNames[model]) return autoModelNames[model]
  const canonical = resolveAlias(getCanonicalName(model))
  const claude = deriveClaudeShortName(canonical)
  if (claude) return claude
  for (const [key, name] of SORTED_SHORT_NAMES) {
    // Match on a version boundary, not a bare prefix: an unlisted future minor
    // (e.g. gpt-5.6) must NOT collapse into the base "gpt-5" entry — it should
    // fall through to its raw id rather than show a wrong name/tier.
    if (canonical === key || canonical.startsWith(key + '-')) return name
  }
  return canonical
}
