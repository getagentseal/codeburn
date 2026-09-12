// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, isAbsolute, relative, win32, posix } from 'node:path'

import { spawnCli, spawnCliAction, spawnEnvFor, spawnSpecFor, startServe, killAll, shutdownAll, CliError, cmdShimArgs, escapeForCmd, nodeManagerDirs, notFoundStage, reapOrphanServe, resolveCodeburnPath, resolveTarget } from './cli'

let dir: string
const originalBin = process.env.CODEBURN_BIN
const originalPathDirs = process.env.CODEBURN_PATH_DIRS
const originalPathFile = process.env.CODEBURN_CLI_PATH_FILE
const originalViteUrl = process.env.VITE_DEV_SERVER_URL
const originalBundled = process.env.CODEBURN_BUNDLED_CLI
const originalDevRepoRoot = process.env.CODEBURN_DEV_REPO_ROOT

/**
 * Windows has no catchable SIGTERM: child.kill() is TerminateProcess, which ends the child
 * outright, so a grace window, a cleanup handler and a child that ignores the first signal
 * are all things the platform cannot do rather than things this code gets wrong. The same
 * goes for a resident that closes its own stdin. These stay exactly as they are and simply
 * do not run there.
 */
const posixOnly = it.skipIf(process.platform === 'win32')

/** Writes an executable node script and points CODEBURN_BIN at it. */
function fakeBin(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
  chmodSync(p, 0o755)
  process.env.CODEBURN_BIN = p
  return p
}

function readMaybe(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** A protocol-faithful fake CLI whose serve child accepts requests before its
 * delayed ready frame. Files expose process starts and heavy request executions
 * without relying on timing or private ServeClient internals. */
function fakeResidentBin(): {
  startsFile: string
  heavyFile: string
  oneShotsFile: string
  actionsFile: string
  serveEnvFile: string
} {
  const startsFile = join(dir, 'serve-starts')
  const heavyFile = join(dir, 'heavy-requests')
  const oneShotsFile = join(dir, 'one-shot-reads')
  const actionsFile = join(dir, 'actions')
  const serveEnvFile = join(dir, 'serve-progress-env')
  fakeBin(
    'resident.js',
    `const fs = require('node:fs'); const readline = require('node:readline');
     const command = process.argv[2];
     if (command === 'serve') {
       fs.appendFileSync(${JSON.stringify(startsFile)}, 's');
       const generation = fs.readFileSync(${JSON.stringify(startsFile)}, 'utf8').length;
       fs.writeFileSync(${JSON.stringify(serveEnvFile)}, process.env.CODEBURN_PROGRESS || '');
       const rl = readline.createInterface({ input: process.stdin });
       rl.on('line', line => {
         const request = JSON.parse(line);
         fs.appendFileSync(${JSON.stringify(heavyFile)}, 'h');
         const progress = 'CODEBURN_PROGRESS ' + JSON.stringify({ kind: 'provider', provider: 'claude', state: 'start', generation }) + '\\n';
         process.stdout.write(JSON.stringify({ id: request.id, progress }) + '\\n');
         process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve', generation, args: request.args }) }) + '\\n');
       });
       setTimeout(() => process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\\n'), 100);
     } else if (command === 'currency') {
       fs.appendFileSync(${JSON.stringify(actionsFile)}, 'a');
       process.stdout.write('currency updated');
     } else {
       fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
       process.stdout.write(JSON.stringify({ via: 'spawn', command }));
     }`,
  )
  return { startsFile, heavyFile, oneShotsFile, actionsFile, serveEnvFile }
}

/** Writes the repo CLI under this test's isolated dev-root override. */
function fakeDevRepoCli(): string {
  const repoRoot = join(dir, 'dev-repo')
  const p = join(repoRoot, 'dist', 'cli.js')
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '#!/usr/bin/env node\n', { mode: 0o755 })
  chmodSync(p, 0o755)
  process.env.CODEBURN_DEV_REPO_ROOT = repoRoot
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeburn-cli-'))
})

afterEach(() => {
  killAll()
  if (originalBin === undefined) delete process.env.CODEBURN_BIN
  else process.env.CODEBURN_BIN = originalBin
  if (originalPathDirs === undefined) delete process.env.CODEBURN_PATH_DIRS
  else process.env.CODEBURN_PATH_DIRS = originalPathDirs
  if (originalPathFile === undefined) delete process.env.CODEBURN_CLI_PATH_FILE
  else process.env.CODEBURN_CLI_PATH_FILE = originalPathFile
  if (originalViteUrl === undefined) delete process.env.VITE_DEV_SERVER_URL
  else process.env.VITE_DEV_SERVER_URL = originalViteUrl
  if (originalBundled === undefined) delete process.env.CODEBURN_BUNDLED_CLI
  else process.env.CODEBURN_BUNDLED_CLI = originalBundled
  if (originalDevRepoRoot === undefined) delete process.env.CODEBURN_DEV_REPO_ROOT
  else process.env.CODEBURN_DEV_REPO_ROOT = originalDevRepoRoot
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveCodeburnPath (Vite development)', () => {
  it('prefers the executable repo dist/cli.js when the Vite dev server is set', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    const devBin = fakeDevRepoCli()

    expect(resolveCodeburnPath()).toBe(devBin)
  })

  it('prefers the repo dev CLI over a persisted-path file (stale global) in dev', () => {
    // A persisted global (e.g. an older Homebrew codeburn) must NOT shadow the
    // repo build in dev, or newly-added commands break. Regression: 0.9.15
    // lacked `sessions`, so the persisted path produced a CLI error.
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    const persistedTarget = join(dir, 'stale-codeburn')
    writeFileSync(persistedTarget, '#!/usr/bin/env node\n', { mode: 0o755 })
    chmodSync(persistedTarget, 0o755)
    const persistedFile = join(dir, 'cli-path.v1')
    writeFileSync(persistedFile, persistedTarget)
    process.env.CODEBURN_CLI_PATH_FILE = persistedFile
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    const devBin = fakeDevRepoCli()

    const resolved = resolveCodeburnPath()
    expect(resolved).toBe(devBin)
    expect(resolved).not.toBe(persistedTarget)
  })

  it('does not return the repo dev CLI outside the Vite dev server', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    delete process.env.VITE_DEV_SERVER_URL

    expect(resolveCodeburnPath()).toBeNull()
  })
})

describe('resolveTarget (bundled CLI in the packaged app)', () => {
  /** An existing (not necessarily executable) file to stand in for the bundle. */
  function bundledEntry(name = 'cli.js'): string {
    const p = join(dir, name)
    writeFileSync(p, '// bundled cli\n')
    return p
  }

  it('resolves the bundled CLI, beating a persisted path and PATH', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    // A persisted global that should NOT win once a bundled CLI is present.
    const persistedTarget = join(dir, 'stale-global')
    writeFileSync(persistedTarget, '#!/usr/bin/env node\n', { mode: 0o755 })
    chmodSync(persistedTarget, 0o755)
    const persistedFile = join(dir, 'cli-path.v1')
    writeFileSync(persistedFile, persistedTarget)
    process.env.CODEBURN_CLI_PATH_FILE = persistedFile

    const entry = bundledEntry()
    process.env.CODEBURN_BUNDLED_CLI = entry

    expect(resolveTarget()).toEqual({ kind: 'bundled', entry })
    expect(resolveCodeburnPath()).toBe(entry)
  })

  it('CODEBURN_BIN still overrides the bundled CLI', () => {
    const override = fakeBin('override.js', 'process.stdout.write("{}")') // sets CODEBURN_BIN
    process.env.CODEBURN_BUNDLED_CLI = bundledEntry('bundled.js')
    delete process.env.VITE_DEV_SERVER_URL

    expect(resolveTarget()).toEqual({ kind: 'external', bin: override })
  })

  it('the dev repo CLI beats the bundled CLI in Vite development', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.CODEBURN_BUNDLED_CLI = bundledEntry('bundled.js')
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
    const devBin = fakeDevRepoCli()

    const target = resolveTarget()
    expect(target).toEqual({ kind: 'external', bin: devBin })
  })

  it('falls through when CODEBURN_BUNDLED_CLI points at a missing file', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = '' // force an empty PATH search space
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.CODEBURN_BUNDLED_CLI = join(dir, 'does-not-exist', 'cli.js')

    expect(resolveTarget()).toBeNull()
    expect(resolveCodeburnPath()).toBeNull()
  })

  // The Windows P0: the packaged app set CODEBURN_BUNDLED_CLI to a C:\ path, but
  // the guard was `startsWith('/')` (POSIX-only), so the bundled CLI was skipped
  // and resolution fell through to a PATH search that finds nothing → not-found
  // on 100% of Windows installs. The guard is now `path.isAbsolute`, which is
  // the platform variant (win32 on Windows). These tests pin both the intent
  // (relative paths are still rejected as a safety guard) and the Windows fix.
  it('resolves an absolute CODEBURN_BUNDLED_CLI (as the packaged app sets it)', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    const entry = bundledEntry('launch.js')
    expect(isAbsolute(entry)).toBe(true)
    process.env.CODEBURN_BUNDLED_CLI = entry
    expect(resolveTarget()).toEqual({ kind: 'bundled', entry })
  })

  it('rejects a relative CODEBURN_BUNDLED_CLI even when the file exists (guards relative injection)', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    const entry = bundledEntry('rel-launch.js')
    const rel = relative(process.cwd(), entry) // resolvable via cwd, but NOT absolute
    expect(isAbsolute(rel)).toBe(false)
    process.env.CODEBURN_BUNDLED_CLI = rel
    // File exists (isFile true), so only the isAbsolute guard can reject it.
    expect(resolveTarget()).toBeNull()
  })

  it('rejects a relative CODEBURN_BIN override even when the file exists', () => {
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    delete process.env.CODEBURN_BUNDLED_CLI
    const bin = join(dir, 'rel-codeburn.js')
    writeFileSync(bin, '#!/usr/bin/env node\n', { mode: 0o755 })
    chmodSync(bin, 0o755)
    const rel = relative(process.cwd(), bin)
    expect(isAbsolute(rel)).toBe(false)
    process.env.CODEBURN_BIN = rel
    expect(resolveTarget()).toBeNull()
  })
})

