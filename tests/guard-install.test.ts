import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction } from '../src/act/apply.js'
import { readRecords } from '../src/act/journal.js'
import {
  buildInstall, buildUninstall, inspectInstall, settingsPathFor,
  GUARD_HOOK_PREFIX, GUARD_STATUSLINE_COMMAND,
} from '../src/guard/settings.js'

const roots: string[] = []
async function makeRoot(): Promise<{ settings: string; actionsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codeburn-guard-install-'))
  roots.push(root)
  await mkdir(join(root, '.claude'), { recursive: true })
  return { settings: join(root, '.claude', 'settings.json'), actionsDir: join(root, 'actions') }
}
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

function canonical(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n'
}
async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf-8'))
}

describe('settingsPathFor', () => {
  it('resolves project (default) and global scopes', () => {
    expect(settingsPathFor({ cwd: '/repo' })).toBe(join('/repo', '.claude', 'settings.json'))
    expect(settingsPathFor({ project: '/x' })).toBe(join('/x', '.claude', 'settings.json'))
    expect(settingsPathFor({ global: true })).toContain(join('.claude', 'settings.json'))
  })
})

describe('guard install', () => {
  it('creates settings with all three hook events when none exists', async () => {
    const { settings, actionsDir } = await makeRoot()
    await rm(settings, { force: true })
    const built = buildInstall(settings)
    expect(built.plan).not.toBeNull()
    expect(built.plan!.kind).toBe('guard-install')
    await runAction(built.plan!, actionsDir)

    const doc = await readJson(settings)
    expect(Object.keys(doc.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toBe(`${GUARD_HOOK_PREFIX} pretooluse`)
    expect(doc.hooks.SessionStart[0].matcher).toBe('startup')
    expect(doc.hooks.Stop[0].matcher).toBeUndefined() // Stop takes no matcher
    // journaled + undoable
    const records = await readRecords(actionsDir)
    expect(records[0]!.kind).toBe('guard-install')
  })

  it('appends to pre-existing user hooks without disturbing them', async () => {
    const { settings, actionsDir } = await makeRoot()
    const original = canonical({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] },
    })
    await writeFile(settings, original)

    await runAction(buildInstall(settings).plan!, actionsDir)
    const doc = await readJson(settings)
    const commands = doc.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    expect(commands).toContain('my-own-hook.sh')
    expect(commands).toContain(`${GUARD_HOOK_PREFIX} pretooluse`)
  })

  it('is idempotent: re-install adds nothing', async () => {
    const { settings, actionsDir } = await makeRoot()
    await rm(settings, { force: true })
    await runAction(buildInstall(settings).plan!, actionsDir)
    const again = buildInstall(settings)
    expect(again.plan).toBeNull()
    expect(again.notes.join(' ')).toContain('already present')
  })

  it('configures the statusline only when none exists', async () => {
    const { settings, actionsDir } = await makeRoot()
    await rm(settings, { force: true })
    await runAction(buildInstall(settings, { statusline: true }).plan!, actionsDir)
    expect((await readJson(settings)).statusLine.command).toBe(GUARD_STATUSLINE_COMMAND)

    // A pre-existing statusline is refused, not overwritten.
    const { settings: s2, actionsDir: a2 } = await makeRoot()
    await writeFile(s2, canonical({ statusLine: { type: 'command', command: 'my-statusline.sh' } }))
    const built = buildInstall(s2, { statusline: true })
    expect(built.notes.join(' ')).toContain('statusline is already configured')
    await runAction(built.plan!, a2)
    expect((await readJson(s2)).statusLine.command).toBe('my-statusline.sh')
  })

  it('refuses to apply a plan when the settings file changed after it was built', async () => {
    const { settings, actionsDir } = await makeRoot()
    await writeFile(settings, canonical({ permissions: { allow: [] } }))
    const built = buildInstall(settings)
    expect(built.plan).not.toBeNull()

    const concurrent = canonical({ permissions: { allow: ['Bash(ls:*)'] } })
    await writeFile(settings, concurrent)

    await expect(runAction(built.plan!, actionsDir)).rejects.toThrow(/changed since the plan was built/)
    expect(await readFile(settings, 'utf-8')).toBe(concurrent) // the concurrent edit survives
    expect(await readRecords(actionsDir)).toEqual([]) // nothing journaled
  })
})

describe('guard uninstall', () => {
  it('removes exactly our entries and restores byte-identical settings', async () => {
    const { settings, actionsDir } = await makeRoot()
    const original = canonical({
      permissions: { allow: [] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] },
    })
    await writeFile(settings, original)

    await runAction(buildInstall(settings, { statusline: true }).plan!, actionsDir)
    // ours are present now
    const mid = inspectInstall(settings)
    expect(mid.hooks.sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
    expect(mid.statusline).toBe(true)

    await runAction(buildUninstall(settings).plan!, actionsDir)
    expect(await readFile(settings, 'utf-8')).toBe(original) // byte-identical
    const after = inspectInstall(settings)
    expect(after.hooks).toEqual([])
    expect(after.statusline).toBe(false)
  })

  it('preserves a user hook that shares the PreToolUse array', async () => {
    const { settings, actionsDir } = await makeRoot()
    await writeFile(settings, canonical({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] },
    }))
    await runAction(buildInstall(settings).plan!, actionsDir)
    await runAction(buildUninstall(settings).plan!, actionsDir)
    const doc = await readJson(settings)
    const commands = doc.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    expect(commands).toEqual(['my-own-hook.sh'])
  })

  it('reports nothing to do on a settings file without our hooks', async () => {
    const { settings } = await makeRoot()
    await writeFile(settings, canonical({ hooks: {} }))
    const built = buildUninstall(settings)
    expect(built.plan).toBeNull()
    expect(built.notes.join(' ')).toContain('no codeburn guard hooks')
  })

  it('reports nothing to do when the settings file is absent', async () => {
    const { settings } = await makeRoot()
    await rm(settings, { force: true })
    expect(existsSync(settings)).toBe(false)
    const built = buildUninstall(settings)
    expect(built.plan).toBeNull()
  })
})
