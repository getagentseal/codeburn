import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

/**
 * IMPORT-SMOKE GUARDRAIL.
 *
 * Proves @codeburn/core performs no filesystem / child-process / network I/O at
 * import time or during exercised parser, decoder, and detector bodies. We run
 * against the BUILT dist (pure ESM whose only deps are `zod` and `node:crypto`),
 * so the child needs no TS loader — just plain node plus a resolve hook that
 * throws on any I/O module (fs, child_process, net, http(s), dns, os, tls,
 * dgram, http2, worker_threads, sqlite, module/createRequire, process). The
 * preload also deletes the network globals (fetch, WebSocket) and makes reads
 * of ambient env keys throw. Resolving the exports-map targets to file paths
 * (rather than importing `@codeburn/core` by name) avoids a self-symlink dance
 * in the worktree while still exercising every declared subpath.
 */
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const registerPreload = resolve(here, 'harness/block-io-register.mjs')
const childScript = resolve(here, 'harness/import-smoke-child.mjs')

function exportsTargets(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'))
  const targets: string[] = []
  for (const [subpath, entry] of Object.entries<Record<string, string>>(pkg.exports)) {
    const rel = entry.import
    expect(rel, `exports["${subpath}"] must declare an import target`).toBeTruthy()
    targets.push(resolve(pkgRoot, rel))
  }
  // Barrel first so the child finds the full export set quickly.
  targets.sort((a) => (a.endsWith('/index.js') ? -1 : 1))
  return targets
}

beforeAll(() => {
  // Build the artifact the guardrail inspects. Fresh build avoids stale dist.
  execFileSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'pipe' })
}, 120_000)

describe('import-smoke guardrail', () => {
  it('imports every exports subpath and runs a trivial op with all I/O modules blocked', () => {
    const targets = exportsTargets()
    for (const t of targets) {
      expect(existsSync(t), `built dist target missing: ${t}`).toBe(true)
    }

    const result = spawnSync(
      process.execPath,
      ['--import', registerPreload, childScript, ...targets],
      { cwd: pkgRoot, encoding: 'utf8' },
    )

    if (result.status !== 0) {
      throw new Error(
        `import-smoke child exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      )
    }
    expect(result.stdout).toContain('IMPORT_SMOKE_OK')
  })

  it('confirms the block hook actually throws on every banned module (harness sanity)', () => {
    // Tiny inline modules that import each banned module must fail under the
    // preload, proving the guardrail can detect I/O across the whole blocklist —
    // otherwise the passing test above is vacuous for the newer entries
    // (os / tls / dgram / http2 / worker_threads / sqlite / module / process).
    const banned = [
      'node:fs',
      'node:os',
      'node:tls',
      'node:dgram',
      'node:http2',
      'node:worker_threads',
      'node:sqlite',
      'node:module',
      'node:process',
    ]
    for (const specifier of banned) {
      const result = spawnSync(
        process.execPath,
        ['--import', registerPreload, '--input-type=module', '--eval', `await import('${specifier}')`],
        { cwd: pkgRoot, encoding: 'utf8' },
      )
      expect(result.status, `import of ${specifier} must fail under the preload`).not.toBe(0)
      expect(result.stderr).toContain('blocked I/O module import')
    }
  })

  it('confirms the preload removes the network globals and ambient env (harness sanity)', () => {
    // fetch/WebSocket are globals, so the loader hook cannot see them — the
    // preload must delete them. And a read of a key that had an ambient value
    // must throw, not silently return undefined. Both are otherwise silent
    // escape routes. The env probe uses a sentinel we set explicitly in the
    // child's environment rather than HOME: the guard's contract is "reads of
    // keys that HAD a value throw", so the test must not depend on a key being
    // present in the ambient environment (env -i / minimal CI containers have
    // no HOME — there the old probe failed for the wrong reason).
    const SENTINEL = 'IMPORT_SMOKE_AMBIENT_SENTINEL'
    const fetchResult = spawnSync(
      process.execPath,
      ['--import', registerPreload, '--input-type=module', '--eval', 'await fetch("http://127.0.0.1")'],
      { cwd: pkgRoot, encoding: 'utf8' },
    )
    expect(fetchResult.status).not.toBe(0)
    expect(fetchResult.stderr).toContain('fetch is not defined')

    const envResult = spawnSync(
      process.execPath,
      ['--import', registerPreload, '--input-type=module', '--eval', `process.env.${SENTINEL}`],
      { cwd: pkgRoot, encoding: 'utf8', env: { ...process.env, [SENTINEL]: 'present' } },
    )
    expect(envResult.status).not.toBe(0)
    expect(envResult.stderr).toContain(`blocked ambient env read "${SENTINEL}"`)
  })
})
