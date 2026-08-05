import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * ARCHITECTURE GATE — decision D2 (#809 phase 6).
 *
 * Task classification (TaskCategory) and the user-/self-correction scans are
 * HOST-SIDE by design: they run in the CLI over the rich decode (ParsedTurn /
 * ClassifiedTurn) and over raw transcript files, never over the wire envelope.
 * `@codeburn/core` produces only the minimized ObservationEnvelope / Finding —
 * structurally incapable of carrying free text (see observations.ts, contracts.ts,
 * and content-smuggling.test.ts).
 *
 * This gate makes that boundary permanent and un-regressable in two ways:
 *   1. Source scan: no file under packages/core/src may name a task category,
 *      a classification/correction identifier, or a correction-pattern phrase.
 *      `userMessage` is confined to the four rich-decode carriers (allowlist).
 *   2. Schema scan: every string-typed property in every envelope schema (all
 *      versions) must be constraint-bounded — enum/const, pattern, date-time,
 *      or length-bounded — with a justified allowlist for the machine-identifier
 *      fields. A new free-text-capable string property fails the gate.
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const srcRoot = resolve(pkgRoot, 'src')

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const sourceFiles = collectSourceFiles(srcRoot).map(f => ({
  rel: relative(pkgRoot, f).split('\\').join('/'),
  text: readFileSync(f, 'utf8'),
}))

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// 1. Source scan
// ---------------------------------------------------------------------------

// The CLI's TaskCategory union (packages/cli/src/types.ts). Frozen here as the
// gate's expectation: classification lives ONLY in the CLI, so none of these
// literals may appear as a string literal anywhere in core.
const TASK_CATEGORY_NAMES = [
  'coding',
  'debugging',
  'feature',
  'refactoring',
  'testing',
  'exploration',
  'planning',
  'delegation',
  'git',
  'build/deploy',
  'conversation',
  'brainstorming',
  'general',
] as const

// Legitimate collisions with a category name. `'git'` here is a member of the
// `CommandFamily` coarse enum in fingerprint.ts (a bash-command bucket:
// git/test/build/package/...), NOT the TaskCategory. It is fingerprint-layer
// command classification, unrelated to task classification, so it is allowed.
// `'general'` in pi/decode.ts is in a comment explaining the original provider's
// skill-vs-read classification (from pi.ts); it's host-side logic explanation,
// not core classification vocabulary.
// Keyed `${name} in ${rel}`; each entry is a justified false positive.
const CATEGORY_LITERAL_ALLOWLIST = new Set<string>([
  'git in src/fingerprint.ts',
  'general in src/providers/pi/decode.ts',
  // Kiro's modern-execution parser searches record-shape keys for conversation
  // arrays; this is a provider data key, not task classification vocabulary.
  'conversation in src/providers/kiro/decode.ts',
])

// Identifiers that would signal classification or correction logic leaking into
// core. (Names of the CLI-only classifier/scanner surface.)
const FORBIDDEN_IDENTIFIERS = [
  'TaskCategory',
  'ClassifiedTurn',
  'subCategory',
  'classifyTurn',
  'classifyConversation',
  'refineByKeywords',
  'scanSelfCorrections',
  'scanUserCorrections',
  'correctionRate',
  'USER_CORRECTION_PATTERNS',
  'SELF_CORRECTION_PATTERNS',
] as const

// Distinctive fragments of the CLI's correction regexes (compare-stats.ts
// SELF_CORRECTION_PATTERNS + workflow-insights.ts USER_CORRECTION_PATTERNS).
// Free-text correction analysis is host-side; none of this vocabulary belongs
// in core.
const CORRECTION_PHRASES = [
  'my mistake',
  'my bad',
  'i apologize',
  'i was wrong',
  'i was incorrect',
  'let me correct',
  'sorry about that',
  'not what i',
  'you missed',
  'you forgot',
  'you misunderstood',
] as const

// `userMessage` is host-held rich-decode data: the decoder captures the user's
// message on the DecodedTurn so the HOST can classify it, but it is never placed
// on the ObservationEnvelope (proven by content-smuggling.test.ts). These four
// files are the only legitimate carriers; any new occurrence elsewhere is a leak.
const USER_MESSAGE_ALLOWLIST = new Set([
  'src/providers/claude/decode.ts',
  'src/providers/claude/types.ts',
  'src/providers/cline-cli/decode.ts',
  'src/providers/cline-cli/types.ts',
  'src/providers/codebuff/decode.ts',
  'src/providers/codebuff/types.ts',
  'src/providers/codewhale/decode.ts',
  'src/providers/codewhale/types.ts',
  'src/providers/codex/decode.ts',
  'src/providers/codex/types.ts',
  'src/providers/grok/decode.ts',
  'src/providers/grok/types.ts',
  'src/providers/kimi/decode.ts',
  'src/providers/kimi/types.ts',
  'src/providers/qwen/decode.ts',
  'src/providers/qwen/types.ts',
  'src/providers/zerostack/decode.ts',
  'src/providers/zerostack/types.ts',
  'src/providers/droid/decode.ts',
  'src/providers/droid/types.ts',
  'src/providers/mux/decode.ts',
  'src/providers/mux/types.ts',
  'src/providers/openclaw/decode.ts',
  'src/providers/openclaw/types.ts',
  'src/providers/open-design/decode.ts',
  'src/providers/open-design/types.ts',
  'src/providers/lingtai-tui/decode.ts',
  'src/providers/lingtai-tui/types.ts',
  'src/providers/gemini/decode.ts',
  'src/providers/gemini/types.ts',
  'src/providers/kimicode/decode.ts',
  'src/providers/kimicode/types.ts',
  'src/providers/mistral-vibe/decode.ts',
  'src/providers/mistral-vibe/types.ts',
  'src/providers/pi/decode.ts',
  'src/providers/pi/types.ts',
  'src/providers/zed/decode.ts',
  'src/providers/zed/types.ts',
  'src/providers/forge/decode.ts',
  'src/providers/forge/types.ts',
  'src/providers/goose/decode.ts',
  'src/providers/goose/types.ts',
  'src/providers/hermes/decode.ts',
  'src/providers/hermes/types.ts',
  'src/providers/warp/decode.ts',
  'src/providers/warp/types.ts',
  'src/providers/cursor-agent/decode.ts',
  'src/providers/cursor-agent/types.ts',
  'src/providers/cursor/decode.ts',
  'src/providers/cursor/types.ts',
  'src/providers/cursor/index.ts',
  'src/providers/quickdesk/decode.ts',
  'src/providers/quickdesk/types.ts',
  'src/providers/devin/decode.ts',
  'src/providers/devin/types.ts',
  'src/providers/copilot/decode.ts',
  'src/providers/copilot/types.ts',
  'src/providers/vscode-cline/decode.ts',
  'src/providers/vscode-cline/types.ts',
  'src/providers/opencode-session/decode.ts',
  'src/providers/opencode-session/types.ts',
  'src/providers/kiro/decode.ts',
  'src/providers/kiro/types.ts',
])

describe('architecture gate: no classification or free text in @codeburn/core source', () => {
  it('finds source files to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(10)
  })

  it('no TaskCategory name appears as a string literal in core/src', () => {
    const offenders: string[] = []
    for (const name of TASK_CATEGORY_NAMES) {
      const re = new RegExp(`['"\`]${escapeRegExp(name)}['"\`]`)
      for (const file of sourceFiles) {
        const entry = `${name} in ${file.rel}`
        if (re.test(file.text) && !CATEGORY_LITERAL_ALLOWLIST.has(entry)) offenders.push(entry)
      }
    }
    expect(offenders, `classification categories must stay CLI-side:\n${offenders.join('\n')}`).toEqual([])
  })

  it('no classification / correction identifier appears in core/src', () => {
    const offenders: string[] = []
    for (const ident of FORBIDDEN_IDENTIFIERS) {
      const re = new RegExp(`\\b${escapeRegExp(ident)}\\b`)
      for (const file of sourceFiles) {
        if (re.test(file.text)) offenders.push(`${ident} in ${file.rel}`)
      }
    }
    expect(offenders, `classifier/scanner surface must stay CLI-side:\n${offenders.join('\n')}`).toEqual([])
  })

  it('no correction-pattern phrase appears in core/src', () => {
    const offenders: string[] = []
    for (const phrase of CORRECTION_PHRASES) {
      for (const file of sourceFiles) {
        if (file.text.toLowerCase().includes(phrase)) offenders.push(`"${phrase}" in ${file.rel}`)
      }
    }
    expect(offenders, `correction vocabulary must stay CLI-side:\n${offenders.join('\n')}`).toEqual([])
  })

  it('userMessage appears only in the allowlisted rich-decode files', () => {
    const offenders = sourceFiles
      .filter(f => /userMessage/i.test(f.text) && !USER_MESSAGE_ALLOWLIST.has(f.rel))
      .map(f => f.rel)
    expect(offenders, `userMessage leaked outside the rich-decode allowlist:\n${offenders.join('\n')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Schema scan
// ---------------------------------------------------------------------------

// Every envelope schema version that has ever shipped. The gate checks all of
// them, so a retired version can never quietly grow a free-text field either.
const SCHEMA_FILES = ['observation-0.1.0', 'observation-0.2.0', 'finding-0.1.0'] as const

type StringField = { path: string; kind: string }

/** Classify a `{type:'string'}` subschema by the constraint that bounds it. */
function classifyStringNode(node: Record<string, unknown>): string {
  if ('const' in node) return `const:${JSON.stringify(node.const)}`
  if ('enum' in node) return `enum[${(node.enum as unknown[]).length}]`
  if ('pattern' in node) return `pattern:${String(node.pattern)}`
  if ('format' in node) return `format:${String(node.format)}`
  if ('maxLength' in node) return `maxLength:${String(node.maxLength)}`
  if ('minLength' in node) return `minLength-only:${String(node.minLength)}`
  return 'UNCONSTRAINED'
}

function walkStringFields(node: unknown, path: string, out: StringField[]): void {
  if (!node || typeof node !== 'object') return
  const n = node as Record<string, unknown>
  if (n.type === 'string') {
    out.push({ path, kind: classifyStringNode(n) })
    return
  }
  if (n.properties && typeof n.properties === 'object') {
    for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
      walkStringFields(v, `${path}/${k}`, out)
    }
  }
  if (n.items) walkStringFields(n.items, `${path}/items`, out)
  if (n.definitions && typeof n.definitions === 'object') {
    for (const [k, v] of Object.entries(n.definitions as Record<string, unknown>)) {
      walkStringFields(v, `${path}#${k}`, out)
    }
  }
}

function enumerateSchema(name: string): StringField[] {
  const schema = JSON.parse(readFileSync(resolve(pkgRoot, 'schemas', `${name}.json`), 'utf8'))
  const out: StringField[] = []
  walkStringFields(schema, name, out)
  return out
}

const allStringFields = SCHEMA_FILES.flatMap(enumerateSchema)

// A string field is "bounded" (cannot hold arbitrary free text) when it is a
// fixed literal, a closed enum, pattern-constrained (16-hex fingerprint,
// canonical tool-name charset, semver), a date-time, or length-capped.
function isBoundedKind(kind: string): boolean {
  return (
    kind.startsWith('const:') ||
    kind.startsWith('enum[') ||
    kind.startsWith('pattern:') ||
    kind.startsWith('format:') ||
    kind.startsWith('maxLength:')
  )
}

// The only string fields NOT length/charset-capped: machine-generated
// identifiers with `minLength:1` and no upper bound. Each is a controlled
// vocabulary emitted by the host (a generator version, a provider/model/pricing
// slug, or a hash-derived dedup key), never user free text — provider and model
// ids have no natural maximum, so no maxLength is asserted. content-smuggling
// tests prove no user text reaches these. Every entry is justified; a NEW
// minLength-only string field NOT listed here fails the gate.
const MACHINE_ID_ALLOWLIST = new Set<string>([
  'observation-0.1.0#ObservationEnvelope/generator/version',
  'observation-0.1.0#ObservationEnvelope/sessions/items/providerId',
  'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/provider',
  'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/model',
  'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/pricingModel',
  'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/dedupKey',
  'observation-0.2.0#ObservationEnvelope/generator/version',
  'observation-0.2.0#ObservationEnvelope/sessions/items/providerId',
  'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/provider',
  'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/model',
  'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/pricingModel',
  'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/dedupKey',
])

// The complete, frozen surface of string-typed schema properties. Regenerating
// this list is a deliberate, reviewed act: ANY added / removed / re-constrained
// string field breaks this test until a human updates the expectation, so the
// envelope's text surface can never drift silently.
const EXPECTED_STRING_FIELDS: StringField[] = [
  { path: 'observation-0.1.0#ObservationEnvelope/schemaVersion', kind: 'const:"0.1.0"' },
  { path: 'observation-0.1.0#ObservationEnvelope/generator/name', kind: 'const:"@codeburn/core"' },
  { path: 'observation-0.1.0#ObservationEnvelope/generator/version', kind: 'minLength-only:1' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/sessionRef', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/projectRef', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/providerId', kind: 'minLength-only:1' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/startedAt', kind: 'format:date-time' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/endedAt', kind: 'format:date-time' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/gitBranchRef', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/provider', kind: 'minLength-only:1' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/model', kind: 'minLength-only:1' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/pricingModel', kind: 'minLength-only:1' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/speed', kind: 'enum[2]' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/costBasis', kind: 'enum[2]' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/timestamp', kind: 'format:date-time' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/dedupKey', kind: 'minLength-only:1' },
  { path: 'observation-0.1.0#ObservationEnvelope/sessions/items/calls/items/toolNames/items', kind: 'pattern:^[A-Za-z0-9_.-]+$' },
  { path: 'observation-0.2.0#ObservationEnvelope/schemaVersion', kind: 'const:"0.2.0"' },
  { path: 'observation-0.2.0#ObservationEnvelope/generator/name', kind: 'const:"@codeburn/core"' },
  { path: 'observation-0.2.0#ObservationEnvelope/generator/version', kind: 'minLength-only:1' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/sessionRef', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/projectRef', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/providerId', kind: 'minLength-only:1' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/startedAt', kind: 'format:date-time' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/endedAt', kind: 'format:date-time' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/gitBranchRef', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/provider', kind: 'minLength-only:1' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/model', kind: 'minLength-only:1' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/pricingModel', kind: 'minLength-only:1' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/speed', kind: 'enum[2]' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/costBasis', kind: 'enum[2]' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/timestamp', kind: 'format:date-time' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/dedupKey', kind: 'minLength-only:1' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/toolNames/items', kind: 'pattern:^[A-Za-z0-9_.-]+$' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/resourceReads/items/resourceId', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/resourceReads/items/resourceClass', kind: 'enum[7]' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/resourceEdits/items/resourceId', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'observation-0.2.0#ObservationEnvelope/sessions/items/calls/items/resourceEdits/items/resourceClass', kind: 'enum[7]' },
  { path: 'finding-0.1.0#Finding/detectorId', kind: 'maxLength:128' },
  { path: 'finding-0.1.0#Finding/algorithmVersion', kind: 'pattern:^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$' },
  { path: 'finding-0.1.0#Finding/confidence/basis', kind: 'maxLength:200' },
  { path: 'finding-0.1.0#Finding/evidence/items/kind', kind: 'maxLength:64' },
  { path: 'finding-0.1.0#Finding/evidence/items/refs/items', kind: 'pattern:^[0-9a-f]{16}$' },
  { path: 'finding-0.1.0#Finding/evidence/items/sessionRefs/items', kind: 'pattern:^[0-9a-f]{16}$' },
]

describe('architecture gate: envelope schemas carry no free-text-capable field', () => {
  it('enumerates string fields across every schema version', () => {
    expect(allStringFields.length).toBeGreaterThan(0)
  })

  it('every string field is bounded or an allowlisted machine identifier', () => {
    const offenders = allStringFields
      .filter(f => !isBoundedKind(f.kind) && !MACHINE_ID_ALLOWLIST.has(f.path))
      .map(f => `${f.path} => ${f.kind}`)
    expect(offenders, `unconstrained string field(s) can carry free text:\n${offenders.join('\n')}`).toEqual([])
  })

  it('no string field is a fully unconstrained bare string', () => {
    const bare = allStringFields.filter(f => f.kind === 'UNCONSTRAINED').map(f => f.path)
    expect(bare, `bare z.string() field(s) found:\n${bare.join('\n')}`).toEqual([])
  })

  it('the string-field surface matches the frozen enumeration', () => {
    const key = (f: StringField) => `${f.path} => ${f.kind}`
    expect(allStringFields.map(key).sort()).toEqual(EXPECTED_STRING_FIELDS.map(key).sort())
  })
})
