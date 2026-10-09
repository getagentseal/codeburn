import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getModelCosts, loadPricing } from '../src/models.js'
import { buildSessionWhy, errorCause, findingText, redact, renderSessionWhyText, type SessionWhy, type WhyFinding } from '../src/session-why.js'
import { CLEARED, REDIRECTED } from './setup/env-isolation-vars.js'

const SID = '0c4f6c1e-5a7b-4e43-9d0e-2b1f7a6c9e10'
const FABLE = 'claude-fable-5-1'
const SONNET = 'claude-sonnet-5'
type Usage = { in?: number; out: number; cr: number; cw: number; cw1h?: number }
type Tool = { id: string; name: string; input: Record<string, unknown> }

// A tiny transcript writer: entries in time order, assistant messages streamed
// as one chunk per content block (same id, same usage) the way Claude Code writes them.
function transcript(start: string) {
  let t = Date.parse(start)
  let n = 0
  const lines: string[] = []
  const iso = () => new Date(t).toISOString()
  const push = (e: Record<string, unknown>) => lines.push(JSON.stringify({ sessionId: SID, cwd: '/work/demo', timestamp: iso(), ...e }))
  return {
    lines,
    wait: (ms: number) => { t += ms },
    prompt: (text: string) => push({ type: 'user', message: { role: 'user', content: text } }),
    note: (text: string) => push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }),
    call: (model: string, u: Usage, tools: Tool[] = [], streamMs = 2000) => {
      const id = `msg_${++n}_${Math.random().toString(36).slice(2, 7)}`
      const usage = { input_tokens: u.in ?? 2, output_tokens: u.out, cache_read_input_tokens: u.cr, cache_creation_input_tokens: u.cw, cache_creation: { ephemeral_5m_input_tokens: u.cw - (u.cw1h ?? 0), ephemeral_1h_input_tokens: u.cw1h ?? 0 } }
      t += streamMs
      push({ type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage } })
      for (const tool of tools) push({ type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'tool_use', ...tool }], usage } })
    },
    result: (id: string, text: string, ms: number, opts: { isError?: boolean; tur?: Record<string, unknown> } = {}) => {
      t += ms
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: opts.isError === true }] }, toolUseResult: opts.tur ?? {} })
    },
    raw: (e: Record<string, unknown>) => push(e),
  }
}

const TRACEBACK = [
  'Exit code 1',
  'tests/test_parse.py F',
  'error: something earlier looked wrong',
  'Traceback (most recent call last):',
  '  File "/work/demo/tests/test_parse.py", line 9, in test_parse',
  '    parse("x")',
  '  File "/work/demo/src/parse.py", line 41, in parse',
  '    raise ValueError("bad token")',
  'ValueError: bad token',
  '1 failed in 0.20s',
].join('\n')

let home = ''
let why: SessionWhy

