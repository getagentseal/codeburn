import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCommandCodeProvider } from '../../src/providers/command-code.js'
import { calculateCost } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// Redacted capture of real Command Code transcripts: shapes, token counts,
// costs and timestamps kept; text, paths and ids replaced.
const FIXTURE = join(import.meta.dirname, '../fixtures/command-code/projects')
const PROJECT = '-work-project-1'
const SESSION = '00000000-0000-4000-8000-000000000001'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'command-code-test-'))
  await cp(FIXTURE, dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function parseAll(seenKeys = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createCommandCodeProvider(dir)
  const calls: ParsedProviderCall[] = []
  for (const source of await provider.discoverSessions()) {
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
  }
  return calls
}

async function sessionLines(): Promise<string[]> {
  return (await readFile(join(dir, PROJECT, `${SESSION}.jsonl`), 'utf-8')).split('\n').filter(Boolean)
}

function sum(calls: ParsedProviderCall[], key: 'costUSD' | 'inputTokens' | 'cacheReadInputTokens' | 'outputTokens'): number {
  return calls.reduce((s, c) => s + c[key], 0)
}

describe('command-code provider', () => {
  it('totals equal the recorded costUsd and input excludes cache reads', async () => {
    const calls = await parseAll()
    expect(calls).toHaveLength(64)
    expect(sum(calls, 'costUSD')).toBeCloseTo(1.743431, 6)
    expect(calls.every(c => c.costFromBilling && !c.costIsEstimated)).toBe(true)
    expect(sum(calls, 'inputTokens')).toBe(375_600)
    expect(sum(calls, 'cacheReadInputTokens')).toBe(3_610_144)
    expect(sum(calls, 'outputTokens')).toBe(41_944)
    expect(new Set(calls.map(c => c.sessionId)).size).toBe(7)
  })

  it('maps one call field by field', async () => {
    const line = (await sessionLines()).map(l => JSON.parse(l)).find(l => l.usage)
    const call = (await parseAll()).find(c => c.deduplicationKey === `command-code:${line.id}`)!
    expect(call).toMatchObject({
      provider: 'command-code',
      model: line.model,
      inputTokens: line.usage.inputTokens - line.usage.cacheReadTokens,
      cacheReadInputTokens: line.usage.cacheReadTokens,
      cacheCreationInputTokens: line.usage.cacheWriteTokens,
      outputTokens: line.usage.outputTokens,
      costUSD: line.usage.costUsd,
      timestamp: line.timestamp,
      sessionId: SESSION,
      project: 'project-1',
      projectPath: '/work/project-1',
    })
  })

  it('collects tools and subagents', async () => {
    const calls = await parseAll()
    const tools = calls.flatMap(c => c.tools)
    expect(tools).toContain('Read')
    expect(tools).toContain('Grep')
    expect(tools).toContain('Bash')
    expect(tools).toContain('Agent')
    expect(calls.flatMap(c => c.subagentTypes ?? [])).toContain('redacted')
    expect(calls.flatMap(c => c.bashCommands)).toContain('echo')
  })

  it('skips sidecar jsonl files', async () => {
    const line = (await sessionLines())[1]!
    for (const sidecar of ['checkpoints', 'prompts']) {
      await writeFile(join(dir, PROJECT, `${SESSION}.${sidecar}.jsonl`), line + '\n')
    }
    const sources = await createCommandCodeProvider(dir).discoverSessions()
    expect(sources).toHaveLength(7)
    expect(sources.every(s => /\/[^./]+\.jsonl$/.test(s.path))).toBe(true)
  })

  it('dedupes duplicate lines and forked sessions by message id', async () => {
    const lines = await sessionLines()
    const assistant = lines.find(l => l.includes('"usage"'))!
    await writeFile(join(dir, PROJECT, `${SESSION}.jsonl`), [...lines, assistant].join('\n') + '\n')
    const fork = [
      JSON.stringify({ type: 'session', version: 3, id: 'fork-session', timestamp: '2026-10-05T00:00:00.000Z', cwd: '/work/project-1' }),
      ...lines.slice(1),
    ]
    await writeFile(join(dir, PROJECT, 'fork-session.jsonl'), fork.join('\n') + '\n')
    const calls = await parseAll()
    expect(calls).toHaveLength(64)
    expect(sum(calls, 'costUSD')).toBeCloseTo(1.743431, 6)
  })

  it('prices a call without costUsd from its tokens', async () => {
    const usage = { inputTokens: 120_000, outputTokens: 2_000, cacheReadTokens: 100_000, cacheWriteTokens: 500 }
    await writeFile(join(dir, PROJECT, 'no-cost.jsonl'), [
      JSON.stringify({ type: 'session', version: 3, id: 'no-cost', timestamp: '2026-10-05T00:00:00.000Z', cwd: '/work/project-1' }),
      JSON.stringify({ type: 'message', id: 'nc-1', parentId: null, timestamp: '2026-10-05T00:00:01.000Z', model: 'moonshotai/Kimi-K3', message: { role: 'assistant', content: [] }, usage }),
    ].join('\n') + '\n')
    const call = (await parseAll()).find(c => c.deduplicationKey === 'command-code:nc-1')!
    const expected = calculateCost('moonshotai/Kimi-K3', 20_000, 2_000, 500, 100_000, 0)
    expect(expected).toBeGreaterThan(0)
    expect(call.inputTokens).toBe(20_000)
    expect(call.costUSD).toBe(expected)
    expect(call.costIsEstimated).toBe(true)
    expect(call.costFromBilling).toBeUndefined()
  })
})
