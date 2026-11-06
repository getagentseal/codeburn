import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { buildMenubarPayload } from '../src/menubar-json.js'
import { aggregateModels } from '../src/models-report.js'
import { calculateCost, loadPricing } from '../src/models.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { buildPeriodData } from '../src/usage-aggregator.js'

const RANGE = { start: new Date('2026-06-01T00:00:00.000Z'), end: new Date('2026-06-02T00:00:00.000Z') }
const dirs: string[] = []

beforeAll(async () => { await loadPricing() })
afterEach(async () => {
  clearSessionCache()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

// A pre-2.1.307 subagent placeholder row: input is recorded, output is
// estimated from 80,000 content chars (20,000 tokens).
async function seed(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'codeburn-estshare-src-'))
  const cache = await mkdtemp(join(tmpdir(), 'codeburn-estshare-cache-'))
  dirs.push(base, cache)
  const subDir = join(base, 'projects', 'p', 's1', 'subagents')
  await mkdir(subDir, { recursive: true })
  await writeFile(join(subDir, 'agent-a.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-01T10:00:00.000Z',
    sessionId: 's1',
    isSidechain: true,
    version: '2.1.300',
    message: {
      id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'x'.repeat(80_000) }],
      stop_reason: null,
      usage: { input_tokens: 1_000_000, output_tokens: 1 },
    },
  }) + '\n')
  process.env['CLAUDE_CONFIG_DIR'] = base
  process.env['CODEBURN_CACHE_DIR'] = cache
}

describe('estimated share of a call with estimated output only', () => {
  it('counts only the output cost as estimated, total unchanged', async () => {
    await seed()
    const input = calculateCost('claude-haiku-4-5', 1_000_000, 0, 0, 0, 0)
    const output = calculateCost('claude-haiku-4-5', 0, 20_000, 0, 0, 0)
    expect(input).toBeCloseTo(1)
    expect(output).toBeCloseTo(0.1)

    const projects = await parseAllSessions(RANGE, 'claude')

    const [row] = await aggregateModels(projects)
    expect(row!.costUSD).toBeCloseTo(1.1)
    expect(row!.estimatedCostUSD).toBeCloseTo(0.1)

    const current = buildMenubarPayload(buildPeriodData('Day', projects), [], null).current
    expect(current.cost).toBeCloseTo(1.1)
    expect(current.estimatedCostUSD).toBeCloseTo(0.1)
    expect(current.costBasis!.estimated).toBeCloseTo(0.1 / 1.1)
    expect(current.costBasis!.calculated).toBeCloseTo(1 / 1.1)
  })
})
