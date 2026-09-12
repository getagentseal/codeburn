import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// End-to-end over the real CLI: the cohort branch of `compare` must apply the
// --project / --exclude / --category / --from--to selection BEFORE computing
// anything, and the reported statistics must be reproducible from the sample
// list the same payload carries. Unit tests pin the math; this one proves the
// selection flags actually reach it.

// Each test spawns `tsx src/cli.ts`, which re-transpiles the CLI per spawn.
beforeAll(() => {
  vi.setConfig({ testTimeout: 60_000 })
})

const SIBLINGS = [
  { dir: '-Users-gone-alpha', cwd: '/Users/gone/alpha', session: 's-alpha' },
  { dir: '-Users-gone-beta', cwd: '/Users/gone/beta', session: 's-beta' },
]

const OPUS = 'claude-opus-4-20250514'
const SONNET = 'claude-3-5-sonnet-20241022'

let homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home) await rm(home, { recursive: true, force: true })
  }
})

function assistantLine(session: string, cwd: string, model: string, minutesAgo: number, costWeights: { input: number; output: number } = { input: 90_000, output: 12_000 }): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sessionId: session,
    cwd,
    message: {
      type: 'message', role: 'assistant', model, id: `${session}-${model}-${minutesAgo}`,
      content: [{ type: 'tool_use', id: `tu-${minutesAgo}`, name: 'Edit', input: {} }],
      usage: {
        input_tokens: costWeights.input,
        output_tokens: costWeights.output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 300_000,
      },
    },
  })
}

function userLine(session: string, cwd: string, minutesAgo: number, text = 'please edit the file'): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    sessionId: session,
    cwd,
    message: { role: 'user', content: text },
  })
}

/**
 * Two sibling projects:
 *  - alpha: 2 opus edit turns, 1 sonnet edit turn, 1 opus+sonnet MIXED turn
 *  - beta:  1 opus edit turn
 */
