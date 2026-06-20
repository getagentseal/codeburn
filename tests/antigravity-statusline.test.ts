import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  buildAntigravityHookLookupPath,
  installAntigravityStatusLineHook,
  resolvePersistentCodeburnPathFromPath,
  uninstallAntigravityStatusLineHook,
} from '../src/antigravity-statusline.js'

describe('Antigravity CLI statusLine hook installer', () => {
  async function withTempSettings(run: (dir: string, settingsPath: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-agy-hook-'))
    const settingsPath = join(dir, 'settings.json')
    const binDir = join(dir, 'bin')
    const codeburnPath = join(binDir, process.platform === 'win32' ? 'codeburn.cmd' : 'codeburn')
    await mkdir(binDir, { recursive: true })
    await writeFile(codeburnPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
    await chmod(codeburnPath, 0o755)
    process.env['CODEBURN_ANTIGRAVITY_SETTINGS_PATH'] = settingsPath
    process.env['CODEBURN_CACHE_DIR'] = join(dir, 'cache')
    process.env.PATH = binDir

    try {
      await run(dir, settingsPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('builds a lookup PATH with user paths before fallbacks', () => {
    const lookupPath = buildAntigravityHookLookupPath(['/Users/me/.nvm/versions/node/v22.13.0/bin', '/usr/bin'].join(delimiter))

    expect(lookupPath.split(delimiter)).toContain('/Users/me/.nvm/versions/node/v22.13.0/bin')
    if (process.platform !== 'win32') expect(lookupPath.split(delimiter)).toContain('/opt/homebrew/bin')
  })

  it('skips transient npx codeburn shims when resolving the hook command', async () => {
    await withTempSettings(async (dir) => {
      const npxBin = join(dir, '.npm', '_npx', 'abcd', 'node_modules', '.bin')
      const persistentBin = join(dir, 'persistent-bin')
      const npxCodeburn = join(npxBin, process.platform === 'win32' ? 'codeburn.cmd' : 'codeburn')
      const persistentCodeburn = join(persistentBin, process.platform === 'win32' ? 'codeburn.cmd' : 'codeburn')
      await mkdir(npxBin, { recursive: true })
      await mkdir(persistentBin, { recursive: true })
      await writeFile(npxCodeburn, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
      await writeFile(persistentCodeburn, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
      await chmod(npxCodeburn, 0o755)
      await chmod(persistentCodeburn, 0o755)

      const resolved = await resolvePersistentCodeburnPathFromPath([npxBin, persistentBin].join(delimiter))

      expect(resolved).toBe(persistentCodeburn)
    })
  })

  it('backs up and restores an existing custom statusLine when forced', async () => {
    await withTempSettings(async (dir, settingsPath) => {
      const customStatusLine = {
        type: 'command',
        command: 'custom-statusline',
        padding: 1,
      }
      await writeFile(settingsPath, `${JSON.stringify({ statusLine: customStatusLine }, null, 2)}\n`)

      await expect(installAntigravityStatusLineHook(false)).rejects.toThrow('already has a custom statusLine')
      expect(await installAntigravityStatusLineHook(true)).toBe('installed')

      const installed = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(installed.statusLine.command).toContain('agy-statusline-hook')
      expect(installed.statusLine.command).not.toContain('custom-statusline')

      const backupPath = join(dir, 'cache', 'antigravity-statusline-previous.json')
      const backup = JSON.parse(await readFile(backupPath, 'utf-8'))
      expect(backup.statusLine).toEqual(customStatusLine)

      expect(await uninstallAntigravityStatusLineHook()).toBe('restored')
      const restored = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(restored.statusLine).toEqual(customStatusLine)
    })
  })

  it('installs CodeBurn statusLine when no statusLine exists', async () => {
    await withTempSettings(async (_dir, settingsPath) => {
      expect(await installAntigravityStatusLineHook(false)).toBe('installed')
      expect(await installAntigravityStatusLineHook(false)).toBe('already-installed')

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(settings.statusLine).toMatchObject({
        type: 'command',
        padding: 0,
      })
      expect(settings.statusLine.command).toContain('agy-statusline-hook')
      expect(settings.statusLine.command).toContain(join(_dir, 'bin'))
      expect(settings.statusLine.command).not.toContain('dist/cli.js')
    })
  })

  it('repairs an existing stale CodeBurn statusLine command without force', async () => {
    await withTempSettings(async (dir, settingsPath) => {
      await writeFile(settingsPath, JSON.stringify({
        statusLine: {
          type: 'command',
          command: "'/usr/local/bin/node' '/Users/me/codeburn-agy-statusline/dist/cli.js' agy-statusline-hook",
          padding: 0,
        },
      }))

      expect(await installAntigravityStatusLineHook(false)).toBe('installed')

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(settings.statusLine.command).toContain(join(dir, 'bin'))
      expect(settings.statusLine.command).toContain('agy-statusline-hook')
      expect(settings.statusLine.command).not.toContain('codeburn-agy-statusline/dist/cli.js')
    })
  })

  it('treats a custom statusLine that only mentions the hook token as custom, not CodeBurn-owned', async () => {
    await withTempSettings(async (_dir, settingsPath) => {
      const custom = 'mybar --note "runs agy-statusline-hook nightly"'
      await writeFile(settingsPath, JSON.stringify({
        statusLine: { type: 'command', command: custom, padding: 0 },
      }))

      await expect(installAntigravityStatusLineHook(false)).rejects.toThrow(/custom statusLine/)

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(settings.statusLine.command).toBe(custom)
    })
  })

  it('removes CodeBurn statusLine when there is no previous hook backup', async () => {
    await withTempSettings(async (_dir, settingsPath) => {
      await writeFile(settingsPath, JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'codeburn agy-statusline-hook',
          padding: 0,
        },
      }))

      expect(await uninstallAntigravityStatusLineHook()).toBe('removed')
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(settings).not.toHaveProperty('statusLine')
    })
  })
})
