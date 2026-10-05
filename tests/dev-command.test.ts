import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
  scripts: { dev: string }
}
let fixture: string

function runDev(args: string, extraEnv: NodeJS.ProcessEnv = {}) {
  // npm runs scripts through the platform's default shell and adds .bin to
  // PATH. Exercise those same semantics, including cmd.exe on Windows.
  return spawnSync(`${manifest.scripts.dev} ${args}`, {
    cwd: fixture,
    shell: true,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), join(fixture, 'node_modules', '.bin'), process.env.PATH].join(process.platform === 'win32' ? ';' : ':'),
      ...extraEnv,
    },
  })
}

describe('development CLI command', () => {
  beforeAll(() => {
    // Both the checkout and executable paths can contain spaces on Windows.
    fixture = mkdtempSync(join(tmpdir(), 'codeburn dev command '))
    const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(join(root, 'src'), join(fixture, 'src'), directoryLink)
    symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), directoryLink)
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}\n')
  })

  afterAll(() => rmSync(fixture, { recursive: true, force: true }))

  it('runs --version through the default shell from a checkout path with spaces', () => {
    const result = runDev('--version')
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })

  it('forwards command arguments to the CLI', () => {
    const result = runDev('status --help')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: codeburn status')
    expect(result.stdout).toContain('--format')
  })

  it('suppresses deprecation warnings while retaining inherited NODE_OPTIONS', () => {
    const preload = join(fixture, 'warning.mjs')
    const marker = join(fixture, 'preload-marker')
    writeFileSync(preload, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(marker)}, "loaded")`,
      'process.emitWarning("dev-command-fixture", "DeprecationWarning")',
    ].join('\n'))
    const result = runDev('--version', {
      NODE_OPTIONS: `--import="${pathToFileURL(preload).href}"`,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
    expect(readFileSync(marker, 'utf8')).toBe('loaded')
    expect(result.stderr).not.toContain('dev-command-fixture')
  })
})