async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-compare-cohort-'))
  homes.push(home)
  const minutes = (n: number) => 5 + n
  const alphaLines = [
    userLine('s-alpha', '/Users/gone/alpha', minutes(1)),
    assistantLine('s-alpha', '/Users/gone/alpha', OPUS, minutes(2)),
    userLine('s-alpha', '/Users/gone/alpha', minutes(3)),
    assistantLine('s-alpha', '/Users/gone/alpha', OPUS, minutes(4)),
    userLine('s-alpha', '/Users/gone/alpha', minutes(5)),
    assistantLine('s-alpha', '/Users/gone/alpha', SONNET, minutes(6)),
    // Mixed turn: two assistant lines of different models between user msgs.
    userLine('s-alpha', '/Users/gone/alpha', minutes(7)),
    assistantLine('s-alpha', '/Users/gone/alpha', OPUS, minutes(8)),
    assistantLine('s-alpha', '/Users/gone/alpha', SONNET, minutes(9)),
  ]
  const betaLines = [
    userLine('s-beta', '/Users/gone/beta', minutes(1)),
    assistantLine('s-beta', '/Users/gone/beta', OPUS, minutes(2)),
  ]
  const alphaDir = join(home, '.claude', 'projects', SIBLINGS[0]!.dir)
  const betaDir = join(home, '.claude', 'projects', SIBLINGS[1]!.dir)
  await mkdir(alphaDir, { recursive: true })
  await mkdir(betaDir, { recursive: true })
  await writeFile(join(alphaDir, `${SIBLINGS[0]!.session}.jsonl`), alphaLines.join('\n') + '\n', 'utf-8')
  await writeFile(join(betaDir, `${SIBLINGS[1]!.session}.jsonl`), betaLines.join('\n') + '\n', 'utf-8')
  return home
}

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEBURN_CACHE_DIR: join(home, 'cache'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

type CohortReport = {
  kind: string
  modelA: { model: string; stats: { observationCount: number; distinctSessionCount: number; costMedian: number | null; costP90: number | null; unknownCostCount: number }; observations: Array<{ costUSD: number; costKnown: boolean; sessionId: string; project: string; category: string }> }
  modelB: { model: string; stats: { observationCount: number }; observations: unknown[] }
  conventions: Record<string, string>
}

describe('compare --format cohort-json', () => {
  it('answers the facet query without models: models, canonical projects, categories', async () => {
    const home = await seedHome()
    const result = runCli(['compare', '--format', 'cohort-json', '--period', '30days'], home)
    expect(result.status).toBe(0)
    // tsx emits a Node deprecation line on stderr; the meaningful assertion is
    // that no codeburn-level warning (e.g. an unmatched project pattern) fired.
    expect(result.stderr).not.toContain('codeburn')
    const facets = JSON.parse(result.stdout)
    expect(facets.kind).toBe('cohort-facets')
    expect(facets.models.map((m: { model: string }) => m.model).sort()).toEqual([OPUS, SONNET].sort())
    expect(facets.projects.map((p: { project: string }) => p.project).sort())
      .toEqual(['-Users-gone-alpha', '-Users-gone-beta'])
    expect(facets.categories.length).toBeGreaterThan(5)
  })

  it('attributes each single-model edit turn to its own model and reports the mixed turn as excluded', async () => {
    const home = await seedHome()
    const result = runCli(['compare', '--format', 'cohort-json', '--period', '30days', '--model-a', OPUS, '--model-b', SONNET], home)
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as CohortReport
    expect(report.kind).toBe('cohort-comparison')
    // alpha: 2 opus turns + beta: 1 opus turn = 3 observations; the mixed turn
    // belongs to NOBODY. Sonnet: 1 single-model turn.
    expect(report.modelA.stats.observationCount).toBe(3)
    expect(report.modelB.stats.observationCount).toBe(1)
    expect(report.modelA.observations).toHaveLength(3)
    // Reproducibility: the median is recomputable from the sample list.
    const costs = report.modelA.observations.map(o => o.costUSD).sort((a, b) => a - b)
    const median = costs.length % 2 === 1
      ? costs[(costs.length - 1) / 2]
      : (costs[costs.length / 2 - 1]! + costs[costs.length / 2]!) / 2
    expect(report.modelA.stats.costMedian).toBeCloseTo(median, 10)
    expect(report.modelA.stats.distinctSessionCount).toBe(2)
    // Conventions are part of the payload, not folklore.
    expect(report.conventions.attribution).toContain('owning model')
  })

  it('lets a rooted --project exclude observations before any statistic is computed', async () => {
    const home = await seedHome()
    const filtered = runCli(['compare', '--format', 'cohort-json', '--period', '30days', '--model-a', OPUS, '--model-b', SONNET, '--project', '/Users/gone/alpha'], home)
    expect(filtered.status).toBe(0)
    const report = JSON.parse(filtered.stdout) as CohortReport
    expect(report.modelA.stats.observationCount).toBe(2)
    expect(report.modelA.observations.every(o => o.project === '-Users-gone-alpha')).toBe(true)
    // And the payload's selection records the restriction.
    expect(JSON.parse(filtered.stdout).selection.projects).toEqual(['-Users-gone-alpha'])
  })

  it('reports zero-observation cohorts with null stats instead of zeros when a category keeps nothing', async () => {
    const home = await seedHome()
    const result = runCli(['compare', '--format', 'cohort-json', '--period', '30days', '--model-a', OPUS, '--model-b', SONNET, '--category', 'testing'], home)
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as CohortReport
    expect(report.modelA.stats.observationCount).toBe(0)
    expect(report.modelA.stats.costMedian).toBeNull()
    expect(report.modelA.observations).toEqual([])
    expect(report.modelB.stats.observationCount).toBe(0)
  })

  it('selects an exact project id while preserving loose --project matching', async () => {
    const home = await seedHome()
    const siblingPath = '/Users/gone/alpha-backend'
    const siblingDir = join(home, '.claude', 'projects', '-Users-gone-alpha-backend')
    await mkdir(siblingDir, { recursive: true })
    await writeFile(join(siblingDir, 's-sibling.jsonl'), [
      userLine('s-sibling', siblingPath, 10),
      assistantLine('s-sibling', siblingPath, OPUS, 9),
    ].join('\n') + '\n')
    const args = ['compare', '--format', 'cohort-json', '--period', '30days', '--model-a', OPUS, '--model-b', SONNET]
    const exact = runCli([...args, '--project-id=/Users/gone/alpha'], home)
    expect(exact.status).toBe(0)
    const report = JSON.parse(exact.stdout) as CohortReport
    expect(report.modelA.stats.observationCount).toBe(2)
    expect(report.modelA.observations.every(o => o.project === '-Users-gone-alpha')).toBe(true)
    const loose = runCli([...args, '--project', 'alpha'], home)
    expect(loose.status).toBe(0)
    expect(JSON.parse(loose.stdout).modelA.stats.observationCount).toBe(3)
    const oneModel = runCli([...args, '--project-id=/Users/gone/alpha-backend'], home)
    expect(oneModel.status).toBe(0)
    const oneModelReport = JSON.parse(oneModel.stdout) as CohortReport
    expect(oneModelReport.modelA.stats.observationCount).toBe(1)
    expect(oneModelReport.modelB.stats.observationCount).toBe(0)
  })

  it('rejects an unknown category with a usable message', async () => {
    const home = await seedHome()
    const result = runCli(['compare', '--format', 'cohort-json', '--period', '30days', '--category', 'not-a-category'], home)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown category "not-a-category"')
  })

  it('rejects an unknown model like the classic format does', async () => {
    const home = await seedHome()
    const result = runCli(['compare', '--format', 'cohort-json', '--period', '30days', '--model-a', 'nope-1', '--model-b', OPUS], home)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('model not found: "nope-1"')
  })

  it('accepts an explicit --from/--to interval', async () => {
    const home = await seedHome()
    const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const to = new Date().toISOString().slice(0, 10)
    const result = runCli(['compare', '--format', 'cohort-json', '--model-a', OPUS, '--model-b', SONNET, '--from', from, '--to', to], home)
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as CohortReport & { selection: { from: string; to: string } }
    expect(report.selection.from).toBe(from)
    expect(report.selection.to).toBe(to)
    expect(report.modelA.stats.observationCount).toBe(3)
  })

  it('leaves the classic json contract untouched (an array of ModelStats)', async () => {
    const home = await seedHome()
    const result = runCli(['compare', '--format', 'json', '--period', '30days'], home)
    expect(result.status).toBe(0)
    const classic = JSON.parse(result.stdout)
    expect(Array.isArray(classic)).toBe(true)
    expect(classic.map((m: { model: string }) => m.model).sort()).toEqual([OPUS, SONNET].sort())
    // Classic rows carry the classic fields, untouched by the cohort work.
    expect(classic[0]).toHaveProperty('editTurns')
    expect(classic[0]).toHaveProperty('editCost')
    expect(classic[0]).not.toHaveProperty('observations')
  })
})
