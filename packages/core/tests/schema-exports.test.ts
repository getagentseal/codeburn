import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * SCHEMAS EXPORT GUARDRAIL.
 *
 * import-smoke proves the package's code imports with all I/O blocked; this
 * file proves the *data* subpath actually serves a real schema. It resolves a
 * concrete subpath through the package's exports map via Node's self-reference
 * (the nearest package.json has `exports`), exactly as a consumer's import
 * would, instead of reading the file directly from disk — so a dropped
 * `./schemas/*` entry, a missing file, or a malformed JSON module all fail
 * the child process. It deliberately lives outside the import-smoke preload:
 * loading a JSON module is inherent fs I/O, and that guardrail is about
 * import-time purity of code while this one is about reachability of shipped
 * data.
 */
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const childScript = resolve(here, 'harness/schema-resolve-child.mjs')

describe('schemas exports map', () => {
  it('resolves a concrete published schema through the exports map and loads it', () => {
    const result = spawnSync(
      process.execPath,
      [childScript, '@codeburn/core/schemas/observation-0.2.0.json'],
      { cwd: pkgRoot, encoding: 'utf8' },
    )
    expect(result.status, `status ${result.status}\nstderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('SCHEMA_EXPORT_OK 0.2.0')
  })
})
