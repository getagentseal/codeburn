import { mkdtempSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, expect, it } from 'vitest'

// A tool or model literally named after an Object.prototype member must stay a
// plain name: a lookup into a plain-object map used to hand back the inherited
// function, which crashed the whole parse and every report built on it.

const ROOT = mkdtempSync(join(tmpdir(), 'codeburn-proto-keys-'))
const day = new Date(Date.now() - 2 * 86_400_000)
const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
const at = (time: string) => new Date(`${ymd}T${time}`).toISOString()
const now = new Date()
const range = {
  start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7),
  end: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
}

afterAll(() => rm(ROOT, { recursive: true, force: true }))

beforeEach(async () => {
  process.env['HOME'] = join(ROOT, 'home')
  process.env['CODEX_HOME'] = join(ROOT, 'codex')
  process.env['CLAUDE_CONFIG_DIR'] = join(ROOT, 'claude')
  process.env['CODEBURN_CACHE_DIR'] = join(ROOT, 'cache')
  await mkdir(join(ROOT, 'cache'), { recursive: true })

  const codexDir = join(ROOT, 'codex', 'sessions', ...ymd.split('-'))
  await mkdir(codexDir, { recursive: true })
  const id = '0199aaaa-0000-7000-8000-00000000000a'
  const usage = { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 5200 }
  await writeFile(join(codexDir, `rollout-${ymd}T10-00-00-${id}.jsonl`), [
    { type: 'session_meta', timestamp: at('10:00:00'), payload: { id, cwd: '/x', model: 'gpt-5.5' } },
    { type: 'event_msg', timestamp: at('10:00:01'), payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: at('10:00:01'), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
    { type: 'response_item', timestamp: at('10:00:02'), payload: { type: 'function_call', name: 'constructor', arguments: '{}' } },
    { type: 'event_msg', timestamp: at('10:00:05'), payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n')

  const claudeDir = join(ROOT, 'claude', 'projects', 'p')
  await mkdir(claudeDir, { recursive: true })
  const line = (id: string, model: string) => JSON.stringify({
    type: 'assistant', timestamp: at('03:30:00'), sessionId: 's1',
    message: { type: 'message', role: 'assistant', model, id, content: [], usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  })
  await writeFile(join(claudeDir, 's1.jsonl'), [line('a', 'claude-sonnet-4-5'), line('b', 'toString'), line('c', '__proto__')].join('\n') + '\n')
})

async function load() {
  const parser = await import('../src/parser.js')
  const models = await import('../src/models.js')
  await models.loadPricing()
  parser.clearSessionCache()
  return { ...parser, ...models }
}

it('a Codex tool named constructor parses and leaves every provider total intact', async () => {
  const { parseAllSessions } = await load()
  const projects = await parseAllSessions(range, 'all')
  const calls = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
  const codex = calls.filter(c => c.provider === 'codex')
  expect(codex).toHaveLength(1)
  expect(codex[0]!.tools).toEqual(['constructor'])
  expect(codex[0]!.costUSD).toBeGreaterThan(0)
  const claude = calls.filter(c => c.provider === 'claude')
  expect(claude).toHaveLength(3)
  expect(claude.find(c => c.model === 'claude-sonnet-4-5')!.costUSD).toBeGreaterThan(0)
  const session = projects.flatMap(p => p.sessions).find(s => s.turns.some(t => t.assistantCalls.some(c => c.provider === 'codex')))!
  expect(session.toolBreakdown['constructor']).toEqual({ calls: 1 })
})

it('a model named toString prices as unknown without throwing', async () => {
  const { parseAllSessions, getShortModelName } = await load()
  expect(getShortModelName('toString')).toBe('toString')
  expect(getShortModelName('constructor')).toBe('constructor')
  const projects = await parseAllSessions(range, 'claude')
  const call = projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls).find(c => c.model === 'toString')!
  expect(call.costUSD).toBe(0)
})

it('the models report and the menubar payload build with a toString model', async () => {
  const { parseAllSessions } = await load()
  const { aggregateModels } = await import('../src/models-report.js')
  const { buildMenubarPayloadForRange } = await import('../src/usage-aggregator.js')
  const rows = await aggregateModels(await parseAllSessions(range, 'all'), { minCost: 0 })
  expect(rows.find(r => r.model === 'toString')?.calls).toBe(1)
  const payload = await buildMenubarPayloadForRange({ range, label: 'w' }, { optimize: false, timeline: false })
  expect(payload.current.calls).toBe(4)
  expect(payload.current.topModels.find(m => m.name === 'toString')?.calls).toBe(1)
})

it('a model named __proto__ keeps its row in the models report, the menubar payload and the export', async () => {
  const { parseAllSessions } = await load()
  const { aggregateModels } = await import('../src/models-report.js')
  const { buildMenubarPayloadForRange } = await import('../src/usage-aggregator.js')
  const { exportJson } = await import('../src/export.js')
  const projects = await parseAllSessions(range, 'all')
  const rows = await aggregateModels(projects, { minCost: 0 })
  expect(rows.find(r => r.model === '__proto__')?.calls).toBe(1)
  const payload = await buildMenubarPayloadForRange({ range, label: 'w' }, { optimize: false, timeline: false })
  expect(payload.current.topModels.find(m => m.name === '__proto__')?.calls).toBe(1)
  const out = await exportJson([{ label: '30 Days', projects }], join(ROOT, 'export.json'))
  const exported = JSON.parse(await readFile(out, 'utf-8'))
  expect(exported.periods[0].models.find((m: { model?: string }) => m.model === '__proto__')).toBeTruthy()
  expect(exported.tools.find((t: { tool?: string }) => t.tool === 'constructor')?.calls).toBe(1)
  expect(({} as Record<string, unknown>)['calls']).toBeUndefined()
})