async function writeFixture(root: string): Promise<void> {
  const dir = join(root, '.claude', 'projects', '-work-demo')
  await mkdir(join(dir, SID, 'subagents'), { recursive: true })
  const m = transcript('2026-09-10T10:00:00.000Z')
  m.raw({ type: 'ai-title', aiTitle: 'Fix the parser' })

  // Prompt 1: a failing test (traceback), an edit, the passing re-run.
  m.prompt('Fix the parser bug and run the tests. token=sk-abcdefghijklmnop1234')
  m.wait(1000)
  m.call(FABLE, { out: 400, cr: 20_000, cw: 30_000, cw1h: 30_000 }, [{ id: 'b1', name: 'Bash', input: { command: 'cd /work/demo && pytest -q', description: 'Run the tests' } }])
  m.result('b1', TRACEBACK, 3000, { isError: true })
  m.call(FABLE, { out: 300, cr: 50_000, cw: 1_000, cw1h: 1_000 }, [{ id: 'e1', name: 'Edit', input: { file_path: '/work/demo/src/parse.py' } }])
  m.result('e1', 'updated', 200, { tur: { structuredPatch: [{ oldStart: 40, oldLines: 1, newStart: 40, newLines: 1, lines: ['-    raise ValueError("bad token")', '+    return None'] }] } })
  m.call(FABLE, { out: 100, cr: 51_000, cw: 500, cw1h: 500 }, [{ id: 'b2', name: 'Bash', input: { command: 'pytest -q' } }])
  m.result('b2', '1 passed', 2000)
  m.call(FABLE, { out: 200, cr: 51_500, cw: 300, cw1h: 300 })
  m.raw({ type: 'system', subtype: 'turn_duration', durationMs: 15_000 })

  // Prompt 2: two helpers; helper 1 launches a nested helper. A background
  // result arrives after 90s with nothing running, then a slow call.
  m.wait(30_000)
  m.prompt('Review both modules in parallel.')
  m.wait(1000)
  m.call(FABLE, { out: 600, cr: 51_800, cw: 900, cw1h: 900 }, [
    { id: 'a1', name: 'Agent', input: { description: 'Review module 1', prompt: 'p', subagent_type: 'general-purpose' } },
    { id: 'a2', name: 'Agent', input: { description: 'Review module 2', prompt: 'p', subagent_type: 'general-purpose' } },
  ])
  m.result('a1', 'done', 20_000, { tur: { agentId: 'x1' } })
  m.result('a2', 'done', 1000, { tur: { agentId: 'x2' } })
  m.note('Another Claude session sent a message: review of module 2 is done')
  m.call(FABLE, { out: 100, cr: 52_700, cw: 400, cw1h: 400 }, [{ id: 'b3', name: 'Bash', input: { command: 'sleep 1 &' } }])
  m.result('b3', 'started', 1000)
  m.result('bg', 'background job finished', 90_000)
  m.call(FABLE, { out: 6_000, cr: 53_100, cw: 300, cw1h: 300 }, [], 70_000)

  // Prompt 3: a large read rides along until the compaction.
  m.wait(10_000)
  m.prompt('Summarize the log.')
  m.wait(1000)
  m.call(FABLE, { out: 80, cr: 53_400, cw: 200, cw1h: 200 }, [{ id: 'r1', name: 'Read', input: { file_path: '/work/demo/app.log' } }])
  m.result('r1', 'x'.repeat(60_000), 500, { tur: { file: { numLines: 1 } } })
  m.call(FABLE, { out: 90, cr: 53_600, cw: 15_000, cw1h: 15_000 })
  m.call(FABLE, { out: 90, cr: 68_600, cw: 100, cw1h: 100 })
  m.wait(100)
  m.raw({ type: 'system', subtype: 'compact_boundary' })
  m.wait(1000)
  m.call(FABLE, { out: 90, cr: 10_000, cw: 100, cw1h: 100 })
  await writeFile(join(dir, `${SID}.jsonl`), m.lines.join('\n') + '\n')

  const helper = async (agentId: string, toolUseId: string, description: string, calls: Array<{ u: Usage; tools?: Tool[] }>, start: string) => {
    const h = transcript(start)
    h.raw({ type: 'user', isSidechain: true, message: { role: 'user', content: 'review' } })
    for (const c of calls) { h.wait(1000); h.call(SONNET, c.u, c.tools) }
    await writeFile(join(dir, SID, 'subagents', `agent-${agentId}.jsonl`), h.lines.map(l => l.replace('"sessionId"', '"isSidechain":true,"sessionId"')).join('\n') + '\n')
    await writeFile(join(dir, SID, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId }))
  }
  await helper('x1', 'a1', 'Review module 1', [
    { u: { out: 3_000, cr: 30_000, cw: 8_000, cw1h: 8_000 } },
    { u: { out: 2_000, cr: 38_000, cw: 4_000, cw1h: 4_000 }, tools: [{ id: 'n1', name: 'Agent', input: { description: 'Deep check' } }] },
    { u: { out: 1_000, cr: 42_000, cw: 1_000, cw1h: 1_000 } },
  ], '2026-09-10T10:00:50.000Z')
  await helper('x2', 'a2', 'Review module 2', [
    { u: { out: 2_500, cr: 30_000, cw: 9_000, cw1h: 9_000 } },
    { u: { out: 1_500, cr: 39_000, cw: 2_000, cw1h: 2_000 } },
  ], '2026-09-10T10:00:51.000Z')
  await helper('x3', 'n1', 'Deep check', [{ u: { out: 4_000, cr: 20_000, cw: 6_000, cw1h: 6_000 } }], '2026-09-10T10:00:58.000Z')
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of CLEARED) delete env[key]
  for (const key of REDIRECTED) env[key] = home
  env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  env.CODEBURN_CACHE_DIR = join(home, '.cache', 'codeburn')
  return env
}
const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: process.cwd(), env: cliEnv(), encoding: 'utf-8', timeout: 120_000 })
const find = <K extends WhyFinding['kind']>(kind: K) => why.findings.filter((f): f is Extract<WhyFinding, { kind: K }> => f.kind === kind)

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-why-'))
  await writeFixture(home)
  await loadPricing()
  why = await buildSessionWhy(join(home, '.claude', 'projects', '-work-demo', `${SID}.jsonl`))
})
afterAll(async () => { await rm(home, { recursive: true, force: true }) })