describe('absolute-path guard is cross-platform (path.isAbsolute, not startsWith("/"))', () => {
  // On the POSIX CI host `isAbsolute` is path.posix.isAbsolute, so these assert
  // the per-platform variants directly to encode the Windows intent regardless
  // of where the suite runs.
  const winPath = 'C:\\Users\\x\\resources\\cli\\dist\\launch.js'

  it('accepts a Windows absolute bundled path where the old startsWith("/") guard rejected it', () => {
    expect(winPath.startsWith('/')).toBe(false)          // old guard: dropped it → the P0
    expect(win32.isAbsolute(winPath)).toBe(true)          // new guard on Windows: accepted
    expect(win32.isAbsolute('cli\\dist\\launch.js')).toBe(false) // relative still rejected
  })

  it('accepts a POSIX absolute path and rejects a relative one (macOS/Linux unchanged)', () => {
    expect(posix.isAbsolute('/res/cli/dist/launch.js')).toBe(true)
    expect(posix.isAbsolute('cli/dist/launch.js')).toBe(false)
  })
})

describe('notFoundStage (non-sensitive telemetry enum for a not-found)', () => {
  it('reports bundled-not-absolute for a relative CODEBURN_BUNDLED_CLI', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_BUNDLED_CLI = 'cli/dist/launch.js'
    expect(notFoundStage()).toBe('bundled-not-absolute')
  })

  it('reports bundled-missing for an absolute CODEBURN_BUNDLED_CLI whose file is absent', () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_BUNDLED_CLI = join(dir, 'nope', 'cli.js')
    expect(notFoundStage()).toBe('bundled-missing')
  })

  it('reports bin-not-absolute for a relative CODEBURN_BIN override', () => {
    process.env.CODEBURN_BIN = 'relative/codeburn'
    delete process.env.CODEBURN_BUNDLED_CLI
    expect(notFoundStage()).toBe('bin-not-absolute')
  })

  it('reports no-path-match when nothing is configured', () => {
    delete process.env.CODEBURN_BIN
    delete process.env.CODEBURN_BUNDLED_CLI
    expect(notFoundStage()).toBe('no-path-match')
  })

  it('spawnCli rejects not-found carrying the resolution stage as detail', async () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    process.env.CODEBURN_BUNDLED_CLI = 'cli/dist/launch.js' // relative → bundled-not-absolute
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'not-found', detail: 'bundled-not-absolute' })
  })
})

