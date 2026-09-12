#!/usr/bin/env node
// Goal-1 demo fixture: an isolated Claude config dir + cache dir with usage in
// the two default compare windows (A = Aug 29 - Sep 4, B = Sep 5 - Sep 11,
// relative to today 2026-09-12 local) so the desktop Compare periods screen
// has a known story to show. Read-only fixture; nothing touches real logs.
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node gen-fixture.mjs <dir>'); process.exit(1) }
await rm(root, { recursive: true, force: true })

const day = (month, date, hour, minute = 0) => new Date(2026, month - 1, date, hour, minute, 0).toISOString()

function assistant(sessionId, ts, model, input, output, msgId) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: ts,
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: input, output_tokens: output },
    },
  })
}
function user(sessionId, ts) {
  return JSON.stringify({ type: 'user', sessionId, timestamp: ts, message: { role: 'user', content: 'work on the feature' } })
}

const MODEL = 'claude-sonnet-4-5'
const MYSTERY = 'mystery-model-9' // no pricing anywhere: coverage must flag it

const sessions = {
  // /work/pricing: active in both windows, MUCH heavier in B (Up), plus a
  // session straddling the A/B boundary (Sep 4 22:00 + Sep 5 08:00).
  'pricing-a1': [
    ['u', day(8, 30, 9)], ['a', day(8, 30, 9, 1), MODEL, 2000, 300],
    ['u', day(9, 2, 10)], ['a', day(9, 2, 10, 1), MODEL, 2500, 400],
  ],
  'pricing-straddle': [
    ['u', day(9, 4, 22)], ['a', day(9, 4, 22, 1), MODEL, 3000, 300],
    ['u', day(9, 5, 8)], ['a', day(9, 5, 8, 1), MODEL, 4000, 400],
  ],
  'pricing-b1': [
    ['u', day(9, 9, 11)], ['a', day(9, 9, 11, 1), MODEL, 12000, 900],
    ['u', day(9, 10, 15)], ['a', day(9, 10, 15, 1), MODEL, 9000, 700],
  ],
  // /work/website: only in A (Gone).
  'website-a1': [
    ['u', day(8, 31, 14)], ['a', day(8, 31, 14, 1), MODEL, 4000, 500],
  ],
  // /work/mobile: only in B (New) — one priced call plus one call on the
  // unpriced model (coverage must flag the unpriced one as unknown, not zero).
  'mobile-b1': [
    ['u', day(9, 8, 9)], ['a', day(9, 8, 9, 1), MYSTERY, 6000, 800],
  ],
  'mobile-b2': [
    ['u', day(9, 7, 16)], ['a', day(9, 7, 16, 1), MODEL, 2000, 300],
  ],
}

const projects = {
  'pricing': 'pricing-a1',
  'pricing2': 'pricing-straddle',
  'pricing3': 'pricing-b1',
  'website': 'website-a1',
  'mobile': 'mobile-b1',
}

const slug = name => name.replaceAll('/', '-')
for (const [dir, prefix] of Object.entries({ '-work-pricing': ['pricing-a1', 'pricing-straddle', 'pricing-b1'], '-work-website': ['website-a1'], '-work-mobile': ['mobile-b1', 'mobile-b2'] })) {
  const dirPath = join(root, 'claude', 'projects', dir)
  await mkdir(dirPath, { recursive: true })
  let seq = 0
  for (const sessionId of prefix) {
    const lines = sessions[sessionId].map(spec => {
      const [kind, ts, model, input, output] = spec
      if (kind === 'u') return user(sessionId, ts)
      seq += 1
      return assistant(sessionId, ts, model, input, output, `msg-${sessionId}-${seq}`)
    })
    await writeFile(join(dirPath, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8')
  }
}
console.log(`fixture written under ${root}`)
