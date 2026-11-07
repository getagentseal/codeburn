import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearScanFileMemo, scanJsonlFile, scanJsonlFileMemoized } from '../src/optimize.js'
import { factsDir } from '../src/scan-facts.js'

let dir: string
let cacheDir: string
const savedCacheDir = process.env['CODEBURN_CACHE_DIR']

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codeburn-optfacts-src-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-optfacts-cache-'))
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  clearScanFileMemo()
})

afterEach(async () => {
  clearScanFileMemo()
  if (savedCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = savedCacheDir
  await rm(dir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

const day = (d: string) => ({ start: new Date(`${d}T00:00:00Z`), end: new Date(`${d}T23:59:59.999Z`) })
const RANGES = [undefined, day('2026-04-14'), day('2026-04-15'), { start: new Date(1970, 0, 1), end: new Date('2026-04-16T00:00:00Z') }]

function lines(): string[] {
  const opener = 'Standing context for this repo. '.repeat(80)
  return [
    JSON.stringify({ type: 'user', timestamp: '2026-04-14T09:00:00Z', cwd: '/a', version: '2.1.1', message: { content: `${opener} run /review` } }),
    // No timestamp: NaN in memory, which must not read back as 0.
    JSON.stringify({ type: 'system', cwd: '/a', version: '2.1.1' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-04-14T09:01:00Z', cwd: '/a', message: { usage: { cache_creation_input_tokens: 900 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/node_modules/x.js' } }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-04-15T10:00:00Z', cwd: '/b', version: '2.1.9', message: { usage: { cache_creation_input_tokens: 1200 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rg -n x src/' } }, { type: 'tool_use', name: 'Skill', input: { skill: 'review' } }] } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: '2026-04-15T10:05:00Z', cwd: '/a', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore' } }] } }),
    JSON.stringify({ type: 'assistant', message: { usage: { cache_creation_input_tokens: 5 }, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/x.ts' } }] } }),
  ]
}

async function fresh(file: string) {
  return Promise.all(RANGES.map(r => scanJsonlFile(file, 'p', r, 0)))
}

async function stored(file: string) {
  const { size, mtimeMs } = await stat(file)
  const out = []
  for (const r of RANGES) {
    clearScanFileMemo()
    out.push(await scanJsonlFileMemoized(file, 'p', r, { size, mtimeMs }, 0))
  }
  return out
}

async function factFiles(): Promise<Map<string, number>> {
  const kindDir = join(factsDir(), 'optimize')
  const out = new Map<string, number>()
  for (const name of await readdir(kindDir).catch(() => [] as string[])) out.set(name, (await stat(join(kindDir, name))).mtimeMs)
  return out
}

describe('optimize scan facts', () => {
  it('a record read back from the store projects exactly as a fresh scan, for every range', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, lines().join('\n') + '\n')
    const expected = await fresh(file)
    expect(await stored(file)).toEqual(expected)
    expect((await factFiles()).size).toBe(1)
    // Served from disk now, still identical.
    expect(await stored(file)).toEqual(expected)
  })

  it('a grown transcript resumes into its stored record and rewrites only its own facts', async () => {
    const file = join(dir, 'live.jsonl')
    const other = join(dir, 'old.jsonl')
    const all = lines()
    await writeFile(file, all.slice(0, 3).join('\n') + '\n')
    await writeFile(other, all.join('\n') + '\n')
    await stored(file)
    await stored(other)
    const before = await factFiles()

    await new Promise(resolve => setTimeout(resolve, 20))
    await appendFile(file, all.slice(3).join('\n') + '\n')
    expect(await stored(file)).toEqual(await fresh(file))

    const after = await factFiles()
    expect([...after].filter(([name, mtime]) => before.get(name) !== mtime)).toHaveLength(1)
    const row = JSON.parse(await readFile(join(factsDir(), 'optimize', [...after].find(([n, m]) => before.get(n) !== m)![0]), 'utf-8'))
    expect(row.offset).toBe((await stat(file)).size)
  })

  it('a last line read before its newline is counted once when the file grows', async () => {
    const file = join(dir, 'live.jsonl')
    // Longer than the head digest, so the grown file resumes from the stored offset.
    const all = [JSON.stringify({ type: 'system', content: 'x'.repeat(5000) }), ...lines()]
    await writeFile(file, all.slice(0, 4).join('\n'))
    await stored(file)
    await new Promise(resolve => setTimeout(resolve, 20))
    await appendFile(file, '\n' + all[5] + '\n')
    const [whole] = await stored(file)
    expect(whole!.calls).toHaveLength(2)
    expect(await stored(file)).toEqual(await fresh(file))
  })

  it('a last line that is a bare scalar is re-read whole, since later bytes can extend it', async () => {
    const file = join(dir, 'live.jsonl')
    const pad = JSON.stringify({ type: 'system', content: 'x'.repeat(5000) })
    await writeFile(file, pad + '\n1')
    await stored(file)
    const row = async () => JSON.parse(await readFile(join(factsDir(), 'optimize', [...(await factFiles()).keys()][0]!), 'utf-8'))
    expect((await row()).offset).toBe(Buffer.byteLength(pad) + 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    await appendFile(file, '23\n')
    await stored(file)
    expect((await row()).offset).toBe((await stat(file)).size)
  })

  it('a rewritten transcript is scanned again in full', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, lines().join('\n') + '\n')
    await stored(file)
    await writeFile(file, lines().slice(2).join('\n') + '\n')
    expect(await stored(file)).toEqual(await fresh(file))
  })
})
