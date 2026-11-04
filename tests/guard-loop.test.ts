import { afterAll, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { parseApiCall, parseJsonlLine } from '../src/parser.js'
import { readCache, writeAllow } from '../src/guard/usage.js'
import { runGuardHook } from '../src/guard/hooks.js'
import { writeGuardConfig, DEFAULT_GUARD_CONFIG, type GuardConfig } from '../src/guard/store.js'
import { setHome } from './setup/home.js'

const roots: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'codeburn-guard-loop-'))
  roots.push(d)
  return d
}
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

const SID = 'sess-loop'
let seq = 0

function useLine(id: string, name: string, input: Record<string, unknown>, outTok = 1_000): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-01T00:00:00.000Z',
    message: {
      model: 'claude-sonnet-4-20250514',
      id: `msg-${id}`,
      type: 'message',
      role: 'assistant',
      usage: { input_tokens: 1_000, output_tokens: outTok, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id, name, input }],
    },
  }) + '\n'
}

function resultLine(id: string, isError: boolean): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-07-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'exit 1' : 'ok', is_error: isError }] },
  }) + '\n'
}

async function setup(config: Partial<GuardConfig> = {}): Promise<{ base: string; path: string }> {
  const base = await tmp()
  const path = join(await tmp(), 'session.jsonl')
  await writeFile(path, '', 'utf-8')
  await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, ...config }, base)
  return { base, path }
}

// One tool call as Claude Code drives it: PreToolUse fires before the (lagging)
// transcript holds the call, then the call and its result land in the file.
async function call(
  env: { base: string; path: string },
  name: string,
  input: Record<string, unknown>,
  o: { fails?: boolean; outTok?: number } = {},
): Promise<string> {
  const id = `toolu_${++seq}`
  const out = await runGuardHook('pretooluse', JSON.stringify({
    session_id: SID, transcript_path: env.path, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id,
  }), { base: env.base })
  await appendFile(env.path, useLine(id, name, input, o.outTok) + resultLine(id, o.fails ?? false))
  return out
}

function warnJson(sentence: string): string {
  return JSON.stringify({
    systemMessage: sentence,
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `${sentence} Change approach or ask the user.` },
  })
}

