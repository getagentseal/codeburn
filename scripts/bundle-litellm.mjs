import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = join(__dirname, '..', 'src', 'data', 'litellm-snapshot.json')

const MANUAL_ENTRIES = {
  // MiniMax-M3 standard paygo pricing (≤512K context). M3 does not support
  // active prompt cache writes, so cache_creation cost is 0; cache reads are
  // billed separately. Source: https://platform.minimax.io/docs/guides/pricing-paygo
  'MiniMax-M3':             [0.6e-6, 2.4e-6, 0, 0.12e-6],
  'MiniMax-M2.7':           [0.3e-6, 1.2e-6, 0.375e-6, 0.06e-6],
  'MiniMax-M2.7-highspeed': [0.6e-6, 2.4e-6, 0.375e-6, 0.06e-6],
  // LiteLLM PR #27056 is not merged yet. Source: https://api-docs.deepseek.com/quick_start/pricing
  'deepseek-v4-flash':      [1.4e-7, 2.8e-7, 0, 2.8e-9],
  'deepseek-v4-pro':        [4.35e-7, 8.7e-7, 0, 3.625e-9],
}

const res = await fetch(LITELLM_URL)
if (!res.ok) throw new Error(`HTTP ${res.status}`)
const data = await res.json()

const snapshot = {}
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

Object.assign(snapshot, MANUAL_ENTRIES)

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(snapshot))
console.log(`Bundled ${Object.keys(snapshot).length} models → src/data/litellm-snapshot.json`)
