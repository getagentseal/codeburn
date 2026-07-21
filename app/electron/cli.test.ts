// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, isAbsolute, relative, win32, posix } from 'node:path'

import { spawnCli, spawnCliAction, spawnEnvFor, spawnSpecFor, killAll, CliError, nodeManagerDirs, notFoundStage, resolveCodeburnPath, resolveTarget } from './cli'

let dir: string
const originalBin = process.env.CODEBURN_BIN
const originalPathDirs = process.env.CODEBURN_PATH_DIRS
const originalPathFile = process.env.CODEBURN_CLI_PATH_FILE
const originalViteUrl = process.env.VITE_DEV_SERVER_URL
const originalBundled = process.env.CODEBURN_BUNDLED_CLI
const originalDevRepoRoot = process.env.CODEBURN_DEV_REPO_ROOT

/** Writes an executable node script and points CODEBURN_BIN at it. */
function fakeBin(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
  chmodSync(p, 0o755)
  process.env.CODEBURN_BIN = p
  return p
}

/** Writes the repo CLI under this test's isolated dev-root override. */
function fakeDevRepoCli(): string {
  const repoRoot = join(dir, 'dev-repo')
  const p = join(repoRoot, 'dist', 'cli.js')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '#!/usr/bin/env node\n', { mode: 0o755 })
  chmodSync(p, 0o755)
  process.env.CODEBURN_DEV_REPO_ROOT = repoRoot
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeburn-cli-'))
})

afterEach(() => {
  if (originalBin === undefined) delete process.env.CODEBURN_BIN
  else process.env.CODEBURN_BIN = originalBin
  if (originalPathDirs === undefined) delete process.env.CODEBURN_PATH_DIRS
  else process.env.CODEBURN_PATH_DIRS = originalPathDirs
  if (originalPathFile === undefined) delete process.env.CODEBURN_CLI_PATH_FILE
  else process.env.CODEBURN_CLI_PATH_FILE = originalPathFile
  if (originalViteUrl === undefined) delete process.env.VITE_DEV_SERVER_URL
  else process.env.VITE_DEV_SERVER_URL = originalViteUrl
  if (originalBundled === undefined) delete process.env.CODEBURN_BUNDLED_CLI
  else process.env.CODEBURN_BUNDLED_CLI = originalBundled
  if (originalDevRepoRoot === undefined) delete process.env.CODEBURN_DEV_REPO_ROOT
  else process.env.CODEBURN_DEV_REPO_ROOT = originalDevRepoRoot
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveCodeburnPath (Vite development)', () => {
  it('prefers the executable repo dist/cli.js when the Vite dev server is set', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    const devBin = fakeDevRepoCli()

    expect(resolveCodeburnPath()).toBe(devBin)
  })

  it('prefers the repo dev CLI over a persisted-path file (stale global) in dev', () => {
    // A persisted global (e.g. an older Homebrew codeburn) must NOT shadow the
    // repo build in dev, or newly-added commands break. Regression: 0.9.15
    // lacked `sessions`, so the persisted path produced a CLI error.
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    const persistedTarget = join(dir, 'stale-codeburn')
    writeFileSync(persistedTarget, '#!/usr/bin/env node\n', { mode: 0o755 })
    chmodSync(persistedTarget, 0o755)
    const persistedFile = join(dir, 'cli-path.v1')
    writeFileSync(persistedFile, persistedTarget)
    process.env.CODEBURN_CLI_PATH_FILE = persistedFile
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    const devBin = fakeDevRepoCli()

    const resolved = resolveCodeburnPath()
    expect(resolved).toBe(devBin)
    expect(resolved).not.toBe(persistedTarget)
  })

  it('does not return the repo dev CLI outside the Vite dev server', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    delete process.env.VITE_DEV_SERVER_URL

    expect(resolveCodeburnPath()).toBeNull()
  })
})