describe('spawnSpecFor (bundled CLI runs via Electron-as-node)', () => {
  it('spawns process.execPath with the bundle as argv[0] and ELECTRON_RUN_AS_NODE set', () => {
    const spec = spawnSpecFor({ kind: 'bundled', entry: '/res/cli/dist/cli.js' }, ['status', '--period', 'today'])
    expect(spec.bin).toBe(process.execPath)
    expect(spec.args).toEqual(['/res/cli/dist/cli.js', 'status', '--period', 'today'])
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    // PATH is still augmented (the bundle's own dir leads), harmless for a CLI
    // that itself shells out during pairing/sync.
    expect((spec.env.PATH ?? '').split(delimiter)[0]).toBe('/res/cli/dist')
  })

  it('spawns an external CLI directly, with no run-as-node flag', () => {
    const spec = spawnSpecFor({ kind: 'external', bin: '/some/bin/codeburn' }, ['status'])
    expect(spec.bin).toBe('/some/bin/codeburn')
    expect(spec.args).toEqual(['status'])
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect((spec.env.PATH ?? '').split(delimiter)[0]).toBe('/some/bin')
  })

  // Windows cannot start a script. Both shapes a `codeburn` install takes there get a runner
  // that can; a POSIX `codeburn` is a shebang script with an exec bit and still runs directly.
  const windowsOnly = it.skipIf(process.platform !== 'win32')

  windowsOnly('runs a .js CLI through Node rather than failing with EFTYPE', () => {
    const spec = spawnSpecFor({ kind: 'external', bin: 'C:\\repo\\dist\\cli.js' }, ['status'])
    expect(spec.bin).toBe(process.execPath)
    expect(spec.args).toEqual(['C:\\repo\\dist\\cli.js', 'status'])
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  windowsOnly('runs a .cmd shim through cmd.exe, as one verbatim command line', () => {
    const spec = spawnSpecFor({ kind: 'external', bin: 'C:\\npm\\codeburn.cmd' }, ['status', '--period', 'today'])
    expect(spec.bin.toLowerCase()).toMatch(/\\system32\\cmd\.exe$/)
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(spec.verbatim).toBe(true)
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  windowsOnly('leaves an .exe alone', () => {
    const spec = spawnSpecFor({ kind: 'external', bin: 'C:\\tools\\codeburn.exe' }, ['status'])
    expect(spec.bin).toBe('C:\\tools\\codeburn.exe')
    expect(spec.args).toEqual(['status'])
    expect(spec.verbatim).toBeUndefined()
  })
})

// Two parsers read this string: cmd itself, then the runtime that splits a command line back
// into argv. Nothing a renderer can put in an argument may reach either as syntax.
describe('cmd.exe command line', () => {
  it('quotes every argument and neutralises the shell metacharacters', () => {
    // The quotes are for the runtime that splits the line back into argv; the `^` are for
    // cmd, which reads the line first and would otherwise act on what is inside them.
    expect(escapeForCmd('status', false)).toBe('^"status^"')
    expect(escapeForCmd('a&b', false)).toBe('^"a^&b^"')
    expect(escapeForCmd('a|b', false)).toBe('^"a^|b^"')
    expect(escapeForCmd('a>b<c', false)).toBe('^"a^>b^<c^"')
    // A `.cmd` re-expands its own arguments, so those get a second round of escaping.
    expect(escapeForCmd('a&b', true)).toBe('^^^"a^^^&b^^^"')
  })

  it('keeps an embedded quote from ending the argument', () => {
    expect(escapeForCmd('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"')
    // A trailing backslash run would otherwise escape the closing quote and swallow the
    // argument after it.
    expect(escapeForCmd('C:\\dir\\', false)).toBe('^"C:\\dir\\\\^"')
  })

  it('builds one /d /s /c line with the shim first', () => {
    const args = cmdShimArgs('C:\\npm\\codeburn.cmd', ['export', '-o', 'C:\\out dir'])
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(args[3]).toBe('"^"C:\\npm\\codeburn.cmd^" ^^^"export^^^" ^^^"-o^^^" ^^^"C:\\out^^^ dir^^^""')
  })

  it.skipIf(process.platform !== 'win32')('runs a real .cmd shim end to end with its arguments intact', async () => {
    // The shape a global npm install leaves on PATH: a batch file that re-expands %* into a
    // node invocation, which is the second parse the double escaping above exists for.
    const target = join(dir, 'echo-args.js')
    writeFileSync(target, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }))\n')
    const shim = join(dir, 'codeburn.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`)
    process.env.CODEBURN_BIN = shim

    await expect(spawnCli(['status', '--model', 'a & b'])).resolves.toEqual({
      args: ['status', '--model', 'a & b'],
    })
  })

  it('never lets an argument close the line and start a command', () => {
    const line = cmdShimArgs('C:\\npm\\codeburn.cmd', ['status" & calc.exe & "'])[3]!
    // Every quote the argument carried is escaped and so is every &, so neither parser can
    // read the tail as a second command.
    expect(line).not.toMatch(/(^|[^^])& calc/)
    expect(line).not.toMatch(/(^|[^^\\])" /)
    expect(line).toContain('^^^&')
  })

  it('spawnCli runs the bundled entry end-to-end as Node', async () => {
    delete process.env.CODEBURN_BIN
    delete process.env.VITE_DEV_SERVER_URL
    process.env.CODEBURN_PATH_DIRS = ''
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-persisted-path')
    // process.execPath is the Node running vitest here; a real packaged app uses
    // Electron's binary, but the spawn shape (execPath + entry + args + env) is
    // identical, so this exercises the whole bundled path.
    const entry = join(dir, 'bundled-cli.js')
    writeFileSync(
      entry,
      'process.stdout.write(JSON.stringify({ ranAsNode: process.env.ELECTRON_RUN_AS_NODE === "1", firstArg: process.argv[2] }))\n',
    )
    process.env.CODEBURN_BUNDLED_CLI = entry

    const result = (await spawnCli(['status'])) as { ranAsNode: boolean; firstArg: string }
    expect(result).toEqual({ ranAsNode: true, firstArg: 'status' })
  })
})

describe('spawnCli', () => {
  it('resolves parsed JSON on success', async () => {
    fakeBin('ok.js', 'process.stdout.write(JSON.stringify({ ok: 1 }))')
    await expect(spawnCli(['status'])).resolves.toEqual({ ok: 1 })
  })

  it('rejects with kind "nonzero" on a non-zero exit', async () => {
    fakeBin('fail.js', 'process.stderr.write("boom"); process.exit(2)')
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'nonzero' } satisfies Partial<CliError>)
  })

  it('rejects with kind "bad-json" on non-JSON stdout', async () => {
    fakeBin('garbage.js', 'process.stdout.write("not json at all")')
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'bad-json' })
  })

  it('rejects with kind "timeout" when the binary hangs', async () => {
    fakeBin('hang.js', 'setInterval(() => {}, 1000)')
    await expect(spawnCli(['status'], { timeoutMs: 300 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('rejects with kind "not-found" when no binary resolves', async () => {
    delete process.env.CODEBURN_BIN
    process.env.CODEBURN_PATH_DIRS = '' // force an empty search space
    process.env.CODEBURN_CLI_PATH_FILE = join(dir, 'no-such-persisted-path')
    try {
      await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'not-found' })
    } finally {
      delete process.env.CODEBURN_PATH_DIRS
      delete process.env.CODEBURN_CLI_PATH_FILE
    }
  })

  it('rejects with kind "too-large" and kills a binary that floods stdout', async () => {
    fakeBin('flood.js', "const s='x'.repeat(1024*1024); for(let i=0;i<20;i++) process.stdout.write(s); setInterval(()=>{},1000)")
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'too-large' } satisfies Partial<CliError>)
  })
})

describe('no-output watchdog (timeoutMs bounds SILENCE, not total runtime)', () => {
  /** First stderr write is immediate after Node boot: that only removes the extra
   *  setInterval delay. The spawn-time silence timer still includes Node boot;
   *  the larger smoke window absorbs startup. Further ticks keep the process
   *  alive past `timeoutMs`. Not a production timeout change. */
  function chattyBin(everyMs: number, extraTicks: number): void {
    fakeBin(
      'chatty.js',
      `let n = 1;
       process.stderr.write('CODEBURN_PROGRESS {"kind":"tick","provider":"claude","done":0,"total":${extraTicks + 1}}\\n');
       const t = setInterval(() => {
         process.stderr.write('CODEBURN_PROGRESS {"kind":"tick","provider":"claude","done":' + n + ',"total":${extraTicks + 1}}\\n');
         if (++n > ${extraTicks}) { clearInterval(t); process.stdout.write(JSON.stringify({ ok: 1, ticks: n })); }
       }, ${everyMs});`,
    )
  }

  // Production already restarts the idle window on every stdout/stderr byte;
  // this is not a product fix. The fixture used to wait one setInterval before
  // the first byte, so a 600ms smoke window raced Node boot (independent 614ms
  // fail). Immediate first stderr write removes only that delay — boot still
  // counts. Extra ticks run ~4s under a 2s silence window, so a fixed
  // total-runtime cap still fails this test. Not a production timeout change.
  it('never kills a child that keeps producing output past the window', async () => {
    chattyBin(400, 10)
    await expect(spawnCli(['optimize'], { timeoutMs: 2_000 })).resolves.toEqual({ ok: 1, ticks: 11 })
  })

  it('kills a child that goes silent, measured from its LAST byte', async () => {
    // One byte lands ~300ms in (plus node boot), well inside the 1s window, then
    // silence. A fixed cap kills at 1s; only a window measured from the LAST byte
    // waits past 1.3s. The gap is wide enough that node's boot cost cannot blur it.
    fakeBin(
      'talks-then-hangs.js',
      `setTimeout(() => process.stderr.write('CODEBURN_PROGRESS {"kind":"keepalive"}\\n'), 300);
       setInterval(() => {}, 1000);`,
    )
    const began = Date.now()
    await expect(spawnCli(['optimize'], { timeoutMs: 1_000 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - began).toBeGreaterThanOrEqual(1_250)
  })

  it('keeps progress heartbeats out of the surfaced error message', async () => {
    fakeBin(
      'progress-then-fails.js',
      `process.stderr.write('CODEBURN_PROGRESS {"kind":"tick","provider":"claude","done":1,"total":2}\\n');
       process.stderr.write('permission denied\\n');
       process.exit(2);`,
    )
    await expect(spawnCli(['status'])).rejects.toMatchObject({ kind: 'nonzero', message: 'permission denied' })
  })

  it('enables CODEBURN_PROGRESS on every read spawn so long parses heartbeat', async () => {
    fakeBin('env-echo.js', 'process.stdout.write(JSON.stringify({ progress: process.env.CODEBURN_PROGRESS }))')
    await expect(spawnCli(['act', 'report', '--json'])).resolves.toEqual({ progress: '1' })
  })
})

describe('graceful kill (SIGTERM, then SIGKILL after the grace)', () => {
  posixOnly('sends SIGTERM first and SIGKILLs a child that ignores it', async () => {
    const signalFile = join(dir, 'signals')
    const pidFile = join(dir, 'stubborn-pid')
    fakeBin(
      'ignores-sigterm.js',
      `const fs = require('node:fs');
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(signalFile)}, 'TERM'));
       process.stdout.write('ready');
       setInterval(() => {}, 1000);`,
    )

    await expect(spawnCli(['status'], { timeoutMs: 1_500 })).rejects.toMatchObject({ kind: 'timeout' })
    // SIGTERM arrives with the rejection; the child survives it and is SIGKILLed
    // only after KILL_GRACE_MS (5s).
    await waitFor(() => readMaybe(signalFile) === 'TERM')
    const pid = Number(readMaybe(pidFile))
    expect(Number.isInteger(pid)).toBe(true)
    expect(() => process.kill(pid, 0)).not.toThrow() // still alive inside the grace
    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    }, 12_000)
  }, 20_000)

  posixOnly('keeps a child inside the SIGTERM grace reapable, so quit cannot orphan it', async () => {
    // The grace timer dies with the app. A child that ignores SIGTERM must still
    // be in the reap set when quit sweeps, or it survives the app that spawned it.
    //
    // The child emits one byte the instant it is ready (pidfile written, handler
    // installed). Because the watchdog restarts on output, the window is measured
    // from READINESS rather than from spawn — so node's cold boot, however slow
    // the machine is, can never eat into it and make this flake.
    const pidFile = join(dir, 'grace-pid')
    fakeBin(
      'ignores-sigterm-quit.js',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       process.on('SIGTERM', () => {});
       process.stderr.write('CODEBURN_PROGRESS {"kind":"keepalive"}\\n');
       setInterval(() => {}, 1000);`,
    )

    await expect(spawnCli(['status'], { timeoutMs: 1_500 })).rejects.toMatchObject({ kind: 'timeout' })
    await waitFor(() => readMaybe(pidFile).length > 0)
    const pid = Number(readMaybe(pidFile))
    expect(() => process.kill(pid, 0)).not.toThrow() // alive, mid-grace

    shutdownAll() // the quit sweep, landing inside the 5s grace
    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    }, 3_000)
  })

  posixOnly('lets a SIGTERM-handling child exit on its own without waiting for SIGKILL', async () => {
    const cleanupFile = join(dir, 'cleanup')
    fakeBin(
      'handles-sigterm.js',
      `const fs = require('node:fs');
       process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(cleanupFile)}, 'released'); process.exit(0); });
       process.stdout.write('ready');
       setInterval(() => {}, 1000);`,
    )
    const began = Date.now()
    await expect(spawnCli(['status'], { timeoutMs: 1_500 })).rejects.toMatchObject({ kind: 'timeout' })
    await waitFor(() => readMaybe(cleanupFile) === 'released')
    expect(Date.now() - began).toBeLessThan(5_000) // never waited out the grace
  })
})

// These start real children and then wait for the OS to report them gone, which is the same
// reason the resident-serve block gets room: the assertions are about which process survives,
// never about how quickly a busy machine gets round to ending it.
describe('orphan serve reaping', { timeout: 30_000 }, () => {
  /** A long-lived stand-in for an orphaned `codeburn serve --stdio` child. */
  function orphanServe(): { pid: number; pidFile: string } {
    const bin = join(dir, 'codeburn')
    writeFileSync(bin, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o755 })
    chmodSync(bin, 0o755)
    const child = spawn(process.execPath, [bin, 'serve', '--stdio'], { stdio: 'ignore' })
    child.unref()
    const pidFile = join(dir, 'serve.pid')
    writeFileSync(pidFile, JSON.stringify({ pid: child.pid, cmd: [process.execPath, bin, 'serve', '--stdio'].join(' ') }))
    return { pid: child.pid!, pidFile }
  }

  it('startServe records the resident pid so a later launch can find it', async () => {
    fakeResidentBin()
    const pidFile = join(dir, 'recorded.pid')
    startServe(pidFile)
    await waitFor(() => readMaybe(pidFile).length > 0)
    const record = JSON.parse(readMaybe(pidFile)) as { pid: number; cmd: string }
    expect(record.pid).toBeGreaterThan(1)
    expect(record.cmd).toContain('serve --stdio')
  })

  it('kills a serve child orphaned by a previous run and clears the pidfile', async () => {
    const { pid, pidFile } = orphanServe()
    await waitFor(() => { try { process.kill(pid, 0); return true } catch { return false } })

    reapOrphanServe(pidFile)

    await waitFor(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
    expect(readMaybe(pidFile)).toBe('')
  })

  // A keyword sniff ("looks like a cli.js running serve") matches plenty of
  // unrelated tools. Identity is the exact argv we recorded, nothing looser.
  it.each([
    ['an unrelated tool', 'unrelated-tool', ['work']],
    ['a lookalike cli.js running serve', 'cli.js', ['serve', '--stdio']],
    ['a lookalike named codeburn', 'codeburn', ['serve', '--stdio']],
  ])('never signals a recycled pid belonging to %s', async (_label, name, args) => {
    const bin = join(dir, name)
    writeFileSync(bin, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o755 })
    chmodSync(bin, 0o755)
    const bystander = spawn(process.execPath, [bin, ...args], { stdio: 'ignore' })
    const pidFile = join(dir, `recycled-${name}.pid`)
    // The pid is right; the recorded command belongs to the serve child that
    // used to own it. Only an exact match may fire.
    writeFileSync(pidFile, JSON.stringify({ pid: bystander.pid, cmd: '/opt/codeburn/dist/cli.js serve --stdio' }))
    try {
      reapOrphanServe(pidFile)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(() => process.kill(bystander.pid!, 0)).not.toThrow()
    } finally {
      bystander.kill('SIGKILL')
    }
  })

  it('ignores a missing, unparseable, or incomplete pidfile', () => {
    expect(() => reapOrphanServe(join(dir, 'absent.pid'))).not.toThrow()
    const junk = join(dir, 'junk.pid')
    writeFileSync(junk, 'not-a-pid')
    expect(() => reapOrphanServe(junk)).not.toThrow()
    const noCmd = join(dir, 'no-cmd.pid')
    writeFileSync(noCmd, JSON.stringify({ pid: 999999 }))
    expect(() => reapOrphanServe(noCmd)).not.toThrow()
  })
})

describe('spawn PATH augmentation (GUI-launched apps have a minimal PATH)', () => {
  it("prepends the resolved binary's own directory so its env-shebang finds node", async () => {
    const bin = fakeBin('path-echo.js', 'process.stdout.write(JSON.stringify({ path: process.env.PATH }))')
    const result = await spawnCli(['status']) as { path: string }
    expect(result.path.split(delimiter)[0]).toBe(dirname(bin))
  })

  it('spawnEnvFor dedupes and keeps the original PATH entries', () => {
    const env = spawnEnvFor('/some/tool/bin/codeburn')
    const parts = (env.PATH ?? '').split(delimiter)
    expect(parts[0]).toBe('/some/tool/bin')
    expect(new Set(parts).size).toBe(parts.length)
    for (const original of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      expect(parts).toContain(original)
    }
  })
})

describe('spawnCli coalescing (read-only)', () => {
  it('shares one child between two concurrent identical calls', async () => {
    const countFile = join(dir, 'spawns')
    fakeBin('counter.js', `require('fs').appendFileSync(${JSON.stringify(countFile)},'x'); process.stdout.write(JSON.stringify({ok:1}))`)
    const [a, b] = await Promise.all([spawnCli(['status']), spawnCli(['status'])])
    expect(a).toEqual({ ok: 1 })
    expect(b).toEqual({ ok: 1 })
    expect(readFileSync(countFile, 'utf8')).toBe('x') // exactly one spawn
  })

  it('reflects an external config change on the next same-argv read', async () => {
    const configFile = join(dir, 'external-config')
    const countFile = join(dir, 'spawns')
    writeFileSync(configFile, 'before')
    fakeBin(
      'external-config.js',
      `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(countFile)}, 'x'); process.stdout.write(JSON.stringify({ value: fs.readFileSync(${JSON.stringify(configFile)}, 'utf8') }))`,
    )

    await expect(spawnCli(['model-alias', '--list'])).resolves.toEqual({ value: 'before' })
    writeFileSync(configFile, 'after')
    await expect(spawnCli(['model-alias', '--list'])).resolves.toEqual({ value: 'after' })
    expect(readFileSync(countFile, 'utf8')).toBe('xx')
  })

  it('never coalesces config-mutating action calls', async () => {
    const countFile = join(dir, 'spawns')
    fakeBin('action-counter.js', `require('fs').appendFileSync(${JSON.stringify(countFile)},'x'); process.stdout.write('done')`)
    await Promise.all([spawnCliAction(['currency', 'EUR']), spawnCliAction(['currency', 'EUR'])])
    expect(readFileSync(countFile, 'utf8')).toBe('xx') // two independent spawns
  })

  it('runs a fresh read after a config-mutating action', async () => {
    const countFile = join(dir, 'spawns')
    fakeBin('mixed.js', `require('fs').appendFileSync(${JSON.stringify(countFile)},'x'); process.stdout.write(JSON.stringify({ok:1}))`)
    await spawnCli(['model-alias', '--list'])
    await spawnCliAction(['model-alias', 'a', 'b'])
    await spawnCli(['model-alias', '--list'])
    expect(readFileSync(countFile, 'utf8')).toBe('xxx')
  })

  it('fences old in-flight reads across a mutation without deleting the new flight', async () => {
    const configFile = join(dir, 'generation-config')
    const startsFile = join(dir, 'generation-read-starts')
    const releaseDir = join(dir, 'generation-release')
    mkdirSync(releaseDir)
    writeFileSync(configFile, 'old')
    fakeBin(
      'generation-fence.js',
      `const fs = require('node:fs'); const path = require('node:path');
       if (process.argv[3] === '--list') {
         const value = fs.readFileSync(${JSON.stringify(configFile)}, 'utf8');
         fs.appendFileSync(${JSON.stringify(startsFile)}, 'r');
         const generation = fs.readFileSync(${JSON.stringify(startsFile)}, 'utf8').length;
         const release = path.join(${JSON.stringify(releaseDir)}, String(generation));
         const timer = setInterval(() => {
           if (!fs.existsSync(release)) return;
           clearInterval(timer);
           process.stdout.write(JSON.stringify({ value, generation }));
         }, 5);
       } else {
         fs.writeFileSync(${JSON.stringify(configFile)}, 'new');
         process.stdout.write('updated');
       }`,
    )

    const oldRead = spawnCli(['model-alias', '--list'])
    await waitFor(() => readMaybe(startsFile) === 'r')
    await expect(spawnCliAction(['model-alias', 'alias', 'model']))
      .resolves.toMatchObject({ ok: true })

    const newRead = spawnCli(['model-alias', '--list'])
    await waitFor(() => readMaybe(startsFile) === 'rr')
    writeFileSync(join(releaseDir, '1'), '')
    await expect(oldRead).resolves.toEqual({ value: 'old', generation: 1 })

    // Settling the superseded flight must not remove the current generation's
    // entry: this identical call still shares read #2 instead of spawning #3.
    const coalescedNewRead = spawnCli(['model-alias', '--list'])
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(readMaybe(startsFile)).toBe('rr')

    writeFileSync(join(releaseDir, '2'), '')
    await expect(Promise.all([newRead, coalescedNewRead])).resolves.toEqual([
      { value: 'new', generation: 2 },
      { value: 'new', generation: 2 },
    ])
  })
})

// Every test here starts several real node children, and the suite runs fifty files at once.
// The assertions are about which child answers, never about how quickly, so the wall clock
// gets room rather than the machine having to be fast enough for the default.
describe('resident serve single-flight', { timeout: 30_000 }, () => {
  it('startServe is idempotent and creates only one resident child', async () => {
    const files = fakeResidentBin()
    startServe()
    startServe()

    const result = await spawnCli(['status', '--double-start'], { timeoutMs: 5_000 }) as { generation: number }

    expect(result.generation).toBe(1)
    expect(readMaybe(files.startsFile)).toBe('s')
    expect(readMaybe(files.heavyFile)).toBe('h')
  })

  it('lazily starts a new resident after an unexpected death and one-shot fallback', async () => {
    const startsFile = join(dir, 'serve-starts')
    const oneShotsFile = join(dir, 'one-shot-reads')
    fakeBin(
      'dies-once-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       const command = process.argv[2];
       if (command === 'serve') {
         fs.appendFileSync(${JSON.stringify(startsFile)}, 's');
         const generation = fs.readFileSync(${JSON.stringify(startsFile)}, 'utf8').length;
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', line => {
           const request = JSON.parse(line);
           if (generation === 1) process.exit(1);
           process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve', generation }) }) + '\\n');
         });
       } else {
         fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
         process.stdout.write(JSON.stringify({ via: 'spawn' }));
       }`,
    )
    startServe()

    await expect(spawnCli(['status', '--first'], { timeoutMs: 5_000 }))
      .resolves.toEqual({ via: 'spawn' })
    await expect(spawnCli(['models', '--second'], { timeoutMs: 5_000 }))
      .resolves.toEqual({ via: 'serve', generation: 2 })

    expect(readMaybe(startsFile)).toBe('ss')
    expect(readMaybe(oneShotsFile)).toBe('o')
  })

  posixOnly('falls back instead of crashing when a live resident closes its stdin', async () => {
    const stdinClosedFile = join(dir, 'resident-stdin-closed')
    fakeBin(
      'closes-stdin-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', line => {
           const request = JSON.parse(line);
           process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve' }) }) + '\\n', () => {
             rl.close();
             fs.closeSync(0);
             fs.writeFileSync(${JSON.stringify(stdinClosedFile)}, 'closed');
           });
         });
         setInterval(() => {}, 1000);
       } else {
         process.stdout.write(JSON.stringify({ via: 'spawn' }));
       }`,
    )
    startServe()

    await expect(spawnCli(['status', '--warm'], { timeoutMs: 5_000 }))
      .resolves.toEqual({ via: 'serve' })
    await waitFor(() => readMaybe(stdinClosedFile) === 'closed')
    await expect(spawnCli(['models', '--after-stdin-close'], { timeoutMs: 5_000 }))
      .resolves.toEqual({ via: 'spawn' })
  })

  it('gives the first resident status request the power-user cold timeout floor', async () => {
    fakeBin(
      'slow-cold-resident.js',
      `const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         const rl = readline.createInterface({ input: process.stdin });
         rl.on('line', line => {
           const request = JSON.parse(line);
           setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve' }) }) + '\\n'), 80);
         });
       } else {
         process.stdout.write(JSON.stringify({ via: 'spawn' }));
       }`,
    )
    startServe()

    await expect(spawnCli(['status', '--cold-floor'], { timeoutMs: 20 }))
      .resolves.toEqual({ via: 'serve' })
  })

  it('starts a queued resident timeout only after the request ahead settles', async () => {
    fakeBin(
      'serial-resident.js',
      `const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         const rl = readline.createInterface({ input: process.stdin });
         (async () => {
           for await (const line of rl) {
             const request = JSON.parse(line);
             if (request.args.includes('--slow')) await new Promise(resolve => setTimeout(resolve, 400));
             process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve', args: request.args }) }) + '\\n');
           }
         })();
       } else {
         process.stdout.write(JSON.stringify({ via: 'spawn' }));
       }`,
    )
    startServe()
    await expect(spawnCli(['status', '--warm'], { timeoutMs: 5_000 }))
      .resolves.toMatchObject({ via: 'serve' })

    const slow = spawnCli(['sessions', '--slow'], { timeoutMs: 1_000 })
    const queued = spawnCli(['models', '--queued'], { timeoutMs: 200 })
    const [slowResult, queuedResult] = await Promise.all([slow, queued])

    expect(slowResult).toMatchObject({ via: 'serve' })
    expect(queuedResult).toMatchObject({ via: 'serve' })
  })

  it('uses the first real request as the only heavy execution, even before ready', async () => {
    const files = fakeResidentBin()
    startServe()

    const result = await spawnCli(['status', '--format', 'menubar-json'], {
      timeoutMs: 5_000,
      extraEnv: { CODEBURN_PROGRESS: '1' },
    }) as { via: string; generation: number }

    expect(result).toMatchObject({ via: 'serve', generation: 1 })
    expect(readMaybe(files.startsFile)).toBe('s')
    expect(readMaybe(files.heavyFile)).toBe('h')
    expect(readMaybe(files.oneShotsFile)).toBe('')
    expect(readMaybe(files.serveEnvFile)).toBe('1')
  })

  // The Projects pane's unfiltered list is the heaviest read in the app, and it
  // was the one panel query that could not ride the resident child: `report` was
  // in neither routing table, so every open paid a node boot plus a full
  // session-cache parse and held one of the two run slots while it did.
  it('routes the JSON report through the resident child instead of a cold spawn', async () => {
    const files = fakeResidentBin()
    startServe()

    const result = await spawnCli(['report', '--format', 'json', '--period', 'lifetime'], { timeoutMs: 5_000 }) as { via: string }

    expect(result).toMatchObject({ via: 'serve' })
    expect(readMaybe(files.oneShotsFile)).toBe('')
  })

  it('forwards serve progress frames through the read onStderr callback', async () => {
    fakeResidentBin()
    startServe()
    const chunks: string[] = []

    await spawnCli(['status'], {
      timeoutMs: 5_000,
      extraEnv: { CODEBURN_PROGRESS: '1' },
      onStderr: chunk => { chunks.push(chunk) },
    })

    expect(chunks.join('')).toBe('CODEBURN_PROGRESS {"kind":"provider","provider":"claude","state":"start","generation":1}\n')
  })

  it('resets the resident watchdog on every progress frame of a long request', async () => {
    // Same contract as a one-shot spawn: a warm serve request that keeps
    // streaming progress is never killed, however long the parse takes. The
    // first status request warms serve, so the second runs under the plain
    // (non-cold-floor) window and can only survive by resetting it.
    fakeBin(
      'streaming-resident.js',
      `const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         const rl = readline.createInterface({ input: process.stdin });
         rl.on('line', line => {
           const request = JSON.parse(line);
           if (!request.args.includes('--stream')) {
             process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve' }) }) + '\\n');
             return;
           }
           let n = 0;
           const t = setInterval(() => {
             process.stdout.write(JSON.stringify({ id: request.id, progress: 'CODEBURN_PROGRESS {"kind":"tick","provider":"claude","done":' + n + ',"total":15}\\n' }) + '\\n');
             if (++n >= 15) {
               clearInterval(t);
               process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve', ticks: n }) }) + '\\n');
             }
           }, 100);
         });
       } else {
         process.stdout.write(JSON.stringify({ via: 'spawn' }));
       }`,
    )
    startServe()

    await expect(spawnCli(['status', '--warm'], { timeoutMs: 5_000 })).resolves.toEqual({ via: 'serve' })
    // ~1.5s of streamed work under a 600ms silence window.
    await expect(spawnCli(['optimize', '--stream'], { timeoutMs: 600 }))
      .resolves.toEqual({ via: 'serve', ticks: 15 })
  })

  it('rejects and terminates a resident that emits an oversized valid JSON frame', async () => {
    const startsFile = join(dir, 'oversized-frame-starts')
    const oneShotsFile = join(dir, 'oversized-frame-one-shots')
    fakeBin(
      'oversized-frame-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         fs.appendFileSync(${JSON.stringify(startsFile)}, 's');
         const generation = fs.readFileSync(${JSON.stringify(startsFile)}, 'utf8').length;
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', line => {
           const request = JSON.parse(line);
           const output = generation === 1
             ? JSON.stringify({ value: 'x'.repeat(16 * 1024 * 1024 + 1024) })
             : JSON.stringify({ generation });
           process.stdout.write(JSON.stringify({ id: request.id, ok: true, output }) + '\\n');
         });
         setInterval(() => {}, 1000);
       } else {
         fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
         process.stdout.write('{}');
       }`,
    )
    startServe()

    await expect(spawnCli(['status', '--oversized-frame'], { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ kind: 'too-large' } satisfies Partial<CliError>)
    await expect(spawnCli(['status', '--after-oversized-frame'], { timeoutMs: 5_000 }))
      .resolves.toEqual({ generation: 2 })
    expect(readMaybe(startsFile)).toBe('ss')
    expect(readMaybe(oneShotsFile)).toBe('')
  })

  it('keeps serve enabled after more overflows than the resident death budget', async () => {
    const startsFile = join(dir, 'overflow-budget-starts')
    const oneShotsFile = join(dir, 'overflow-budget-one-shots')
    fakeBin(
      'always-oversized-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         fs.appendFileSync(${JSON.stringify(startsFile)}, 's');
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', line => {
           const request = JSON.parse(line);
           const output = JSON.stringify({ value: 'x'.repeat(16 * 1024 * 1024 + 1024) });
           process.stdout.write(JSON.stringify({ id: request.id, ok: true, output }) + '\\n');
         });
         setInterval(() => {}, 1000);
       } else {
         fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
         process.stdout.write('{}');
       }`,
    )
    startServe()

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(spawnCli(['status', '--overflow', String(attempt)], { timeoutMs: 5_000 }))
        .rejects.toMatchObject({ kind: 'too-large' } satisfies Partial<CliError>)
    }

    // An overflow kill is deliberate, so it never spends the unexpected-death
    // budget: the fourth request still reaches a resident, not a one-shot.
    expect(readMaybe(startsFile)).toBe('ssss')
    expect(readMaybe(oneShotsFile)).toBe('')
  })

  it('rejects and terminates a resident whose protocol line never terminates', async () => {
    const startsFile = join(dir, 'unterminated-line-starts')
    const oneShotsFile = join(dir, 'unterminated-line-one-shots')
    fakeBin(
      'unterminated-line-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         fs.appendFileSync(${JSON.stringify(startsFile)}, 's');
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', () => process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1024)));
         setInterval(() => {}, 1000);
       } else {
         fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
         process.stdout.write('{}');
       }`,
    )
    startServe()

    await expect(spawnCli(['status', '--unterminated-line'], { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ kind: 'too-large' } satisfies Partial<CliError>)
    expect(readMaybe(startsFile)).toBe('s')
    expect(readMaybe(oneShotsFile)).toBe('')
  })

  it('keeps requests with any non-progress env override on the one-shot path', async () => {
    const files = fakeResidentBin()
    startServe()

    const result = await spawnCli(['status'], {
      timeoutMs: 5_000,
      extraEnv: { CODEBURN_PROGRESS: '1', CODEBURN_TEST_MODE: 'isolated' },
    }) as { via: string }

    expect(result.via).toBe('spawn')
    expect(readMaybe(files.heavyFile)).toBe('')
    expect(readMaybe(files.oneShotsFile)).toBe('o')
  })

  it('treats empty and undefined-only env overrides as serve-compatible', async () => {
    const files = fakeResidentBin()
    startServe()

    const empty = await spawnCli(['status', '--empty-env'], {
      timeoutMs: 5_000,
      extraEnv: {},
    }) as { via: string }
    const undefinedOnly = await spawnCli(['models', '--undefined-env'], {
      timeoutMs: 5_000,
      extraEnv: { CODEBURN_PROGRESS: undefined },
    }) as { via: string }

    expect(empty.via).toBe('serve')
    expect(undefinedOnly.via).toBe('serve')
    expect(readMaybe(files.heavyFile)).toBe('hh')
    expect(readMaybe(files.oneShotsFile)).toBe('')
  })

  it('restarts the resident child after a successful config mutation', async () => {
    const files = fakeResidentBin()
    startServe()

    const before = await spawnCli(['status'], { timeoutMs: 5_000 }) as { generation: number }
    const action = await spawnCliAction(['currency', 'EUR'], { timeoutMs: 5_000 })
    const after = await spawnCli(['status'], { timeoutMs: 5_000 }) as { generation: number }

    expect(action).toMatchObject({ ok: true, stdout: 'currency updated', code: 0 })
    expect(before.generation).toBe(1)
    expect(after.generation).toBe(2)
    expect(readMaybe(files.startsFile)).toBe('ss')
    expect(readMaybe(files.heavyFile)).toBe('hh')
    expect(readMaybe(files.actionsFile)).toBe('a')
  })

  posixOnly('SIGTERMs the outgoing resident on a mutation restart instead of hard-killing it', async () => {
    // A settings mutation replaces a child that may hold the cache refresh lock.
    // Same hazard as a timeout, so it gets the same grace: only a catchable
    // signal lets the outgoing child unlink its own lock instead of leaving it
    // for the next parse's stale-pid takeover.
    const signalFile = join(dir, 'restart-signals')
    fakeBin(
      'sigterm-aware-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       const command = process.argv[2];
       if (command === 'serve') {
         process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(signalFile)}, 'TERM'); process.exit(0); });
         const rl = readline.createInterface({ input: process.stdin });
         rl.on('line', line => {
           const request = JSON.parse(line);
           process.stdout.write(JSON.stringify({ id: request.id, ok: true, output: JSON.stringify({ via: 'serve' }) }) + '\\n');
         });
       } else {
         process.stdout.write('currency updated');
       }`,
    )
    startServe()

    await expect(spawnCli(['status'], { timeoutMs: 5_000 })).resolves.toEqual({ via: 'serve' })
    await expect(spawnCliAction(['currency', 'EUR'], { timeoutMs: 5_000 })).resolves.toMatchObject({ ok: true })

    await waitFor(() => readMaybe(signalFile) === 'TERM')
  })

  it('preserves the unexpected-death budget across mutation restarts', async () => {
    const startsFile = join(dir, 'serve-starts')
    const oneShotsFile = join(dir, 'one-shot-reads')
    fakeBin(
      'crashing-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       const command = process.argv[2];
       if (command === 'serve') {
         fs.appendFileSync(${JSON.stringify(startsFile)}, 's');
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', () => process.exit(1));
       } else if (command === 'currency') {
         process.stdout.write('currency updated');
       } else {
         fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
         process.stdout.write(JSON.stringify({ via: 'spawn' }));
       }`,
    )
    startServe()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(spawnCli(['status', '--attempt', String(attempt)], { timeoutMs: 5_000 }))
        .resolves.toEqual({ via: 'spawn' })
      await expect(spawnCliAction(['currency', attempt % 2 === 0 ? 'EUR' : 'USD'], { timeoutMs: 5_000 }))
        .resolves.toMatchObject({ ok: true })
    }

    // A mutation may replace a healthy child, but it must not erase real crash
    // history and resurrect serve after the third unexpected death.
    expect(readMaybe(startsFile)).toBe('sss')
    await expect(spawnCli(['status', '--after-budget'], { timeoutMs: 5_000 }))
      .resolves.toEqual({ via: 'spawn' })
    expect(readMaybe(startsFile)).toBe('sss')
    expect(readMaybe(oneShotsFile)).toBe('oooo')
  })

  it('stops lazy crash recovery after three consecutive resident deaths', async () => {
    const startsFile = join(dir, 'serve-starts')
    const oneShotsFile = join(dir, 'one-shot-reads')
    fakeBin(
      'always-crashing-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         fs.appendFileSync(${JSON.stringify(startsFile)}, 's');
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', () => process.exit(1));
       } else {
         fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
         process.stdout.write(JSON.stringify({ via: 'spawn' }));
       }`,
    )
    startServe()

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(spawnCli(['status', '--lazy-crash', String(attempt)], { timeoutMs: 5_000 }))
        .resolves.toEqual({ via: 'spawn' })
    }

    expect(readMaybe(startsFile)).toBe('sss')
    expect(readMaybe(oneShotsFile)).toBe('oooo')
  })

  it('does not spawn a one-shot fallback after killAll destroys serve', async () => {
    const requestSeenFile = join(dir, 'request-seen')
    const oneShotsFile = join(dir, 'one-shot-reads')
    fakeBin(
      'shutdown-resident.js',
      `const fs = require('node:fs'); const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         const rl = readline.createInterface({ input: process.stdin });
         rl.once('line', () => { fs.writeFileSync(${JSON.stringify(requestSeenFile)}, '1'); });
       } else {
         fs.appendFileSync(${JSON.stringify(oneShotsFile)}, 'o');
         process.stdout.write('{}');
       }`,
    )
    startServe()
    const pending = spawnCli(['status', '--shutdown'], { timeoutMs: 60_000 })
    for (let attempt = 0; attempt < 400 && !readMaybe(requestSeenFile); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const requestSeen = readMaybe(requestSeenFile)
    killAll()

    expect(requestSeen).toBe('1')
    await expect(pending).rejects.toMatchObject({ kind: 'nonzero' })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(readMaybe(oneShotsFile)).toBe('')
  })

  it('gracefully releases the resident lock, then force-reaps its process tree', async () => {
    if (process.platform === 'win32') return
    const pidFile = join(dir, 'resident-shutdown-pid')
    const grandchildPidFile = join(dir, 'provider-child-pid')
    const termFile = join(dir, 'resident-shutdown-term')
    const grandchildTermFile = join(dir, 'provider-child-term')
    const hydrationLock = join(dir, 'hydrating.lock')
    const grandchildBody = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));
      process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(grandchildTermFile)}, 'TERM'));
      setInterval(() => {}, 1000);
    `
    fakeBin(
      'stubborn-resident-shutdown.js',
      `const fs = require('node:fs'); const readline = require('node:readline'); const { spawn } = require('node:child_process');
       if (process.argv[2] === 'serve') {
         fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
         fs.writeFileSync(${JSON.stringify(hydrationLock)}, 'owned');
         spawn(process.execPath, ['-e', ${JSON.stringify(grandchildBody)}], { stdio: 'ignore' });
         process.on('SIGTERM', () => {
           fs.writeFileSync(${JSON.stringify(termFile)}, 'TERM');
           try { fs.unlinkSync(${JSON.stringify(hydrationLock)}); } catch {}
           setTimeout(() => process.exit(0), 50);
         });
         readline.createInterface({ input: process.stdin });
         setInterval(() => {}, 1000);
       } else { process.stdout.write('{}'); }`,
    )
    startServe()
    await waitFor(() => readMaybe(pidFile).length > 0 && readMaybe(grandchildPidFile).length > 0)
    const pids = [Number(readMaybe(pidFile)), Number(readMaybe(grandchildPidFile))]

    try {
      const startedAt = performance.now()
      await shutdownAll()
      const elapsedMs = performance.now() - startedAt

      expect(elapsedMs).toBeLessThan(1_500)
      expect(readMaybe(termFile)).toBe('TERM')
      expect(readMaybe(grandchildTermFile)).toBe('TERM')
      expect(readMaybe(hydrationLock)).toBe('')
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  })

  it('keeps the warm resident child after a successful export', async () => {
    const files = fakeResidentBin()
    startServe()

    const before = await spawnCli(['status'], { timeoutMs: 5_000 }) as { generation: number }
    const action = await spawnCliAction(['export', '-f', 'json', '-o', join(dir, 'usage.json')], { timeoutMs: 5_000 })
    // A different panel query proves which resident generation handled the
    // next served read without relying on same-request coalescing.
    const after = await spawnCli(['models', '--format', 'json'], { timeoutMs: 5_000 }) as { generation: number }

    expect(action.ok).toBe(true)
    expect(before.generation).toBe(1)
    expect(after.generation).toBe(1)
    expect(readMaybe(files.startsFile)).toBe('s')
    expect(readMaybe(files.heavyFile)).toBe('hh')
  })
})

