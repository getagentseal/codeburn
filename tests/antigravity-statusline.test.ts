import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  installAntigravityStatusLineHook,
  uninstallAntigravityStatusLineHook,
} from '../src/antigravity-statusline.js'

describe('Antigravity CLI statusLine hook installer', () => {
  async function withTempSettings(run: (dir: string, settingsPath: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-agy-hook-'))
    const settingsPath = join(dir, 'settings.json')
    const oldSettingsPath = process.env['CODEBURN_ANTIGRAVITY_SETTINGS_PATH']
    const oldCacheDir = process.env['CODEBURN_CACHE_DIR']
    process.env['CODEBURN_ANTIGRAVITY_SETTINGS_PATH'] = settingsPath
    process.env['CODEBURN_CACHE_DIR'] = join(dir, 'cache')

    try {
      await run(dir, settingsPath)
    } finally {
      if (oldSettingsPath === undefined) delete process.env['CODEBURN_ANTIGRAVITY_SETTINGS_PATH']
      else process.env['CODEBURN_ANTIGRAVITY_SETTINGS_PATH'] = oldSettingsPath
      if (oldCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
      await rm(dir, { recursive: true, force: true })
    }
  }

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