function denyJson(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

describe('identical-call loop', () => {
  it('warns at 4 identical calls in a row and blocks at 8', async () => {
    const env = await setup()
    const outs: string[] = []
    for (let i = 0; i < 8; i++) outs.push(await call(env, 'Read', { file_path: '/repo/a.ts', limit: 50 }))
    expect(outs.slice(0, 3)).toEqual(['', '', ''])
    expect(outs[3]).toBe(warnJson('codeburn guard: Read was called 4 times in a row with the same input.'))
    expect(outs.slice(4, 7)).toEqual(['', '', ''])
    const cost = (await readCache(SID, env.base)).costUSD
    expect(outs[7]).toBe(denyJson(
      `Read was called 8 times in a row with the same input; this session is $${cost.toFixed(2)} (codeburn guard). Change approach or ask the user. Run 'codeburn guard allow' to lift this for the session, or raise loopStopAfter in guard.json.`,
    ))
  })

  it('counts the same when the transcript already holds the incoming call', async () => {
    const env = await setup()
    const outs: string[] = []
    for (let i = 0; i < 4; i++) {
      const id = `toolu_${++seq}`
      await appendFile(env.path, useLine(id, 'Grep', { pattern: 'x' }))
      outs.push(await runGuardHook('pretooluse', JSON.stringify({
        session_id: SID, transcript_path: env.path, tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: id,
      }), { base: env.base }))
    }
    expect(outs.slice(0, 3)).toEqual(['', '', ''])
    expect(outs[3]).toContain('Grep was called 4 times in a row')
  })

  it('treats key order as the same input and a different input as a break', async () => {
    const env = await setup()
    const outs: string[] = []
    for (let i = 0; i < 3; i++) outs.push(await call(env, 'Read', i % 2 ? { limit: 5, file_path: '/a' } : { file_path: '/a', limit: 5 }))
    outs.push(await call(env, 'Read', { file_path: '/b', limit: 5 }))
    for (let i = 0; i < 3; i++) outs.push(await call(env, 'Read', { file_path: '/a', limit: 5 }))
    expect(outs.every(o => o === '')).toBe(true)
    expect(await call(env, 'Read', { limit: 5, file_path: '/a' })).toContain('called 4 times in a row')
  })

  it('warns once per session', async () => {
    const env = await setup()
    const outs: string[] = []
    for (let i = 0; i < 5; i++) outs.push(await call(env, 'Read', { file_path: '/a' }))
    await call(env, 'Read', { file_path: '/other' })
    for (let i = 0; i < 5; i++) outs.push(await call(env, 'Read', { file_path: '/a' }))
    expect(outs.filter(o => o !== '')).toHaveLength(1)
    expect((await readCache(SID, env.base)).loopWarned).toBe(true)
  })
})

describe('failing-command retry', () => {
  it('warns after 3 failures and blocks after 5; successes reset nothing', async () => {
    const env = await setup()
    const test = { command: 'npm test -- --run tests/a-very-long-path/that-goes-on-and-on/and-on.test.ts', description: 'Run tests' }
    const outs: string[] = []
    let edit = 0
    const run = async (fails: boolean) => {
      outs.push(await call(env, 'Bash', test, { fails }))
      await call(env, 'Edit', { file_path: '/a.ts', old_string: String(edit), new_string: String(++edit) })
    }
    await run(true)
    await run(true)
    await run(false)
    await run(true)
    const shown = test.command.slice(0, 60)
    expect(outs).toEqual(['', '', '', ''])
    await run(true)
    expect(outs[4]).toBe(warnJson(`codeburn guard: the command "${shown}" already failed 3 times.`))
    await run(true)
    expect(outs[5]).toBe('')
    const out = await call(env, 'Bash', test)
    const cost = (await readCache(SID, env.base)).costUSD
    expect(out).toBe(denyJson(
      `The command "${shown}" already failed 5 times; this session is $${cost.toFixed(2)} (codeburn guard). Change approach or ask the user. Run 'codeburn guard allow' to lift this for the session, or raise retryStopAfter in guard.json.`,
    ))
  })

  it('only counts shell tools', async () => {
    const env = await setup({ loopWarnAfter: null, loopStopAfter: null })
    const outs: string[] = []
    for (let i = 0; i < 6; i++) outs.push(await call(env, 'WebFetch', { command: 'x' }, { fails: true }))
    expect(outs.every(o => o === '')).toBe(true)
    for (let i = 0; i < 4; i++) outs.push(await call(env, 'PowerShell', { command: 'Get-Thing' }, { fails: true }))
    expect(JSON.parse(outs[9]!).systemMessage).toContain('"Get-Thing" already failed 3 times')
  })
})

describe('guard allow', () => {
  it('lifts loop and retry stops for that session only', async () => {
    const env = await setup({ loopStopAfter: 3, retryStopAfter: 2 })
    for (let i = 0; i < 2; i++) await call(env, 'Bash', { command: 'gh run view 1 --exit-status' }, { fails: true })
    expect(await call(env, 'Bash', { command: 'gh run view 1 --exit-status' })).toContain('"permissionDecision":"deny"')
    await writeAllow(SID, env.base)
    for (let i = 0; i < 4; i++) expect(await call(env, 'Bash', { command: 'gh run view 1 --exit-status' }, { fails: true })).not.toContain('deny')

    const other = await setup({ loopStopAfter: 3 })
    const input = (id: string) => JSON.stringify({ session_id: 'sess-other', transcript_path: other.path, tool_name: 'Read', tool_input: { file_path: '/a' }, tool_use_id: id })
    await writeAllow(SID, other.base)
    const outs: string[] = []
    for (let i = 0; i < 3; i++) outs.push(await runGuardHook('pretooluse', input(`toolu_o${i}`), { base: other.base }))
    expect(outs[2]).toContain('"permissionDecision":"deny"')
  })
})

describe('loop and retry settings', () => {
  it('thresholds from guard.json override the defaults; null turns a signal off', async () => {
    const env = await setup({ loopWarnAfter: 2, loopStopAfter: 3 })
    expect(await call(env, 'Read', { file_path: '/a' })).toBe('')
    expect(await call(env, 'Read', { file_path: '/a' })).toContain('called 2 times in a row')
    expect(await call(env, 'Read', { file_path: '/a' })).toContain('"permissionDecision":"deny"')

    const off = await setup({ loopWarnAfter: null, loopStopAfter: null, retryWarnAfter: null, retryStopAfter: null })
    const outs: string[] = []
    for (let i = 0; i < 12; i++) outs.push(await call(off, 'Bash', { command: 'false' }, { fails: true }))
    expect(outs.every(o => o === '')).toBe(true)
  })

  it('guard status prints the loop and retry thresholds', async () => {
    const home = await tmp()
    setHome(home)
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, retryStopAfter: null })
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    try {
      const { registerGuardCommands } = await import('../src/guard/cli.js')
      const program = new Command()
      registerGuardCommands(program)
      await program.parseAsync(['node', 'codeburn', 'guard', 'status'])
    } finally {
      spy.mockRestore()
    }
    const out = lines.join('\n')
    expect(out).toContain('loop warn:  4 identical calls')
    expect(out).toContain('loop stop:  8 identical calls')
    expect(out).toContain('retry warn: 3 failures')
    expect(out).toContain('retry stop: off')
  })
})

