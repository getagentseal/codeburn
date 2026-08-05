/**
 * Tests for the sync privacy-key contract (src/privacy-key.ts).
 *
 * Sync ids (device/span/trace) must be stable ACROSS processes: the
 * partial-rejection retry in push.ts only works if a retry carries the same
 * span ids. getPersistedHostPrivacyKey enforces that by refusing to degrade —
 * it throws when the key cannot be persisted, and refuses to silently
 * regenerate a key file that exists but does not hold a valid key. That
 * includes a zero-byte or whitespace-only file (a partial write) and a file
 * that cannot be read: 'no file at all' is the only state that may be
 * created. The tolerant getHostPrivacyKey (used by the optimize detectors,
 * which only need per-process stability) also refuses to overwrite a corrupt
 * file — it degrades to an ephemeral in-memory key and leaves the file alone,
 * so the strict path still sees the corruption.
 *
 * First creation is exclusive (O_CREAT|O_EXCL): concurrent first uses converge
 * on one key — the loser re-reads and adopts the winner's — so two processes
 * can never mint different keys and mix cached device ids with spans derived
 * from the other.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, chmod, readFile, writeFile, stat } from 'fs/promises'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { getHostPrivacyKey, getPersistedHostPrivacyKey } from '../src/privacy-key.js'
import { buildOtlpPayload, deriveDeviceId, type CallWithSession } from '../src/sync/otlp.js'
import type { ParsedApiCall, TokenUsage } from '../src/types.js'

// ── Test env: isolated HOME per test ─────────────────────────────────

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-privkey-'))
  process.env.HOME = tmpDir
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function keyFilePath(): string {
  return join(tmpDir, '.config', 'codeburn', 'privacy-key')
}

// ── getPersistedHostPrivacyKey: happy path ───────────────────────────

describe('getPersistedHostPrivacyKey', () => {
  it('generates and persists a valid key on first use', async () => {
    const key = getPersistedHostPrivacyKey()
    expect(key).toMatch(/^[0-9a-f]{64}$/)

    const raw = await readFile(keyFilePath(), 'utf-8')
    expect(raw.trim()).toBe(key)
  })

  it('persists with owner-only permissions', async () => {
    getPersistedHostPrivacyKey()
    const s = await stat(keyFilePath())
    // mode 0600: no group or other bits, whatever the umask clears
    expect(s.mode & 0o077).toBe(0)
  })

  it('is stable across calls in one process', () => {
    expect(getPersistedHostPrivacyKey()).toBe(getPersistedHostPrivacyKey())
  })

  it('returns the same key in a fresh process (cross-process stability)', async () => {
    const first = getPersistedHostPrivacyKey()

    // Simulate a second process: wipe the module registry so the cached key
    // is gone and the file must be re-read.
    vi.resetModules()
    const { getPersistedHostPrivacyKey: again } = await import('../src/privacy-key.js')
    expect(again()).toBe(first)
  })
})

// ── F1 failure modes ─────────────────────────────────────────────────

describe('getPersistedHostPrivacyKey — F1 failure modes', () => {
  it('throws on an unwritable config dir instead of degrading to a per-process key', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    await chmod(configDir, 0o555) // read-only: writes fail

    try {
      expect(() => getPersistedHostPrivacyKey()).toThrow(/Cannot persist a host privacy key/)
      // No ephemeral fallback file appears
      await expect(readFile(keyFilePath(), 'utf-8')).rejects.toThrow()
    } finally {
      await chmod(configDir, 0o755) // let afterEach rm it
    }
  })

  it('throws on a corrupt key file and does NOT overwrite it', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    // Truncated / partial write: non-empty but not 64 hex chars
    await writeFile(keyFilePath(), 'deadbeef-truncated')

    expect(() => getPersistedHostPrivacyKey()).toThrow(/corrupted/)
    const raw = await readFile(keyFilePath(), 'utf-8')
    expect(raw).toBe('deadbeef-truncated') // untouched — no silent re-key
  })

  it('throws on a zero-byte key file (partial write) and does NOT replace it', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    // A crashed writer: file created, nothing written. A zero-byte file is a
    // partial write — corrupt, NOT an absent key. It must not be treated as
    // missing and silently regenerated.
    await writeFile(keyFilePath(), '')

    expect(() => getPersistedHostPrivacyKey()).toThrow(/corrupted/)
    const raw = await readFile(keyFilePath(), 'utf-8')
    expect(raw).toBe('') // untouched — no silent re-key
  })

  it('throws on a whitespace-only key file and does NOT replace it', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    await writeFile(keyFilePath(), '\n\n')

    expect(() => getPersistedHostPrivacyKey()).toThrow(/corrupted/)
    const raw = await readFile(keyFilePath(), 'utf-8')
    expect(raw).toBe('\n\n') // untouched — no silent re-key
  })

  it('throws when the key file exists but cannot be read, and does NOT replace it', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    // A valid key made unreadable: the file EXISTS, so it must never be
    // overwritten — the failure must surface to the operator instead.
    const original = 'c0deb00c'.repeat(8)
    await writeFile(keyFilePath(), original + '\n')
    await chmod(keyFilePath(), 0o000)

    try {
      expect(() => getPersistedHostPrivacyKey()).toThrow(/could not be read/)
    } finally {
      await chmod(keyFilePath(), 0o600) // restore so we can inspect it
    }
    const raw = await readFile(keyFilePath(), 'utf-8')
    expect(raw).toBe(original + '\n') // untouched — no silent re-key
  })
})

// ── Tolerant path: corrupt file is never silently replaced ─────────────

describe('getHostPrivacyKey — corrupt file is never silently replaced', () => {
  it('falls back to an ephemeral key, leaves the file alone, and the strict path still fails', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    await writeFile(keyFilePath(), 'deadbeef-truncated')

    // Fresh module instance: don't let a cached key from earlier tests mask
    // the corrupt-file path.
    vi.resetModules()
    const { getHostPrivacyKey, getPersistedHostPrivacyKey } = await import('../src/privacy-key.js')

    const key = getHostPrivacyKey()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(getHostPrivacyKey()).toBe(key) // per-process stability kept

    // The tolerant path must NOT have overwritten the corrupt file.
    expect(await readFile(keyFilePath(), 'utf-8')).toBe('deadbeef-truncated')

    // The strict path still sees the corruption and fails loudly — it is not
    // masked by a freshly regenerated file.
    expect(() => getPersistedHostPrivacyKey()).toThrow(/corrupted/)
    expect(await readFile(keyFilePath(), 'utf-8')).toBe('deadbeef-truncated')
  })
})

// ── F1 through the sync-facing surface (buildOtlpPayload) ────────────

function makeCall(): ParsedApiCall {
  const usage: TokenUsage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
  return {
    provider: 'kiro',
    model: 'claude-sonnet-4-6',
    usage,
    costUSD: 0.01,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-07-10T10:00:00.000Z',
    bashCommands: [],
    deduplicationKey: 'test:key:1',
  }
}

function makeCws(): CallWithSession {
  return { call: makeCall(), sessionId: 'session-abc', project: 'my-project' }
}

describe('buildOtlpPayload — F1 failure mode', () => {
  it('aborts (throws) before any payload is built when the key cannot be persisted', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    await chmod(configDir, 0o555)

    try {
      expect(() => buildOtlpPayload([makeCws()])).toThrow(/Cannot persist a host privacy key/)
    } finally {
      await chmod(configDir, 0o755)
    }
  })

  it('aborts (throws) on a corrupt key file', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    await writeFile(keyFilePath(), 'deadbeef-truncated')

    expect(() => buildOtlpPayload([makeCws()])).toThrow(/corrupted/)
    const raw = await readFile(keyFilePath(), 'utf-8')
    expect(raw).toBe('deadbeef-truncated')
  })

  it('aborts (throws) on a zero-byte key file and does NOT replace it', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    await writeFile(keyFilePath(), '')

    expect(() => buildOtlpPayload([makeCws()])).toThrow(/corrupted/)
    const raw = await readFile(keyFilePath(), 'utf-8')
    expect(raw).toBe('')
  })
})

// ── Concurrent first use: exclusive create + convergence ─────────────

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}

// Fixture path anchored to THIS file, not process.cwd(): vitest workers run
// with the invocation cwd (repo root under `--root packages/cli`), so a
// cwd-relative path silently points at a nonexistent file and the worker
// exits before ever writing its ready file.
const FIRST_USE_WORKER = fileURLToPath(new URL('./fixtures/privacy-key-first-use-worker.ts', import.meta.url))

function firstUseWorker(goFile: string, readyFile: string, homeDir: string): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', 'tsx', FIRST_USE_WORKER, goFile, readyFile],
    { cwd: process.cwd(), env: { ...process.env, HOME: homeDir }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

function waitForExit(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`))
      else resolve(stdout)
    })
  })
}

describe('concurrent first use', () => {
  it('on a create collision (EEXIST), re-reads and adopts the concurrent winner key', async () => {
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    const winnerKey = 'e'.repeat(64)

    // Simulate another process winning the create race: our exclusive write
    // collides, and the winner's key is already on disk when we re-read.
    vi.doMock('fs', async importOriginal => {
      const actual = await importOriginal<typeof import('fs')>()
      return {
        ...actual,
        writeFileSync: (p: string, _data: unknown, _opts?: unknown) => {
          actual.writeFileSync(p, winnerKey + '\n', { mode: 0o600, flag: 'wx' })
          const err = new Error(`EEXIST: file already exists, open '${p}'`) as NodeJS.ErrnoException
          err.code = 'EEXIST'
          throw err
        },
      }
    })
    vi.resetModules()
    try {
      const { getPersistedHostPrivacyKey } = await import('../src/privacy-key.js')
      expect(getPersistedHostPrivacyKey()).toBe(winnerKey)
      expect(await readFile(keyFilePath(), 'utf-8')).toBe(winnerKey + '\n')
    } finally {
      vi.doUnmock('fs')
      vi.resetModules()
    }
  })

  it('two processes racing the first use end with ONE key and consistent ids', async () => {
    // Three rounds, each on a fresh HOME: a round where the key file already
    // exists cannot race, so every round must start from an empty config dir.
    // On a non-exclusive first write a racing pair mints two keys and the
    // assertion below fails; with the exclusive create they always converge.
    for (let round = 0; round < 3; round++) {
      const home = join(tmpDir, `round-${round}`)
      const goFile = join(home, 'go')
      const readyA = join(home, 'a.ready')
      const readyB = join(home, 'b.ready')
      await mkdir(home, { recursive: true })

      const a = firstUseWorker(goFile, readyA, home)
      const b = firstUseWorker(goFile, readyB, home)
      // Only release the race once BOTH processes are booted and spinning.
      await Promise.all([waitFor(readyA), waitFor(readyB)])
      await writeFile(goFile, 'go')

      const [outA, outB] = await Promise.all([waitForExit(a), waitForExit(b)])
      const resA = JSON.parse(outA) as { key: string; deviceId: string }
      const resB = JSON.parse(outB) as { key: string; deviceId: string }

      // The loser must adopt the winner's key, not mint and overwrite its own —
      // otherwise cached device ids from one key mix with spans derived from the
      // other.
      expect(resA.key).toBe(resB.key)
      // ... and the converged key is the one persisted on disk.
      expect((await readFile(join(home, '.config', 'codeburn', 'privacy-key'), 'utf-8')).trim()).toBe(resA.key)
      // Ids derived under the converged key agree across both processes.
      expect(resA.deviceId).toBe(resB.deviceId)
      expect(resA.deviceId).toBe(deriveDeviceId(resA.key, 'race-host', 'race-user'))
    }
  })
})
