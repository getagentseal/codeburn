import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The launcher (src/cli.ts, copied verbatim to dist/cli.js) is the only place
// that runs before React and Ink are imported. React picks its development
// build unless NODE_ENV is exactly "production", and that build records a
// performance.measure() entry on every render into Node's user-timing buffer,
// which nothing ever trims: an interactive dashboard left open for days grows
// until V8 aborts with "JavaScript heap out of memory". The launcher must
// default NODE_ENV to "production" while leaving an explicit value untouched.

let dir: string

function runLauncher(env: Record<string, string | undefined>): string {
  const base = { ...process.env }
  delete base['NODE_ENV']
  const result = spawnSync(process.execPath, [join(dir, 'cli.js')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...base, ...env },
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

describe('CLI launcher NODE_ENV default', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeburn-cli-node-env-'))
    copyFileSync(join(process.cwd(), 'src', 'cli.ts'), join(dir, 'cli.js'))
    // Stand-in for dist/main.js: report the environment the launcher handed us.
    writeFileSync(join(dir, 'main.js'), 'process.stdout.write(JSON.stringify(process.env.NODE_ENV ?? null))\n')
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults NODE_ENV to production when the shell leaves it unset', () => {
    expect(runLauncher({})).toBe('"production"')
  })

  it('treats an empty NODE_ENV as unset', () => {
    expect(runLauncher({ NODE_ENV: '' })).toBe('"production"')
  })

  it('keeps an explicit NODE_ENV', () => {
    expect(runLauncher({ NODE_ENV: 'development' })).toBe('"development"')
  })
})
