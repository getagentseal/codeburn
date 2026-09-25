import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { classifyRootReuse, createOutputMemoEntry, fileDaySpan, outputMemoKey, servedDayRange } from '../src/serve.js'
import { noonTz } from './fixtures/clock.js'

it('timestamps a completed output memo before parsing begins', () => {
  const parseStartedAt = 100
  const rootEventDuringParseAt = 150
  const parseCompletedAt = 200
  const memo = createOutputMemoEntry(parseStartedAt, parseCompletedAt, 'output', 'config')
  const rootsQuietSince = (sinceTs: number): boolean => rootEventDuringParseAt < sinceTs

  // The old completion timestamp incorrectly made the in-parse event look
  // older than the memo. The start timestamp keeps it visible to validation.
  expect(rootsQuietSince(parseCompletedAt)).toBe(true)
  expect(memo.createdAt).toBe(parseCompletedAt)
  expect(memo.validatedFrom).toBe(parseStartedAt)
  expect(rootsQuietSince(memo.validatedFrom)).toBe(false)
})

it('classifies watcher gaps as unknown without confusing them with dirty roots', () => {
  expect(classifyRootReuse(100, { startedAt: 50, lastEventAt: 0, healthy: false })).toBe('unknown')
  expect(classifyRootReuse(100, { startedAt: 150, lastEventAt: 0, healthy: true })).toBe('unknown')
  expect(classifyRootReuse(100, { startedAt: 50, lastEventAt: 100, healthy: false })).toBe('dirty')
  expect(classifyRootReuse(100, { startedAt: 50, lastEventAt: 100, healthy: true })).toBe('dirty')
  expect(classifyRootReuse(100, { startedAt: 50, lastEventAt: 99, healthy: true })).toBe('clean')
})

describe('day-scoped invalidation', () => {
  const day = (d: string): number => new Date(`${d}T12:00:00`).getTime()
  const startOfDay = (ms: number): number => {
    const x = new Date(ms)
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  }
  const spanOf = (from: string, to: string) => fileDaySpan({ birthtimeMs: day(from), mtimeMs: day(to) }, startOfDay)
  const august = { startMs: day('2026-08-20'), endMs: day('2026-08-20') + 3600_000 }
  const dirty = { startedAt: 50, lastEventAt: 100, healthy: true }

  it('covers every day between the creation of a file and its last write, plus a day of slack', () => {
    const span = spanOf('2026-09-15', '2026-09-16')
    expect(span.startMs).toBe(startOfDay(day('2026-09-14')))
    expect(span.endMs).toBe(startOfDay(day('2026-09-17')) - 1)
  })

  it('keeps a finalized past range clean when only files from today changed', () => {
    const state = { ...dirty, changedSince: () => ['/roots/today.jsonl'] }
    expect(classifyRootReuse(100, state, august, () => spanOf('2026-09-16', '2026-09-16'))).toBe('clean')
  })

  it('dirties a range a changed file could have written into', () => {
    const state = { ...dirty, changedSince: () => ['/roots/old.jsonl'] }
    // Born before the queried day and still being appended: its own days reach
    // into the range, so the range is not reusable.
    expect(classifyRootReuse(100, state, august, () => spanOf('2026-08-19', '2026-09-16'))).toBe('dirty')
  })

  it('refuses to scope an event it cannot place', () => {
    const unknownSpan = { ...dirty, changedSince: () => ['/roots/gone.jsonl'] }
    expect(classifyRootReuse(100, unknownSpan, august, () => null)).toBe('dirty')
    const unnamed = { ...dirty, changedSince: () => null }
    expect(classifyRootReuse(100, unnamed, august, () => spanOf('2026-09-16', '2026-09-16'))).toBe('dirty')
    // No range to scope against is the old, whole-corpus answer.
    expect(classifyRootReuse(100, { ...dirty, changedSince: () => [] })).toBe('dirty')
  })

  it('still reports unknown coverage rather than clean', () => {
    const state = { startedAt: 150, lastEventAt: 100, healthy: true, changedSince: () => ['/roots/today.jsonl'] }
    expect(classifyRootReuse(100, state, august, () => spanOf('2026-09-16', '2026-09-16'))).toBe('unknown')
  })
})

