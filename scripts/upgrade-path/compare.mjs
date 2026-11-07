// Per-provider payload parity between the published CLI and this build.
//
//   node scripts/upgrade-path/compare.mjs <baselineDir> <upgradedDir>
//
// Each dir holds the payloads run.mjs captured: `export.json` (per-call records,
// the token/call source) and `menubar.json` (the unrounded per-provider cost).
// Prints one row per provider and exits non-zero on a diff that is not expected.
//
// Expectations, and why:
//   claude, codex, gemini, kiro, cursor  parse identically either side of the
//       upgrade. Calls and every token field must match EXACTLY; cost is allowed
//       COST_TOLERANCE of drift because the two binaries carry different bundled
//       LiteLLM price snapshots and only agree when the shared pricing cache in
//       CODEBURN_CACHE_DIR is warm (which it is, unless the runner is offline).
//   grok    changed by design in #1015: usage now comes from the CLI's own
//       turn_completed records instead of a context-curve estimate. The change
//       is REPORTED, never asserted — not even directionally. On real corpora
//       the changelog documents totals rising, but that is a property of real
//       Grok sessions, and the direction here would only reflect how the
//       generator happened to size its synthetic context curve against its
//       synthetic usage records. Both sides must still count the same SESSIONS,
//       which is the part the corpus can honestly establish.
//   dsh     did not exist in the published CLI. Reported; required to be absent
//       in the baseline and present after the upgrade.
//   codex   PRICING changed by design in #1075: reasoning tokens are billed
//       inside output rather than on top of it, and cache writes are carved out
//       of the input bucket. Nothing about what was PARSED moved, so codex keeps
//       the full exact treatment for the call count and every token field; the
//       cost tolerance is instead replaced with REPRICE_TOLERANCE — the
//       upgraded cost must be strictly lower than the baseline and within 25%
//       of it, since #1075 only ever removes a double-count and never raises
//       cost — and the delta is reported instead. Drop it from this list once a
//       published CLI carries the fix.
const EXACT = ['claude', 'codex', 'gemini', 'kiro', 'cursor']
const CHANGED_BY_DESIGN = ['grok']
const COST_CHANGED_BY_DESIGN = ['codex']
// #1830 f846b630: OTel input_tokens is cache-inclusive, so cache reads are now
// carved out of inputTokens instead of being billed twice. inputTokens and cost
// may only drop; every other field and the call count must stay exact.
const INPUT_CARVED_BY_DESIGN = ['copilot']
const NEW_IN_THIS_RELEASE = ['dsh']

const COST_TOLERANCE = 0.005 // 0.5% relative
// #1075 only ever LOWERS codex cost (double-counted reasoning removed, cache
// writes carved out of the input bucket) and by a bounded amount on any real
// corpus; a rise, or a drop past this bound, means something beyond the known
// repricing changed.
const REPRICE_TOLERANCE = 0.25 // 25% relative

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [baseDir, upDir] = process.argv.slice(2)
if (!baseDir || !upDir) {
  console.error('usage: compare.mjs <baselineDir> <upgradedDir>')
  process.exit(2)
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheWriteTokens', 'cacheReadTokens']

function load(dir) {
  const exported = JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8'))
  const menubar = JSON.parse(readFileSync(join(dir, 'menubar.json'), 'utf8'))
  const byProvider = {}
  for (const r of exported.records ?? []) {
    const p = r.provider || 'unknown'
    const acc = (byProvider[p] ??= { calls: 0, cost: 0, ...Object.fromEntries(TOKEN_FIELDS.map(f => [f, 0])) })
    acc.calls++
    acc.cost += r.cost ?? 0
    for (const f of TOKEN_FIELDS) acc[f] += r[f] ?? 0
  }
  // Prefer the unrounded cost, keyed by the provider's internal id.
  // `providerDetails` is the only place that pairing exists — the sibling
  // `providers` map is keyed by lowercased display name. The per-record sum
  // above stands in when a binary predates providerDetails; it is rounded per
  // record, so it is the coarser of the two.
  for (const d of menubar.current?.providerDetails ?? []) {
    if (byProvider[d.id]) byProvider[d.id].cost = d.cost
  }
  return byProvider
}

const base = load(baseDir)
const up = load(upDir)
const providers = [...new Set([...Object.keys(base), ...Object.keys(up)])].sort()

const failures = []
const notes = []
const rows = []

const relDiff = (a, b) => (a === 0 && b === 0 ? 0 : Math.abs(b - a) / Math.max(Math.abs(a), Math.abs(b)))
const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(6))

