// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { spawnCli, spawnCliAction, spawnEnvFor, killAll, CliError, nodeManagerDirs, resolveCodeburnPath } from './cli'

let dir: string
const originalBin = process.env.CODEBURN_BIN
const originalPathDirs = process.env.CODEBURN_PATH_DIRS
const originalPathFile = process.env.CODEBURN_CLI_PATH_FILE
const originalViteUrl = process.env.VITE_DEV_SERVER_URL

/** Writes an executable node script and points CODEBURN_BIN at it. */
function fakeBin(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
  chmodSync(p, 0o755)
  process.env.CODEBURN_BIN = p
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
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveCodeburnPath (Vite development)', () => {
  it('prefers the executable repo dist/cli.js when the Vite dev server is set', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'

    expect(resolveCodeburnPath()).toMatch(/dist\/cli\.js$/)
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

    const resolved = resolveCodeburnPath()
    expect(resolved).toMatch(/dist\/cli\.js$/)
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
