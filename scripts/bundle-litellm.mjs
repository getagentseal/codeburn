import { writeFileSync, mkdirSync } from 'fs'
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
}

const snapshot = {}

// --- Pass 1+2: LiteLLM (primary) ---
const res = await fetch(LITELLM_URL)
if (!res.ok) throw new Error(`HTTP ${res.status}`)
const data = await res.json()
const entries = Object.entries(data).filter(([k]) => k !== 'sample_spec')

function toVal(entry) {
  const inp = entry.input_cost_per_token
  const out = entry.output_cost_per_token
  if (inp == null || out == null) return null
  return [inp, out, entry.cache_creation_input_token_cost ?? null, entry.cache_read_input_token_cost ?? null, entry.provider_specific_entry?.fast ?? null]
}

// Pass 1: direct entries (no prefix) get priority
for (const [name, entry] of entries) {
  if (name.includes('/')) continue
  const val = toVal(entry)
  if (val) snapshot[name] = val
}
// Pass 2: prefixed entries - store full key + stripped (first-write-wins)
for (const [name, entry] of entries) {
  if (!name.includes('/')) continue
  const val = toVal(entry)
  if (!val) continue
  if (!snapshot[name]) snapshot[name] = val
  const stripped = name.replace(/^[^/]+\//, '')
  if (stripped !== name && !snapshot[stripped]) snapshot[stripped] = val
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
writeFileSync(snapshotPath, JSON.stringify(snapshot))
writeFileSync(fallbackPath, JSON.stringify(fallback))
console.log(`Bundled ${Object.keys(snapshot).length} primary + ${Object.keys(fallback).length} fallback models`)
