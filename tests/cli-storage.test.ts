import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { afterEach, expect, it } from 'vitest'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

it('prints metadata-only JSON and text without modifying source files or creating a cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cli-storage-'))
  homes.push(home)
  const codex = join(home, 'custom-codex')
  const sessions = join(codex, 'sessions')
  const config = join(home, '.config', 'codeburn')
  const cache = join(home, 'absent-cache')
  await mkdir(sessions, { recursive: true })
  await mkdir(config, { recursive: true })
  const source = join(sessions, 'rollout-unparseable.jsonl')
  await writeFile(source, 'not JSON: counted without parsing')
  // A non-USD currency would normally make preAction fetch and cache FX rates.
  await writeFile(join(config, 'config.json'), JSON.stringify({ currency: { code: 'EUR' } }))
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'storage', '--provider', 'codex', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex, CODEBURN_CACHE_DIR: cache },
  })
  const json = run(['--json'])
  expect(json.status, json.stderr).toBe(0)
  const report = JSON.parse(json.stdout)
  expect(report.sources).toEqual({ files: 1, bytes: 33 })
  expect(report.providers.map((p: { provider: string }) => p.provider)).toEqual(['codex'])
  expect(report.cache).toMatchObject({ files: 0, bytes: 0 })
  const text = run([])
  expect(text.status, text.stderr).toBe(0)
  expect(text.stdout).toContain('Storage footprint (read-only)')
  expect(text.stdout).toContain('33 B')
  expect(await readFile(source, 'utf8')).toBe('not JSON: counted without parsing')
  expect(await readdir(home)).not.toContain('absent-cache')
  expect(await readdir(config)).toEqual(['config.json'])
})
