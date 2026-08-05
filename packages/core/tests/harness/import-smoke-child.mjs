// Runs under block-io-register.mjs. argv[2..] are absolute paths to every
// exports-map dist target (computed by the parent test from package.json, since
// this child cannot read files). It imports each one, then proves:
//   1. imports touch nothing (any I/O import inside core throws),
//   2. a trivial fingerprint + schema parse work,
//   3. a representative PARSER body (claude parseJsonlLine),
//   4. a representative DECODER body (codex decodeCodex), and
//   5. a representative DETECTOR body (junkReadsDetector)
// all execute cleanly under the same stubs. A decoder or detector that opened a
// file, hit the network, or read ambient env when CALLED now fails the guard —
// previously only import purity was proven, so an I/O-bearing body passed.
import { pathToFileURL } from 'node:url'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('import-smoke: no dist targets provided')
  process.exit(2)
}

const loaded = {}
for (const abs of targets) {
  const mod = await import(pathToFileURL(abs).href)
  loaded[abs] = mod
}

// The barrel is the first target by convention; find whichever export set has
// the functions we need (index re-exports everything).
const barrel = Object.values(loaded).find(
  (m) => typeof m.sessionRef === 'function' && typeof m.parseObservationEnvelope === 'function',
)
if (!barrel) {
  console.error('import-smoke: barrel exports not found across targets')
  process.exit(3)
}

// Trivial fingerprint (pure crypto, no I/O).
const ref = barrel.sessionRef('smoke-key', 'claude', 'session-123')
if (!/^[0-9a-f]{16}$/.test(ref)) {
  console.error(`import-smoke: unexpected fingerprint ${ref}`)
  process.exit(4)
}

// Trivial schema parse.
const env = barrel.parseObservationEnvelope({
  schemaVersion: '0.2.0',
  generator: { name: '@codeburn/core', version: '0.0.0-smoke' },
  sessions: [],
})
if (env.schemaVersion !== '0.2.0') {
  console.error('import-smoke: parse returned unexpected envelope')
  process.exit(5)
}

// ── body coverage under the stubs ──────────────────────────────────────────

// 3. Parser body: claude parseJsonlLine must parse a real user line. A parser
// whose body reached for fs/env/network would throw here.
const claude = Object.values(loaded).find((m) => typeof m.parseJsonlLine === 'function')
if (!claude) {
  console.error('import-smoke: claude parser module not found across targets')
  process.exit(6)
}
const entry = claude.parseJsonlLine(
  JSON.stringify({ type: 'user', timestamp: '2026-07-17T10:00:00.000Z', sessionId: 'sess-smoke', message: { role: 'user', content: 'hello' } }),
)
if (!entry || entry.type !== 'user') {
  console.error('import-smoke: parseJsonlLine returned unexpected result')
  process.exit(7)
}

// 4. Decoder body: codex decodeCodex over a minimal rollout must emit a call.
const codex = Object.values(loaded).find((m) => typeof m.decodeCodex === 'function')
if (!codex) {
  console.error('import-smoke: codex decoder module not found across targets')
  process.exit(8)
}
const { calls } = codex.decodeCodex({
  records: [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-07-17T10:00:00.000Z', payload: { cwd: '/smoke', originator: 'codex-cli', session_id: 'sess-smoke', model: 'gpt-5.3-codex' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-07-17T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-07-17T10:00:05.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }, total_token_usage: { total_tokens: 8 } } } }),
  ],
  context: { privacyKey: 'smoke-key', providerId: 'codex', sourceRef: 'smoke-ref' },
})
if (!Array.isArray(calls) || calls.length === 0) {
  console.error('import-smoke: decodeCodex produced no calls')
  process.exit(9)
}

// 5. Detector body: junkReadsDetector over an envelope with 3 dependency reads
// must emit exactly one finding (the boundary case from detectors.test.ts). A
// detector whose body touched I/O would throw here instead.
const detectorsMod = Object.values(loaded).find((m) => typeof m.junkReadsDetector === 'function')
if (!detectorsMod) {
  console.error('import-smoke: detectors module not found across targets')
  process.exit(10)
}
const junkEnv = {
  schemaVersion: '0.2.0',
  generator: { name: '@codeburn/core', version: '0.0.0-smoke' },
  sessions: [{
    sessionRef: '0000000000000000',
    projectRef: '0000000000000000',
    providerId: 'claude',
    startedAt: '2026-07-17T10:00:00.000Z',
    calls: [{
      provider: 'claude',
      model: 'claude-opus-4-8',
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheCreate: 0 },
      webSearchRequests: 0,
      speed: 'standard',
      costBasis: 'estimated',
      timestamp: '2026-07-17T10:00:00.000Z',
      dedupKey: 'smoke-dedup',
      toolNames: ['Read'],
      turnIndex: 0,
      resourceReads: [
        { resourceId: '0000000000000000', resourceClass: 'dependency' },
        { resourceId: '1111111111111111', resourceClass: 'dependency' },
        { resourceId: '2222222222222222', resourceClass: 'dependency' },
      ],
    }],
    turnCount: 1,
  }],
}
const junkFindings = detectorsMod.junkReadsDetector(junkEnv)
if (!Array.isArray(junkFindings) || junkFindings.length !== 1) {
  console.error(`import-smoke: junkReadsDetector expected 1 finding, got ${junkFindings?.length}`)
  process.exit(11)
}

console.log('IMPORT_SMOKE_OK')