describe('session cost diagnosis: reconciliation', () => {
  it('matches `codeburn sessions` for the session, its turns and its helpers', () => {
    const run = cli('sessions', '--format', 'json', '--period', 'lifetime')
    expect(run.status, run.stderr).toBe(0)
    type Row = { sessionId: string; cost: number; calls: number; turns: number }
    const rows = JSON.parse(run.stdout) as Array<Row & { subagents?: Row[] }>
    const row = rows.find(r => r.sessionId === SID)!
    expect(row).toBeDefined()
    // The parent row folds its helpers in and lists them under `subagents`.
    const helperRows = row.subagents ?? []
    expect(helperRows).toHaveLength(3)
    expect(rows.some(r => r.sessionId.startsWith('agent-'))).toBe(false)
    const helpers = (pick: (r: Row) => number) => helperRows.reduce((s, r) => s + pick(r), 0)
    const ownCost = row.cost - helpers(r => r.cost)
    expect(Math.abs(why.cost - ownCost)).toBeLessThan(1e-9)
    expect(Math.abs(why.turns.reduce((s, t) => s + t.cost, 0) - ownCost)).toBeLessThan(1e-9)
    expect(why.calls).toBe(row.calls - helpers(r => r.calls))
    // `sessions` counts the injected hand-back as its own turn; the view folds it into prompt 2.
    expect(why.turns.length).toBe(row.turns - helpers(r => r.turns) - 1)
    expect(Math.abs(why.helperCost - helpers(r => r.cost))).toBeLessThan(1e-9)
  })

  it('prints the same payload through `sessions --id <id> --why --format json`, and text by default', () => {
    const json = cli('sessions', '--id', SID.slice(0, 8), '--why', '--format', 'json')
    expect(json.status, json.stderr).toBe(0)
    const payload = JSON.parse(json.stdout) as SessionWhy
    expect(payload.cost).toBeCloseTo(why.cost, 12)
    expect(payload.findings.map(f => f.kind)).toEqual(why.findings.map(f => f.kind))
    const text = cli('sessions', '--id', SID, '--why')
    expect(text.status, text.stderr).toBe(0)
    expect(text.stdout).toContain('Worth a look, ranked by cost')
    expect(cli('sessions', '--why').status).toBe(1)
  })
})

