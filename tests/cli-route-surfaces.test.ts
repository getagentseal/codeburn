import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DAILY_CACHE_VERSION } from '../src/daily-cache.js'

// Each test spawns `tsx src/cli.ts`, which re-transpiles the CLI per spawn.
vi.setConfig({ testTimeout: 60_000 })

// The #1448 review seeded three Claude sessions of one model — direct,
// single-region Bedrock, cross-region Bedrock — and found `codeburn models`
// printing two identical labels while the menubar payload blended them into
// one row: the surfaces keyed model rows differently. This runs the real
// binary over the same three sessions and asserts every surface agrees on the
// same three rows, at the prices main already showed for them (#1450).

const SESSIONS = [
  { id: 's-direct', model: 'claude-haiku-4-5-20251001', expectRow: 'Haiku 4.5' },
  { id: 's-bedrock', model: 'anthropic.claude-haiku-4-5-20251001-v1:0', expectRow: 'Haiku 4.5 (Bedrock)' },
  { id: 's-bedrock-us', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', expectRow: 'Haiku 4.5 (Bedrock us)' },
] as const

let homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home) await rm(home, { recursive: true, force: true })
  }
})

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-route-surfaces-'))
  homes.push(home)
  const dir = join(home, '.claude', 'projects', '-Users-gone-app')
  await mkdir(dir, { recursive: true })
  // Dated yesterday (UTC): the daily cache never persists today's entries
  // (daily-cache.ts, "no today/future entries"), and the last assertion reads
  // the finalized day back off disk.
  const yesterdayNoon = new Date()
  yesterdayNoon.setUTCDate(yesterdayNoon.getUTCDate() - 1)
  yesterdayNoon.setUTCHours(12, 0, 0, 0)
  for (const [index, session] of SESSIONS.entries()) {
    const ts = new Date(yesterdayNoon.getTime() + index * 60_000).toISOString()
    const user = JSON.stringify({ type: 'user', uuid: `${session.id}-u`, parentUuid: null, sessionId: session.id, timestamp: ts, cwd: '/Users/gone/app', message: { role: 'user', content: 'hello' } })
    const assistant = JSON.stringify({
      type: 'assistant', uuid: `${session.id}-a`, parentUuid: `${session.id}-u`, sessionId: session.id, timestamp: ts, cwd: '/Users/gone/app',
      message: {
        type: 'message', role: 'assistant', model: session.model, id: `${session.id}-m`, content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    await writeFile(join(dir, `${session.id}.jsonl`), `${user}\n${assistant}\n`, 'utf-8')
  }
  return home
}

function runCli(args: string[], home: string): string {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, 'cache'),
      // Keep every other provider out of the run so the rows are exactly ours.
      HERMES_HOME: join(home, 'no-hermes'), CODEX_HOME: join(home, 'no-codex'),
      TZ: 'UTC',
    },
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

type Row = { name: string; cost: number; calls: number }
const round = (n: number) => Math.round(n * 100) / 100

describe('billing routes: the same three rows on every surface', () => {
  it('models, the menubar payload (current + history) and the daily cache agree, at the prices main showed', async () => {
    const home = await seedHome()

    // codeburn models --format json: rows carry the route and their raw ids.
    const models = JSON.parse(runCli(['models', '--provider', 'claude', '--period', 'week', '--format', 'json'], home)) as unknown
    const modelRows = (Array.isArray(models) ? models : (models as { rows?: unknown[]; models?: unknown[] }).rows ?? (models as { models?: unknown[] }).models ?? []) as Array<{ modelDisplayName: string; costUSD: number; calls: number; rawModels: string[]; route: string | null }>
    const modelsByName = new Map(modelRows.map(r => [r.modelDisplayName, r]))
    expect([...modelsByName.keys()].sort()).toEqual(SESSIONS.map(s => s.expectRow).sort())
    expect(modelsByName.get('Haiku 4.5')).toMatchObject({ route: null, rawModels: ['claude-haiku-4-5-20251001'] })
    expect(modelsByName.get('Haiku 4.5 (Bedrock)')).toMatchObject({ route: 'bedrock', rawModels: ['anthropic.claude-haiku-4-5-20251001-v1:0'] })
    expect(modelsByName.get('Haiku 4.5 (Bedrock us)')).toMatchObject({ route: 'bedrock', rawModels: ['us.anthropic.claude-haiku-4-5-20251001-v1:0'] })

    // The cross-region profile is a dearer SKU and keeps its own price; the
    // bare Bedrock id matches direct. Neither moved: routes are display-only.
    const direct = modelsByName.get('Haiku 4.5')!.costUSD
    const bedrock = modelsByName.get('Haiku 4.5 (Bedrock)')!.costUSD
    const bedrockUs = modelsByName.get('Haiku 4.5 (Bedrock us)')!.costUSD
    expect(direct).toBeGreaterThan(0)
    expect(round(bedrock)).toBe(round(direct))
    expect(bedrockUs).toBeGreaterThan(bedrock)

    // status --format menubar-json: current.topModels and history.daily[].topModels
    // key on the same function, so they carry the same three rows.
    const payload = JSON.parse(runCli(['status', '--format', 'menubar-json', '--period', 'week'], home)) as {
      current: { topModels: Row[] }
      history: { daily: Array<{ topModels: Array<Row & { rawModels?: string[] }> }> }
    }
    const current = new Map(payload.current.topModels.map(m => [m.name, m]))
    expect([...current.keys()].sort()).toEqual(SESSIONS.map(s => s.expectRow).sort())
    for (const s of SESSIONS) {
      expect(round(current.get(s.expectRow)!.cost), s.expectRow).toBe(round(modelsByName.get(s.expectRow)!.costUSD))
      expect(current.get(s.expectRow)!.calls, s.expectRow).toBe(1)
    }
    const history = new Map(payload.history.daily.flatMap(d => d.topModels).map(m => [m.name, m]))
    expect([...history.keys()].sort()).toEqual(SESSIONS.map(s => s.expectRow).sort())
    // A row that folds exactly one raw id reports no rawModels list (#1241 contract).
    for (const s of SESSIONS) expect(history.get(s.expectRow)!.rawModels, s.expectRow).toBeUndefined()

    // The finalized day is keyed by the row key too (v33), so a route the
    // provider recorded in its own column would survive into it.
    const cache = JSON.parse(await readFile(join(home, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), 'utf-8')) as { days: Array<{ models: Record<string, unknown> }> }
    const dayKeys = new Set(cache.days.flatMap(d => Object.keys(d.models)))
    for (const s of SESSIONS) expect(dayKeys.has(s.expectRow), s.expectRow).toBe(true)
    expect(dayKeys.has('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(false)
  })
})