describe('resolveTarget (bundled CLI in the packaged app)', () => {
  /** An existing (not necessarily executable) file to stand in for the bundle. */
  function bundledEntry(name = 'cli.js'): string {
    const p = join(dir, name)
    writeFileSync(p, '// bundled cli\n')
    return p
  }

  it('resolves the bundled CLI, beating a persisted path and PATH', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    // A persisted global that should NOT win once a bundled CLI is present.
    const persistedTarget = join(dir, 'stale-global')
    writeFileSync(persistedTarget, '#!/usr/bin/env node\n', { mode: 0o755 })
    chmodSync(persistedTarget, 0o755)
    const persistedFile = join(dir, 'cli-path.v1')
    writeFileSync(persistedFile, persistedTarget)
    process.env.CODEBURN_CLI_PATH_FILE = persistedFile

    const entry = bundledEntry()
    process.env.CODEBURN_BUNDLED_CLI = entry

    expect(resolveTarget()).toEqual({ kind: 'bundled', entry })
    expect(resolveCodeburnPath()).toBe(entry)
  })

  it('CODEBURN_BIN still overrides the bundled CLI', () => {
    const override = fakeBin('override.js', 'process.stdout.write("{}")') // sets CODEBURN_BIN
    process.env.CODEBURN_BUNDLED_CLI = bundledEntry('bundled.js')
    delete process.env.VITE_DEV_SERVER_URL

    expect(resolveTarget()).toEqual({ kind: 'external', bin: override })
  })

  it('the dev repo CLI beats the bundled CLI in Vite development', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.CODEBURN_BUNDLED_CLI = bundledEntry('bundled.js')
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    const devBin = fakeDevRepoCli()

    const target = resolveTarget()
    expect(target).toEqual({ kind: 'external', bin: devBin })
  })

  it('falls through when CODEBURN_BUNDLED_CLI points at a missing file', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = '' // force an empty PATH search space
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.CODEBURN_BUNDLED_CLI = join(dir, 'does-not-exist', 'cli.js')

    expect(resolveTarget()).toBeNull()
    expect(resolveCodeburnPath()).toBeNull()
  })

  // The Windows P0: the packaged app set CODEBURN_BUNDLED_CLI to a C:\ path, but
  // the guard was `startsWith('/')` (POSIX-only), so the bundled CLI was skipped
  // and resolution fell through to a PATH search that finds nothing → not-found
  // on 100% of Windows installs. The guard is now `path.isAbsolute`, which is
  // the platform variant (win32 on Windows). These tests pin both the intent
  // (relative paths are still rejected as a safety guard) and the Windows fix.
  it('resolves an absolute CODEBURN_BUNDLED_CLI (as the packaged app sets it)', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    const entry = bundledEntry('launch.js')
    expect(isAbsolute(entry)).toBe(true)
    process.env.CODEBURN_BUNDLED_CLI = entry
    expect(resolveTarget()).toEqual({ kind: 'bundled', entry })
  })

  it('rejects a relative CODEBURN_BUNDLED_CLI even when the file exists (guards relative injection)', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    const entry = bundledEntry('rel-launch.js')
    const rel = relative(process.cwd(), entry) // resolvable via cwd, but NOT absolute
    expect(isAbsolute(rel)).toBe(false)
    process.env.CODEBURN_BUNDLED_CLI = rel
    // File exists (isFile true), so only the isAbsolute guard can reject it.
    expect(resolveTarget()).toBeNull()
  })

  it('rejects a relative CODEBURN_BIN override even when the file exists', () => {
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    delete process.env.CODEBURN_BUNDLED_CLI
    const bin = join(dir, 'rel-codeburn.js')
    writeFileSync(bin, '#!/usr/bin/env node\n', { mode: 0o755 })
    chmodSync(bin, 0o755)
    const rel = relative(process.cwd(), bin)
    expect(isAbsolute(rel)).toBe(false)
    process.env.CODEBURN_BIN = rel
    expect(resolveTarget()).toBeNull()
  })
})