describe('killAll', () => {
  it('reaps an in-flight child so its promise settles', async () => {
    fakeBin('hang-kill.js', 'setInterval(() => {}, 1000)')
    const pending = spawnCli(['status'], { timeoutMs: 60_000 })
    // Let the child spawn before reaping.
    await new Promise(resolve => setTimeout(resolve, 50))
    killAll()
    await expect(pending).rejects.toMatchObject({ kind: 'nonzero' })
  })

  it('terminal shutdown rejects new read and action races without spawning', async () => {
    const startsFile = join(dir, 'starts')
    fakeBin(
      'shutdown-guard.js',
      `require('node:fs').appendFileSync(${JSON.stringify(startsFile)}, 'x'); process.stdout.write('{}')`,
    )

    shutdownAll()
    startServe()

    await expect(spawnCli(['status', '--after-shutdown']))
      .rejects.toMatchObject({ kind: 'nonzero' })
    await expect(spawnCliAction(['currency', 'EUR']))
      .resolves.toMatchObject({ ok: false, code: null })
    expect(readMaybe(startsFile)).toBe('')
  })

  it('terminal shutdown cancels read and action slots admitted before their spawn microtask', async () => {
    const startsFile = join(dir, 'starts-after-admission')
    fakeBin(
      'shutdown-after-admission.js',
      `require('node:fs').appendFileSync(${JSON.stringify(startsFile)}, process.argv[2] + '\\n'); if (process.argv[2] === 'status') process.stdout.write('{}'); else process.stdout.write('updated')`,
    )

    // Both calls synchronously acquire the two free scheduler slots. Their
    // actual spawn resumes in a microtask, which is exactly the before-quit race.
    const read = spawnCli(['status', '--admitted'])
    const action = spawnCliAction(['currency', 'EUR'])
    shutdownAll()

    await Promise.all([
      expect(read).rejects.toMatchObject({ kind: 'nonzero' }),
      expect(action).resolves.toMatchObject({ ok: false, code: null }),
    ])
    expect(readMaybe(startsFile)).toBe('')
  })
})

