import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { writeMacCliLauncher } = createRequire(import.meta.url)('./after-pack.cjs') as {
  writeMacCliLauncher: (cliDir: string, executableName: string) => void
}

describe.skipIf(process.platform === 'win32')('writeMacCliLauncher', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('runs the bundle\'s own executable as Node on the bundled CLI, wherever the bundle lives', () => {
    root = mkdtempSync(join(tmpdir(), 'codeburn-after-pack-'))
    const contents = join(root, 'Some Folder', 'CodeBurn.app', 'Contents')
    const cliDir = join(contents, 'Resources', 'cli')
    mkdirSync(join(cliDir, 'dist'), { recursive: true })
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    writeFileSync(join(cliDir, 'dist', 'launch.js'), '')
    writeFileSync(join(contents, 'MacOS', 'CodeBurn'), '#!/bin/sh\nprintf "%s|%s\\n" "$ELECTRON_RUN_AS_NODE" "$*"\n', { mode: 0o755 })

    writeMacCliLauncher(cliDir, 'CodeBurn')
    const run = spawnSync(join(cliDir, 'codeburn'), ['status', '--format', 'menubar-json'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe(`1|${realpathSync(cliDir)}/dist/launch.js status --format menubar-json\n`)
  })
})