// End-to-end protocol test for `codeburn serve --stdio` (the desktop app's
// resident query server). Runs the real entry through tsx against the
// test-isolated env (env-isolation.ts points every provider at empty dirs),
// so requests answer fast and deterministically empty.
describe('codeburn serve --stdio', () => {
  let child: ChildProcess
  let buffer = ''
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>()
  const progressFrames = new Map<number, Array<Record<string, unknown>>>()
  let configPath = ''
  let readyResolve: () => void
  const ready = new Promise<void>(resolve => { readyResolve = resolve })

  function request(id: number, args: string[]): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      waiters.set(id, resolve)
      child.stdin!.write(JSON.stringify({ id, args }) + '\n')
    })
  }

  function sendRaw(line: string): void {
    child.stdin!.write(line + '\n')
  }

  beforeAll(async () => {
    const home = process.env['HOME']!
    configPath = join(home, '.config', 'codeburn', 'config.json')
    await mkdir(join(home, '.config', 'codeburn'), { recursive: true })
    // Give the resident process one real provider root to arm. With no
    // successfully armed roots, event-driven reuse correctly stays disabled.
    await mkdir(join(home, '.claude', 'projects'), { recursive: true })
    await writeFile(configPath, JSON.stringify({ currency: { code: 'USD' } }), 'utf8')

    // Keep the EUR half of the config-freshness regression fully offline.
    const cacheDir = join(home, '.cache', 'codeburn')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, 'exchange-rate.json'), JSON.stringify({
      timestamp: Date.now(),
      code: 'EUR',
      rate: 0.9,
    }), 'utf8')

    child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'cli.ts'), 'serve', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env },
    })
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) } catch { continue }
        if (msg['ready']) { readyResolve(); continue }
        if (typeof msg['progress'] === 'string' && !('ok' in msg)) {
          const id = msg['id'] as number
          const frames = progressFrames.get(id) ?? []
          frames.push(msg)
          progressFrames.set(id, frames)
          continue
        }
        const waiter = waiters.get(msg['id'] as number)
        if (waiter) { waiters.delete(msg['id'] as number); waiter(msg) }
      }
    })
    await ready
  }, 60_000)

  afterAll(() => {
    child?.kill('SIGKILL')
  })

  it('answers an allowed query with the command stdout', async () => {
    const res = await request(1, ['status', '--format', 'menubar-json', '--period', 'today'])
    expect(res['ok']).toBe(true)
    const payload = JSON.parse(res['output'] as string) as { current: { label: string } }
    expect(payload.current.label).toContain('Today')
  }, 60_000)

  it('isolates option state between requests (no sticky --period)', async () => {
    // The whole reason serve rebuilds the program per request: commander
    // option state is sticky, and a leaked --period would mislabel every
    // later panel.
    const month = await request(2, ['status', '--format', 'menubar-json', '--period', 'month'])
    const today = await request(3, ['status', '--format', 'menubar-json', '--period', 'today'])
    const monthLabel = (JSON.parse(month['output'] as string) as { current: { label: string } }).current.label
    const todayLabel = (JSON.parse(today['output'] as string) as { current: { label: string } }).current.label
    expect(monthLabel).not.toBe(todayLabel)
    expect(todayLabel).toContain('Today')
  }, 60_000)

  it('stamps every answer with the generation it was derived in', async () => {
    const first = await request(40, ['status', '--format', 'menubar-json', '--period', 'today'])
    const second = await request(41, ['status', '--format', 'menubar-json', '--period', 'week'])
    const firstGen = first['generation'] as { n: number; at: string }
    const secondGen = second['generation'] as { n: number; at: string }
    expect(firstGen.n).toBeGreaterThan(0)
    // A distinct derivation advances the counter, and says when it happened.
    expect(secondGen.n).toBeGreaterThan(firstGen.n)
    expect(Number.isNaN(Date.parse(secondGen.at))).toBe(false)
    expect(Date.parse(secondGen.at)).toBeGreaterThanOrEqual(Date.parse(firstGen.at))

    // A repeat of the first query is either re-derived (a new counter) or
    // served from the memo, in which case it carries the SAME stamp it was
    // derived under rather than the moment it was handed over.
    const repeat = await request(42, ['status', '--format', 'menubar-json', '--period', 'today'])
    const repeatGen = repeat['generation'] as { n: number; at: string }
    if (repeat['output'] === first['output']) {
      expect([firstGen.n, secondGen.n + 1]).toContain(repeatGen.n)
    }
    expect(repeatGen.n).toBeGreaterThan(0)
  }, 60_000)

  // The desktop app buckets these into its consent-gated app_close event: serve
  // is a plain CLI child, so Electron's own metrics cannot see this cost.
  it('reports its own CPU seconds and peak RSS on an answer', async () => {
    const res = await request(43, ['status', '--format', 'menubar-json', '--period', 'today'])
    const usage = res['usage'] as { cpuSec: number; rssMb: number }
    expect(usage.cpuSec).toBeGreaterThan(0)
    expect(usage.rssMb).toBeGreaterThan(0)
  }, 60_000)

  it('refuses commands outside the read allowlist', async () => {
    const res = await request(4, ['currency', 'EUR'])
    expect(res['ok']).toBe(false)
    expect(res['refused']).toBe(true)
  })

  it('refuses a smuggled positional on an allowed command', async () => {
    const res = await request(5, ['sessions', 'positional-arg'])
    expect(res['ok']).toBe(false)
    expect(res['refused']).toBe(true)
  })

  it('refuses every optimize apply-only option without touching shell config or the action journal', async () => {
    const home = process.env['HOME']!
    const zshrc = join(home, '.zshrc')
    const journal = join(home, '.config', 'codeburn', 'actions', 'journal.jsonl')
    await writeFile(zshrc, '# user-owned\n', 'utf8')

    // `optimize` is the only served command whose Commander definition also
    // has mutation-capable options. The full request below used to execute a
    // shell-config action inside the resident process.
    const applied = await request(300, [
      'optimize', '--apply', '--yes', '--only', 'bash-output-cap', '--period', 'today',
    ])
    expect(applied).toMatchObject({ ok: false, refused: true })

    // Keep the allowlist categorical: apply-only modifiers are not useful to
    // a read query and must not become resident options on their own either.
    for (const [id, args] of [
      [301, ['optimize', '--yes']],
      [302, ['optimize', '--dry-run']],
      [303, ['optimize', '--only', 'bash-output-cap']],
    ] as const) {
      expect(await request(id, [...args])).toMatchObject({ ok: false, refused: true })
    }

    expect(await readFile(zshrc, 'utf8')).toBe('# user-owned\n')
    await expect(readFile(journal, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('accepts the reviewed read-only option surface for every served command', async () => {
    const commands: Array<[number, string[]]> = [
      [310, ['status', '--format', 'json', '--period', 'today']],
      [311, ['overview', '--period', 'today', '--no-color']],
      [312, ['models', '--format', 'json', '--period', 'today', '--no-totals']],
      [313, ['sessions', '--format', 'json', '--period', 'today', '--no-pager']],
      [314, ['compare', '--format', 'json', '--period', 'today']],
      [315, ['yield', '--format', 'json', '--period', 'today']],
      [316, ['spend', '--format', 'flow-json', '--period', 'today']],
      [317, ['optimize', '--format', 'json', '--period', 'today']],
      [318, ['audit', '--format', 'json', '--period', 'today']],
      [319, ['report', '--format', 'json', '--period', 'today']],
    ]
    for (const [id, args] of commands) {
      expect(await request(id, args)).toMatchObject({ ok: true })
    }
  }, 60_000)

  // SERVE_OPTIONS mirrors the Commander definitions: a command that declares
  // --project/--exclude but is missing them here falls back to a cold spawn.
  it('routes --project/--exclude for every command that declares them', async () => {
    const commands: Array<[number, string[]]> = [
      [330, ['status', '--format', 'json', '--period', 'today', '--project', '/nope']],
      [331, ['overview', '--period', 'today', '--no-color', '--exclude', '/nope']],
      [332, ['models', '--format', 'json', '--period', 'today', '--project', '/nope']],
      [333, ['sessions', '--format', 'json', '--period', 'today', '--exclude', '/nope']],
      [334, ['compare', '--format', 'json', '--period', 'today', '--project', '/nope']],
      [335, ['yield', '--format', 'json', '--period', 'today', '--exclude', '/nope']],
      [336, ['spend', '--format', 'flow-json', '--period', 'today', '--project', '/nope']],
      [337, ['optimize', '--format', 'json', '--period', 'today', '--exclude', '/nope']],
      [338, ['audit', '--format', 'json', '--period', 'today', '--project', '/nope']],
      [339, ['report', '--format', 'json', '--period', 'today', '--exclude', '/nope']],
    ]
    for (const [id, args] of commands) {
      expect(await request(id, args)).toMatchObject({ ok: true })
    }
  }, 60_000)

  // #1451: --route/--billing are call-level slicers on models/sessions/audit,
  // the same shape as --project/--exclude, and must be servable the same way.
  it('routes --route/--billing for every command that declares them', async () => {
    const commands: Array<[number, string[]]> = [
      [350, ['models', '--format', 'json', '--period', 'today', '--route', 'bedrock']],
      [351, ['sessions', '--format', 'json', '--period', 'today', '--billing', 'metered']],
      [352, ['audit', '--format', 'json', '--period', 'today', '--route', 'direct', '--billing', 'subscription']],
    ]
    for (const [id, args] of commands) {
      expect(await request(id, args)).toMatchObject({ ok: true })
    }
  }, 60_000)

  // `report` is the interactive dashboard on every format but json, and a TUI
  // inside a child whose stdout is the wire would write frames nobody can read.
  // Only its JSON form is servable; the rest is refused and falls back to a
  // one-shot spawn, which is where an interactive dashboard belongs.
  it('serves the JSON report but refuses its interactive form', async () => {
    expect(await request(340, ['report', '--format', 'json', '--period', 'today'])).toMatchObject({ ok: true })
    expect(await request(341, ['report', '--period', 'today'])).toMatchObject({ ok: false, refused: true })
    expect(await request(342, ['report', '--format', 'tui', '--period', 'today'])).toMatchObject({ ok: false, refused: true })
    // --refresh only paces the dashboard, so it is not part of the served surface.
    expect(await request(343, ['report', '--format', 'json', '--period', 'today', '--refresh', '60'])).toMatchObject({ ok: false, refused: true })
  }, 60_000)

  it('survives a malformed request line and keeps serving', async () => {
    sendRaw('this is not json')
    const res = await request(6, ['status', '--format', 'menubar-json', '--period', 'today'])
    expect(res['ok']).toBe(true)
  }, 60_000)

  it('streams captured command stderr as protocol progress frames', async () => {
    const res = await request(7, ['status', '--provider', 'definitely-not-a-real-provider'])
    expect(res['ok']).toBe(false)

    const frames = progressFrames.get(7) ?? []
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => Object.keys(frame).sort().join(',') === 'id,progress')).toBe(true)
    expect(frames.map(frame => frame['progress']).join('')).toContain('unknown provider')
  }, 60_000)

  it('discovers a newly configured Claude root on identical resident argv', async () => {
    const home = process.env['HOME']!
    const rootA = join(home, 'claude-root-a')
    const rootB = join(home, 'claude-root-b')
    const slug = '-Users-test-shared-project'
    const cwd = '/Users/test/shared-project'

    const writeClaudeSession = async (root: string, sessionId: string, marker: string): Promise<void> => {
      const projectDir = join(root, 'projects', slug)
      await mkdir(projectDir, { recursive: true })
      const lines = [
        {
          type: 'summary', summary: marker, leafUuid: `leaf-${marker}`, sessionId, cwd,
          timestamp: '2026-08-12T10:00:00.000Z',
        },
        {
          type: 'user', uuid: `user-${marker}`, sessionId, cwd,
          timestamp: '2026-08-12T10:00:01.000Z', message: { role: 'user', content: marker },
        },
        {
          type: 'assistant', uuid: `assistant-${marker}`, parentUuid: `user-${marker}`, sessionId, cwd,
          timestamp: '2026-08-12T10:00:02.000Z',
          message: {
            id: `msg-${marker}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'reply' }], usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      ]
      await writeFile(join(projectDir, `${sessionId}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n'))
    }

    await writeClaudeSession(rootA, 'resident-session-a', 'a')
    await writeClaudeSession(rootB, 'resident-session-b', 'b')
    const args = ['sessions', '--period', 'lifetime', '--provider', 'claude', '--format', 'json', '--no-pager']

    await writeFile(configPath, JSON.stringify({ claudeConfigDirs: [rootA] }), 'utf8')
    const first = await request(200, args)
    expect(first['ok']).toBe(true)
    expect((JSON.parse(first['output'] as string) as Array<{ sessionId: string }>).map(row => row.sessionId)).toEqual([
      'resident-session-a',
    ])

    // Same command in the same process; only config.json adds root B.
    await writeFile(configPath, JSON.stringify({ claudeConfigDirs: [rootA, rootB] }), 'utf8')
    const second = await request(201, args)
    expect(second['ok']).toBe(true)
    expect((JSON.parse(second['output'] as string) as Array<{ sessionId: string }>).map(row => row.sessionId).sort()).toEqual([
      'resident-session-a',
      'resident-session-b',
    ])

    // Keep the following currency-freshness regression self-contained.
    await writeFile(configPath, JSON.stringify({ currency: { code: 'USD' } }), 'utf8')
  }, 60_000)

  it('invalidates identical-argv output memo immediately when config.json changes', async () => {
    const args = ['status', '--format', 'menubar-json', '--period', 'week', '--no-optimize', '--no-timeline']
    const usdConfig = JSON.stringify({ currency: { code: 'USD' } })
    await writeFile(configPath, usdConfig, 'utf8')

    let previous = await request(8, args)
    expect(previous['ok']).toBe(true)
    expect((JSON.parse(previous['output'] as string) as { currency: { code: string } }).currency.code).toBe('USD')

    // Prove this argv is actually hitting the output memo before testing its
    // invalidation. The root watchers arm asynchronously at serve startup, so
    // allow a few requests until two byte-identical generated payloads arrive.
    let memoized: Record<string, unknown> | null = null
    for (let id = 9; id < 110; id++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const next = await request(id, args)
      if (next['output'] === previous['output']) {
        memoized = next
        break
      }
      previous = next
    }
    expect(memoized).not.toBeNull()

    // A byte-identical rewrite changes filesystem metadata but not effective
    // configuration. The memo must survive it and return the exact generated
    // payload, including the original volatile `generated` timestamp.
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(configPath, usdConfig, 'utf8')
    const sameBytes = await request(110, args)
    expect(sameBytes['ok']).toBe(true)
    expect(sameBytes['output']).toBe(memoized!['output'])
    // `generated` is minted per render, so an unchanged stamp is the proof
    // that a memo hit returns the stored string instead of re-rendering.
    const stamp = (res: Record<string, unknown>): string =>
      (JSON.parse(res['output'] as string) as { generated: string }).generated
    expect(stamp(sameBytes)).toBe(stamp(memoized!))

    // Same byte length as USD: a size-only fingerprint would miss this.
    await writeFile(configPath, JSON.stringify({ currency: { code: 'EUR' } }), 'utf8')
    const fresh = await request(111, args)
    expect(fresh['ok']).toBe(true)
    expect((JSON.parse(fresh['output'] as string) as { currency: { code: string } }).currency.code).toBe('EUR')
    expect(fresh['output']).not.toBe(memoized!['output'])

    // Removing the configured currency is the USD reset contract. The serve
    // process must reset its module-level currency state as well as invalidate
    // the output memo, otherwise a long-lived child keeps rendering EUR.
    await writeFile(configPath, '{}', 'utf8')
    const reset = await request(112, args)
    expect(reset['ok']).toBe(true)
    expect((JSON.parse(reset['output'] as string) as {
      currency: { code: string; rate: number }
    }).currency).toMatchObject({ code: 'USD', rate: 1 })
  }, 60_000)

  it('exits on natural stdin EOF after arming a watcher for an existing Claude root', async () => {
    const claudeRoot = join(process.env['HOME']!, 'claude-eof-root')
    await mkdir(join(claudeRoot, 'projects'), { recursive: true })

    const eofChild = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'cli.ts'), 'serve', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeRoot },
    })
    let stdout = ''
    const becameReady = new Promise<void>((resolve, reject) => {
      eofChild.once('error', reject)
      eofChild.stdout!.setEncoding('utf8')
      eofChild.stdout!.on('data', (chunk: string) => {
        stdout += chunk
        if (stdout.split('\n').some(line => {
          try { return (JSON.parse(line) as { ready?: boolean }).ready === true } catch { return false }
        })) resolve()
      })
      eofChild.once('exit', (code, signal) => reject(new Error(`serve exited before ready: ${code ?? signal}`)))
    })
    const exited = new Promise<boolean>(resolve => eofChild.once('exit', () => resolve(true)))

    let naturalExit = false
    try {
      await becameReady
      // READY is intentionally emitted before provider probing; give the real
      // watcher setup time to finish so the regression exercises its handle.
      await new Promise(resolve => setTimeout(resolve, 500))
      eofChild.stdin!.end()
      naturalExit = await Promise.race([
        exited,
        new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000)),
      ])
    } finally {
      if (!naturalExit) {
        eofChild.kill('SIGKILL')
        await exited
      }
    }

    expect(naturalExit).toBe(true)
  }, 10_000)

  it('answers an in-flight request in full when stdin closes on the same tick', async () => {
    // The transport closing does not cancel work already accepted. Returning
    // before the queue drains loses the response frame outright, and because
    // runCaptured() monkeypatches process.exit into a thrown ExitSignal it also
    // turns the clean exit into a failure.
    const raceChild = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'cli.ts'), 'serve', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env },
    })
    let stdout = ''
    const lines = (): Array<Record<string, unknown>> => stdout.split('\n')
      .map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } })
      .filter((v): v is Record<string, unknown> => v !== null)

    const becameReady = new Promise<void>((resolve, reject) => {
      raceChild.once('error', reject)
      raceChild.stdout!.setEncoding('utf8')
      raceChild.stdout!.on('data', (chunk: string) => {
        stdout += chunk
        if (lines().some(msg => msg['ready'] === true)) resolve()
      })
      raceChild.once('exit', (code, signal) => reject(new Error(`serve exited before ready: ${code ?? signal}`)))
    })
    const exited = new Promise<number | null>(resolve => raceChild.once('exit', code => resolve(code)))

    await becameReady
    // Request and EOF in the same tick: the request is accepted, then the
    // transport is gone before it can possibly have finished.
    raceChild.stdin!.write(JSON.stringify({ id: 77, args: ['status', '--format', 'json'] }) + '\n')
    raceChild.stdin!.end()

    const code = await Promise.race([
      exited,
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 15_000)),
    ])
    if (code === 'hung') { raceChild.kill('SIGKILL'); await exited }

    expect(code).toBe(0)
    const answer = lines().find(msg => msg['id'] === 77)
    expect(answer).toBeDefined()
    expect(answer!['ok']).toBe(true)
    expect(typeof answer!['output']).toBe('string')
    expect(() => JSON.parse(answer!['output'] as string)).not.toThrow()
  }, 25_000)

  it('gives up on an async-wedged request at the drain bound instead of lingering', async () => {
    // The drain must not become the orphan it was added to prevent. A request
    // that never settles releases the child at the bound (shortened here from
    // its 45s default, which no legitimate request comes near).
    const drainMs = 1_500
    const wedgeChild = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures', 'serve-wedged-request.ts')], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CODEBURN_SERVE_DRAIN_MS: String(drainMs) },
    })
    let stdout = ''
    const becameReady = new Promise<void>((resolve, reject) => {
      wedgeChild.once('error', reject)
      wedgeChild.stdout!.setEncoding('utf8')
      wedgeChild.stdout!.on('data', (chunk: string) => {
        stdout += chunk
        if (stdout.includes('"ready"')) resolve()
      })
      wedgeChild.once('exit', () => reject(new Error('serve exited before ready')))
    })
    const exited = new Promise<number | null>(resolve => wedgeChild.once('exit', code => resolve(code)))

    await becameReady
    wedgeChild.stdin!.write(JSON.stringify({ id: 91, args: ['status', '--format', 'json'] }) + '\n')
    wedgeChild.stdin!.end()

    const began = Date.now()
    const outcome = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), drainMs + 12_000)),
    ])
    const elapsed = Date.now() - began
    if (outcome === 'hung') { wedgeChild.kill('SIGKILL'); await exited }

    expect(outcome).toBe('exited')
    // It waited for the request (not an instant return) but did not wait forever.
    expect(elapsed).toBeGreaterThanOrEqual(drainMs - 250)
  }, 30_000)
})