describe('session cost diagnosis: independent recomputation', () => {
  // Hand pricing from the rate table, not calculateCost: 1-hour cache writes at 1.6x.
  const price = (model: string, u: Usage) => {
    const c = getModelCosts(model)!
    const cw1h = u.cw1h ?? 0
    return { input: (u.in ?? 2) * c.inputCostPerToken, output: u.out * c.outputCostPerToken, cacheRead: u.cr * c.cacheReadCostPerToken, cacheWrite: (u.cw - cw1h) * c.cacheWriteCostPerToken + cw1h * c.cacheWriteCostPerToken * 1.6 }
  }
  const total = (p: ReturnType<typeof price>) => p.input + p.output + p.cacheRead + p.cacheWrite
  const prompt1: Usage[] = [
    { out: 400, cr: 20_000, cw: 30_000, cw1h: 30_000 }, { out: 300, cr: 50_000, cw: 1_000, cw1h: 1_000 },
    { out: 100, cr: 51_000, cw: 500, cw1h: 500 }, { out: 200, cr: 51_500, cw: 300, cw1h: 300 },
  ]

  it('turn cost and its parts', () => {
    const parts = prompt1.map(u => price(FABLE, u))
    const t1 = why.turns[0]!
    expect(t1.cost).toBeCloseTo(parts.reduce((s, p) => s + total(p), 0), 12)
    expect(t1.parts.cacheWrite).toBeCloseTo(parts.reduce((s, p) => s + p.cacheWrite, 0), 12)
    expect(t1.parts.cacheRead).toBeCloseTo(parts.reduce((s, p) => s + p.cacheRead, 0), 12)
    const sum = t1.parts.input + t1.parts.output + t1.parts.cacheRead + t1.parts.cacheWrite + t1.parts.webSearch
    expect(Math.abs(sum - t1.cost)).toBeLessThan(1e-12)
  })

  it('helpers, nested ones counted under the prompt that launched their parent, repriced one tier down', () => {
    const helperUsage: Usage[] = [
      { out: 3_000, cr: 30_000, cw: 8_000, cw1h: 8_000 }, { out: 2_000, cr: 38_000, cw: 4_000, cw1h: 4_000 }, { out: 1_000, cr: 42_000, cw: 1_000, cw1h: 1_000 },
      { out: 2_500, cr: 30_000, cw: 9_000, cw1h: 9_000 }, { out: 1_500, cr: 39_000, cw: 2_000, cw1h: 2_000 },
      { out: 4_000, cr: 20_000, cw: 6_000, cw1h: 6_000 },
    ]
    const cost = helperUsage.reduce((s, u) => s + total(price(SONNET, u)), 0)
    const haiku = helperUsage.reduce((s, u) => s + total(price('claude-haiku-4-5', u)), 0)
    expect(why.turns[1]!.helperCost).toBeCloseTo(cost, 12)
    const [f] = find('helpers')
    expect(f).toMatchObject({ turn: 2, direct: 2, nested: 1, loose: 0, models: ['Sonnet 5'], descriptions: ['Review module 1', 'Review module 2'], calls: 6, minCalls: 1, maxCalls: 3 })
    expect(f!.usd).toBeCloseTo(cost, 12)
    expect(f!.share).toBeCloseTo(cost / (why.cost + cost), 12)
    expect(f!.alt!.model).toBe('Haiku 4.5')
    expect(f!.alt!.cost).toBeCloseTo(haiku, 12)
  })
})

