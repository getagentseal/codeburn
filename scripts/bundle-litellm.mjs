import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// Pricing sources, in priority order:
//   1. LiteLLM        - broad, maintained, tracks provider list prices.
//   2. MANUAL_ENTRIES - hand-curated overrides for the primary snapshot.
//   3. models.dev     - only FIRST-PARTY maker providers (not the 100+
//                       gateways/resellers): official direct price for models
//                       LiteLLM hasn't added yet (e.g. MiniMax-M3).
//   4. OpenRouter     - resale rates, one clean price per canonical model;
//                       a coverage backstop for makers not in models.dev.
//
// Output is TWO files:
//   litellm-snapshot.json  - primary (LiteLLM + MANUAL_ENTRIES). Used for the
//                            exact / canonical / prefix lookups.
//   pricing-fallback.json  - gap-fill (models.dev + OpenRouter). Consulted ONLY
//                            as a last resort, so a reseller variant name can
//                            never shadow an existing canonical/alias match.
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const MODELS_DEV_URL = 'https://models.dev/api.json'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dirname, '..', 'src', 'data')
const snapshotPath = join(dataDir, 'litellm-snapshot.json')
const fallbackPath = join(dataDir, 'pricing-fallback.json')
const metaPath = join(dataDir, 'litellm-snapshot.meta.json')

// models.dev provider ids that are the actual model MAKERS (publish official
// list prices), as opposed to gateways/resellers (openrouter, nano-gpt, vercel,
// poe, novita, etc.) that mark up or discount. An id missing here just means
// that maker's models fall through to OpenRouter; an unknown id is ignored.
const MODELS_DEV_FIRST_PARTY = new Set([
  'openai', 'anthropic', 'google', 'google-vertex', 'mistral', 'deepseek',
  'xai', 'minimax', 'minimax-cn', 'moonshotai', 'zhipuai', 'alibaba',
  'alibaba-cn', 'cohere', 'perplexity', 'inception', 'morph',
])