describe('output memo key', () => {
  const args = ['status', '--format', 'menubar-json', '--period', 'today', '--no-timeline']

  it('separates the same query asked on either side of local midnight', () => {
    const before = outputMemoKey(args, new Date(2026, 8, 16, 23, 59))
    const after = outputMemoKey(args, new Date(2026, 8, 17, 0, 1))
    expect(before).not.toBe(after)
  })

  it('is stable for the same query within a day', () => {
    expect(outputMemoKey(args, new Date(2026, 8, 16, 9, 0)))
      .toBe(outputMemoKey(args, new Date(2026, 8, 16, 17, 30)))
  })

  it('separates queries whose resolved day range differs', () => {
    const now = new Date(2026, 8, 16, 12, 0)
    const day = ['report', '--format', 'json', '--day', '2026-08-20']
    const otherDay = ['report', '--format', 'json', '--day', '2026-08-21']
    expect(outputMemoKey(day, now)).not.toBe(outputMemoKey(otherDay, now))
  })
})

describe('servedDayRange', () => {
  const day = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  it('reads an explicit day', () => {
    expect(servedDayRange(['report', '--format', 'json', '--day', '2026-08-20']))
      .toEqual({ from: '2026-08-20', to: '2026-08-20' })
  })

  it('reads an explicit from/to window', () => {
    expect(servedDayRange(['status', '--format', 'menubar-json', '--from', '2026-08-01', '--to', '2026-08-31']))
      .toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('resolves a named period against today', () => {
    const today = day(new Date())
    expect(servedDayRange(['status', '--format', 'menubar-json', '--period', 'today']))
      .toEqual({ from: today, to: today })
    const week = servedDayRange(['status', '--format', 'menubar-json', '--period', 'week'])
    expect(week?.to).toBe(today)
    expect(week!.from < today).toBe(true)
  })

  it('accepts the short period flag and the inline form', () => {
    expect(servedDayRange(['models', '--format', 'json', '-p', 'today']))
      .toEqual(servedDayRange(['models', '--format', 'json', '--period', 'today']))
    expect(servedDayRange(['models', '--format', 'json', '--period=today']))
      .toEqual(servedDayRange(['models', '--format', 'json', '--period', 'today']))
  })

  it('says nothing rather than guessing a default or a bad value', () => {
    // The command's own default period lives in main.ts; guessing it here would
    // stamp a range the answer may not have used.
    expect(servedDayRange(['status', '--format', 'menubar-json'])).toBeNull()
    expect(servedDayRange(['status', '--format', 'menubar-json', '--period', 'fortnight'])).toBeNull()
    expect(servedDayRange(['report', '--format', 'json', '--day', 'not-a-day'])).toBeNull()
  })
})

// Regression: the desktop polls `status --format menubar-json --no-optimize`,
// and `--no-optimize` used to route the resident child through the on-disk
// status snapshot. A poll landing inside that snapshot's settle window is
// answered with the deliberately deferred PRE-change payload, which serve then
// memoized; with the roots quiet again the memo stayed valid and replayed the
// stale payload until the next write or the 5-minute memo cap. Measured: the
// menubar stuck on the old cost for 40s+.
describe('codeburn serve --stdio never defers a menubar poll', () => {
  let child: ChildProcess
  let home = ''
  let sessionFile = ''
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>()
  let readyResolve: () => void
  const ready = new Promise<void>(resolve => { readyResolve = resolve })

  const calls = (res: Record<string, unknown>): number =>
    (JSON.parse(res['output'] as string) as { current: { calls: number } }).current.calls
  const cost = (res: Record<string, unknown>): number =>
    (JSON.parse(res['output'] as string) as { current: { cost: number } }).current.cost

  function request(id: number, args: string[]): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      waiters.set(id, resolve)
      child.stdin!.write(JSON.stringify({ id, args }) + '\n')
    })
  }

  // The corpus fixture is shaped like the ones in cli-status-menubar.test.ts:
  // two hours back, served from a zone where "today" has room for it.
  const base = new Date(Date.now() - 2 * 3600_000)
  const ts = (offset: number): string => new Date(base.getTime() + offset).toISOString().replace(/\.\d+Z$/, 'Z')
  const pricedCall = (n: number, offset: number): string => [
    JSON.stringify({ type: 'user', sessionId: 's1', timestamp: ts(offset), message: { role: 'user', content: 'go' } }),
    JSON.stringify({
      type: 'assistant', sessionId: 's1', timestamp: ts(offset + 60_000),
      message: {
        id: `msg-${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 500, output_tokens: 50 },
      },
    }),
  ].join('\n')

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'codeburn-serve-freshness-'))
    const projectDir = join(home, '.claude', 'projects', 'myapp')
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(home, '.config', 'codeburn'), { recursive: true })
    await writeFile(join(home, '.config', 'codeburn', 'config.json'), JSON.stringify({ currency: { code: 'USD' } }), 'utf8')
    sessionFile = join(projectDir, 'session.jsonl')
    await writeFile(sessionFile, pricedCall(1, 0) + '\n', 'utf8')

    child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'cli.ts'), 'serve', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
        // Force the snapshot settle window wide open. The real one is 2s, and
        // racing a 2s wall clock from a CI runner is how this test would rot;
        // a window this large makes "the deferral must not happen in serve"
        // deterministic instead of timing-dependent.
        CODEBURN_STATUS_SNAPSHOT_SETTLE_MS: '600000',
        TZ: noonTz(),
      },
    })
    let buffer = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) } catch { continue }
        if (msg['ready']) { readyResolve(); continue }
        if (typeof msg['progress'] === 'string' && !('ok' in msg)) continue
        const waiter = waiters.get(msg['id'] as number)
        if (waiter) { waiters.delete(msg['id'] as number); waiter(msg) }
      }
    })
    await ready
  }, 120_000)

  afterAll(async () => {
    child?.kill('SIGKILL')
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('reflects a single appended call on the poll after it, and keeps reflecting it', async () => {
    const args = ['status', '--format', 'menubar-json', '--period', 'today', '--no-timeline', '--no-optimize']

    const first = await request(500, args)
    expect(first['ok'], JSON.stringify(first)).toBe(true)
    expect(calls(first)).toBe(1)
    const firstCost = cost(first)

    // One append, then nothing else touches the corpus for the rest of the
    // test - exactly the protocol that pinned the menubar.
    await appendFile(sessionFile, pricedCall(2, 120_000) + '\n', 'utf8')
    // Let the root watcher observe the write before polling, so the poll below
    // is the one that has to decide between deferring and answering. Generous
    // rather than tight: nothing here races the settle window.
    await new Promise(resolve => setTimeout(resolve, 3000))

    // Inside the settle window: a one-shot CLI may debounce here, the resident
    // process must not - it has the parse state and cannot be re-asked.
    const inWindow = await request(501, args)
    expect(inWindow['ok'], JSON.stringify(inWindow)).toBe(true)
    expect(calls(inWindow)).toBe(2)
    expect(cost(inWindow)).toBeGreaterThan(firstCost)

    // The actual regression: with no further filesystem event the output memo
    // stays valid, so whatever the previous poll answered is replayed. A
    // deferred answer here is stale for the whole memo cap.
    const memoed = await request(502, args)
    expect(memoed['ok'], JSON.stringify(memoed)).toBe(true)
    expect(calls(memoed)).toBe(2)
    expect(cost(memoed)).toBeGreaterThan(firstCost)
  }, 120_000)
})