describe('absolute-path guard is cross-platform (path.isAbsolute, not startsWith("/"))', () => {
  // On the POSIX CI host `isAbsolute` is path.posix.isAbsolute, so these assert
  // the per-platform variants directly to encode the Windows intent regardless
  // of where the suite runs.
  const winPath = 'C:\\Users\\x\\resources\\cli\\dist\\launch.js'

  it('accepts a Windows absolute bundled path where the old startsWith("/") guard rejected it', () => {
    expect(winPath.startsWith('/')).toBe(false)          // old guard: dropped it → the P0
    expect(win32.isAbsolute(winPath)).toBe(true)          // new guard on Windows: accepted
    expect(win32.isAbsolute('cli\\dist\\launch.js')).toBe(false) // relative still rejected
  })

  it('accepts a POSIX absolute path and rejects a relative one (macOS/Linux unchanged)', () => {
    expect(posix.isAbsolute('/res/cli/dist/launch.js')).toBe(true)
    expect(posix.isAbsolute('cli/dist/launch.js')).toBe(false)
  })
})

describe('notFoundStage (non-sensitive telemetry enum for a not-found)', () => {
  it('reports bundled-not-absolute for a relative CODEBURN_BUNDLED_CLI', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_BUNDLED_CLI = 'cli/dist/launch.js'
    expect(notFoundStage()).toBe('bundled-not-absolute')
  })

  it('reports bundled-missing for an absolute CODEBURN_BUNDLED_CLI whose file is absent', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_BUNDLED_CLI = join(dir, 'nope', 'cli.js')
    expect(notFoundStage()).toBe('bundled-missing')
  })

  it('reports bin-not-absolute for a relative CODEBURN_BIN override', () => {
    process.env.CODEBURN_BIN = 'relative/codeburn'
    delete process.env.CODEBURN_BUNDLED_CLI
    expect(notFoundStage()).toBe('bin-not-absolute')
  })

  it('reports no-path-match when nothing is configured', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.CODEBURN_BUNDLED_CLI
    expect(notFoundStage()).toBe('no-path-match')
  })

  it('spawnCli rejects not-found carrying the resolution stage as detail', async () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.CODEBURN_BUNDLED_CLI = 'cli/dist/launch.js' // relative → bundled-not-absolute
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'not-found', detail: 'bundled-not-absolute' })
  })
})

describe('spawnSpecFor (bundled CLI runs via Electron-as-node)', () => {
  it('spawns process.execPath with the bundle as argv[0] and ELECTRON_RUN_AS_NODE set', () => {
    const spec = spawnSpecFor({ kind: 'bundled', entry: '/res/cli/dist/cli.js' }, ['status', '--period', 'today'])
    expect(spec.bin).toBe(process.execPath)
    expect(spec.args).toEqual(['/res/cli/dist/cli.js', 'status', '--period', 'today'])
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    // PATH is still augmented (the bundle's own dir leads), harmless for a CLI
    // that itself shells out during pairing/sync.
    expect((spec.env.PATH ?? '').split(':')[0]).toBe('/res/cli/dist')
  })

  it('spawns an external CLI directly, with no run-as-node flag', () => {
    const spec = spawnSpecFor({ kind: 'external', bin: '/some/bin/codeburn' }, ['status'])
    expect(spec.bin).toBe('/some/bin/codeburn')
    expect(spec.args).toEqual(['status'])
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect((spec.env.PATH ?? '').split(':')[0]).toBe('/some/bin')
  })

  it('spawnCli runs the bundled entry end-to-end as Node', async () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    // process.execPath is the Node running vitest here; a real packaged app uses
    // Electron's binary, but the spawn shape (execPath + entry + args + env) is
    // identical, so this exercises the whole bundled path.
    const entry = join(dir, 'bundled-cli.js')
    writeFileSync(
      entry,
      'process.stdout.write(JSON.stringify({ ranAsNode: process.env.ELECTRON_RUN_AS_NODE === "1", firstArg: process.argv[2] }))\n',
    )
    process.env.CODEBURN_BUNDLED_CLI = entry

    const result = (await spawnCli(['status'])) as { ranAsNode: boolean; firstArg: string }
    expect(result).toEqual({ ranAsNode: true, firstArg: 'status' })
  })
})

