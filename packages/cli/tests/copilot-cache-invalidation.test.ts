// Regression test for the copilot JetBrains dedup-key shape change (D1).
//
// The JetBrains dedup key was an unkeyed sha256 of the assistant reply text
// (12 hex chars — 48 bits, dictionary-attackable on short replies); it is now
// an HMAC keyed with the host's privacy key. That changes the VALUE of the
// dedup key for EVERY record, not just hostile ones. copilot is the SOLE
// member of DURABLE_PROVIDER_NAMES: the durable union-merge never deletes
// cached turns — it appends any turn whose dedup keys are not already cached.
// So without a PROVIDER_PARSE_VERSIONS bump, the first time a JetBrains
// transcript re-parses after the change, the session's ENTIRE history would
// re-ingest under the new keyed digests while the old unkeyed-digest copies
// remain in the cache — both coexist, and the daily cache re-derives
// double-counted totals.
//
// The fix registers a new copilot parse version, which changes the provider
// envFingerprint and makes `parseAllSessions` DISCARD the stale section
// (rather than merging into it) on first run, so the old-shape keys are
// dropped and the double-append cannot happen.
//
// This test exercises the full `parseAllSessions` pipeline against a seeded
// session-cache.json, in both directions:
//  - a cache seeded with the CURRENT fingerprint is honored (the old-shape
//    keys stay, proving the seed is structurally valid and actually trusted)
//  - a cache seeded with the PRE-BUMP fingerprint is discarded and the .db
//    re-parses under the new key shape — the old keys are gone, and exactly
//    one (keyed) copy of each record remains

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { createHash, createHmac } from 'crypto'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import {
  CACHE_VERSION,
  computeEnvFingerprint,
  fingerprintFile,
  sessionCachePath,
  type SessionCache,
} from '../src/session-cache.js'

const TEST_ROOT = `${process.env['TMPDIR'] || '/tmp'}/copilot-cache-inv-${process.pid}-${Date.now()}`
const CACHE_DIR = join(TEST_ROOT, 'cache')
const JB_ROOT = join(TEST_ROOT, 'jetbrains')

// The JetBrains reply text used throughout. The digest in the dedup key is
// derived from EXACTLY this string, so the seeded old-shape key and the
// expected new-shape key are both computed from it.
const REPLY_TEXT = 'Hello! How can I help you today?'
const STORE_ID = 'conv-1'

// What computeEnvFingerprint('copilot') returned under the PRE-BUMP parse
// version ('cli-shutdown-cost-v1-skills'): copilot has no PROVIDER_ENV_VARS,
// so the fingerprint is a hash of the single `parser=` part. This is the
// fingerprint sitting in every cache written before the dedup-key change.
function preBumpFingerprint(): string {
  return createHash('sha256').update('parser=cli-shutdown-cost-v1-skills').digest('hex').slice(0, 16)
}

// The dedup key the pre-fix decoder wrote: an UNKEYED sha256 of the reply text.
function oldShapeKey(): string {
  const digest = createHash('sha256').update(REPLY_TEXT).digest('hex').slice(0, 12)
  return `copilot:jb:${STORE_ID}:${digest}:1`
}

// The dedup key the hardened decoder writes on the CLI path: an HMAC keyed
// with the bridge's privacy key, which is EMPTY there (bridge.ts — the rich
// decode is what feeds this cache, and minimization happens on the sync path).
function newShapeKey(): string {
  const digest = createHmac('sha256', '').update(REPLY_TEXT).digest('hex').slice(0, 12)
  return `copilot:jb:${STORE_ID}:${digest}:1`
}

// ---- Nitrite-.db fixture helpers (same on-disk shape as the real JetBrains
// Copilot plugin store: MVStore header + entity-class anchor + nested-escaped
// assistant blobs). See copilot.test.ts for the full family. ----

function jbAssistantBlob(text: string): string {
  const innerMd = { type: 'Markdown', data: JSON.stringify({ text, annotations: [] }) }
  const valueMap: Record<string, unknown> = {
    'a1b2c3d4-0000-0000-0000-000000000001': { type: 'Value', value: JSON.stringify(innerMd) },
  }
  const outer: Record<string, unknown> = {
    __first__: { type: 'Subgraph', value: JSON.stringify(valueMap) },
  }
  return JSON.stringify(outer)
}

function jbDbContent(blobs: string[]): string {
  return (
    'H:2,block:9,blockSize:1000,format:3\n' +
    'com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn\n' +
    blobs.join('\nt\x00\x00model\n') +
    '\n'
  )
}

async function createJetBrainsDb(): Promise<string> {
  const dir = join(JB_ROOT, 'iu', 'chat-agent-sessions', STORE_ID)
  await mkdir(dir, { recursive: true })
  const dbPath = join(dir, 'copilot-agent-sessions-nitrite.db')
  await writeFile(dbPath, jbDbContent([jbAssistantBlob(REPLY_TEXT)]))
  return dbPath
}

