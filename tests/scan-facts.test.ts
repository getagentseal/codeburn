import { appendFile, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scanSelfCorrections } from '../src/compare-stats.js'
import { factsDir, fileFacts, type FactsPass, type FactsResume } from '../src/scan-facts.js'

function assistant(model: string, text: string, timestamp?: string): string {
  return JSON.stringify({
    type: 'assistant',
    ...(timestamp ? { timestamp } : {}),
    message: { model, content: [{ type: 'text', text }] },
  })
}

let dir: string
let cacheDir: string
const savedCacheDir = process.env['CODEBURN_CACHE_DIR']

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codeburn-facts-src-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-facts-cache-'))
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  if (savedCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = savedCacheDir
  await rm(dir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

async function factFiles(kind: string): Promise<Map<string, number>> {
  const kindDir = join(factsDir(), kind)
  const out = new Map<string, number>()
  for (const name of await readdir(kindDir).catch(() => [] as string[])) {
    out.set(name, (await stat(join(kindDir, name))).mtimeMs)
  }
  return out
}

describe('fileFacts', () => {
  it('serves an unchanged file from the stored row, resumes a grown one, rescans a rewritten one', async () => {
    // Past the digested head, as a real transcript is: growth inside it reads as a rewrite.
    const first = 'one'.padEnd(5000, '.')
    const file = join(dir, 'a.jsonl')
    await writeFile(file, first + '\n')
    const scan = vi.fn(async (resume?: FactsResume<string[]>): Promise<FactsPass<string[]>> => {
      const text = (await readFile(file, 'utf-8')).slice(resume?.fromOffset ?? 0)
      const complete = text.slice(0, text.lastIndexOf('\n') + 1)
      return {
        facts: [...(resume?.facts ?? []), ...complete.split('\n').filter(Boolean)],
        offset: (resume?.fromOffset ?? 0) + Buffer.byteLength(complete),
      }
    })

    expect(await fileFacts('t', file, scan)).toEqual([first])
    expect(await fileFacts('t', file, scan)).toEqual([first])
    expect(scan).toHaveBeenCalledTimes(1)

    await appendFile(file, 'two\n')
    expect(await fileFacts('t', file, scan)).toEqual([first, 'two'])
    expect(scan.mock.calls[1]![0]).toEqual({ fromOffset: 5001, facts: [first] })

    await truncate(file, 0)
    await writeFile(file, 'new\n')
    expect(await fileFacts('t', file, scan)).toEqual(['new'])
    expect(scan.mock.calls[2]![0]).toBeUndefined()
  })

  it('keys rows by the version directory', async () => {
    const file = join(dir, 'a.jsonl')
    await writeFile(file, 'x\n')
    await fileFacts('t', file, async () => ({ facts: 1, offset: 2 }))
    expect(factsDir()).toMatch(/scan-facts\.v\d+$/)
    expect((await factFiles('t')).size).toBe(1)
  })
})

describe('self-correction facts', () => {
  it('answers from stored facts the same as a fresh scan, untimed hits included', async () => {
    await writeFile(join(dir, 's.jsonl'), [
      assistant('opus-4-6', 'My bad.', '2026-04-14T23:30:00Z'),
      assistant('opus-4-6', 'I was wrong.', '2026-04-15T00:30:00Z'),
      assistant('opus-4-6', 'I apologize.'),
      assistant('sonnet-4-6', 'Done.', '2026-04-15T01:00:00Z'),
    ].join('\n') + '\n')
    const day = { start: new Date('2026-04-15T00:00:00Z'), end: new Date('2026-04-15T23:59:59.999Z') }
    const lifetime = { start: new Date(1970, 0, 1), end: day.end }

    const fresh = [await scanSelfCorrections([dir]), await scanSelfCorrections([dir], undefined, day), await scanSelfCorrections([dir], undefined, lifetime)]
    const stored = [await scanSelfCorrections([dir]), await scanSelfCorrections([dir], undefined, day), await scanSelfCorrections([dir], undefined, lifetime)]
    expect(fresh.map(m => m.get('opus-4-6'))).toEqual([3, 1, 2])
    expect(stored).toEqual(fresh)
  })

  it('counts a message copied into two transcripts once, from facts too', async () => {
    const line = assistant('opus-4-6', 'My mistake.', '2026-04-15T10:00:00Z')
    await writeFile(join(dir, 'a.jsonl'), line + '\n')
    await writeFile(join(dir, 'b.jsonl'), line + '\n' + assistant('opus-4-6', 'My bad.', '2026-04-15T11:00:00Z') + '\n')
    expect((await scanSelfCorrections([dir])).get('opus-4-6')).toBe(2)
    expect((await scanSelfCorrections([dir])).get('opus-4-6')).toBe(2)
  })

  it('a live transcript that grows refreshes only its own facts', async () => {
    const live = join(dir, 'live.jsonl')
    await writeFile(live, assistant('opus-4-6', 'My bad.', '2026-04-15T10:00:00Z') + '\n')
    await writeFile(join(dir, 'old.jsonl'), assistant('opus-4-6', 'I was wrong.', '2026-04-14T10:00:00Z') + '\n')
    expect((await scanSelfCorrections([dir])).get('opus-4-6')).toBe(2)
    const before = await factFiles('corrections')

    await new Promise(resolve => setTimeout(resolve, 20))
    await appendFile(live, [
      assistant('opus-4-6', 'My bad.', '2026-04-15T10:00:00Z'),
      assistant('opus-4-6', 'Sorry about that.', '2026-04-15T10:05:00Z'),
    ].join('\n') + '\n')
    expect((await scanSelfCorrections([dir])).get('opus-4-6')).toBe(3)

    const after = await factFiles('corrections')
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    const changed = [...after].filter(([name, mtime]) => before.get(name) !== mtime)
    expect(changed).toHaveLength(1)
  })
})