describe('spawnCli', () => {
  it('resolves parsed JSON on success', async () => {
    fakeBin('ok.js', 'process.stdout.write(JSON.stringify({ ok: 1 }))')
    await expect(spawnCli(['status'])).resolves.toEqual({ ok: 1 })
  })

  it('rejects with kind "nonzero" on a non-zero exit', async () => {
    fakeBin('fail.js', 'process.stderr.write("boom"); process.exit(2)')
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'nonzero' } satisfies Partial<CliError>)
  })

  it('rejects with kind "bad-json" on non-JSON stdout', async () => {
    fakeBin('garbage.js', 'process.stdout.write("not json at all")')
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'bad-json' })
  })

  it('rejects with kind "timeout" when the binary hangs', async () => {
    fakeBin('hang.js', 'setInterval(() => {}, 1000)')
    await expect(spawnCli(['status'], { timeoutMs: 150 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('rejects with kind "not-found" when no binary resolves', async () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = '' // force an empty search space
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-such-persisted-path')
    try {
      await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'not-found' })
    } finally {
      delete process.env.CODEBURN_PATH_DIRS
      delete process.env.CODEBURN_CLI_PATH_FILE
    }
  })

  it('rejects with kind "too-large" and kills a binary that floods stdout', async () => {
    fakeBin('flood.js', "const s='x'.repeat(1024*1024); for(let i=0;i<20;i++) process.stdout.write(s); setInterval(()=>{},1000)")
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'too-large' } satisfies Partial<CliError>)
  })
})

describe('spawn PATH augmentation (GUI-launched apps have a minimal PATH)', () => {
  it("prepends the resolved binary's own directory so its env-shebang finds node", async () => {
    const bin = fakeBin('path-echo.js', 'process.stdout.write(JSON.stringify({ path: process.env.PATH }))')
    const result = await spawnCli(['status']) as { path: string }
    expect(result.path.split(':')[0]).toBe(dirname(bin))
  })

  it('spawnEnvFor dedupes and keeps the original PATH entries', () => {
    const env = spawnEnvFor('/some/tool/bin/codeburn')
    const parts = (env.PATH ?? '').split(':')
    expect(parts[0]).toBe('/some/tool/bin')
    expect(new Set(parts).size).toBe(parts.length)
    for (const original of (process.env.PATH ?? '').split(':').filter(Boolean)) {
      expect(parts).toContain(original)
    }
  })
})

describe('spawnCli coalescing (read-only)', () => {
  it('shares one child between two concurrent identical calls', async () => {
    const countFile = join(dir, 'spawns')
    fakeBin('counter.js', `require('fs').appendFileSync(${JSON.stringify(countFile)},'x'); process.stdout.write(JSON.stringify({ok:1}))`)
    const [a, b] = await Promise.all([spawnCli(['status']), spawnCli(['status'])])
    expect(a).toEqual({ ok: 1 })
    expect(b).toEqual({ ok: 1 })
    expect(readFileSync(countFile, 'utf8')).toBe('x') // exactly one spawn
  })

  it('spawns again once the 5s result cache has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const countFile = join(dir, 'spawns')
      fakeBin('counter-ttl.js', `require('fs').appendFileSync(${JSON.stringify(countFile)},'x'); process.stdout.write(JSON.stringify({ok:1}))`)
      vi.setSystemTime(0)
      await spawnCli(['status'])
      vi.setSystemTime(6_000)
      await spawnCli(['status'])
      expect(readFileSync(countFile, 'utf8')).toBe('xx') // cache expired → new spawn
    } finally {
      vi.useRealTimers()
    }
  })

  it('never coalesces config-mutating action calls', async () => {
    const countFile = join(dir, 'spawns')
    fakeBin('action-counter.js', `require('fs').appendFileSync(${JSON.stringify(countFile)},'x'); process.stdout.write('done')`)
    await Promise.all([spawnCliAction(['currency', 'EUR']), spawnCliAction(['currency', 'EUR'])])
    expect(readFileSync(countFile, 'utf8')).toBe('xx') // two independent spawns
  })

  it('flushes the read cache when an action completes, so post-action refetches are fresh', async () => {
    const countFile = join(dir, 'spawns')
    fakeBin('mixed.js', `require('fs').appendFileSync(${JSON.stringify(countFile)},'x'); process.stdout.write(JSON.stringify({ok:1}))`)
    await spawnCli(['model-alias', '--list']) // primes the 5s cache
    await spawnCliAction(['model-alias', 'a', 'b']) // config change → cache flush
    await spawnCli(['model-alias', '--list']) // must NOT serve the pre-action cache
    expect(readFileSync(countFile, 'utf8')).toBe('xxx')
  })
})

