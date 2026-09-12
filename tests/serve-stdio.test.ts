import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { classifyRootReuse, createOutputMemoEntry } from '../src/serve.js'

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