const MANUAL_ENTRIES = {
  // Mistral Large 4 ("Le Chonk"), public preview from 2026-10-06. Mistral's
  // pricing page lists $1.36 / $4.18 (cached $0.14) struck through for the
  // preview rate below, which is what Mistral and OpenRouter bill today. Without
  // these rows the ids prefix-match the 2024 bare `mistral-large` ($4 / $12).
  // Remove once LiteLLM carries them; reprice if the preview discount ends.
  'mistral-large-4-0':      [0.68e-6, 2.09e-6, null, 0.07e-6],
  'mistral-large-2610':     [0.68e-6, 2.09e-6, null, 0.07e-6],
  'mistral-large-4':        [0.68e-6, 2.09e-6, null, 0.07e-6],
  'MiniMax-M2.7':           [0.3e-6, 1.2e-6, 0.375e-6, 0.06e-6],
  'MiniMax-M2.7-highspeed': [0.6e-6, 2.4e-6, 0.375e-6, 0.06e-6],
  // deepseek-v4-flash / deepseek-v4-pro were hand-pinned here while LiteLLM PR
  // #27056 was open (#1134). LiteLLM now carries official PEAK pricing for both
  // spellings (bare + `deepseek/`-prefixed, verified equal against
  // https://api-docs.deepseek.com/quick_start/pricing - off-peak is half of
  // peak), so the pins are gone and the snapshot speaks for itself.
  // Mythos 5 launch pricing; not yet in LiteLLM or the models.dev/OpenRouter gap-fill (Fable is).
  'claude-mythos-5':        [10e-6, 50e-6, 12.5e-6, 1e-6],
  // gpt-5.6-codex / gpt-5.6-codex-max (#1077, #1134): STILL not in LiteLLM as
  // of the 2026-09-29 refresh (the 2026-08-24 repricing reached the gpt-5.6
  // base row, $5/$30 -> $4/$20, but no codex SKU row exists upstream). Every
  // prior Codex-suffixed id LiteLLM DOES carry bills identically to its
  // bare-model sibling of the same generation - gpt-5-codex == gpt-5,
  // gpt-5.1-codex == gpt-5.1-codex-max == gpt-5.1, gpt-5.2-codex == gpt-5.2,
  // gpt-5.3-codex == gpt-5.3 (all four rates identical, verified against the
  // live model_prices_and_context_window.json). Mirroring that pattern onto
  // gpt-5.6 rather than inventing a number: both ids carry the exact gpt-5.6
  // row, verbatim INCLUDING the >272k tier block and the Flex slot, so the
  // tests/models.test.ts codex-equals-base assertion can hold. These are full-row mirrors, not
  // hand-picked rates: drop both entries entirely once LiteLLM ships the
  // codex SKUs, rather than editing them in place.
  'gpt-5.6-codex':          [4e-6, 2e-5, 5e-6, 4e-7, 2, { threshold: 272000, input: 8e-6, output: 3e-5, cacheWrite: 1e-5, cacheRead: 8e-7 }, [2e-6, 1e-5, 2.5e-6, 2e-7, null, { threshold: 272000, input: 4e-6, output: 1.5e-5, cacheWrite: 5e-6, cacheRead: 4e-7 }]],
  'gpt-5.6-codex-max':      [4e-6, 2e-5, 5e-6, 4e-7, 2, { threshold: 272000, input: 8e-6, output: 3e-5, cacheWrite: 1e-5, cacheRead: 8e-7 }, [2e-6, 1e-5, 2.5e-6, 2e-7, null, { threshold: 272000, input: 4e-6, output: 1.5e-5, cacheWrite: 5e-6, cacheRead: 4e-7 }]],
  // LiteLLM dropped `claude-opus-4` upstream (a refresh moves dropped ids to
  // the fallback tier), but the Cursor-style alias `claude-4-opus` resolves
  // against PRIMARY rows - without this pin the bare id falls to the
  // snowflake gateway row and under-prices by 3x. Anthropic list price.
  'claude-opus-4':          [15e-6, 75e-6, 18.75e-6, 1.5e-6],
}