describe('Stop nudge after a loop', () => {
  it('reports the calls and the dollars burned after the first warning, once', async () => {
    const env = await setup({ checkpointUSD: null })
    for (let i = 0; i < 3; i++) await call(env, 'Read', { file_path: '/a' })
    const before = seq + 1
    for (let i = 0; i < 3; i++) await call(env, 'Read', { file_path: '/a' }, { outTok: 50_000 })
    const burned = [before, before + 1, before + 2]
      .map(n => parseApiCall(parseJsonlLine(useLine(`toolu_${n}`, 'Read', { file_path: '/a' }, 50_000))!)!.costUSD)
      .reduce((a, b) => a + b, 0)
    const stop = JSON.stringify({ session_id: SID, transcript_path: env.path, hook_event_name: 'Stop' })
    const out = await runGuardHook('stop', stop, { base: env.base })
    expect(out).toBe(JSON.stringify({
      systemMessage: `codeburn guard: 6 identical tool calls in a row; the calls after the first warning cost $${burned.toFixed(2)}.`,
    }))
    expect(burned).toBeGreaterThan(1)
    expect(await runGuardHook('stop', stop, { base: env.base })).toBe('')
  })
})

describe('hook time', () => {
  it('stays fast on a 20 MB transcript once the tail is cached', async () => {
    const env = await setup()
    const pad = 'x'.repeat(1_800)
    const chunk: string[] = []
    let n = 0
    while (chunk.length * 2_200 < 20 * 1024 * 1024) {
      const id = `toolu_bulk_${n++}`
      chunk.push(useLine(id, 'Bash', { command: `echo ${n} ${pad}` }) + resultLine(id, n % 7 === 0))
    }
    await writeFile(env.path, chunk.join(''), 'utf-8')
    const cold = performance.now()
    await call(env, 'Read', { file_path: '/a' })
    const coldMs = performance.now() - cold
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      await call(env, 'Read', { file_path: '/a' })
      times.push(performance.now() - t)
    }
    const warmMs = times.sort((a, b) => a - b)[2]!
    console.log(`guard hook on 20 MB transcript: cold ${coldMs.toFixed(0)} ms, warm median ${warmMs.toFixed(1)} ms`)
    expect(warmMs).toBeLessThan(200)
  }, 60_000)
})
