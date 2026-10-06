import { describe, expect, it, vi } from 'vitest'

import { createRouter, isWebUrl } from '../src/host'

const editor = () => ({
  chooseDirectory: vi.fn(async () => '/tmp/out'),
  openExternal: vi.fn(async () => {}),
  openSettings: vi.fn(async () => {}),
  setScope: vi.fn(async () => {}),
})

describe('createRouter', () => {
  it('forwards an allowed channel to the shared handler with its args', async () => {
    const getOverview = vi.fn(async () => ({ ok: true as const, value: { current: { cost: 1 } } }))
    const route = createRouter({ 'codeburn:getOverview': getOverview }, editor())
    expect(await route('codeburn:getOverview', ['today', 'all'])).toEqual({ ok: true, value: { current: { cost: 1 } } })
    expect(getOverview).toHaveBeenCalledWith('today', 'all')
  })

  it('refuses channels outside the forwarded list, desktop-only ones included', async () => {
    const companionInstall = vi.fn()
    const route = createRouter({ 'codeburn:companionInstall': companionInstall, 'codeburn:telemetryTrack': vi.fn() }, editor())
    for (const channel of ['codeburn:companionInstall', 'codeburn:telemetryTrack', 'nope', 42]) {
      expect(await route(channel, [])).toEqual({ ok: false, error: { kind: 'bad-args', message: 'unknown channel' } })
    }
    expect(companionInstall).not.toHaveBeenCalled()
  })

  it('answers the editor-owned channels itself', async () => {
    const actions = editor()
    const route = createRouter({}, actions)
    expect(await route('codeburn:getLanguage', [])).toEqual({ ok: true, value: null })
    expect(await route('codeburn:chooseDirectory', [])).toEqual({ ok: true, value: '/tmp/out' })
    await route('codeburn:setIdeScope', [true])
    expect(actions.setScope).toHaveBeenCalledWith(true)
    await route('codeburn:openIdeSettings', [])
    expect(actions.openSettings).toHaveBeenCalled()
  })

  it('opens only web links', async () => {
    const actions = editor()
    const route = createRouter({}, actions)
    await route('codeburn:openExternal', ['https://github.com/getagentseal/codeburn'])
    await route('codeburn:openExternal', ['file:///etc/passwd'])
    await route('codeburn:openExternal', ['command:workbench.action.quit'])
    expect(actions.openExternal).toHaveBeenCalledTimes(1)
    expect(actions.openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn')
  })

  it('turns an editor failure into an error envelope', async () => {
    const actions = editor()
    actions.chooseDirectory.mockRejectedValueOnce(new Error('cancelled'))
    expect(await createRouter({}, actions)('codeburn:chooseDirectory', [])).toEqual({ ok: false, error: { kind: 'nonzero', message: 'cancelled' } })
  })
})

describe('isWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isWebUrl('http://x.test')).toBe(true)
    expect(isWebUrl('vscode://settings')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
    expect(isWebUrl(undefined)).toBe(false)
  })
})

describe('workspace scope through the shared handlers', () => {
  it('adds the workspace as a rooted --project on every scoped read, and never asks for combined scope', async () => {
    const { createBridgeHandlers } = await import('../../app/electron/bridge-handlers')
    const { scopeFilter } = await import('../src/workspace')
    const calls: string[][] = []
    const spawnCli = vi.fn(async (args: string[]) => { calls.push(args); return {} })
    const base = { spawnCli, spawnCliAction: vi.fn(), resolveCodeburnPath: () => '/cli', getQuota: vi.fn(async () => []) }
    const scoped = createBridgeHandlers({ ...base, scopeProjectFilter: scopeFilter(['/w/app']) })
    await scoped['codeburn:getOverview']!('today', 'all', undefined, null, false, 'combined')
    await scoped['codeburn:getSessions']!('week', 'claude')
    await scoped['codeburn:getUnfilteredProjects']!()
    expect(calls[0]).toContain('--project=/w/app')
    expect(calls[0]).not.toContain('combined')
    expect(calls[1]).toEqual(['sessions', '--format', 'json', '--period', 'week', '--provider', 'claude', '--project=/w/app'])
    expect(calls[2]).not.toContain('--project=/w/app')
    const unscoped = createBridgeHandlers(base)
    await unscoped['codeburn:getSessions']!('week', 'all')
    expect(calls[3]).toEqual(['sessions', '--format', 'json', '--period', 'week'])
  })
})