const snapshot = {}
const readPrevious = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}
const previousSnapshot = readPrevious(snapshotPath)
const previousFallback = readPrevious(fallbackPath)
// Holds (rules c and e) last one refresh: an id the previous refresh already
// held takes the current upstream value now, so a stale quote or a wrong
// maker row can delay a reprice once, never forever.
const previousMeta = readPrevious(metaPath)
const refreshDate = new Date().toISOString().slice(0, 10)
const expired = []
const heldBefore = (list, id) => {
  if (!(id in (previousMeta[list] ?? {}))) return false
  expired.push(id)
  return true
}
const fetchJson = (url, label) => fetch(url).then((r) => r.json()).catch((e) => {
  console.warn(`${label} skipped: ${e.message}`)
  return null
})
const md = await fetchJson(MODELS_DEV_URL, 'models.dev')
const or = (await fetchJson(OPENROUTER_URL, 'openrouter'))?.data ?? null
// Routers (`auto`, `fusion`, `*-latest` pointers) have no model of their own:
// a price on one is whatever it routed to, and its bare key would price every
// `<gateway>/auto` id. models.dev marks them by family, OpenRouter by its
// `Router` tokenizer and its own `openrouter/` namespace. They are never
// gap-filled, and never carried forward unless they are a `~` version pointer
// (`~anthropic/claude-sonnet-latest`), which bills as the model it names.
const ROUTER_FAMILIES = new Set(['auto', 'model-router'])
const isOpenRouterRouter = (m) => m.architecture?.tokenizer === 'Router' || String(m.id).startsWith('openrouter/')
const routerIds = new Set([
  ...(or ?? []).filter((m) => isOpenRouterRouter(m) && !String(m.id).startsWith('~')).map((m) => String(m.id).toLowerCase()),
  ...Object.values(md ?? {}).flatMap((p) => Object.entries(p.models ?? {})
    .filter(([, m]) => ROUTER_FAMILIES.has(m.family)).map(([mid]) => mid.toLowerCase())),
])
const isRouter = (key) => [key, key.replace(/^openrouter\//, '')].some((k) => routerIds.has(k.toLowerCase()))

// --- Pass 1+2: LiteLLM (primary) ---
const res = await fetch(LITELLM_URL)
if (!res.ok) throw new Error(`HTTP ${res.status}`)
const data = await res.json()
const entries = Object.entries(data).filter(([k]) => k !== 'sample_spec')

// The plain context-length tiers only: `input_cost_per_token_above_272k_tokens`
// and siblings. Service-tier variants (`_above_272k_priority_tokens`,
// `_above_272k_flex_tokens`) and the 1-hour cache-write combination are NOT
// context thresholds and are deliberately not matched. The threshold comes
// from the key suffix (272k -> 272000) because LiteLLM carries no numeric
// threshold field (#1076). Mirrored in src/models.ts parseLiteLLMEntry.
const TIER_KEY_RE = /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/

// OpenAI's priority processing tier ships as explicit `<rate>_priority` keys
// beside the standard ones (and `_above_<n>k_tokens_priority` for gpt-5.6's
// long-context tier). Codex's Fast speed setting bills through it (#1616), so
// slot 5 falls back to that ratio when the row carries no
// `provider_specific_entry.fast`. Derived only where every bucket the row
// prices agrees on one ratio — models without priority keys, or rows whose
// ratios disagree (azure/gpt-5.5: 2.5x base, 2x above 272k), stay null (1x).
// A tier without its own priority keys (gpt-5.4, gpt-5.5) gets `fast: 1` so it
// stays at standard tier rates: OpenAI quotes no Fast long-context price there.
// Never a hand-picked number. Mirrored in src/models.ts parseLiteLLMEntry.
const PRIORITY_KEY_SUFFIX = '_priority'
const MAX_DERIVED_FAST_MULTIPLIER = 100

function priorityMultiplierOf(entry, suffix = PRIORITY_KEY_SUFFIX) {
  const ratios = []
  let inputRatio
  let outputRatio
  for (const [key, value] of Object.entries(entry)) {
    if (!key.endsWith(suffix)) continue
    const base = entry[key.slice(0, -suffix.length)]
    if (typeof value !== 'number' || typeof base !== 'number') continue
    if (!Number.isFinite(value) || !Number.isFinite(base) || value <= 0 || base <= 0) continue
    const ratio = value / base
    if (key === `input_cost_per_token${suffix}`) inputRatio = ratio
    else if (key === `output_cost_per_token${suffix}`) outputRatio = ratio
    ratios.push(ratio)
  }
  if (inputRatio === undefined || outputRatio === undefined) return null
  const agreed = ratios.every((r) => Math.abs(r - inputRatio) <= 1e-9 * Math.max(r, inputRatio))
  // Rounded to 4 decimals so division noise (1.7999999999999998) never ships.
  return agreed && inputRatio <= MAX_DERIVED_FAST_MULTIPLIER ? Math.round(inputRatio * 1e4) / 1e4 : null
}

function tierOf(entry) {
  // Rates are read ONLY from the largest threshold a model carries, so a
  // hypothetical entry with two tiers can never mix a smaller tier's rates
  // under the bigger threshold. Values must be finite and non-negative, the
  // same validation src/models.ts applies on the live path.
  const byThreshold = new Map()
  for (const [key, value] of Object.entries(entry)) {
    const m = TIER_KEY_RE.exec(key)
    if (!m || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    const tokens = Number(m[2]) * 1000
    const rates = byThreshold.get(tokens) ?? {}
    if (m[1] === 'input_cost_per_token') rates.input = value
    else if (m[1] === 'output_cost_per_token') rates.output = value
    else if (m[1] === 'cache_read_input_token_cost') rates.cacheRead = value
    else rates.cacheWrite = value
    byThreshold.set(tokens, rates)
  }
  if (byThreshold.size === 0) return null
  const threshold = Math.max(...byThreshold.keys())
  const rates = byThreshold.get(threshold)
  if (rates.input == null || rates.output == null) return null
  return { threshold, input: rates.input, output: rates.output, cacheWrite: rates.cacheWrite ?? null, cacheRead: rates.cacheRead ?? null }
}

// OpenAI's Flex processing tier ships as explicit `<rate>_flex` keys
// (`_above_<n>k_tokens_flex` for the long-context tier), carried as slot 6: a
// full tuple of Flex rates, appended only where the row publishes input and
// output flex rates so every other row stays byte-identical. Rates, not a
// ratio (gpt-5.4's flex cache read is $0.13/M, not half of $0.25/M); a bucket
// without a flex rate keeps its standard rate. Mirrored in src/models.ts flexOf.
const FLEX_KEY_SUFFIX = '_flex'

function flexOf(entry, cacheWrite, cacheRead, tier) {
  const rate = (key) => {
    const v = entry[key + FLEX_KEY_SUFFIX]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  }
  const input = rate('input_cost_per_token')
  const output = rate('output_cost_per_token')
  if (input === null || output === null) return null
  const above = (key) => `${key}_above_${tier.threshold / 1000}k_tokens`
  return [input, output, rate('cache_creation_input_token_cost') ?? cacheWrite, rate('cache_read_input_token_cost') ?? cacheRead, null, tier ? {
    threshold: tier.threshold,
    input: rate(above('input_cost_per_token')) ?? tier.input,
    output: rate(above('output_cost_per_token')) ?? tier.output,
    cacheWrite: rate(above('cache_creation_input_token_cost')) ?? tier.cacheWrite,
    cacheRead: rate(above('cache_read_input_token_cost')) ?? tier.cacheRead,
  } : null]
}

function toVal(entry) {
  const inp = entry.input_cost_per_token
  const out = entry.output_cost_per_token
  if (inp == null || out == null) return null
  const explicitFast = entry.provider_specific_entry?.fast
  const priorityFast = explicitFast == null ? priorityMultiplierOf(entry) : null
  const tier = tierOf(entry)
  if (tier && priorityFast !== null && !Object.keys(entry).some((k) => k.endsWith(`_above_${tier.threshold / 1000}k_tokens${PRIORITY_KEY_SUFFIX}`))) {
    tier.fast = 1
  }
  const val = [inp, out, entry.cache_creation_input_token_cost ?? null, entry.cache_read_input_token_cost ?? null, explicitFast ?? priorityFast, tier]
  const flex = flexOf(entry, val[2], val[3], tier)
  const ultrafast = priorityMultiplierOf(entry, '_ultrafast')
  if (ultrafast !== null) return [...val, flex, ultrafast]
  return flex ? [...val, flex] : val
}

// Pass 1: direct entries (no prefix) get priority
for (const [name, entry] of entries) {
  if (name.includes('/')) continue
  const val = toVal(entry)
  if (val) snapshot[name] = val
}
// A tuple's completeness: how many optional rate slots (cache-write,
// cache-read) carry a published value. A richer upstream row may cite it to
// FILL a sparser entry's missing slots - never as a license to re-price it
// (see the fillsOnly guard in Pass 2). The tier slot (5) is deliberately not
// counted: tier presence must never decide which row wins, or a tier-bearing
// row would outrank the base-richer row main would have picked.
const completeness = (val) => (val[2] != null ? 1 : 0) + (val[3] != null ? 1 : 0)

// Pass 2: prefixed entries - store full key + stripped (slot-fill-only)
// A prefixed row may claim the slot its vendor-stripped key would answer
// (e.g. `fireworks_ai/accounts/fireworks/models/x` keeps the
// `accounts/fireworks/models/x` query priced) - but never when the stripped
// key is itself an upstream entry name. LiteLLM sorts reseller namespaces
// (`openrouter/deepseek/deepseek-v4-pro`) before the vendor's own row
// (`deepseek/deepseek-v4-pro`), so an unconditional claim let resale rates
// shadow the official row for the very same id, with the winner decided
// purely by JSON key order (#1134: the openrouter row held the
// `deepseek/deepseek-v4-pro` slot at ~40% under official peak pricing).
const entryNames = new Set(Object.keys(data))
// Which prefixed row claims an absent bare key: the model maker's own row
// (`xai/grok-4.6`) over any reseller's (`azure_ai/grok-4.6`), whatever the JSON
// order, even at $0 (Gemma is free on Google's own API). Among the other rows
// a $0/$0 one yields to any priced one (the `codestral/` free-beta rows priced
// `codestral-latest` at nothing); otherwise the first row claims, as before.
// The key keeps the position its first claimant gave it. Mirrored in
// src/models.ts.
const MAKER_PREFIXES = new Set([
  'xai', 'mistral', 'cohere', 'anthropic', 'openai', 'gemini', 'deepseek', 'moonshot',
  'zai', 'minimax', 'ai21', 'perplexity', 'dashscope', 'meta_llama', 'xiaomi_mimo',
])
// Two segments only: `perplexity/openai/gpt-5.6-sol` is Perplexity reselling.
const isMaker = (name) => name.split('/').length === 2 && MAKER_PREFIXES.has(name.split('/')[0])
const isFree = (val) => val[0] === 0 && val[1] === 0
const bareClaims = new Map()
const makerClaimed = new Set()
const held = {}
const claimants = new Map()
for (const [name, entry] of [...entries.filter(([n]) => isMaker(n)), ...entries.filter(([n]) => !isMaker(n))]) {
  if (!name.includes('/')) continue
  const stripped = name.replace(/^[^/]+\//, '')
  if (entryNames.has(stripped)) continue
  const val = toVal(entry)
  if (!val) continue
  claimants.set(stripped, [...(claimants.get(stripped) ?? []), JSON.stringify(val)])
  const prev = bareClaims.get(stripped)
  if (!prev || (!makerClaimed.has(stripped) && isFree(prev) && !isFree(val))) bareClaims.set(stripped, val)
  if (isMaker(name)) makerClaimed.add(stripped)
}
// A namespaced stripped key (`openai/gpt-5.3-codex` from
// `perplexity/openai/gpt-5.3-codex`) is a reseller quoting a maker's model.
// When that maker's own row exists - the bare upstream entry or a maker-prefixed
// row whose provider is the namespace (`MiniMaxAI` ~ `minimax`) - it prices
// the key, whatever reseller row comes first in the JSON. Region and size
// namespaces (`eu/gpt-5.4`, `1024-x-1024/gpt-image-1`) match no provider, so
// those keys keep their own reseller rate.
const makerOf = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/ai$/, '')
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
// A maker row more than 2x above the median reseller quote for the same model
// is more likely a wrong upstream row than a price change, so the id it would
// reprice keeps its previous value. A maker row below the resellers is the
// maker's own price and wins.
const offMarket = (official, quotes) => [0, 1].some((i) => {
  const m = median(quotes.map((q) => q[i]))
  return m > 0 && official[i] / m > 2
})
const outliers = {}
for (const stripped of bareClaims.keys()) {
  const slash = stripped.lastIndexOf('/')
  if (slash < 0) continue
  const ns = makerOf(stripped.split('/')[0])
  const model = stripped.slice(slash + 1)
  const official = [model, ...[...MAKER_PREFIXES].map((p) => `${p}/${model}`)]
    .filter((c) => data[c] && makerOf(data[c].litellm_provider ?? (c.includes('/') ? c.split('/')[0] : '')) === ns)
    .map((c) => toVal(data[c]))
    .find(Boolean)
  if (!official) continue
  const previous = previousSnapshot[stripped]
  if (previous && JSON.stringify(previous) !== JSON.stringify(official) && offMarket(official, claimants.get(stripped).map((q) => JSON.parse(q))) && !heldBefore('outliers', stripped)) {
    bareClaims.set(stripped, previous)
    makerClaimed.add(stripped)
    outliers[stripped] = refreshDate
    continue
  }
  bareClaims.set(stripped, official)
  makerClaimed.add(stripped)
}
// A stripped key no maker row claims is a reseller's figure, and which
// reseller wins is JSON order. It keeps its previous value only while some
// current reseller row still quotes it; once none does, it takes the claim.
function holdsPrevious(stripped) {
  const previous = previousSnapshot[stripped]
  if (!previous || makerClaimed.has(stripped)) return false
  const p = JSON.stringify(previous)
  if (p === JSON.stringify(bareClaims.get(stripped)) || !claimants.get(stripped).includes(p)) return false
  if (heldBefore('held', stripped)) return false
  held[stripped] = refreshDate
  return true
}
for (const [name, entry] of entries) {
  if (!name.includes('/')) continue
  const val = toVal(entry)
  if (!val) continue
  if (!snapshot[name]) snapshot[name] = val
  const stripped = name.replace(/^[^/]+\//, '')
  if (stripped === name) continue
  const existing = snapshot[stripped]
  // The stripped key may already hold Pass 1's direct entry or an earlier
  // Pass 2 row. A "more complete" upstream row may only top up missing
  // slots - it never re-prices a filled one: input/output must be identical,
  // and every non-null optional slot of the existing tuple must survive
  // verbatim (val may add slots, never change them). Guarantees no rate ever
  // changes across a refresh; only missing slots fill. The completeness-wins
  // version re-priced 43 input/output and 34 cache rates by swapping in a
  // different upstream row (grok-3 3/15 -> 1.25/2.5). Slot 5 (the tier object) stays out of the guard: it is
  // built fresh per row, so a reference compare is always false and would
  // veto fills main performs (it silently dropped the azure cache-read fill
  // for gpt-5.4-pro-class rows); and since the replacement only fires when
  // the candidate fills a missing BASE slot, the winning row's tier travels
  // with its own base rates - splicing the old row's tier onto the new row's
  // base would mix two different upstream rows.
  const fillsOnly = (cand, prev) =>
    cand[0] === prev[0]
    && cand[1] === prev[1]
    && (prev[2] == null || cand[2] === prev[2])
    && (prev[3] == null || cand[3] === prev[3])
  if (!existing) {
    if (!bareClaims.has(stripped)) continue
    snapshot[stripped] = holdsPrevious(stripped) ? previousSnapshot[stripped] : bareClaims.get(stripped)
    continue
  }
  // A fill on a key the previous snapshot had may only restore its previous
  // slots: a reseller row added since never tops up an id users already price.
  const before = previousSnapshot[stripped]
  const restores = !before || [2, 3].every((i) => existing[i] != null || val[i] == null || val[i] === before[i])
  if (restores && completeness(val) > completeness(existing) && fillsOnly(val, existing)) snapshot[stripped] = val
}

// A MANUAL_ENTRY that LiteLLM now ships is a candidate to delete (the override
// would otherwise shadow upstream forever with a possibly-stale hand value).
for (const k of Object.keys(MANUAL_ENTRIES)) {
  if (snapshot[k]) console.log(`note: MANUAL_ENTRIES['${k}'] is now in LiteLLM - candidate to remove`)
}
// A previous primary row upstream no longer produces stays in the primary
// snapshot verbatim. Demoted to the fallback it would only be reached after
// prefix matching, so a shorter sibling key would price it instead
// (`mistral-large` fell to a $0 `mistral` row) and aliases aimed at it would
// stop resolving.
const carriedIds = []
const droppedRouters = []
for (const [k, v] of Object.entries(previousSnapshot)) {
  if (snapshot[k] !== undefined) continue
  if (isRouter(k)) {
    droppedRouters.push(k)
    continue
  }
  snapshot[k] = v
  if (!(k in MANUAL_ENTRIES)) carriedIds.push(k)
}
// Upstream dropping a long-context tier from a row whose base rates did not
// move would reprice every past request above the threshold at the base rate;
// the previous tier stays. A row upstream re-priced takes upstream's shape.
const sameRates = (a, b, slots) => slots.every((i) => (a[i] ?? null) === (b[i] ?? null))
const keptTiers = []
for (const [k, v] of Object.entries(snapshot)) {
  const previousTier = previousSnapshot[k]?.[5]
  if (!previousTier || v[5] || !sameRates(v, previousSnapshot[k], [0, 1, 2, 3])) continue
  const val = [...v]
  val[5] = previousTier
  snapshot[k] = val
  keptTiers.push(k)
}
// A rate that turns exactly $0 on a row whose other rates did not move is
// treated as missing, not free: a $0 cache write bills every cache-creation
// token at nothing, where the previous slot (or its absence) billed them.
const zeroSlots = []
for (const [k, v] of Object.entries(snapshot)) {
  const before = previousSnapshot[k]
  if (!before || !(v[0] > 0)) continue
  const slots = [1, 2, 3].filter((i) => v[i] === 0 && before[i] !== 0)
  if (slots.length === 0 || !sameRates(v, before, [0, 1, 2, 3].filter((i) => !slots.includes(i)))) continue
  const val = [...v]
  for (const i of slots) val[i] = before[i] ?? null
  snapshot[k] = val
  zeroSlots.push(k)
}
Object.assign(snapshot, MANUAL_ENTRIES)

// --- Gap fill into a SEPARATE fallback map (last-resort only) ---
const fallback = {}
// Strip the vendor prefix to the last path segment, then the @pin and trailing
// -YYYYMMDD date that the runtime's getCanonicalName also strips, so a fallback
// key lines up with the canonical form actually queried (otherwise e.g.
// `vendor/claude-3-5-sonnet@20241022` becomes a key the lookup can never reach).
const bareKey = (name) => name.replace(/^.*\//, '').replace(/@.*$/, '').replace(/-\d{8}$/, '')
// `seen` holds every primary key AND its bareKey form (both lowercased) so we
// never re-add a model LiteLLM/MANUAL already covers under either shape; fallback
// keys are added too so the first source wins (models.dev before OpenRouter).
const seen = new Set()
for (const k of Object.keys(snapshot)) {
  seen.add(k.toLowerCase())
  seen.add(bareKey(k).toLowerCase())
}
// A refresh must never leave a model that HAD pricing without any: the
// previous fallback's entries carry forward verbatim when neither the new
// primary nor the new gap-fill covers them exactly (previous primary rows
// already carried into the primary above).
const finite = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
// A rate pair is usable only if both sides are non-negative and not both zero.
// OpenRouter uses -1 as a "variable / BYOK price" sentinel; without this guard a
// negative per-token cost would ship and subtract from a user's spend totals.
const validRates = (inp, out) => inp != null && out != null && inp >= 0 && out >= 0 && !(inp === 0 && out === 0)
// Drop the same negative sentinel on optional cache fields.
const nonNeg = (v) => (v != null && v >= 0 ? v : null)
function addGap(key, val) {
  if (!key || !val) return false
  const lk = key.toLowerCase()
  if (seen.has(lk)) return false
  fallback[key] = val
  seen.add(lk)
  return true
}

// --- Pass 3: models.dev first-party makers (official list prices) ---
if (md) {
  // Surface drift in our hand-maintained maker allowlist: if an id we classify
  // as first-party is gone from the API, it was renamed/removed and the set is
  // stale (its models would silently fall through to OpenRouter resale rates).
  for (const id of MODELS_DEV_FIRST_PARTY) {
    if (!md[id]) console.warn(`note: models.dev no longer lists first-party id '${id}' - allowlist may be stale`)
  }
  let added = 0
  for (const pid of Object.keys(md).sort()) {
    if (!MODELS_DEV_FIRST_PARTY.has(pid)) continue
    const models = md[pid].models ?? {}
    for (const mid of Object.keys(models).sort()) {
      const c = models[mid].cost
      if (!c || ROUTER_FAMILIES.has(models[mid].family)) continue
      const inp = finite(c.input), out = finite(c.output)
      if (!validRates(inp, out)) continue
      // models.dev cost is per MILLION tokens; snapshot is per token.
      const cw = nonNeg(c.cache_write != null ? finite(c.cache_write) : null)
      const cr = nonNeg(c.cache_read != null ? finite(c.cache_read) : null)
      if (addGap(bareKey(mid), [inp / 1e6, out / 1e6, cw != null ? cw / 1e6 : null, cr != null ? cr / 1e6 : null, null])) added++
    }
  }
  console.log(`models.dev (first-party): +${added} models`)
}

// --- Pass 4: OpenRouter (resale backstop) ---
if (or) {
  let added = 0
  for (const m of or) {
    if (isOpenRouterRouter(m)) continue
    const p = m.pricing ?? {}
    const inp = finite(p.prompt), out = finite(p.completion)
    if (!validRates(inp, out)) continue
    // OpenRouter pricing fields are already per-token.
    const cw = nonNeg(p.input_cache_write != null ? finite(p.input_cache_write) : null)
    const cr = nonNeg(p.input_cache_read != null ? finite(p.input_cache_read) : null)
    if (addGap(bareKey(m.id ?? ''), [inp, out, cw, cr, null])) added++
  }
  console.log(`openrouter (backstop): +${added} models`)
}

mkdirSync(dataDir, { recursive: true })
let carried = 0
// Coverage here is exact-key ONLY. The runtime resolver (`getModelCosts`)
// never tries `vendor/<id>` for a bare `<id>` query — it looks the given id
// up verbatim, peels segments off it, and strips variant suffixes, but never
// adds a vendor prefix — so treating a `~x-ai/grok-latest` primary as
// covering a bare `grok-latest` would drop the old entry while the model
// still prices as null (the first version of this refresh did exactly that
// to 96 fallback ids). NOT date-stripped either, for the same reason: a
// dated primary variant like `qwen/qwen3.5-plus-20260420` does not answer
// the undated query.
const coveredByKey = (key) =>
  snapshot[key] !== undefined
  || fallback[key] !== undefined
for (const [k, v] of Object.entries(previousFallback)) {
  if (coveredByKey(k)) continue
  if (fallback[k] !== undefined) continue
  // Same hygiene the gap-fill passes enforce: a carried row must not be
  // @pin or date-suffixed (a query can never arrive in those forms - the
  // runtime only ever peels them off, never adds them; a vendor-prefixed
  // key CAN arrive verbatim, so it stays carriable) and must not be free on
  // both ends (an unpriced model falls to expected-free handling, not a $0
  // fallback row). Primary files legitimately hold such rows, so the guard
  // lives here: when upstream drops one, carrying it verbatim would
  // re-import exactly what tests/pricing-fallback-data.test.ts keeps out
  // of this file.
  if (/@/.test(k) || /-\d{8}$/.test(k)) continue
  if (!validRates(v[0], v[1])) continue
  fallback[k] = v
  carried += 1
}
if (carried > 0) console.log(`carried ${carried} previous fallback entries forward`)
console.log(`primary: carried ${carriedIds.length} dropped rows, held ${Object.keys(held).length} reseller keys, kept ${keptTiers.length} tiers, ${Object.keys(outliers).length} off-market maker rows, ${expired.length} holds expired, ${zeroSlots.length} new $0 slots`)
writeFileSync(snapshotPath, JSON.stringify(snapshot))
writeFileSync(fallbackPath, JSON.stringify(fallback))
writeFileSync(metaPath, JSON.stringify({ carried: carriedIds, droppedRouters, held, outliers, expired, keptTiers, zeroSlots }, null, 1) + '\n')
console.log(`Bundled ${Object.keys(snapshot).length} primary + ${Object.keys(fallback).length} fallback models`)
