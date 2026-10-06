import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// A one-shot read that waits on another process's cold hydration lock does no
// parsing yet, and the app watchdogs kill on silence. It must beat anyway.
describe('one-shot CLI keepalive', () => {
  it('beats while waiting on a foreign hydration lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cb-entry-keepalive-home-'))
    const cacheDir = await mkdtemp(join(tmpdir(), 'cb-entry-keepalive-cache-'))
    // This test process is alive and is not the child, so the child waits.
    await writeFile(join(cacheDir, 'hydrating.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'status', '--format', 'menubar-json', '--provider', 'claude'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEBURN_CACHE_DIR: cacheDir,
        CODEBURN_PROGRESS: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    try {
      const sawKeepalive = await new Promise<boolean>(resolve => {
        let stderr = ''
        const timer = setTimeout(() => resolve(false), 20_000)
        child.stderr.on('data', chunk => {
          stderr += chunk
          if (stderr.includes('"kind":"keepalive"')) { clearTimeout(timer); resolve(true) }
        })
        child.on('exit', () => { clearTimeout(timer); resolve(false) })
      })
      expect(sawKeepalive).toBe(true)
    } finally {
      child.kill('SIGKILL')
      await rm(home, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  }, 30_000)
})