// Seeds a session cache holding ONE old-shape copilot turn for the .db, under
// the given envFingerprint. The cached file fingerprint is the REAL .db's, so
// a cache at the current fingerprint is served verbatim (proving the seed is
// trusted), while a pre-bump fingerprint forces the section rebuild.
async function seedCache(dbPath: string, envFingerprint: string): Promise<void> {
  const fp = await fingerprintFile(dbPath)
  if (!fp) throw new Error('failed to fingerprint seeded JetBrains .db')
  const now = new Date().toISOString()
  const cache: SessionCache = {
    version: CACHE_VERSION,
    providers: {
      copilot: {
        envFingerprint,
        files: {
          [dbPath]: {
            fingerprint: fp,
            mcpInventory: [],
            turns: [{
              timestamp: now,
              sessionId: STORE_ID,
              userMessage: '',
              calls: [{
                provider: 'copilot',
                model: 'gpt-4o',
                usage: {
                  inputTokens: 0,
                  outputTokens: 10,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                  cacheCreationOneHourTokens: 0,
                },
                speed: 'standard',
                timestamp: now,
                tools: [],
                bashCommands: [],
                skills: [],
                subagentTypes: [],
                deduplicationKey: oldShapeKey(),
              }],
            }],
          },
        },
      },
    },
  }
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(sessionCachePath(), JSON.stringify(cache))
}

async function cachedCopilotKeys(): Promise<{ envFingerprint: string; keys: string[] }> {
  const raw = JSON.parse(await readFile(sessionCachePath(), 'utf-8')) as {
    providers: Record<string, {
      envFingerprint: string
      files: Record<string, { turns: Array<{ calls: Array<{ deduplicationKey: string }> }> }>
    }>
  }
  const section = raw.providers['copilot']
  const keys: string[] = []
  for (const file of Object.values(section.files)) {
    for (const turn of file.turns) {
      for (const call of turn.calls) keys.push(call.deduplicationKey)
    }
  }
  return { envFingerprint: section.envFingerprint, keys }
}

async function parsedCopilotCalls() {
  const projects = await parseAllSessions(undefined, 'copilot')
  return projects
    .flatMap(p => p.sessions)
    .flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls)
}

beforeEach(async () => {
  // Runs after env-isolation's global beforeEach, which cleared these vars.
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  process.env['CODEBURN_COPILOT_JETBRAINS_DIR'] = JB_ROOT
  process.env['CODEBURN_COPILOT_DISABLE_OTEL'] = '1'
  clearSessionCache()
  await rm(TEST_ROOT, { recursive: true, force: true })
})

afterAll(async () => {
  clearSessionCache()
  await rm(TEST_ROOT, { recursive: true, force: true })
})

describe('copilot session cache invalidation', () => {
  it('registers a copilot parse-version bump in the env fingerprint', () => {
    // The pre-bump fingerprint is what every cache written before the
    // dedup-key change holds. It must NOT match the current one, or the
    // durable union-merge would keep the old unkeyed-digest keys and append
    // the same records under the new keyed shape on the next re-parse.
    expect(computeEnvFingerprint('copilot')).not.toBe(preBumpFingerprint())
  })

  it('control: a cache at the CURRENT fingerprint is honored (old-shape keys stay)', async () => {
    const dbPath = await createJetBrainsDb()
    await seedCache(dbPath, computeEnvFingerprint('copilot'))

    const calls = await parsedCopilotCalls()

    // The seeded cache is structurally valid and trusted: the unchanged .db is
    // not re-parsed, so the old-shape key survives verbatim. This proves the
    // seed is real (not silently ignored) — and that WITHOUT a fingerprint
    // bump, the pre-fix keys would be served forever.
    expect(calls).toHaveLength(1)
    const { envFingerprint, keys } = await cachedCopilotKeys()
    expect(envFingerprint).toBe(computeEnvFingerprint('copilot'))
    expect(keys).toEqual([oldShapeKey()])
  })

  it('regression: a pre-bump fingerprint discards the section instead of merging', async () => {
    const dbPath = await createJetBrainsDb()
    await seedCache(dbPath, preBumpFingerprint())

    const calls = await parsedCopilotCalls()

    // The pre-bump fingerprint no longer matches, so the section is REBUILT:
    // the old-shape key is dropped and the .db re-parses under the new keyed
    // shape. Exactly one copy of the record remains — had the section been
    // merged instead of discarded, the durable union-merge would have kept the
    // old key AND appended the new one (the double-append this bump prevents).
    expect(calls).toHaveLength(1)
    expect(calls[0]!.deduplicationKey).toBe(newShapeKey())
    const { envFingerprint, keys } = await cachedCopilotKeys()
    expect(envFingerprint).toBe(computeEnvFingerprint('copilot'))
    expect(keys).toEqual([newShapeKey()])
    expect(keys).not.toContain(oldShapeKey())
  })
})