describe('spawnCli concurrency scheduler', () => {
  // A fake CLI that records each spawn (by subcommand) and then blocks until a
  // release file named after that subcommand appears, so the test controls
  // exactly when each child exits and can observe how many run at once.
  function schedulerBin(startedFile: string, releaseDir: string): void {
    fakeBin(
      'sched.js',
      `const fs = require('fs'); const path = require('path');
       const cmd = process.argv[2];
       fs.appendFileSync(${JSON.stringify(startedFile)}, cmd + '\\n');
       const rel = path.join(${JSON.stringify(releaseDir)}, cmd);
       const t = setInterval(() => {
         if (fs.existsSync(rel)) { clearInterval(t); process.stdout.write('{}'); process.exit(0); }
       }, 5);`,
    )
  }
  function startedList(startedFile: string): string[] {
    try { return readFileSync(startedFile, 'utf8').split('\n').filter(Boolean) } catch { return [] }
  }
  function release(releaseDir: string, cmd: string): void { writeFileSync(join(releaseDir, cmd), '') }
  async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('waitUntil timed out')
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

  // Reset scheduler state so a leaked running slot can never starve the next test.
  afterEach(() => { killAll() })

  it('runs at most two children at once; a third waits for a freed slot', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    const p1 = spawnCli(['status'])
    const p2 = spawnCli(['models'])
    const p3 = spawnCli(['sessions'])
    await waitUntil(() => startedList(startedFile).length === 2)
    await delay(100) // the cap must keep the third from sneaking in
    expect(startedList(startedFile).sort()).toEqual(['models', 'status'])

    release(releaseDir, 'status') // free one slot
    await waitUntil(() => startedList(startedFile).includes('sessions'))

    release(releaseDir, 'models'); release(releaseDir, 'sessions')
    await Promise.all([p1, p2, p3])
  })

  it('lets a later interactive spawn preempt an earlier queued background one', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    // Fill both slots so the next two calls must queue.
    const p1 = spawnCli(['fill1'], { priority: 'background' })
    const p2 = spawnCli(['fill2'], { priority: 'background' })
    await waitUntil(() => startedList(startedFile).length === 2)

    // Queue a background first, then an interactive.
    const pbg = spawnCli(['bg'], { priority: 'background' })
    const pint = spawnCli(['inter'], { priority: 'interactive' })
    await delay(50)
    expect(startedList(startedFile)).not.toContain('bg')
    expect(startedList(startedFile)).not.toContain('inter')

    // Free exactly one slot: the interactive must take it despite queueing later.
    release(releaseDir, 'fill1')
    await waitUntil(() => startedList(startedFile).length === 3)
    expect(startedList(startedFile)).toContain('inter')
    expect(startedList(startedFile)).not.toContain('bg')

    release(releaseDir, 'fill2'); release(releaseDir, 'inter'); release(releaseDir, 'bg')
    await Promise.all([p1, p2, pbg, pint])
  })

  it('does not spend a slot on a coalesced (same-argv) call', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    const p1 = spawnCli(['status'])
    const p2 = spawnCli(['models'])
    await waitUntil(() => startedList(startedFile).length === 2)

    const p1b = spawnCli(['status'])   // coalesces onto p1's child — no new slot
    const p3 = spawnCli(['sessions'])  // genuinely new — queued behind the cap
    await delay(100)
    expect(startedList(startedFile).length).toBe(2) // still just the two originals

    release(releaseDir, 'status') // frees the slot the coalesced pair shared
    await waitUntil(() => startedList(startedFile).includes('sessions'))

    release(releaseDir, 'models'); release(releaseDir, 'sessions')
    const [a, b] = await Promise.all([p1, p1b])
    expect(a).toEqual(b) // one child served both callers
    await Promise.all([p2, p3])
  })

  it('cancels a queued spawn on killAll instead of letting it spawn later', async () => {
    const startedFile = join(dir, 'started')
    const releaseDir = join(dir, 'release'); mkdirSync(releaseDir)
    schedulerBin(startedFile, releaseDir)

    const p1 = spawnCli(['status'])
    const p2 = spawnCli(['models'])
    await waitUntil(() => startedList(startedFile).length === 2)
    const p3 = spawnCli(['sessions']) // queued behind the cap, no child yet
    await delay(50)
    expect(startedList(startedFile)).not.toContain('sessions')

    killAll() // reaps the two running AND cancels the queued third
    // Attach all three rejection handlers synchronously: the queued spawn rejects
    // at once, so it must not sit unhandled while the killed children settle.
    await Promise.all([
      expect(p1).rejects.toMatchObject({ kind: 'nonzero' }),
      expect(p2).rejects.toMatchObject({ kind: 'nonzero' }),
      expect(p3).rejects.toMatchObject({ kind: 'nonzero' }),
    ])

    await delay(50)
    expect(startedList(startedFile)).not.toContain('sessions') // never spawned
  })

  it('limits six simultaneous resident-failure fallbacks to two one-shot children', async () => {
    const startedFile = join(dir, 'fallback-started')
    const activeDir = join(dir, 'fallback-active'); mkdirSync(activeDir)
    const activeCountsFile = join(dir, 'fallback-active-counts')
    const releaseDir = join(dir, 'fallback-release'); mkdirSync(releaseDir)
    fakeBin(
      'failing-resident-with-blocked-fallbacks.js',
      `const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
       if (process.argv[2] === 'serve') {
         const rl = readline.createInterface({ input: process.stdin });
         rl.on('line', line => {
           const request = JSON.parse(line);
           process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: 'resident failed' }) + '\\n');
         });
       } else {
         const id = process.argv[3];
         fs.appendFileSync(${JSON.stringify(startedFile)}, id + '\\n');
         const activeFile = path.join(${JSON.stringify(activeDir)}, String(process.pid));
         fs.writeFileSync(activeFile, '');
         fs.appendFileSync(${JSON.stringify(activeCountsFile)}, fs.readdirSync(${JSON.stringify(activeDir)}).length + '\\n');
         const releaseFile = path.join(${JSON.stringify(releaseDir)}, id);
         const timer = setInterval(() => {
           if (!fs.existsSync(releaseFile)) return;
           clearInterval(timer);
           fs.unlinkSync(activeFile);
           process.stdout.write(JSON.stringify({ via: 'spawn', id }));
         }, 5);
       }`,
    )
    startServe()

    const requests = Array.from({ length: 6 }, (_, index) =>
      spawnCli(['status', `fallback-${index}`], { timeoutMs: 5_000 }),
    )
    await waitUntil(() => startedList(startedFile).length >= 2)
    await delay(150)
    const admittedBeforeRelease = startedList(startedFile)

    for (let index = 0; index < 6; index += 1) release(releaseDir, `fallback-${index}`)
    await Promise.all(requests)

    const activeCounts = startedList(activeCountsFile).map(Number)
    expect(admittedBeforeRelease).toHaveLength(2)
    expect(Math.max(...activeCounts)).toBeLessThanOrEqual(2)
  })
})

