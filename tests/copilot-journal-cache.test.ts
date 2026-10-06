import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { PROVIDER_PARSE_VERSIONS, computeEnvFingerprint } from '../src/session-cache.js'
import { DAILY_CACHE_VERSION, currentTzKey, ensureCacheHydrated, toDateString } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { calculateCost } from '../src/models.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'

let root: string
let path: string
let date: string
let timestamp: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copilot-journal-cache-'))
  const ws = join(root, 'workspace')
  const chats = join(ws, 'hash', 'chatSessions')
  await mkdir(chats, { recursive: true })
  vi.stubEnv('CODEBURN_CACHE_DIR', join(root, 'cache'))
  vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
  vi.stubEnv('CODEBURN_COPILOT_WS_STORAGE_DIR', ws)
  vi.stubEnv('CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', join(root, 'no-global'))
  vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(root, 'no-jb'))
  vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(root, 'no-cli'))
  vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', join(root, 'no-store'))
  timestamp = new Date(Date.now() - 4 * 86400000).toISOString()
  date = toDateString(new Date(timestamp))
  path = join(chats, 'journal.jsonl')
  await writeFile(path, JSON.stringify({ kind: 0, v: { sessionId: 'cache-journal', creationDate: Date.parse(timestamp), requests: [
    { requestId: 'output', modelId: 'copilot/gpt-4o', promptTokens: 12345, completionTokens: 678 },
    { requestId: 'input-only', modelId: 'copilot/gpt-4o', promptTokens: 1000, completionTokens: 0 },
  ] } }) + '\n')
  clearSessionCache()
})

afterEach(async () => {
  clearSessionCache()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('repairs a pre-fix session cache and finalized daily cache without duplicating durable calls', async () => {
  const parse = () => parseAllSessions(undefined, 'copilot')
  const fresh = await parse()
  const expected = aggregateProjectsIntoDays(fresh)
  expect(expected).toHaveLength(1)
  expect(expected[0]).toMatchObject({ date, calls: 2, inputTokens: 13345, outputTokens: 678 })

  // Seed the exact pre-fix output: one output-bearing call with zero input,
  // and no input-only call. A second, deleted file represents durable history
  // that must survive the parser version change unchanged.
  const disk = await readCacheOnDisk()
  const section = disk.providers['copilot']!
  const file = section.files[path]!
  expect(file).toBeDefined()
  file.turns = file.turns.filter(turn => turn.calls.some(call => call.deduplicationKey.endsWith(':output')))
  for (const turn of file.turns) for (const call of turn.calls) {
    call.usage.inputTokens = 0
    call.costUSD = calculateCost('gpt-4o', 0, 678, 0, 0, 0)
  }
  const retained = structuredClone(file)
  for (const turn of retained.turns) for (const call of turn.calls) {
    call.deduplicationKey = 'copilot-chatsession:pruned:output'
    call.usage.outputTokens = 10
    call.costUSD = calculateCost('gpt-4o', 0, 10, 0, 0, 0)
  }
  section.files[join(root, 'deleted.jsonl')] = retained
  const currentVersion = PROVIDER_PARSE_VERSIONS.copilot!
  try {
    PROVIDER_PARSE_VERSIONS.copilot = currentVersion.replace('-journal-request-input-v1', '')
    section.envFingerprint = computeEnvFingerprint('copilot')
  } finally {
    PROVIDER_PARSE_VERSIONS.copilot = currentVersion
  }
  await writeCacheOnDisk(disk)
  clearSessionCache()

  const before = aggregateProjectsIntoDays(await parse())
  expect(before[0]).toMatchObject({ calls: 3, inputTokens: 13345, outputTokens: 688 })
  clearSessionCache()
  expect(aggregateProjectsIntoDays(await parse())).toEqual(before)

  const oldCost = calculateCost('gpt-4o', 0, 678, 0, 0, 0)
  const oldProjects = structuredClone(fresh)
  for (const project of oldProjects) for (const session of project.sessions) {
    session.turns = session.turns.filter(turn => turn.assistantCalls.some(call => call.deduplicationKey.endsWith(':output')))
    for (const turn of session.turns) for (const call of turn.assistantCalls) {
      call.usage.inputTokens = 0
      call.costUSD = oldCost
    }
  }
  // Derive all maps consistently from old calls, so the loader's carried
  // remainder repair cannot mask a malformed fixture.
  const staleDays = aggregateProjectsIntoDays(oldProjects)
  expect(staleDays[0]).toMatchObject({ calls: 1, inputTokens: 0, outputTokens: 678 })
  await writeFile(join(root, 'cache', 'daily-cache.v46.json'), JSON.stringify({
    version: 46, savingsConfigHash: '', tzKey: currentTzKey(), lastComputedDate: date,
    days: staleDays, complete: true, watermarkTrusted: true,
  }))
  const hydrated = await ensureCacheHydrated(parse, aggregateProjectsIntoDays, '')
  expect(hydrated.version).toBe(DAILY_CACHE_VERSION)
  expect(hydrated.days.find(day => day.date === date)).toMatchObject({ calls: 3, inputTokens: 13345, outputTokens: 688 })
})