describe('session cost diagnosis: rules', () => {
  it('flags the costly prompt with its median multiple and a one-tier-down repricing', () => {
    const [f] = find('hotspot')
    expect(f).toMatchObject({ turn: 1, calls: 4, toolCalls: 3, models: ['Fable 5.1'] })
    expect(f!.share).toBeGreaterThanOrEqual(0.2)
    expect(f!.alt!.model).toBe('Opus 5.5')
    expect(f!.alt!.cost).toBeLessThan(f!.usd!)
  })

  it('names what ended a failed command and the calls up to the next successful Bash', () => {
    const [f] = find('failed')
    expect(f).toMatchObject({ turn: 1, tool: 'Bash', description: 'Run the tests', userStopped: false, afterCalls: 2 })
    expect(f!.error).toMatchObject({ exitCode: 1, cause: 'ValueError: bad token', location: '/work/demo/src/parse.py, line 41' })
    expect(f!.error.secondary).toContain('error: something earlier looked wrong')
    const calls = why.turns[0]!.steps.filter(s => s.kind === 'model')
    expect(f!.usd).toBeCloseTo(calls[1]!.cost + calls[2]!.cost, 12)
  })

  it('keeps time-only findings without dollars', () => {
    const [idle] = find('idle')
    expect(idle).toMatchObject({ turn: 2, usd: null, share: null, endedBy: 'tool' })
    expect(renderSessionWhyText(why)).toContain('with nothing running')
    expect(idle!.timeMs).toBe(90_000)
    const [slow] = find('slowCall')
    expect(slow).toMatchObject({ turn: 2, usd: null, model: 'Fable 5.1', outputTokens: 6_000 })
    expect(slow!.timeMs).toBeGreaterThanOrEqual(70_000)
  })

  it('estimates a large result only until the next compaction', () => {
    const [f] = find('carry')
    expect(f).toMatchObject({ turn: 3, source: 'tool', tool: 'Read', chars: 60_000, tokens: 15_000, calls: 2, estimate: true })
    const c = getModelCosts(FABLE)!
    expect(f!.writeUsd).toBeCloseTo(15_000 * c.cacheWriteCostPerToken * 1.6, 12)
    expect(f!.readUsd).toBeCloseTo(15_000 * c.cacheReadCostPerToken, 12)
  })

  it('estimates the starting context from the first call and the later calls that read at least that much', () => {
    const [f] = find('prefix')
    const c = getModelCosts(FABLE)!
    // Uncached input (2 tokens) is never re-read, so the threshold and re-read size are the cached 50,000.
    expect(f).toMatchObject({ tokens: 50_002, cached: 50_000, uncached: 30_000, laterCalls: why.calls - 1, estimate: true })
    const readers = why.turns.flatMap(t => t.steps).filter(s => s.kind === 'model' && s.tokens.cacheRead >= 50_000).length
    expect(f!.readCalls).toBe(readers)
    expect(f!.writeUsd).toBeCloseTo(30_000 * c.cacheWriteCostPerToken * 1.6, 12)
    expect(f!.readUsd).toBeCloseTo(readers * 50_000 * c.cacheReadCostPerToken, 12)
  })

  it('flags re-reading when cache reads dominate', () => {
    const share = why.parts.cacheRead / why.cost
    expect(find('reread')).toHaveLength(share >= 0.5 ? 1 : 0)
  })

  it('ranks by dollars, time-only last, and the text output names every finding', () => {
    const usd = why.findings.map(f => f.usd ?? -1)
    expect(usd.slice(0, why.findings.filter(f => f.usd !== null).length)).toEqual([...usd.filter(x => x >= 0)].sort((a, b) => b - a))
    const text = renderSessionWhyText(why)
    expect(text).toContain('ValueError: bad token')
    expect(text).toContain('If Haiku 4.5 can do these tasks')
  })
})

describe('session cost diagnosis: content', () => {
  it('redacts secrets in prompts and output', () => {
    expect(why.turns[0]!.prompt.text).not.toContain('sk-abcdefghijklmnop1234')
    expect(redact('export API_KEY=abc123def456ghi')).toBe('export API_KEY=••••')
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).not.toContain('eyJzdWIi')
    expect(redact('ghp_' + 'a'.repeat(36))).toBe('ghp_••••')
    // Fake values assembled at runtime so secret scanners don't flag the fixture.
    const fake = 'x'.repeat(24)
    expect(redact(`key sk_${'live'}_${fake} and rk_${'test'}_${fake}`)).toBe('key sk_live_•••• and rk_test_••••')
    expect(redact(`aws_secret_access_key = ${fake}/${fake}`)).toBe('aws_secret_access_key = ••••')
    expect(redact('git clone https://deploy:hunter2secret@github.com/acme/app.git')).toBe('git clone https://deploy:••••@github.com/acme/app.git')
    expect(redact('postgres://app:pa55w0rd@db.internal:5432/main')).toBe('postgres://app:••••@db.internal:5432/main')
  })

  it('keeps the edit diff and the command output for the steps', () => {
    const steps = why.turns[0]!.steps.filter(s => s.kind === 'tool')
    expect(steps.map(s => s.kind === 'tool' && s.name)).toEqual(['Bash', 'Edit', 'Bash'])
    const edit = steps[1]!
    expect(edit.kind === 'tool' && edit.detail?.diff).toContain('+    return None')
    const bash = steps[0]!
    expect(bash.kind === 'tool' && bash.detail?.output).toContain('ValueError: bad token')
  })

  it('errorCause skips trailing tallies and uses the last error line', () => {
    expect(errorCause('Exit code 2\nsrc/a.ts(1,2): error TS2339: nope\nFound 1 error.').cause).toBe('src/a.ts(1,2): error TS2339: nope')
    expect(errorCause('Exit code 1\nwarning: x\nfatal: not a git repository').exitCode).toBe(1)
  })
})

