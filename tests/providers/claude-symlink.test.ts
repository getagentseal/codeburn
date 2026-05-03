import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { claude } from '../../src/providers/claude.js'

let tmpDir: string
let claudeDir: string
let realTarget: string
let originalConfigDir: string | undefined
let originalHome: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'claude-symlink-test-'))
  claudeDir = join(tmpDir, 'claude-config')
  realTarget = join(tmpDir, 'outside-the-sandbox')
  await mkdir(join(claudeDir, 'projects'), { recursive: true })
  await mkdir(realTarget, { recursive: true })
  await writeFile(join(realTarget, 'sneaky.jsonl'), '{"type":"hello"}\n')

  originalConfigDir = process.env['CLAUDE_CONFIG_DIR']
  originalHome = process.env['HOME']
  process.env['CLAUDE_CONFIG_DIR'] = claudeDir
  process.env['HOME'] = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  await rm(tmpDir, { recursive: true, force: true })
})

describe('claude provider — symlink protection in session discovery', () => {
  it('skips symbolic-link entries pointing outside the projects dir', async ({ skip }) => {
    const realProjectDir = join(claudeDir, 'projects', 'real-project')
    await mkdir(realProjectDir, { recursive: true })
    try {
      const symlinkType = process.platform === 'win32' ? 'junction' : undefined
      await symlink(realTarget, join(claudeDir, 'projects', 'shady-link'), symlinkType)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        skip(`symlink creation not permitted in this environment (${code})`)
        return
      }
      throw err
    }

    const sources = await claude.discoverSessions()
    const claudeSources = sources.filter(s => s.provider === 'claude')
    const projects = claudeSources.map(s => s.project)

    expect(projects).toContain('real-project')
    expect(projects).not.toContain('shady-link')
    for (const s of claudeSources) {
      expect(s.path.startsWith(realTarget)).toBe(false)
    }
  })

  it('still discovers regular project directories', async () => {
    await mkdir(join(claudeDir, 'projects', 'plain'), { recursive: true })

    const sources = await claude.discoverSessions()
    const claudeSources = sources.filter(s => s.provider === 'claude')
    const projects = claudeSources.map(s => s.project)

    expect(projects).toContain('plain')
  })
})
