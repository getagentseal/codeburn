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
  // LiteLLM PR #27056 is not merged yet. Source: https://api-docs.deepseek.com/quick_start/pricing
  'deepseek-v4-flash':      [1.4e-7, 2.8e-7, 0, 2.8e-9],
  'deepseek-v4-pro':        [4.35e-7, 8.7e-7, 0, 3.625e-9],
  // Mythos 5 launch pricing; not yet in LiteLLM or the models.dev/OpenRouter gap-fill (Fable is).
  'claude-mythos-5':        [10e-6, 50e-6, 12.5e-6, 1e-6],
  // gpt-5.6-codex / gpt-5.6-codex-max (#1077): not yet in LiteLLM. Every prior
  // Codex-suffixed id LiteLLM DOES carry bills identically to its bare-model
  // sibling of the same generation - gpt-5-codex == gpt-5, gpt-5.1-codex ==
  // gpt-5.1-codex-max == gpt-5.1, gpt-5.2-codex == gpt-5.2, gpt-5.3-codex ==
  // gpt-5.3 (all four input/output/cache-write/cache-read rates identical,
  // verified against the live model_prices_and_context_window.json). Mirroring
  // that pattern onto gpt-5.6 rather than inventing a number: both ids get the
  // exact gpt-5.6 tuple (Sol-tier: $5/$30 per million, 1.25x cache-write).
  'gpt-5.6-codex':          [5e-6, 3e-5, 6.25e-6, 5e-7],
  'gpt-5.6-codex-max':      [5e-6, 3e-5, 6.25e-6, 5e-7],
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

function toVal(entry) {
  const inp = entry.input_cost_per_token
  const out = entry.output_cost_per_token
  if (inp == null || out == null) return null
  return [inp, out, entry.cache_creation_input_token_cost ?? null, entry.cache_read_input_token_cost ?? null, entry.provider_specific_entry?.fast ?? null, tierOf(entry)]
}

// Pass 1: direct entries (no prefix) get priority
for (const [name, entry] of entries) {
  if (name.includes('/')) continue
  const val = toVal(entry)
  if (val) snapshot[name] = val
}
// A tuple's completeness: how many rate slots carry a published value. Used
// to keep a richer entry from being shadowed by a sparser alias of the same
// model (e.g. a new `nebius/MiniMaxAI/MiniMax-M3` without cache-read rates
// must not displace the publisher's entry that carries them).
const completeness = (val) => (val[2] != null ? 1 : 0) + (val[3] != null ? 1 : 0) + (val[5] != null ? 1 : 0)

// Pass 2: prefixed entries - store full key + stripped (completeness-wins)
for (const [name, entry] of entries) {
  if (!name.includes('/')) continue
  const val = toVal(entry)
  if (!val) continue
  if (!snapshot[name]) snapshot[name] = val
  const stripped = name.replace(/^[^/]+\//, '')
  if (stripped === name) continue
  const existing = snapshot[stripped]
  if (!existing || completeness(val) > completeness(existing)) snapshot[stripped] = val
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
// previous fallback's entries forward verbatim when neither the new primary
// nor the new gap-fill covers them. Sources drop and rename ids routinely
// (nine models lost all pricing in the 2026-09-18 regen), and the fallback is
// exactly the last-resort tier those ids belong to.
const previousFallback = (() => {
  try {
    return JSON.parse(readFileSync(fallbackPath, 'utf8'))
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
// Coverage here is exact-key or vendor-prefixed (the resolution pipeline
// reaches `vendor/<id>` for a bare `<id>` query), but NOT date-stripped: a
// dated primary variant like `qwen/qwen3.5-plus-20260420` does not answer the
// undated query, so `seen` (which folds date-stripped bare names) would
// silently drop the old entry while the model keeps pricing only under a name
// nobody queries.
const coveredByKey = (key) =>
  snapshot[key] !== undefined
  || fallback[key] !== undefined
  || Object.keys(snapshot).some(k => k.endsWith(`/${key}`))
for (const [k, v] of Object.entries(previousFallback)) {
  if (coveredByKey(k)) continue
  fallback[k] = v
  carried += 1
}
if (carried > 0) console.log(`carried ${carried} previously-priced fallback entries forward`)
writeFileSync(snapshotPath, JSON.stringify(snapshot))
writeFileSync(fallbackPath, JSON.stringify(fallback))
console.log(`Bundled ${Object.keys(snapshot).length} primary + ${Object.keys(fallback).length} fallback models`)
