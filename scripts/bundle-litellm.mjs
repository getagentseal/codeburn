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

function priorityMultiplierOf(entry) {
  const ratios = []
  let inputRatio
  let outputRatio
  for (const [key, value] of Object.entries(entry)) {
    if (!key.endsWith(PRIORITY_KEY_SUFFIX)) continue
    const base = entry[key.slice(0, -PRIORITY_KEY_SUFFIX.length)]
    if (typeof value !== 'number' || typeof base !== 'number') continue
    if (!Number.isFinite(value) || !Number.isFinite(base) || value <= 0 || base <= 0) continue
    const ratio = value / base
    if (key === 'input_cost_per_token_priority') inputRatio = ratio
    else if (key === 'output_cost_per_token_priority') outputRatio = ratio
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
  // different upstream row (grok-3 3/15 -> 1.25/2.5, mistral-large-latest
  // 8/24 -> 0.5/1.5). Slot 5 (the tier object) stays out of the guard: it is
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
    if (!entryNames.has(stripped)) snapshot[stripped] = val
    continue
  }
  if (completeness(val) > completeness(existing) && fillsOnly(val, existing)) snapshot[stripped] = val
}

// A MANUAL_ENTRY that LiteLLM now ships is a candidate to delete (the override
// would otherwise shadow upstream forever with a possibly-stale hand value).
for (const k of Object.keys(MANUAL_ENTRIES)) {
  if (snapshot[k]) console.log(`note: MANUAL_ENTRIES['${k}'] is now in LiteLLM - candidate to remove`)
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
// A refresh must never leave a model that HAD pricing without any: carry the
// previous files' entries forward verbatim when neither the new primary nor
// the new gap-fill covers them exactly. That means both the previous
// fallback's own last-resort entries AND previous PRIMARY rows the new
// upstream data dropped or renamed (LiteLLM removed e.g.
// `gpt-image-2-2026-04-21` and the Bedrock marengo embeds between regens) —
// an id users priced yesterday stays priced at its last known rate in the
// fallback tier, which is exactly the last-resort tier orphaned ids belong
// in. Primary rows are consulted before fallback rows so a key present in
// both keeps its authoritative primary value.
const previousFallback = (() => {
  try {
    return JSON.parse(readFileSync(fallbackPath, 'utf8'))
  } catch {
    return {}
  }
})()
const previousSnapshot = (() => {
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf8'))
  } catch {
    return {}
  }
})()
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
try {
  const md = await (await fetch(MODELS_DEV_URL)).json()
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
      if (!c) continue
      const inp = finite(c.input), out = finite(c.output)
      if (!validRates(inp, out)) continue
      // models.dev cost is per MILLION tokens; snapshot is per token.
      const cw = nonNeg(c.cache_write != null ? finite(c.cache_write) : null)
      const cr = nonNeg(c.cache_read != null ? finite(c.cache_read) : null)
      if (addGap(bareKey(mid), [inp / 1e6, out / 1e6, cw != null ? cw / 1e6 : null, cr != null ? cr / 1e6 : null, null])) added++
    }
  }
  console.log(`models.dev (first-party): +${added} models`)
} catch (e) {
  console.warn(`models.dev skipped: ${e.message}`)
}

// --- Pass 4: OpenRouter (resale backstop) ---
try {
  const or = (await (await fetch(OPENROUTER_URL)).json()).data ?? []
  let added = 0
  for (const m of or) {
    const p = m.pricing ?? {}
    const inp = finite(p.prompt), out = finite(p.completion)
    if (!validRates(inp, out)) continue
    // OpenRouter pricing fields are already per-token.
    const cw = nonNeg(p.input_cache_write != null ? finite(p.input_cache_write) : null)
    const cr = nonNeg(p.input_cache_read != null ? finite(p.input_cache_read) : null)
    if (addGap(bareKey(m.id ?? ''), [inp, out, cw, cr, null])) added++
  }
  console.log(`openrouter (backstop): +${added} models`)
} catch (e) {
  console.warn(`openrouter skipped: ${e.message}`)
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
for (const [k, v] of [...Object.entries(previousSnapshot), ...Object.entries(previousFallback)]) {
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
if (carried > 0) console.log(`carried ${carried} previously-priced entries forward (dropped primary rows + fallback)`)
writeFileSync(snapshotPath, JSON.stringify(snapshot))
writeFileSync(fallbackPath, JSON.stringify(fallback))
console.log(`Bundled ${Object.keys(snapshot).length} primary + ${Object.keys(fallback).length} fallback models`)
