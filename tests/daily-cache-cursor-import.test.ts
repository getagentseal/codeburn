import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'

import { CURSOR_CSV_HEADER, importCursorCsv, replacedProviders } from '../src/cursor-import.js'
import { DAILY_CACHE_VERSION, dailyCachePath, ensureCacheHydrated, invalidateProviderDays, toDateString, type DailyEntry } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { loadPricing } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

const DAY = 86_400_000
const base = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 20 * DAY
const iso = (offsetDays: number, hour = 12) => new Date(base + offsetDays * DAY + hour * 3_600_000).toISOString()

const HOME = mkdtempSync(join(tmpdir(), 'daily-cache-cursor-import-home-'))
let root: string

async function writeAgentTranscript(id: string, mtimeMs: number): Promise<void> {
  const dir = join(homedir(), '.cursor', 'projects', 'proj', 'agent-transcripts')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.txt`)
  await writeFile(path, `user:\n<user_query>question ${id}</user_query>\nA:\nanswer ${'x'.repeat(400)}\n`)
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000)
}

async function writeCsv(): Promise<string> {
  const q = (v: string | number) => `"${v}"`
  const row = [iso(1, 9), '', '', 'Included', 'auto', 'No', 0, 100, 0, 50, 150, 'Included'].map(q).join(',')
  const path = join(root, 'usage.csv')
  await writeFile(path, [CURSOR_CSV_HEADER.join(','), row].join('\n') + '\n')
  const savedAt = (base + 30 * DAY) / 1000
  await utimes(path, savedAt, savedAt)
  return path
}

const hydrate = () => {
  clearSessionCache()
  return ensureCacheHydrated((range) => parseAllSessions(range, 'all'), aggregateProjectsIntoDays)
}
const slice = (days: DailyEntry[], date: string, provider: string) => days.find(d => d.date === date)?.providers[provider]

// What a version bump finds: the current file's days under an older version
// number, and no current file.
async function demoteCurrentFileTo(version: number): Promise<void> {
  const current = JSON.parse(await readFile(dailyCachePath(), 'utf-8'))
  await writeFile(join(process.env['CODEBURN_CACHE_DIR']!, `daily-cache.v${version}.json`), JSON.stringify({ ...current, version }))
  await rm(dailyCachePath())
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'daily-cache-cursor-import-'))
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['HOME'] = HOME
  process.env['USERPROFILE'] = HOME
  await rm(HOME, { recursive: true, force: true })
  await loadPricing()
})

describe('cursor-agent slices on days a Cursor import covers', () => {
  const coveredDay = toDateString(new Date(base + DAY + 5 * 3_600_000))

  it('a re-derive after an import this build never invalidated drops the old cursor-agent slice', async () => {
    await writeAgentTranscript('inside', base + DAY + 5 * 3_600_000)
    const sealed = await hydrate()
    expect(slice(sealed.days, coveredDay, 'cursor-agent')?.calls).toBe(1)

    await demoteCurrentFileTo(34)
    await importCursorCsv(await writeCsv())
    clearSessionCache()
    const live = (await parseAllSessions({ start: new Date(base - 10 * DAY), end: new Date(base + 10 * DAY) }, 'all'))
      .flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    expect(live.filter(c => c.provider === 'cursor-agent')).toHaveLength(0)

    const after = await hydrate()
    expect(slice(after.days, coveredDay, 'cursor')?.calls).toBe(1)
    expect(slice(after.days, coveredDay, 'cursor-agent')).toBeUndefined()
  })

  it('keeps a Grok Bot slice the import holds no Grok Bot rows for', async () => {
    await writeAgentTranscript('inside', base + DAY + 5 * 3_600_000)
    await hydrate()
    await demoteCurrentFileTo(34)
    const oldPath = join(process.env['CODEBURN_CACHE_DIR']!, 'daily-cache.v34.json')
    const old = JSON.parse(await readFile(oldPath, 'utf-8'))
    const day = old.days.find((d: DailyEntry) => d.date === coveredDay)
    day.providers.grokbot = structuredClone(day.providers['cursor-agent'])
    day.calls += day.providers.grokbot.calls
    day.cost += day.providers.grokbot.cost
    await writeFile(oldPath, JSON.stringify(old))

    await importCursorCsv(await writeCsv())
    const after = await hydrate()
    expect(slice(after.days, coveredDay, 'grokbot')?.calls).toBe(1)
    expect(slice(after.days, coveredDay, 'cursor-agent')).toBeUndefined()
  })

  it('the next version bump does not adopt the cursor-agent slice back from an older file', async () => {
    await writeAgentTranscript('inside', base + DAY + 5 * 3_600_000)
    await hydrate()
    await demoteCurrentFileTo(34)

    const s = await importCursorCsv(await writeCsv())
    expect(s.changed).toBe(true)
    await invalidateProviderDays(replacedProviders(), toDateString(new Date(s.coverage.start)), toDateString(new Date(s.coverage.end)))
    const firstRun = await hydrate()
    expect(slice(firstRun.days, coveredDay, 'cursor-agent')).toBeUndefined()
    expect(slice(firstRun.days, coveredDay, 'cursor')?.calls).toBe(1)

    await demoteCurrentFileTo(DAILY_CACHE_VERSION - 1)
    const nextBump = await hydrate()
    expect(slice(nextBump.days, coveredDay, 'cursor')?.calls).toBe(1)
    expect(slice(nextBump.days, coveredDay, 'cursor-agent')).toBeUndefined()
  })
})