describe('killAll', () => {
  it('reaps an in-flight child so its promise settles', async () => {
    fakeBin('hang-kill.js', 'setInterval(() => {}, 1000)')
    const pending = spawnCli(['status'], { timeoutMs: 60_000 })
    // Let the child spawn before reaping.
    await new Promise(resolve => setTimeout(resolve, 50))
    killAll()
    await expect(pending).rejects.toMatchObject({ kind: 'nonzero' })
  })
})

describe('spawnCli concurrency scheduler', () => {
  // A fake CLI that records each spawn (by subcommand) and then blocks until a
  // release file named after that subcommand appears, so the test controls
  // exactly when each child exits and can observe how many run at once.
  function schedulerBin(startedFile: string, releaseDir: string): void {
    fakeBin(
      'sched.js',
      `const fs = require('fs'); const path = require('path');
       const cmd = process.argv[2];
       fs.appendFileSync(${JSON.stringify(startedFile)}, cmd + '\\n');
       const rel = path.join(${JSON.stringify(releaseDir)}, cmd);
       const t = setInterval(() => {
         if (fs.existsSync(rel)) { clearInterval(t); process.stdout.write('{}'); process.exit(0); }
       }, 5);`,
    )
  }
  function startedList(startedFile: string): string[] {
    try { return readFileSync(startedFile, 'utf8').split('\n').filter(Boolean) } catch { return [] }
  }
  function release(releaseDir: string, cmd: string): void { writeFileSync(join(releaseDir, cmd), '') }
  async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('waitUntil timed out')
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

  // Reset scheduler state so a leaked running slot can never starve the next test.
  afterEach(() => { killAll() })

  it('runs at most two children at once; a third waits for a freed slot', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    const p1 = spawnCli(['status'])
    const p2 = spawnCli(['models'])
    const p3 = spawnCli(['sessions'])
    await waitUntil(() => startedList(startedFile).length === 2)
    await delay(100) // the cap must keep the third from sneaking in
    expect(startedList(startedFile).sort()).toEqual(['models', 'status'])

    release(releaseDir, 'status') // free one slot
    await waitUntil(() => startedList(startedFile).includes('sessions'))

    release(releaseDir, 'models'); release(releaseDir, 'sessions')
    await Promise.all([p1, p2, p3])
  })

  it('lets a later interactive spawn preempt an earlier queued background one', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    // Fill both slots with real interactive work so the next two calls queue.
    const p1 = spawnCli(['fill1'], { priority: 'interactive' })
    const p2 = spawnCli(['fill2'], { priority: 'interactive' })
    await waitUntil(() => startedList(startedFile).length === 2)

    // Queue a background first, then an interactive.
    const pbg = spawnCli(['bg'], { priority: 'background' })
    const pint = spawnCli(['inter'], { priority: 'interactive' })
    await delay(50)
    expect(startedList(startedFile)).not.toContain('bg')
    expect(startedList(startedFile)).not.toContain('inter')

    // Free exactly one slot: the interactive must take it despite queueing later.
    release(releaseDir, 'fill1')
    await waitUntil(() => startedList(startedFile).length === 3)
    expect(startedList(startedFile)).toContain('inter')
    expect(startedList(startedFile)).not.toContain('bg')

    release(releaseDir, 'fill2'); release(releaseDir, 'inter'); release(releaseDir, 'bg')
    await Promise.all([p1, p2, pbg, pint])
  })

  it('reserves one CLI lane while background prefetch is running', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    const bg1 = spawnCli(['bg1'], { priority: 'background' })
    const bg2 = spawnCli(['bg2'], { priority: 'background' })
    await waitUntil(() => startedList(startedFile).includes('bg1'))
    await delay(50)
    expect(startedList(startedFile)).toEqual(['bg1'])

    const interactive = spawnCli(['clicked'], { priority: 'interactive' })
    await waitUntil(() => startedList(startedFile).includes('clicked'))
    expect(startedList(startedFile)).not.toContain('bg2')

    release(releaseDir, 'bg1'); release(releaseDir, 'clicked')
    await waitUntil(() => startedList(startedFile).includes('bg2'))
    release(releaseDir, 'bg2')
    await Promise.all([bg1, bg2, interactive])
  })

  it('does not spend a slot on a coalesced (same-argv) call', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    const p1 = spawnCli(['status'])
    const p2 = spawnCli(['models'])
    await waitUntil(() => startedList(startedFile).length === 2)

    const p1b = spawnCli(['status'])   // coalesces onto p1's child — no new slot
    const p3 = spawnCli(['sessions'])  // genuinely new — queued behind the cap
    await delay(100)
    expect(startedList(startedFile).length).toBe(2) // still just the two originals

    release(releaseDir, 'status') // frees the slot the coalesced pair shared
    await waitUntil(() => startedList(startedFile).includes('sessions'))

    release(releaseDir, 'models'); release(releaseDir, 'sessions')
    const [a, b] = await Promise.all([p1, p1b])
    expect(a).toEqual(b) // one child served both callers
    await Promise.all([p2, p3])
  })

  it('cancels a queued spawn on killAll instead of letting it spawn later', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    const p1 = spawnCli(['status'])
    const p2 = spawnCli(['models'])
    await waitUntil(() => startedList(startedFile).length === 2)
    const p3 = spawnCli(['sessions']) // queued behind the cap, no child yet
    await delay(50)
    expect(startedList(startedFile)).not.toContain('sessions')

    killAll() // reaps the two running AND cancels the queued third
    // Attach all three rejection handlers synchronously: the queued spawn rejects
    // at once, so it must not sit unhandled while the killed children settle.
    await Promise.all([
      expect(p1).rejects.toMatchObject({ kind: 'nonzero' }),
      expect(p2).rejects.toMatchObject({ kind: 'nonzero' }),
      expect(p3).rejects.toMatchObject({ kind: 'nonzero' }),
    ])

    await delay(50)
    expect(startedList(startedFile)).not.toContain('sessions') // never spawned
  })
})

