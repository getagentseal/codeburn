import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ancestorsOf, replaceAndRelaunch, runningAppPids } from '../src/menubar-installer.js'

describe('ancestorsOf', () => {
  const ps = ['  1     0', ' 50     1', ' 60    50', ' 70    60', ' 80     1', ''].join('\n')

  it('walks the parent chain up to launchd', () => {
    expect([...ancestorsOf(70, ps)]).toEqual([60, 50])
  })

  it('does not count unrelated processes', () => {
    expect(ancestorsOf(70, ps).has(80)).toBe(false)
    expect(ancestorsOf(80, ps).size).toBe(0)
  })

  it('stops on a cycle and on an unknown pid', () => {
    expect([...ancestorsOf(2, ' 2 3\n 3 2\n')]).toEqual([3, 2])
    expect(ancestorsOf(999, ps).size).toBe(0)
  })
})

// A stand-in for the menubar app: a real process with a unique name, so the pgrep, kill and
// ancestry code runs for real without going near the installed CodeBurnMenubar. It runs an
// optional command as its child (the Update button's `codeburn menubar --force`), records the
// exit status, then idles until signalled. SIGTERM is held off until the status is on disk:
// the helper signals the app as soon as its child is reaped, and a real app handles that
// termination itself rather than dying between two lines of C.
const DUMMY_C = `#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 2) {
    sigset_t term;
    sigemptyset(&term);
    sigaddset(&term, SIGTERM);
    sigprocmask(SIG_BLOCK, &term, NULL);
    int status = system(argv[2]);
    FILE *f = fopen(argv[1], "w");
    fprintf(f, "%d", WEXITSTATUS(status));
    fclose(f);
    sigprocmask(SIG_UNBLOCK, &term, NULL);
  }
  for (;;) pause();
}
`

const canRun = process.platform === 'darwin' && spawnSync('cc', ['--version']).status === 0

describe.skipIf(!canRun)('replaceAndRelaunch with a stand-in app', () => {
  vi.setConfig({ testTimeout: 60_000 })
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn()
  })

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-relaunch-'))
    const name = `cbRl${Math.random().toString(16).slice(2, 8)}`
    const bin = join(dir, name)
    await writeFile(join(dir, 'dummy.c'), DUMMY_C)
    expect(spawnSync('cc', ['-o', bin, join(dir, 'dummy.c')]).status).toBe(0)
    const staged = join(dir, 'staged', 'CodeBurnMenubar.app')
    const target = join(dir, 'apps', 'CodeBurnMenubar.app')
    await mkdir(staged, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(staged, 'v'), 'new')
    await writeFile(join(target, 'v'), 'old')
    const procs: ChildProcess[] = []
    cleanup.push(async () => {
      for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
      await rm(dir, { recursive: true, force: true })
    })
    const start = async (args: string[]) => {
      const p = spawn(bin, args, { stdio: 'ignore' })
      procs.push(p)
      await once(p, 'spawn')
      return p
    }
    const marker = join(dir, 'launched')
    // Stands in for `open`: records whether the app was still alive and which bundle was in
    // place at the moment of the launch.
    const launchCommand = (pid: number) => ['/bin/sh', '-c', 'kill -0 "$1" 2>/dev/null && s=alive || s=dead; echo "$s $(cat "$3/v")" > "$2"', 'launch', String(pid), marker]
    return { dir, name, staged, target, marker, start, launchCommand }
  }

  async function waitFor(path: string, ms = 30_000): Promise<string> {
    const until = Date.now() + ms
    for (;;) {
      const text = existsSync(path) ? await readFile(path, 'utf-8') : ''
      if (text.endsWith('\n')) return text.trim()
      if (Date.now() > until) throw new Error(`timed out waiting for ${path}`)
      await new Promise(r => setTimeout(r, 100))
    }
  }

  it('from a terminal: stops the app, swaps, then launches, before returning', async () => {
    const t = await setup()
    const app = await t.start([])
    expect(await runningAppPids(t.name)).toEqual([app.pid])
    const exited = once(app, 'exit')

    await replaceAndRelaunch(t.staged, t.target, true, { processName: t.name, launchCommand: t.launchCommand(app.pid!) })

    expect(await readFile(t.marker, 'utf-8')).toBe('dead new\n')
    expect((await exited)[1]).toBe('SIGTERM')
  })

  it('from the app itself: finds its ancestor, swaps while it runs, exits, then the helper stops and relaunches it', async () => {
    const t = await setup()
    const installer = pathToFileURL(join(process.cwd(), 'src', 'menubar-installer.ts')).href
    const swapped = join(t.dir, 'swapped')
    const child = join(t.dir, 'child.mts')
    const status = join(t.dir, 'status')
    const appPid = join(t.dir, 'apppid')
    // The dummy's pid is only known once it runs, so the child reads it from its parent.
    await writeFile(child, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { replaceAndRelaunch } from ${JSON.stringify(installer)}
while (!existsSync(${JSON.stringify(appPid)})) await new Promise(r => setTimeout(r, 50))
const app = Number(readFileSync(${JSON.stringify(appPid)}, 'utf-8'))
await replaceAndRelaunch(${JSON.stringify(t.staged)}, ${JSON.stringify(t.target)}, true, {
  processName: ${JSON.stringify(t.name)},
  launchCommand: ${JSON.stringify(t.launchCommand(0).slice(0, 3))}.concat(['launch', String(app), ${JSON.stringify(t.marker)}]),
})
let alive = true
try { process.kill(app, 0) } catch { alive = false }
writeFileSync(${JSON.stringify(swapped)}, (alive ? 'alive ' : 'dead ') + readFileSync(${JSON.stringify(join(t.target, 'v'))}, 'utf-8'))
`)
    const cmd = `exec "${process.execPath}" --import tsx "${child}"`
    const app = await t.start([status, cmd])
    await writeFile(appPid, String(app.pid))
    const exited = once(app, 'exit')

    expect(await waitFor(t.marker)).toBe('dead new')
    // The CLI finished, successfully, with the app still alive to read its exit status...
    expect(await readFile(status, 'utf-8')).toBe('0')
    // ...and the bundle was already swapped while the app was running.
    expect(await readFile(swapped, 'utf-8')).toBe('alive new')
    expect((await exited)[1]).toBe('SIGTERM')
  })
})