describe('session cost diagnosis: prompt boundaries, helpers waiting, dates, rounding', () => {
  const SID2 = '9a1d2c3b-0000-4e43-9d0e-2b1f7a6c9e11'
  let why2: SessionWhy

  beforeAll(async () => {
    const dir = join(home, '.claude', 'projects', '-work-other')
    await mkdir(join(dir, SID2, 'subagents'), { recursive: true })
    const m = transcript('2026-09-10T10:00:00.000Z')
    m.prompt('Run the build and review it.')
    m.wait(1000)
    m.call(FABLE, { out: 100, cr: 1_000, cw: 1_000 }, [{ id: 'f1', name: 'Bash', input: { command: 'npm run build' } }])
    m.result('f1', 'Exit code 1\nerror TS2339: nope', 2000, { isError: true })
    m.call(FABLE, { out: 100, cr: 2_000, cw: 100 }, [{ id: 'h1', name: 'Agent', input: { description: 'Review it' } }])
    m.result('h1', 'started', 1000, { tur: { agentId: 'y1' } })
    m.wait(90_000)
    m.note('Another Claude session sent a message: review done')
    m.call(FABLE, { out: 100, cr: 2_100, cw: 100 })
    m.wait(26 * 3_600_000)
    m.prompt('Try the build again tomorrow.')
    m.wait(1000)
    m.call(FABLE, { out: 100, cr: 2_200, cw: 100 }, [{ id: 'ok1', name: 'Bash', input: { command: 'npm run build' } }])
    m.result('ok1', 'built', 2000)
    m.call(FABLE, { out: 50, cr: 2_300, cw: 50 })
    await writeFile(join(dir, `${SID2}.jsonl`), m.lines.join('\n') + '\n')
    const h = transcript('2026-09-10T10:00:06.000Z')
    h.call(SONNET, { out: 500, cr: 1_000, cw: 500 })
    await writeFile(join(dir, SID2, 'subagents', 'agent-y1.jsonl'), h.lines.join('\n') + '\n')
    await writeFile(join(dir, SID2, 'subagents', 'agent-y1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Review it', toolUseId: 'h1' }))
    why2 = await buildSessionWhy(join(dir, `${SID2}.jsonl`))
  })

  it('does not count calls in a later prompt as recovery from a failure', () => {
    const f = why2.findings.find(x => x.kind === 'failed')
    expect(f).toMatchObject({ turn: 1, usd: null, share: null, afterCalls: null })
    expect(findingText(f!, why2).lines.join(' ')).not.toContain('After it')
  })

  it('calls a gap that ended with a helper reporting back waiting on helpers', () => {
    const f = why2.findings.find(x => x.kind === 'idle')
    expect(f).toMatchObject({ turn: 1, endedBy: 'helper' })
    expect(findingText(f!, why2).title).toContain('waiting on helpers')
  })

  it('prints local dates and the end date when the session spans days', () => {
    const local = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    const header = renderSessionWhyText(why2).split('\n')[1]!
    expect(header).toContain(local(why2.startedAt))
    expect(header).toContain(local(why2.endedAt))
  })

  it('shows a saving that is the difference of the shown figures', () => {
    const f = { id: 'x', kind: 'hotspot', turn: 1, usd: 1.006, share: 0.5, calls: 2, toolCalls: 0, models: ['Fable 5.1'], median: 0.4, parts: { input: 0, output: 1.006, cacheRead: 0, cacheWrite: 0, webSearch: 0 }, tokens: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, alt: { model: 'Opus 5.5', cost: 0.504 } } as WhyFinding
    expect(findingText(f, why2).lines.join(' ')).toContain('the same tokens cost $0.50 (−$0.51)')
  })
})