describe('spawnCliAction', () => {
  it('returns stdout and ok:true on success', async () => {
    fakeBin('action-ok.js', 'process.stdout.write("currency updated")')
    await expect(spawnCliAction(['currency', 'EUR'])).resolves.toEqual({ ok: true, stdout: 'currency updated', stderr: '', code: 0 })
  })

  it('returns stderr and ok:false on a non-zero exit', async () => {
    fakeBin('action-fail.js', 'process.stderr.write("invalid alias"); process.exit(3)')
    await expect(spawnCliAction(['model-alias', 'a', 'b'])).resolves.toEqual({ ok: false, stdout: '', stderr: 'invalid alias', code: 3 })
  })
})

describe('nodeManagerDirs (nvm resolution)', () => {
  const savedNvm = process.env.NVM_DIR
  afterEach(() => {
    if (savedNvm === undefined) delete process.env.NVM_DIR
    else process.env.NVM_DIR = savedNvm
  })

  it('scans nvm version dirs newest-first and takes the first that holds codeburn', () => {
    // Two versions; the lexicographically-"newest" (v9.0.0 > v22.0.0 as strings)
    // has NO codeburn, while the real newer v22.0.0 does. The old `sort().reverse()[0]`
    // would pick v9.0.0's bin and miss the CLI entirely.
    const nvm = mkdtempSync(join(tmpdir(), 'codeburn-nvm-'))
    try {
      const versions = join(nvm, 'versions', 'node')
      const v9bin = join(versions, 'v9.0.0', 'bin')
      const v22bin = join(versions, 'v22.0.0', 'bin')
      mkdirSync(v9bin, { recursive: true })
      mkdirSync(v22bin, { recursive: true })
      const codeburn = join(v22bin, 'codeburn')
      writeFileSync(codeburn, '#!/bin/sh\n', { mode: 0o755 })
      chmodSync(codeburn, 0o755)

      process.env.NVM_DIR = nvm
      const dirs = nodeManagerDirs()
      expect(dirs).toContain(v22bin)
      expect(dirs).not.toContain(v9bin)
    } finally {
      rmSync(nvm, { recursive: true, force: true })
    }
  })
})
