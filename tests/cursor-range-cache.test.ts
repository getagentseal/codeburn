import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { createRequire } from 'module'
import { join } from 'path'
import { tmpdir } from 'os'

import { getEditorDataDir } from '../src/editor-data-dir.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { isSqliteAvailable } from '../src/sqlite.js'
import type { DateRange, ProjectSummary } from '../src/types.js'

const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()
const lastDays = (n: number): DateRange => ({ start: new Date(Date.now() - n * DAY), end: new Date() })

let root: string

async function createCursorDb(createdAt: string[]): Promise<void> {
  const dir = join(getEditorDataDir('Cursor', root, process.platform), 'User', 'globalStorage')
  await mkdir(dir, { recursive: true })
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'state.vscdb'))
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  const stmt = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  createdAt.forEach((ts, i) => stmt.run(`bubbleId:conv-${i}:bubble-${i}`, JSON.stringify({
    type: 2,
    conversationId: `conv-${i}`,
    text: 'def hello(): pass',
    tokenCount: { inputTokens: 100, outputTokens: 100 },
    createdAt: ts,
    modelInfo: { modelName: 'gpt-5' },
  })))
  db.close()
}

function totals(projects: ProjectSummary[]): { calls: number; cost: number } {
  let calls = 0
  let cost = 0
  for (const p of projects) for (const s of p.sessions) for (const t of s.turns) for (const c of t.assistantCalls) {
    calls++
    cost += c.costUSD
  }
  return { calls, cost }
}

async function parse(range: DateRange, cacheDir: string) {
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  clearSessionCache()
  return totals(await parseAllSessions(range, 'cursor'))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursor-range-cache-'))
  process.env['HOME'] = root
  process.env['USERPROFILE'] = root
  process.env['APPDATA'] = join(root, 'AppData', 'Roaming')
  delete process.env['XDG_CONFIG_HOME']
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(!isSqliteAvailable())('cursor parse cached across ranges', () => {
  it('a wider range after a narrow one matches a cold wide parse', async () => {
    await createCursorDb([daysAgo(1), daysAgo(10), daysAgo(20)])
    const cold = await parse(lastDays(30), join(root, 'cold'))
    expect(cold.calls).toBe(3)

    const warm = join(root, 'warm')
    expect((await parse(lastDays(7), warm)).calls).toBe(1)
    expect(await parse(lastDays(30), warm)).toEqual(cold)
  })
})