describe('spawnCliAction', () => {
  it('returns stdout and ok:true on success', async () => {
    fakeBin('action-ok.js', 'process.stdout.write("currency updated")')
    await expect(spawnCliAction(['currency', 'EUR'])).resolves.toEqual({ ok: true, stdout: 'currency updated', stderr: '', code: 0 })
  })

  it('returns stderr and ok:false on a non-zero exit', async () => {
    fakeBin('action-fail.js', 'process.stderr.write("invalid alias"); process.exit(3)')
    await expect(spawnCliAction(['model-alias', 'a', 'b'])).resolves.toEqual({ ok: false, stdout: '', stderr: 'invalid alias', code: 3 })
  })
})

describe('nodeManagerDirs (nvm resolution)', () => {
  const savedNvm = process.env.NVM_DIR
  afterEach(() => {
    if (savedNvm === undefined) delete process.env.NVM_DIR
    else process.env.NVM_DIR = savedNvm
  })

  it('scans nvm version dirs newest-first and takes the first that holds codeburn', () => {
    // Two versions; the lexicographically-"newest" (v9.0.0 > v22.0.0 as strings)
    // has NO codeburn, while the real newer v22.0.0 does. The old `sort().reverse()[0]`
    // would pick v9.0.0's bin and miss the CLI entirely.
    const nvm = mkdtempSync(join(tmpdir(), 'codeburn-nvm-'))
    try {
      const versions = join(nvm, 'versions', 'node')
      const v9bin = join(versions, 'v9.0.0', 'bin')
      const v22bin = join(versions, 'v22.0.0', 'bin')
      mkdirSync(v9bin, { recursive: true })
      mkdirSync(v22bin, { recursive: true })
      const codeburn = join(v22bin, 'codeburn')
      writeFileSync(codeburn, '#!/bin/sh\n', { mode: 0o755 })
      chmodSync(codeburn, 0o755)

      process.env.NVM_DIR = nvm
      const dirs = nodeManagerDirs()
      expect(dirs).toContain(v22bin)
      expect(dirs).not.toContain(v9bin)
    } finally {
      rmSync(nvm, { recursive: true, force: true })
    }
  })
})
