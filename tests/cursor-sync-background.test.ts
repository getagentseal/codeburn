import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'

import { CURSOR_CSV_HEADER, cursorImportPath } from '../src/cursor-import.js'
import { maybeSyncCursor, setCursorImportRunner } from '../src/cursor-sync.js'
import { cursorDatabasePath } from '../src/quota/cursor.js'
import { isSqliteAvailable } from '../src/sqlite.js'

// The CLI runs that hold a fake cursor.com download open until the test lets go.
vi.setConfig({ testTimeout: 60_000 })

const requireForTest = createRequire(import.meta.url)
const CLI = join(__dirname, '..', 'src', 'cli.ts')

function jwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode({ sub: 'auth0|background_sync', exp: Math.floor(Date.now() / 1000) + 86_400 })}.signature`
}

function writeToken(home: string): void {
  const path = cursorDatabasePath(process.platform, home)
  mkdirSync(dirname(path), { recursive: true })
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (file: string) => any }
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', jwt())
  db.close()
}

function csv(): string {
  const row = [new Date(Date.now() - 2 * 3_600_000).toISOString(), '', '', 'Included', 'auto', 'No', 0, 1234, 0, 0, 1234, 'Included']
  return [CURSOR_CSV_HEADER.join(','), row.map(v => `"${v}"`).join(',')].join('\n') + '\n'
}

// A cursor.com that answers only once `release` exists, so a run that waits
// on it cannot print anything before the test lets go.
const FAKE_FETCH = `
import { existsSync, readFileSync } from 'node:fs'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://cursor.com/')) return realFetch(url, init)
  while (!existsSync(process.env.FAKE_CURSOR_RELEASE)) await new Promise(r => setTimeout(r, 25))
  return new Response(readFileSync(process.env.FAKE_CURSOR_CSV, 'utf8'), { status: 200 })
}
`

const until = async (check: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

let root: string
let release: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursor-sync-bg-'))
  const home = join(root, 'home')
  writeToken(home)
  // One provider root for serve to watch; without an armed root it memoizes nothing.
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  release = join(root, 'release')
  await writeFile(join(root, 'fake-fetch.mjs'), FAKE_FETCH)
  await writeFile(join(root, 'usage.csv'), csv())
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEBURN_CACHE_DIR: join(root, 'cache'),
    FAKE_CURSOR_RELEASE: release,
    FAKE_CURSOR_CSV: join(root, 'usage.csv'),
  }
  delete env['CODEBURN_CURSOR_SYNC']
  // The in-process sync reads this too; a shell that disables sync must not hang the test.
  vi.stubEnv('CODEBURN_CURSOR_SYNC', '')
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  setCursorImportRunner(null)
  await rm(root, { recursive: true, force: true })
})

function start(args: string[]): { child: ChildProcess; stdout: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(join(root, 'fake-fetch.mjs')).href, CLI, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString() })
  return { child, stdout: () => out, exited: new Promise(resolve => child.on('exit', resolve)) }
}

const cursorCalls = (report: string): number => {
  const parsed = JSON.parse(report) as { overview: { calls: number } }
  return parsed.overview.calls
}

describe.skipIf(!isSqliteAvailable())('background Cursor sync', () => {
  it('a deferred import waits for the runner, then lands', async () => {
    let applyLater: (() => void) | undefined
    setCursorImportRunner(apply => new Promise((resolve, reject) => { applyLater = () => { apply().then(resolve, reject) } }))
    vi.stubEnv('HOME', env['HOME']!)
    vi.stubEnv('USERPROFILE', env['HOME']!)
    const fetchImpl = async () => new Response(csv(), { status: 200 })
    const sync = maybeSyncCursor({ fetchImpl, deferImport: true })
    await until(() => applyLater !== undefined, 'the runner')
    expect(existsSync(cursorImportPath())).toBe(false)
    applyLater!()
    expect((await sync)?.changed).toBe(true)
    expect(existsSync(cursorImportPath())).toBe(true)
  })

  it('a one-shot JSON report answers before cursor.com does, and the next run shows the import', async () => {
    const args = ['report', '--format', 'json', '--provider', 'cursor', '--period', 'today']
    const first = start(args)
    await until(() => first.stdout().trim().endsWith('}'), 'the first answer')
    expect(cursorCalls(first.stdout())).toBe(0)
    expect(existsSync(cursorImportPath())).toBe(false)

    await writeFile(release, '')
    expect(await first.exited).toBe(0)
    expect(existsSync(cursorImportPath())).toBe(true)

    const second = start(args)
    expect(await second.exited).toBe(0)
    expect(cursorCalls(second.stdout())).toBe(1)
  })

  it('serve applies the import between requests and stops serving the answer it memoized', async () => {
    const serve = start(['serve', '--stdio'])
    let lines: string[] = []
    serve.child.stdout!.on('data', () => { lines = serve.stdout().split('\n').filter(Boolean) })
    const answer = async (id: number, args: string[]): Promise<{ output: string; generation: { n: number } }> => {
      serve.child.stdin!.write(JSON.stringify({ id, args }) + '\n')
      let found: { id?: number; ok?: boolean; output?: string; generation?: { n: number } } | undefined
      await until(() => (found = lines.map(l => JSON.parse(l)).find(m => m.id === id && m.ok !== undefined)) !== undefined, `answer ${id}`)
      expect(found!.ok).toBe(true)
      return found as { output: string; generation: { n: number } }
    }
    const args = ['report', '--format', 'json', '--provider', 'cursor', '--period', 'today']
    try {
      await until(() => lines.some(l => l.includes('"ready"')), 'serve ready')
      expect(cursorCalls((await answer(1, args)).output)).toBe(0)
      // Asked again before the download lands: once the watchers are armed, which
      // can be after the first few answers on a slow machine, the memo answers.
      let id = 2
      let memoized = await answer(id++, args)
      for (let next = await answer(id++, args); next.generation.n !== memoized.generation.n; next = await answer(id++, args)) memoized = next

      await writeFile(release, '')
      await until(() => existsSync(cursorImportPath()), 'the import')
      const after = await answer(id, args)
      expect(after.generation.n).toBeGreaterThan(memoized.generation.n)
      expect(cursorCalls(after.output)).toBe(1)
    } finally {
      serve.child.stdin!.end()
      await serve.exited
    }
  })
})
