import { afterAll, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { parseApiCall, parseJsonlLine } from '../src/parser.js'
import { emptyCache, readCache, writeAllow, writeCache } from '../src/guard/usage.js'
import { runGuardHook } from '../src/guard/hooks.js'
import { allowPath, sessionCachePath, writeGuardConfig, DEFAULT_GUARD_CONFIG, type GuardConfig } from '../src/guard/store.js'
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

function resultLine(id: string, isError: boolean, output?: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-07-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output ?? (isError ? 'exit 1' : 'ok'), is_error: isError }] },
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
  o: { fails?: boolean; outTok?: number; output?: string } = {},
): Promise<string> {
  const id = `toolu_${++seq}`
  const out = await runGuardHook('pretooluse', JSON.stringify({
    session_id: SID, transcript_path: env.path, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id,
  }), { base: env.base })
  await appendFile(env.path, useLine(id, name, input, o.outTok) + resultLine(id, o.fails ?? false, o.output))
  return out
}

function warnJson(sentence: string): string {
  return JSON.stringify({
    systemMessage: sentence,
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `${sentence} Change approach or ask the user.` },
  })
}

function denyJson(reason: string, userNote: string): string {
  return JSON.stringify({ systemMessage: userNote, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
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
      `Read was called 8 times in a row with the same input; this session is $${cost.toFixed(2)} (codeburn guard). Change approach or ask the user.`,
      `codeburn guard: stopped Read after 8 identical calls in a row. Run 'codeburn guard allow' to lift this for the session, or raise loopStopAfter in guard.json.`,
    ))
  })

  it('keeps denying after the stop, though each denied call gets the deny reason as its result', async () => {
    const env = await setup()
    const input = { file_path: '/repo/a.ts' }
    const outs: string[] = []
    for (let i = 0; i < 12; i++) {
      const id = `toolu_${++seq}`
      const out = await runGuardHook('pretooluse', JSON.stringify({
        session_id: SID, transcript_path: env.path, tool_name: 'Read', tool_input: input, tool_use_id: id,
      }), { base: env.base })
      const reason = out.includes('"deny"') ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string : undefined
      await appendFile(env.path, useLine(id, 'Read', input) + resultLine(id, reason !== undefined, reason ?? 'same contents'))
      outs.push(out)
    }
    expect(outs.slice(0, 7).filter(o => o.includes('"deny"'))).toHaveLength(0)
    for (const out of outs.slice(7)) expect(out).toContain('"permissionDecision":"deny"')
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

  it('never counts polling a background task as a loop', async () => {
    const env = await setup()
    for (const name of ['BashOutput', 'TaskOutput', 'Monitor']) {
      const outs: string[] = []
      for (let i = 0; i < 8; i++) outs.push(await call(env, name, { bash_id: 'bash_1' }))
      expect(outs.every(o => o === '')).toBe(true)
    }
    const edits: string[] = []
    for (let i = 0; i < 8; i++) edits.push(await call(env, 'Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }))
    expect(edits[7]).toContain('"permissionDecision":"deny"')
  })

  it('never counts a sleep followed by a read-only check as a loop', async () => {
    const env = await setup()
    const outs: string[] = []
    for (let i = 0; i < 8; i++) outs.push(await call(env, 'Bash', { command: 'sleep 30 && gh run view 123' }))
    for (let i = 0; i < 8; i++) outs.push(await call(env, 'Bash', { command: '  sleep 150; gh pr view 1895 --json state' }))
    for (let i = 0; i < 8; i++) outs.push(await call(env, 'Bash', { command: 'sleep 5; git status' }))
    for (let i = 0; i < 8; i++) outs.push(await call(env, 'Bash', { command: 'sleep 5' }))
    for (let i = 0; i < 12; i++) outs.push(await call(env, 'Bash', { command: 'sleep 150 && echo waiting' }, { output: 'waiting' }))
    expect(outs.every(o => o === '')).toBe(true)
  })

  it('still counts a sleep followed by an echo that writes a file', async () => {
    const env = await setup()
    const outs: string[] = []
    for (let i = 0; i < 8; i++) outs.push(await call(env, 'Bash', { command: 'sleep 1 && echo x > file' }))
    const multi: string[] = []
    for (let i = 0; i < 8; i++) multi.push(await call(env, 'Bash', { command: 'sleep 1 && echo x\nnpm test' }))
    expect(multi[7]).toContain('"permissionDecision":"deny"')
    expect(outs[3]).toContain('called 4 times in a row')
    expect(outs[7]).toContain('"permissionDecision":"deny"')
  })

  it('still counts a sleep followed by a command that does work', async () => {
    const env = await setup()
    const outs: string[] = []
    for (let i = 0; i < 8; i++) outs.push(await call(env, 'Bash', { command: 'sleep 0; npm test' }, { output: '3 passing' }))
    expect(outs.slice(0, 3)).toEqual(['', '', ''])
    expect(outs[3]).toBe(warnJson('codeburn guard: Bash was called 4 times in a row with the same input.'))
    expect(outs[7]).toContain('"permissionDecision":"deny"')
  })

  it('counts identical calls only while they keep getting the same result', async () => {
    const env = await setup()
    const changing: string[] = []
    for (let i = 0; i < 8; i++) changing.push(await call(env, 'Bash', { command: 'cat x' }, { output: `line ${i}` }))
    expect(changing.every(o => o === '')).toBe(true)

    const same: string[] = []
    for (let i = 0; i < 8; i++) same.push(await call(env, 'Bash', { command: 'ls' }, { output: 'a.ts b.ts' }))
    expect(same.slice(0, 3)).toEqual(['', '', ''])
    expect(same[3]).toBe(warnJson('codeburn guard: Bash was called 4 times in a row with the same input.'))
    expect(same[7]).toContain('"permissionDecision":"deny"')
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
  it('warns after 3 failures in a row and blocks after 5', async () => {
    const env = await setup({ loopWarnAfter: null, loopStopAfter: null })
    const test = { command: 'npm test -- --run tests/a-very-long-path/that-goes-on-and-on/and-on.test.ts', description: 'Run tests' }
    const outs: string[] = []
    for (let i = 0; i < 5; i++) outs.push(await call(env, 'Bash', test, { fails: true }))
    const shown = test.command.slice(0, 60)
    expect(outs.slice(0, 3)).toEqual(['', '', ''])
    expect(outs[3]).toBe(warnJson(`codeburn guard: the command "${shown}" already failed 3 times.`))
    expect(outs[4]).toBe('')
    const out = await call(env, 'Bash', test)
    const cost = (await readCache(SID, env.base)).costUSD
    expect(out).toBe(denyJson(
      `The command "${shown}" already failed 5 times; this session is $${cost.toFixed(2)} (codeburn guard). Change approach or ask the user.`,
      `codeburn guard: stopped "${shown}" after 5 failures in a row. Run 'codeburn guard allow' to lift this for the session, or raise retryStopAfter in guard.json.`,
    ))
  })

  it('an edit between runs resets the count, so a red-green loop is never stopped', async () => {
    const env = await setup()
    const test = { command: 'npm test', description: 'Run tests' }
    const outs: string[] = []
    for (let i = 0; i < 5; i++) {
      outs.push(await call(env, 'Bash', test, { fails: true }))
      await call(env, 'Edit', { file_path: '/a.ts', old_string: String(i), new_string: String(i + 1) })
    }
    outs.push(await call(env, 'Bash', test))
    expect(outs.every(o => o === '')).toBe(true)
  })

  it('only a successful edit resets the count', async () => {
    const run = async (editFails: boolean) => {
      const env = await setup({ loopWarnAfter: null, loopStopAfter: null })
      for (let i = 0; i < 2; i++) await call(env, 'Bash', { command: 'npm test' }, { fails: true })
      await call(env, 'Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }, { fails: editFails })
      for (let i = 0; i < 3; i++) await call(env, 'Bash', { command: 'npm test' }, { fails: true })
      return call(env, 'Bash', { command: 'npm test' })
    }
    expect(await run(true)).toContain('"permissionDecision":"deny"')
    expect(await run(false)).not.toContain('deny')
  })

  it('a passing run resets that command only', async () => {
    const env = await setup({ loopWarnAfter: null, loopStopAfter: null })
    for (let i = 0; i < 2; i++) await call(env, 'Bash', { command: 'npm test' }, { fails: true })
    for (let i = 0; i < 2; i++) await call(env, 'Bash', { command: 'npm run lint' }, { fails: true })
    await call(env, 'Bash', { command: 'npm test' })
    await call(env, 'Bash', { command: 'npm test' }, { fails: true })
    await call(env, 'Read', { file_path: '/a' })
    expect(Object.values((await readCache(SID, env.base)).failedCommands).sort()).toEqual([1, 2])
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

describe('guard allow without an id', () => {
  async function allowCli(): Promise<{ out: string; err: string; code: typeof process.exitCode }> {
    const out: string[] = []
    const err: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
    const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')) })
    try {
      const { registerGuardCommands } = await import('../src/guard/cli.js')
      const program = new Command()
      registerGuardCommands(program)
      await program.parseAsync(['node', 'codeburn', 'guard', 'allow'])
      return { out: out.join('\n'), err: err.join('\n'), code: process.exitCode }
    } finally {
      log.mockRestore()
      error.mockRestore()
      process.exitCode = undefined
    }
  }
  async function session(id: string, cwd: string, ageMs: number): Promise<void> {
    await writeCache({ ...emptyCache(id), cwd, costUSD: 12.5 })
    const at = new Date(Date.now() - ageMs)
    await utimes(sessionCachePath(id), at, at)
  }

  it('refuses when two sessions wrote their cache in the last few minutes', async () => {
    setHome(await tmp())
    await session('sess-a', '/repo/a', 30_000)
    await session('sess-b', '/repo/b', 10_000)
    const r = await allowCli()
    expect(r.code).toBe(1)
    expect(r.err).toContain('Pass the session id')
    expect(r.err).toContain('sess-a  /repo/a  $12.50')
    expect(r.err).toContain('sess-b  /repo/b  $12.50')
    await expect(stat(allowPath('sess-b'))).rejects.toThrow()
  })

  it('names the session it lifts when only one is recent', async () => {
    setHome(await tmp())
    await session('sess-old', '/repo/old', 60 * 60_000)
    await session('sess-new', '/repo/new', 10_000)
    const r = await allowCli()
    expect(r.code).toBeUndefined()
    expect(r.out).toContain('Session sess-new  /repo/new  $12.50')
    await stat(allowPath('sess-new'))
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

describe('Stop nudge after failed runs', () => {
  it('names the longest streak, even after an edit broke it', async () => {
    const env = await setup({ checkpointUSD: null, loopWarnAfter: null, loopStopAfter: null, retryStopAfter: null })
    for (let i = 0; i < 4; i++) await call(env, 'Bash', { command: 'npm test' }, { fails: true })
    await call(env, 'Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' })
    await call(env, 'Bash', { command: 'npm test' }, { fails: true })
    const stop = JSON.stringify({ session_id: SID, transcript_path: env.path, hook_event_name: 'Stop' })
    expect(JSON.parse(await runGuardHook('stop', stop, { base: env.base })).systemMessage)
      .toContain('codeburn guard: a longest streak of 4 failed runs of one command;')
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