for (const name of providers) {
  const b = base[name]
  const u = up[name]
  let verdict

  if (NEW_IN_THIS_RELEASE.includes(name)) {
    if (b) failures.push(`${name}: expected to be absent from the 0.9.20 baseline, but it reported ${b.calls} calls`)
    else if (!u || u.calls === 0) failures.push(`${name}: new in this release but the upgraded run reported nothing`)
    verdict = 'new (expected)'
  } else if (!b || !u) {
    failures.push(`${name}: present in ${b ? 'baseline' : 'upgraded'} only`)
    verdict = 'MISSING'
  } else if (CHANGED_BY_DESIGN.includes(name)) {
    const bt = TOKEN_FIELDS.reduce((s, f) => s + b[f], 0)
    const ut = TOKEN_FIELDS.reduce((s, f) => s + u[f], 0)
    if (b.calls !== u.calls) failures.push(`${name}: usage accounting changed in #1015, but the session/call COUNT should not have: ${b.calls} != ${u.calls}`)
    verdict = 'changed by design'
    notes.push(`${name}: tokens ${bt} -> ${ut}, cost ${fmt(b.cost)} -> ${fmt(u.cost)} (#1015, expected; magnitude here is a property of the fixture, not evidence)`)
  } else {
    const diffs = []
    if (b.calls !== u.calls) diffs.push(`calls ${b.calls} != ${u.calls}`)
    const carved = INPUT_CARVED_BY_DESIGN.includes(name)
    for (const f of TOKEN_FIELDS) {
      if (carved && f === 'inputTokens') {
        if (u[f] > b[f]) diffs.push(`${f} ${b[f]} -> ${u[f]} rose; #1830 only carves cache reads out of input`)
      } else if (b[f] !== u[f]) diffs.push(`${f} ${b[f]} != ${u[f]}`)
    }
    const costDrift = relDiff(b.cost, u.cost)
    let repriced = false
    if (COST_CHANGED_BY_DESIGN.includes(name)) {
      if (u.cost > b.cost) diffs.push(`cost ${fmt(b.cost)} -> ${fmt(u.cost)} rose; #1075 should only lower codex cost`)
      else if (costDrift > REPRICE_TOLERANCE) diffs.push(`cost ${fmt(b.cost)} -> ${fmt(u.cost)} (${(costDrift * 100).toFixed(3)}% > ${(REPRICE_TOLERANCE * 100).toFixed(0)}% expected bound for #1075)`)
      else {
        repriced = true
        notes.push(`${name}: cost ${fmt(b.cost)} -> ${fmt(u.cost)} (${(costDrift * 100).toFixed(3)}%) — repricing expected (#1075); tokens and calls still asserted exactly`)
      }
    } else if (carved) {
      if (u.cost > b.cost && costDrift > COST_TOLERANCE) diffs.push(`cost ${fmt(b.cost)} -> ${fmt(u.cost)} rose; #1830 should only lower copilot cost`)
    } else if (costDrift > COST_TOLERANCE) {
      diffs.push(`cost ${fmt(b.cost)} != ${fmt(u.cost)} (${(costDrift * 100).toFixed(3)}% > ${(COST_TOLERANCE * 100).toFixed(1)}%)`)
    }
    if (!EXACT.includes(name) && !carved) {
      if (diffs.length) failures.push(`${name}: no expectation declared in compare.mjs; ${diffs.join(', ')}`)
      else notes.push(`${name}: no expectation declared in compare.mjs; identical`)
      verdict = diffs.length ? 'differs (unclassified)' : 'identical'
    } else if (diffs.length) {
      failures.push(`${name}: ${diffs.join(', ')}`)
      verdict = 'DIFFERS'
    } else if (carved && (u.inputTokens < b.inputTokens || u.cost < b.cost)) {
      verdict = 'changed by design (#1830)'
      notes.push(`${name}: inputTokens ${b.inputTokens} -> ${u.inputTokens}, cost ${fmt(b.cost)} -> ${fmt(u.cost)} (#1830 f846b630: OTel input_tokens is cache-inclusive, cache reads carved out of inputTokens)`)
    } else if (repriced) {
      verdict = `repriced (cost ${(costDrift * 100).toFixed(3)}% drift)`
    } else {
      verdict = costDrift === 0 ? 'identical' : `identical (cost ${(costDrift * 100).toFixed(3)}% drift)`
    }
  }

  rows.push({
    provider: name,
    calls: `${b?.calls ?? '-'} -> ${u?.calls ?? '-'}`,
    tokens: `${b ? TOKEN_FIELDS.reduce((s, f) => s + b[f], 0) : '-'} -> ${u ? TOKEN_FIELDS.reduce((s, f) => s + u[f], 0) : '-'}`,
    cost: `${b ? fmt(b.cost) : '-'} -> ${u ? fmt(u.cost) : '-'}`,
    verdict,
  })
}

const cols = ['provider', 'calls', 'tokens', 'cost', 'verdict']
const width = Object.fromEntries(cols.map(c => [c, Math.max(c.length, ...rows.map(r => r[c].length))]))
const line = r => cols.map(c => String(r[c]).padEnd(width[c])).join('  ')
console.log('')
console.log(line(Object.fromEntries(cols.map(c => [c, c.toUpperCase()]))))
console.log(cols.map(c => '-'.repeat(width[c])).join('  '))
for (const r of rows) console.log(line(r))
console.log('')
for (const n of notes) console.log(`note: ${n}`)
for (const f of failures) console.log(`FAIL: ${f}`)
console.log(failures.length ? `\nparity: ${failures.length} unexpected difference(s)` : '\nparity: ok')
process.exit(failures.length ? 1 : 0)
