import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, expect, it } from 'vitest'

let home = ''

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true })
})

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEBURN_CACHE_DIR: join(home, 'cache') },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

it('a setter refuses to overwrite an unparseable config and keeps its bytes', async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-config-bad-'))
  const dir = join(home, '.config', 'codeburn')
  await mkdir(dir, { recursive: true })
  const original = '{\n  "priceOverrides": { "my-model": { "input": 1, "output": 2 } },\n}\n'
  await writeFile(join(dir, 'config.json'), original)

  const res = runCli(['currency', 'EUR'])

  expect(res.status).toBe(1)
  expect(res.stderr).toContain('is not valid JSON')
  const files = await readdir(dir)
  expect(files).not.toContain('config.json')
  const corrupt = files.filter(f => f.startsWith('config.json.corrupt-'))
  expect(corrupt).toHaveLength(1)
  expect(await readFile(join(dir, corrupt[0]!), 'utf-8')).toBe(original)
})

it('a setter still creates the config when none exists', async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-config-none-'))

  const res = runCli(['currency', 'EUR'])

  expect(res.status).toBe(0)
  expect(res.stderr).toBe('')
  const saved = JSON.parse(await readFile(join(home, '.config', 'codeburn', 'config.json'), 'utf-8'))
  expect(saved.currency.code).toBe('EUR')
})
