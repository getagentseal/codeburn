import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

type RunningDashboard = {
  child: ChildProcess
  home: string
  hydrationLock: string
  readOutput: () => string
}

const running: RunningDashboard[] = []

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number, readOutput: () => string): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  elapsedMs: number
}> {
  const startedAt = performance.now()
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(
        `dashboard process ${child.pid ?? 'unknown'} did not exit within ${timeoutMs} ms; output:\n${readOutput().slice(-2_000)}`,
      ))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, elapsedMs: performance.now() - startedAt })
    })
  })
}

async function startHydratingDashboard(): Promise<RunningDashboard> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-dashboard-exit-'))
  const sessionsDir = join(home, '.claude', 'projects', 'fixture')
  const cacheDir = join(home, 'cache')
  await mkdir(sessionsDir, { recursive: true })

  // Keep the real background hydration in flight long enough to exercise the
  // public keystroke-to-process-exit seam without mocking cache ownership. How
  // long it stays in flight scales with the BYTES the index has to parse, while
  // the setup and teardown cost scales with the FILE COUNT - and 2000 creates
  // plus 2000 utimes on a cold temp dir, then 2000 unlinks, is what pushed this
  // past the 30s limit on Windows CI. Same 60 MB, a twentieth of the files.
  const body = '{}\n'.repeat(200_000)
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1_000)
  await Promise.all(Array.from({ length: 100 }, async (_, offset) => {
    const sessionPath = join(sessionsDir, `old-${offset}.jsonl`)
    await writeFile(sessionPath, body)
    await utimes(sessionPath, old, old)
  }))

  const bootstrap = `
    const define = (target, key, value) => Object.defineProperty(target, key, { configurable: true, value });
    define(process.stdin, 'isTTY', true);
    define(process.stdout, 'isTTY', true);
    define(process.stdout, 'columns', 120);
    define(process.stdout, 'rows', 50);
    if (typeof process.stdin.setRawMode !== 'function') define(process.stdin, 'setRawMode', enabled => {
      process.stderr.write('CODEBURN_RAW_MODE ' + String(enabled) + '\\n');
      return process.stdin;
    });
  `
  const ttyPreload = `data:text/javascript,${encodeURIComponent(bootstrap)}`
  const child = spawn(process.execPath, [
    '--import', 'tsx',
    '--import', ttyPreload,
    join(process.cwd(), 'src', 'cli.ts'),
    'report', '--period', 'today', '--refresh', '0',
  ], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: cacheDir,
      CODEBURN_DESKTOP_SESSIONS_DIR: join(home, 'desktop-sessions'),
      CODEBURN_PARSE_WORKERS: '0',
      CODEBURN_PRICING_SNAPSHOT_ONLY: '1',
      CODEBURN_FX_NO_FETCH: '1',
      CODEBURN_VERBOSE: '1',
      FORCE_COLOR: '0',
      TZ: 'UTC',
    },
  })

  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })

  const dashboard = { child, home, hydrationLock: join(cacheDir, 'hydrating.lock'), readOutput: () => output }
  running.push(dashboard)
  // The cold background index takes and releases the hydration lock once per
  // phase, and its opening phases cover windows these 200-day-old sessions fall
  // outside of, so the lock blinks for a few ms before the lifetime phase holds
  // it for seconds. Returning on a blink hands back a process that has already
  // let go, so require the lock to survive a settle.
  await waitFor(
    async () => {
      if (!output.includes('progressive startup on')) return false
      if (!await pathExists(dashboard.hydrationLock)) return false
      await new Promise(resolve => setTimeout(resolve, 150))
      return pathExists(dashboard.hydrationLock)
    },
    15_000,
    `dashboard never entered background hydration; output:\n${output.slice(-2_000)}`,
  )
  return dashboard
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async ({ child, home }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', () => resolve())
    })
    await rm(home, { recursive: true, force: true })
  }))
})

describe('interactive dashboard process exit during cold hydration', () => {
  function expectTerminalTeardown(output: string): void {
    expect(output).toContain('CODEBURN_RAW_MODE true')
    expect(output).toContain('CODEBURN_RAW_MODE false')
    expect(output).toContain('\x1b[?1006l\x1b[?1000l')
    expect(output).toContain('\x1b[?1049l')
    expect(output).toContain('\x1b[?25h')
  }

  it('removes the owned hydration lock when the confirmed q exit returns control', async () => {
    const { child, hydrationLock, readOutput } = await startHydratingDashboard()

    child.stdin?.write('q')
    await waitFor(
      () => readOutput().includes('Finishing background index'),
      1_000,
      `dashboard did not render quit confirmation; output:\n${readOutput().slice(-2_000)}`,
    )
    expect(await pathExists(hydrationLock)).toBe(true)
    child.stdin?.write('q')
    const exited = await waitForExit(child, 1_000, readOutput)

    expect(exited.elapsedMs).toBeLessThan(1_000)
    expect({ code: exited.code, signal: exited.signal }).toEqual({ code: 0, signal: null })
    expect(await pathExists(hydrationLock)).toBe(false)
    expectTerminalTeardown(readOutput())
  }, 30_000)

  it('removes the owned hydration lock and restores the terminal on raw Ctrl-C', async () => {
    const { child, hydrationLock, readOutput } = await startHydratingDashboard()

    child.stdin?.write('\x03')
    const exited = await waitForExit(child, 1_000, readOutput)

    expect(exited.elapsedMs).toBeLessThan(1_000)
    expect({ code: exited.code, signal: exited.signal }).toEqual({ code: 130, signal: null })
    expect(await pathExists(hydrationLock)).toBe(false)
    expectTerminalTeardown(readOutput())
  }, 30_000)
})
