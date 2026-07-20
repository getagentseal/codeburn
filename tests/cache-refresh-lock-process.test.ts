import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { emptyCache, loadCache, saveCache } from '../src/session-cache.js'

const roots: string[] = []

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
}

async function waitForAny(dir: string, names: string[], timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const name of names) if (existsSync(join(dir, name))) return name
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error(`timed out waiting for ${names.join(', ')}; saw ${(await readdir(dir)).join(', ')}`)
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return child.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error(`worker exited ${child.exitCode}`))
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)))
  })
}

function worker(cacheDir: string, barriers: string, id: string, source: string, bypass = false): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'tests/fixtures/cache-refresh-worker.ts'), cacheDir, barriers, id, source, String(bypass)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('warm refresh child-process regression', () => {
  it('gives exactly one contender ownership of a stale lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cb-refresh-stale-'))
    roots.push(root)
    const cacheDir = join(root, 'cache')
    const barriers = join(root, 'barriers')
    await mkdir(cacheDir, { recursive: true })
    await mkdir(barriers, { recursive: true })
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    const initial = emptyCache()
    initial.complete = true
    await saveCache(initial)
    const stalePath = join(cacheDir, 'session-refresh.lock')
    await writeFile(stalePath, JSON.stringify({ pid: 1, token: 'abandoned', at: 1 }))
    await utimes(stalePath, new Date(1), new Date(1))
    const source = join(root, 'changed.json')
    await writeFile(source, JSON.stringify({ output: 303 }))

    const a = worker(cacheDir, barriers, 'a', source)
    const b = worker(cacheDir, barriers, 'b', source)
    const winner = await Promise.race([
      waitFor(join(barriers, 'a.parsed')).then(() => 'a'),
      waitFor(join(barriers, 'b.parsed')).then(() => 'b'),
    ])
    const loser = winner === 'a' ? 'b' : 'a'
    expect(Number(existsSync(join(barriers, 'a.parsed'))) + Number(existsSync(join(barriers, 'b.parsed')))).toBe(1)
    // Keep the winner alive through the loser's full waiter budget: a second
    // stale contender must never publish or steal a heartbeating successor.
    const loserOutcome = await waitForAny(barriers, [
      `${loser}.timed-out`, `${loser}.parsed`, `${loser}.completed-by-other`, `${loser}.unavailable`,
    ])
    expect(loserOutcome, (await readdir(barriers)).join(',')).toBe(`${loser}.timed-out`)
    await writeFile(join(barriers, `${winner}.save`), '')
    await Promise.all([waitForExit(a), waitForExit(b)])
    await expect(stat(join(cacheDir, 'session-refresh.lock.takeover'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes disjoint parsed updates so the later publication cannot drop the first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cb-refresh-process-'))
    roots.push(root)
    const cacheDir = join(root, 'cache')
    const barriers = join(root, 'barriers')
    await mkdir(cacheDir, { recursive: true })
    await mkdir(barriers, { recursive: true })
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    const initial = emptyCache()
    initial.complete = true
    await saveCache(initial)

    const sourceA = join(root, 'changed-a.json')
    const sourceB = join(root, 'changed-b.json')
    await writeFile(sourceA, JSON.stringify({ output: 101 }))
    await writeFile(sourceB, JSON.stringify({ output: 202 }))

    const a = worker(cacheDir, barriers, 'a', sourceA)
    const b = worker(cacheDir, barriers, 'b', sourceB)

    // Exactly one child can cross the acquisition barrier. Let it publish and
    // release; only then can the other reload the first child's update.
    let retry: ChildProcess | undefined
    await Promise.race([
      waitFor(join(barriers, 'a.parsed')).then(() => 'a'),
      waitFor(join(barriers, 'b.parsed')).then(() => 'b'),
    ]).then(async first => {
      const second = first === 'a' ? 'b' : 'a'
      const secondSource = second === 'a' ? sourceA : sourceB
      await writeFile(join(barriers, `${first}.save`), '')
      await waitFor(join(barriers, `${first}.published`))
      // A waiter that observes the clean release correctly serves the holder's
      // fresh snapshot instead of mutating. A subsequent refresh of that
      // process then acquires normally and applies its independently visible
      // source change on top of the holder's publication.
      const outcome = await waitForAny(barriers, [`${second}.completed-by-other`, `${second}.parsed`])
      if (outcome === `${second}.parsed`) {
        await writeFile(join(barriers, `${second}.save`), '')
      } else {
        await waitForExit(second === 'a' ? a : b)
        retry = worker(cacheDir, barriers, `${second}-retry`, secondSource)
        await waitFor(join(barriers, `${second}-retry.parsed`))
        await writeFile(join(barriers, `${second}-retry.save`), '')
      }
    })

    await Promise.all([waitForExit(a), waitForExit(b), ...(retry ? [waitForExit(retry)] : [])])
    const files = (await loadCache()).providers['regression']?.files ?? {}
    expect(Object.keys(files).sort()).toEqual([sourceA, sourceB].sort())
  })

  it('proves the barrier reproducer loses one update when the transaction gate is bypassed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cb-refresh-control-'))
    roots.push(root)
    const cacheDir = join(root, 'cache')
    const barriers = join(root, 'barriers')
    await mkdir(cacheDir, { recursive: true })
    await mkdir(barriers, { recursive: true })
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    const initial = emptyCache()
    initial.complete = true
    await saveCache(initial)

    const sourceA = join(root, 'changed-a.json')
    const sourceB = join(root, 'changed-b.json')
    await writeFile(sourceA, JSON.stringify({ output: 101 }))
    await writeFile(sourceB, JSON.stringify({ output: 202 }))
    const a = worker(cacheDir, barriers, 'a', sourceA, true)
    const b = worker(cacheDir, barriers, 'b', sourceB, true)
    await Promise.all([waitFor(join(barriers, 'a.parsed')), waitFor(join(barriers, 'b.parsed'))])

    await writeFile(join(barriers, 'a.save'), '')
    await waitFor(join(barriers, 'a.published'))
    await writeFile(join(barriers, 'b.save'), '')
    await Promise.all([waitForExit(a), waitForExit(b)])

    const files = (await loadCache()).providers['regression']?.files ?? {}
    expect(Object.keys(files)).toEqual([sourceB])
  })
})
