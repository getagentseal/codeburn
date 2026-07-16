// Regression test for the Kiro stale-cache path (#618, #619).
//
// Before this fix the Kiro parser returned 0 turns for every IDE execution
// file that stores content under `context.messages[].entries`. Those empty
// results were cached in session-cache.json keyed by file fingerprint, so
// shipping a fixed parser alone is not enough: unchanged files would keep
// their cached `turns: []` forever. The fix registers kiro in
// PROVIDER_PARSE_VERSIONS, which changes the provider envFingerprint and
// makes `parseProviderSources` discard the stale section on first run.
//
// This test exercises the full `parseAllSessions` pipeline against a seeded
// session-cache.json, in both directions:
//  - a cache seeded with the CURRENT fingerprint is honored (zero-turn entry
//    stays, proving the seed is structurally valid and actually trusted)
//  - a cache seeded with the PRE-FIX fingerprint is discarded and the file
//    is re-parsed, recovering the calls the broken parser missed

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import {
  CACHE_VERSION,
  computeEnvFingerprint,
  fingerprintFile,
  type SessionCache,
} from '../src/session-cache.js'

// The kiro provider singleton captures homedir() when its module is first
// imported, so HOME must point at the test root before ../src/parser.js is
// evaluated. vi.hoisted runs ahead of the static imports above (but after
// tests/setup/env-isolation.ts, whose per-test beforeEach re-sandboxes env
// vars — anything read at *call* time, like CODEBURN_CACHE_DIR, must be
// re-asserted in this file's own beforeEach).
const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/kiro-cache-inv-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  return root
})

const HOME = join(testRoot, 'home')
const CACHE_DIR = join(testRoot, 'cache')

function kiroAgentDir(): string {
  if (process.platform === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  if (process.platform === 'win32') {
    return join(HOME, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  return join(HOME, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
}

// What computeEnvFingerprint('kiro') returned before kiro had an entry in
// PROVIDER_PARSE_VERSIONS: no env vars, no parser version, i.e. a hash of
// zero parts. This is the fingerprint sitting in every pre-fix cache.
function preFixFingerprint(): string {
  return createHash('sha256').update([].join('\0')).digest('hex').slice(0, 16)
}

// Writes one IDE execution file in the context.messages[].entries format that
// the pre-fix parser turned into 0 turns, and returns its path.
async function seedExecutionFile(): Promise<string> {
  const dir = join(kiroAgentDir(), 'a'.repeat(32), 'b'.repeat(32))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'exec-stale-001')
  await writeFile(path, JSON.stringify({
    executionId: 'exec-stale-001',
    workflowType: 'chat-agent',
    status: 'succeed',
    startTime: 1780000000000,
    chatSessionId: 'session-stale-001',
    context: {
      messages: [
        { role: 'human', entries: [{ type: 'text', text: 'What is TypeScript?' }] },
        { role: 'bot', entries: [{ type: 'text', text: 'TypeScript is a typed superset of JavaScript.' }] },
      ],
    },
  }))
  return path
}

async function seedCache(execPath: string, envFingerprint: string): Promise<void> {
  const fp = await fingerprintFile(execPath)
  if (!fp) throw new Error('failed to fingerprint seeded execution file')
  const cache: SessionCache = {
    version: CACHE_VERSION,
    providers: {
      kiro: {
        envFingerprint,
        files: {
          [execPath]: { fingerprint: fp, mcpInventory: [], turns: [] },
        },
      },
    },
  }
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(join(CACHE_DIR, 'session-cache.json'), JSON.stringify(cache))
}

async function parseKiroCalls() {
  const projects = await parseAllSessions(undefined, 'kiro')
  return projects
    .flatMap(p => p.sessions)
    .flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls)
}

beforeEach(async () => {
  // Runs after env-isolation's global beforeEach, which cleared this var.
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

afterAll(async () => {
  clearSessionCache()
  await rm(testRoot, { recursive: true, force: true })
})

describe('Kiro session cache invalidation', () => {
  it('registers a kiro parser version in the env fingerprint', () => {
    expect(computeEnvFingerprint('kiro')).not.toBe(preFixFingerprint())
  })

  it('control: a zero-turn cache entry at the current fingerprint is honored', async () => {
    const execPath = await seedExecutionFile()
    await seedCache(execPath, computeEnvFingerprint('kiro'))

    const calls = await parseKiroCalls()

    // The seeded cache is structurally valid and trusted: the unchanged file
    // is not re-parsed, so the stale zero-turn entry yields no calls. This
    // guards the regression test below against passing for the wrong reason
    // (an invalid or unread seed being silently ignored).
    expect(calls).toHaveLength(0)
  })

  it('regression: a pre-fix cache fingerprint forces a re-parse that recovers the calls', async () => {
    const execPath = await seedExecutionFile()
    await seedCache(execPath, preFixFingerprint())

    const calls = await parseKiroCalls()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.usage.inputTokens).toBeGreaterThan(0)
    expect(calls[0]!.usage.outputTokens).toBeGreaterThan(0)
  })
})
