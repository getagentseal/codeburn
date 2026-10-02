import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
const testHome = vi.hoisted(() => {
  const path = `${process.env['TMPDIR'] || '/tmp'}/vibe-unified-${process.pid}-${Date.now()}`
  process.env['VIBE_HOME'] = `${path}/.vibe`
  return path
})
import fixture from '../fixtures/mistral-vibe-unified.json'
import { clearSessionCache, parseAllSessions } from '../../src/parser.js'
import { createMistralVibeProvider } from '../../src/providers/mistral-vibe.js'
import { fingerprintFile } from '../../src/session-cache.js'
import { setHome } from '../setup/home.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let home: string
let root: string
let session: string
let current: string

beforeEach(async () => {
  home = testHome
  await mkdir(home, { recursive: true })
  setHome(home)
  process.env['VIBE_HOME'] = join(home, '.vibe')
  process.env['CODEBURN_CACHE_DIR'] = join(home, 'cache')
  root = join(home, '.vibe/logs/session')
  session = join(root, 'unified', fixture.turn1.CURRENT.session_id)
  current = join(session, 'CURRENT')
})

afterEach(async () => {
  clearSessionCache()
  await rm(home, { recursive: true, force: true })
})

async function writeSnapshot(files: Record<string, unknown>) {
  await rm(session, { recursive: true, force: true })
  for (const [name, value] of Object.entries(files)) {
    const path = join(session, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, name.endsWith('.jsonl')
      ? (value as unknown[]).map(line => JSON.stringify(line)).join('\n') + '\n'
      : JSON.stringify(value))
  }
}

async function calls(seenKeys = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createMistralVibeProvider(root)
  const result: ParsedProviderCall[] = []
  for (const source of await provider.discoverSessions()) {
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) result.push(call)
  }
  return result
}

function tokens(values: ParsedProviderCall[]) {
  return values.reduce((sum, call) => ({
    input: sum.input + call.inputTokens,
    output: sum.output + call.outputTokens,
    cached: sum.cached + call.cacheReadInputTokens,
  }), { input: 0, output: 0, cached: 0 })
}

describe('Mistral Vibe Unified Harness (real 2.25.8 store, local API fixture)', () => {
  it('discovers CURRENT beside stats-free metadata and preserves cached input', async () => {
    await writeSnapshot(fixture.turn1)
    const provider = createMistralVibeProvider(root)
    expect(await provider.discoverSessions()).toEqual([
      { path: current, project: 'vibe-repro', provider: 'mistral-vibe' },
    ])
    const parsed = await calls()
    expect(parsed).toHaveLength(1)
    expect(tokens(parsed)).toEqual({ input: 40, output: 15, cached: 80 })
    expect(parsed[0]).toMatchObject({
      model: 'mistral-medium-3.5', cachedInputTokens: 80,
      userMessage: 'Reply exactly: CODEBURN_MISTRAL_REPRO_OK',
      projectPath: '/tmp/vibe-repro', timestamp: '2026-10-01T23:33:28.883Z',
    })
    expect(parsed[0]!.costUSD).toBeGreaterThan(0)
  })

  it('retains the first turn after Vibe prunes its journal and does not double-count projections', async () => {
    await writeSnapshot(fixture.turn2)
    const parsed = await calls()
    expect(parsed.map(c => [c.inputTokens, c.outputTokens, c.cacheReadInputTokens])).toEqual([
      [40, 15, 80], [64, 10, 64],
    ])
    expect(tokens(parsed)).toEqual({ input: 104, output: 25, cached: 144 })
    expect(new Set(parsed.map(c => c.turnId)).size).toBe(2)
    const seen = new Set<string>()
    expect(await calls(seen)).toHaveLength(2)
    expect(await calls(seen)).toHaveLength(0)
  })

  it('reads only the committed generation and handles fully pruned journals', async () => {
    await writeSnapshot(fixture.turn2)
    await rm(join(session, 'journal'), { recursive: true })
    // A partial, newer generation must never displace CURRENT.
    const unpublished = join(session, 'generations/9999999999999999')
    await mkdir(unpublished)
    await writeFile(join(unpublished, 'projection-state.json'), '{}')
    expect(tokens(await calls())).toEqual({ input: 104, output: 25, cached: 144 })
  })

  it('reparses appended journal usage without a CURRENT or directory mtime change', async () => {
    await writeSnapshot(fixture.turn1)
    const before = await fingerprintFile(current)
    const beforeCurrent = await readFile(current, 'utf8')
    const initial = await parseAllSessions(undefined, 'mistral-vibe')
    expect(initial.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls))
      .toHaveLength(1)
    const tail = fixture.turn2['journal/0000000000000009.jsonl']
    await appendFile(join(session, 'journal/0000000000000009.jsonl'), tail.map(r => JSON.stringify(r)).join('\n') + '\n')
    expect(await readFile(current, 'utf8')).toBe(beforeCurrent)
    expect(await fingerprintFile(current)).not.toEqual(before)
    clearSessionCache()
    const after = await parseAllSessions(undefined, 'mistral-vibe')
    const parsed = after.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    expect(parsed).toHaveLength(2)
    expect(parsed.reduce((sum, c) => sum + c.usage.inputTokens + c.usage.cacheReadInputTokens + c.usage.outputTokens, 0)).toBe(273)
  })

  it('ignores duplicate journal sequences and truncated trailing writes', async () => {
    await writeSnapshot(fixture.turn2)
    const path = join(session, 'journal/0000000000000017.jsonl')
    await appendFile(path, fixture.turn2['journal/0000000000000009.jsonl'].map(r => JSON.stringify(r)).join('\n') + '\n{"sequence":')
    expect(tokens(await calls())).toEqual({ input: 104, output: 25, cached: 144 })
  })

  it('does not interpret malformed manifests or paths outside the store', async () => {
    await writeSnapshot(fixture.turn1)
    await writeFile(current, JSON.stringify({ ...fixture.turn1.CURRENT, generation: '../../outside' }))
    expect(await calls()).toEqual([])
  })

  it('supports pre-delta projection_advanced records without reusing contextUsage', async () => {
    const files = structuredClone(fixture.turn1) as Record<string, unknown>
    const records = fixture.turn1['journal/0000000000000001.jsonl']
    files['journal/0000000000000001.jsonl'] = records.flatMap(record => {
      if (record.type !== 'projection_delta' || !('delta' in record.payload)) return []
      return record.payload.delta.filter(op => op.op === 'set_envelope').map(op => ({
        sequence: record.sequence, type: 'projection_advanced', payload: { snapshot: 'state' in op ? op.state : {} },
      }))
    })
    await writeSnapshot(files)
    expect(tokens(await calls())).toEqual({ input: 40, output: 15, cached: 80 })
  })
})
