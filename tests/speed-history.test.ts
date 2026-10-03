import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSpeedHistory } from '../src/speed/history.js'
import { buildSpeedReport } from '../src/speed/report.js'
import { getProvider } from '../src/providers/index.js'
import type { Provider, ParsedProviderCall } from '../src/providers/types.js'

vi.mock('../src/providers/index.js', () => ({ getProvider: vi.fn(async () => undefined) }))
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'speed-history-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.mocked(getProvider).mockReset(); vi.mocked(getProvider).mockResolvedValue(undefined) })

describe('native ZCode request timings', () => {
  it('reads first_token_at and request duration without inventing the last token timestamp', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const file = join(dir, 'db.sqlite')
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE model_usage (id TEXT, model_id TEXT, started_at INTEGER, completed_at INTEGER, first_token_at INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, status TEXT)`)
    const start = Date.parse('2026-10-01T00:00:00Z')
    db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?)').run('r1', 'GLM-test', start, start + 1250, start + 250, 80, 20, 'completed')
    db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?)').run('r2', 'GLM-test', start, start + 1250, start + 250, 10, 0, 'cancelled')
    db.close()
    const history = await readSpeedHistory(100, file)
    expect(history.warnings).toEqual([])
    expect(history.samples).toHaveLength(2)
    expect(history.samples.find(s => s.id === 'r1')).toMatchObject({ harness: 'zcode', model: 'GLM-test', durationMs: 1250, firstEmissionMs: 250, outputTokens: 100, events: [] })
    expect(history.samples.every(s => s.lastEmissionMs === undefined)).toBe(true)
    expect(buildSpeedReport(history.samples).rows[0]).toMatchObject({ effectiveTokensPerSecond: 80, firstEmissionMsP50: 250,
      generationTokensPerSecondP50: 99, generationRateEstimated: true, generationRequests: 1, bufferedDelivery: false,
      interTokenMsP50: null, timedRequests: 1, requests: 2 })
  })

  it('handles missing optional columns and a missing database without assuming zero latency', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const file = join(dir, 'legacy.sqlite')
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE model_usage (id TEXT, model_id TEXT, started_at INTEGER, completed_at INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER);
      INSERT INTO model_usage VALUES ('r1','GLM-test',1780000000000,1780000001000,10,0)`)
    db.close()
    const history = await readSpeedHistory(100, file)
    expect(history.warnings).toEqual([])
    expect(history.samples[0].firstEmissionMs).toBeUndefined()
    expect(buildSpeedReport(history.samples).rows[0].firstEmissionMsP50).toBeNull()
    expect((await readSpeedHistory(100, join(dir, 'absent.sqlite'))).samples).toEqual([])
  })

  it('applies the ZCode request limit inside the report window, not to the newest rows overall', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const file = join(dir, 'window.sqlite')
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE model_usage (id TEXT, model_id TEXT, started_at INTEGER, completed_at INTEGER, first_token_at INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, status TEXT)`)
    const start = Date.parse('2026-10-01T00:00:00Z'), end = start + 86_400_000
    for (const [id, at] of [['before', start - 1], ['early', start], ['late', end - 1000], ['after', end + 1]] as const) {
      db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?)').run(id, 'GLM-test', at, at + 1000, at + 200, 10, 0, 'completed')
    }
    db.close()
    expect((await readSpeedHistory(1, file, false)).samples.map(s => s.id)).toEqual(['after'])
    const truncated = await readSpeedHistory(1, file, false, { start, end })
    expect(truncated.samples.map(s => s.id)).toEqual(['late'])
    expect(truncated.warnings).toEqual(['ZCode history: only the 1 most recent requests in this window were read (--history-limit)'])
    const whole = await readSpeedHistory(10, file, false, { start, end })
    expect(whole.samples.map(s => s.id).sort()).toEqual(['early', 'late'])
    expect(whole.warnings).toEqual([])
  })

  it('skips Codex session discovery for lightweight GUI generation reads', async () => {
    expect(await readSpeedHistory(10, join(dir, 'absent.sqlite'), false)).toEqual({ samples: [], warnings: [] })
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('excludes Codex turns that mix models instead of proportionally inventing per-model timing', async () => {
    const path = join(dir, 'rollout.jsonl')
    await writeFile(path, '')
    const calls = [
      { turnId: 'mixed', model: 'model-a' }, { turnId: 'mixed', model: 'model-b' }, { turnId: 'single', model: 'model-a' },
    ].map((c, i) => ({ ...c, timestamp: '2026-10-01T09:00:00Z', deduplicationKey: `request-${i}`, activeDurationMs: 1000, activeGeneratedTokens: 10 } as ParsedProviderCall))
    vi.mocked(getProvider).mockResolvedValue({
      discoverSessions: async () => [{ path, project: 'test', provider: 'codex' }],
      createSessionParser: () => ({ async *parse() { for (const call of calls) yield call } }),
    } as unknown as Provider)
    const history = await readSpeedHistory(100, join(dir, 'absent.sqlite'))
    expect(history.samples).toHaveLength(1)
    expect(history.samples[0]).toMatchObject({ id: 'request-2', model: 'model-a', source: 'codex-checkpoint', resolution: 'turn', outputTokens: 10 })
    expect(buildSpeedReport(history.samples).rows[0]).toMatchObject({ generationTokensPerSecondP50: null, generationRequests: 0, effectiveTokensPerSecond: 10 })
  })
})
