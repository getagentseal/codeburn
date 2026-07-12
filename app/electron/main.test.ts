// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

// Stub electron so importing main.ts does not require an Electron runtime.
vi.mock('electron', () => ({
  app: { name: 'CodeBurn', whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
  BrowserWindow: class {},
  ipcMain: { handle: () => {} },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
}))

import { createApplicationMenuTemplate, createBridgeHandlers } from './main'
import { CliError } from './cli'

function fakeSpawn(result: unknown = { current: { cost: 12.34 } }) {
  const calls: string[][] = []
  const spawnCli = vi.fn(async (args: string[]) => {
    calls.push(args)
    return result
  })
  const spawnCliAction = vi.fn(async (args: string[]) => {
    calls.push(args)
    return { ok: true, stdout: 'updated', stderr: '', code: 0 }
  })
  return { spawnCli, spawnCliAction, calls }
}

// Every codeburn:* channel with a representative arg tuple → the exact argv it
// must spawn. cliStatus is the one channel that resolves without spawning.
const CHANNELS = [
  'codeburn:getOverview',
  'codeburn:getPlans',
  'codeburn:getActReport',
  'codeburn:getModels',
  'codeburn:getSessions',
  'codeburn:getCompareModels',
  'codeburn:getCompare',
  'codeburn:getYield',
  'codeburn:getSpendFlow',
  'codeburn:getDevices',
  'codeburn:getDevicesScan',
  'codeburn:getShareStatus',
  'codeburn:getIdentity',
  'codeburn:getAliases',
  'codeburn:getProxyPaths',
  'codeburn:setCurrency',
  'codeburn:resetCurrency',
  'codeburn:addAlias',
  'codeburn:removeAlias',
  'codeburn:cliStatus',
] as const

const ARGV_CASES: Array<{ channel: string; args: unknown[]; argv: string[] }> = [
  { channel: 'codeburn:getOverview', args: ['30days', 'claude'], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--provider', 'claude'] },
  { channel: 'codeburn:getOverview', args: ['30days', 'all'], argv: ['status', '--format', 'menubar-json', '--period', '30days'] },
  { channel: 'codeburn:getPlans', args: ['week'], argv: ['status', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getActReport', args: [], argv: ['act', 'report', '--json'] },
  { channel: 'codeburn:getModels', args: ['week', 'claude', true], argv: ['models', '--format', 'json', '--period', 'week', '--provider', 'claude', '--by-task'] },
  { channel: 'codeburn:getModels', args: ['week', 'all', false], argv: ['models', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getSessions', args: ['week', 'all'], argv: ['sessions', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getSessions', args: ['30days', 'claude', { from: '2026-07-01', to: '2026-07-11' }], argv: ['sessions', '--format', 'json', '--period', '30days', '--provider', 'claude', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getCompareModels', args: ['month', 'codex'], argv: ['compare', '--format', 'json', '--period', 'month', '--provider', 'codex'] },
  { channel: 'codeburn:getCompare', args: ['month', 'all', 'model-a', 'model-b'], argv: ['compare', '--format', 'json', '--period', 'month', '--model-a', 'model-a', '--model-b', 'model-b'] },
  { channel: 'codeburn:getYield', args: ['today'], argv: ['yield', '--format', 'json', '--period', 'today'] },
  { channel: 'codeburn:getSpendFlow', args: ['month', 'openai'], argv: ['spend', '--format', 'flow-json', '--period', 'month', '--provider', 'openai'] },
  { channel: 'codeburn:getOverview', args: ['30days', 'all', { from: '2026-07-01', to: '2026-07-11' }], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getModels', args: ['week', 'claude', true, { from: '2026-07-01', to: '2026-07-11' }], argv: ['models', '--format', 'json', '--period', 'week', '--provider', 'claude', '--by-task', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getYield', args: ['today', { from: '2026-07-01', to: '2026-07-11' }], argv: ['yield', '--format', 'json', '--period', 'today', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getSpendFlow', args: ['month', 'all', { from: '2026-07-01', to: '2026-07-11' }], argv: ['spend', '--format', 'flow-json', '--period', 'month', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getDevices', args: ['week'], argv: ['devices', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getDevicesScan', args: [], argv: ['devices', 'scan', '--format', 'json'] },
  { channel: 'codeburn:getShareStatus', args: [], argv: ['share', 'status', '--format', 'json'] },
  { channel: 'codeburn:getIdentity', args: [], argv: ['identity', '--format', 'json'] },
  { channel: 'codeburn:getAliases', args: [], argv: ['model-alias', '--list', '--format', 'json'] },
  { channel: 'codeburn:getProxyPaths', args: [], argv: ['proxy-path', '--list', '--format', 'json'] },
  { channel: 'codeburn:setCurrency', args: ['EUR'], argv: ['currency', 'EUR'] },
  { channel: 'codeburn:resetCurrency', args: [], argv: ['currency', '--reset'] },
  { channel: 'codeburn:addAlias', args: ['unknown-model', 'priced-model'], argv: ['model-alias', 'unknown-model', 'priced-model'] },
  { channel: 'codeburn:removeAlias', args: ['unknown-model'], argv: ['model-alias', '--remove', 'unknown-model'] },
]

function flattenMenuItems(items: any[]): any[] {
  return items.flatMap(item => {
    const submenu = Array.isArray(item.submenu) ? flattenMenuItems(item.submenu) : []
    return [item, ...submenu]
  })
}

describe('createBridgeHandlers (channel → argv for all channels)', () => {
  it('exposes exactly the bridge channels', () => {
    const handlers = createBridgeHandlers({ spawnCli: vi.fn(), spawnCliAction: vi.fn(), resolveCodeburnPath: () => null })
    expect(Object.keys(handlers).sort()).toEqual([...CHANNELS].sort())
  })

  it.each(ARGV_CASES)('$channel with $args spawns the expected argv', async ({ channel, args, argv }) => {
    const { spawnCli, spawnCliAction, calls } = fakeSpawn()
    const handlers = createBridgeHandlers({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' })
    const res = await handlers[channel]!(...args)
    expect(calls[0]).toEqual(argv)
    expect(res).toMatchObject({ ok: true })
  })

  it('codeburn:cliStatus resolves from resolveCodeburnPath without spawning', async () => {
    const spawnCli = vi.fn()
    const handlers = createBridgeHandlers({ spawnCli, spawnCliAction: vi.fn(), resolveCodeburnPath: () => '/opt/homebrew/bin/codeburn' })
    const res = await handlers['codeburn:cliStatus']!()
    expect(spawnCli).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, value: { found: true, path: '/opt/homebrew/bin/codeburn' } })
  })
})

describe('createBridgeHandlers (IPC wiring)', () => {
  it('getOverview spawns menubar-json for the period, omitting --provider for "all"', async () => {
    const { spawnCli, spawnCliAction, calls } = fakeSpawn()
    const handlers = createBridgeHandlers({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' })
    const res = await handlers['codeburn:getOverview']!('30days', 'all')
    expect(calls[0]).toEqual(['status', '--format', 'menubar-json', '--period', '30days'])
    expect(res).toEqual({ ok: true, value: { current: { cost: 12.34 } } })
  })

  it('adds --provider and --by-task when requested', async () => {
    const { spawnCli, spawnCliAction, calls } = fakeSpawn([])
    const handlers = createBridgeHandlers({ spawnCli, spawnCliAction, resolveCodeburnPath: () => null })
    await handlers['codeburn:getModels']!('week', 'claude', true)
    expect(calls[0]).toEqual(['models', '--format', 'json', '--period', 'week', '--provider', 'claude', '--by-task'])
  })

  it('returns an error envelope carrying the CliError kind', async () => {
    const spawnCli = vi.fn(async () => {
      throw new CliError('nonzero', 'boom')
    })
    const handlers = createBridgeHandlers({ spawnCli, spawnCliAction: vi.fn(), resolveCodeburnPath: () => '/bin/codeburn' })
    const res = await handlers['codeburn:getYield']!('today')
    expect(res).toEqual({ ok: false, error: { kind: 'nonzero', message: 'boom' } })
  })

  it('cliStatus reports the resolved binary path', async () => {
    const handlers = createBridgeHandlers({
      spawnCli: vi.fn(),
      spawnCliAction: vi.fn(),
      resolveCodeburnPath: () => '/opt/homebrew/bin/codeburn',
    })
    const res = await handlers['codeburn:cliStatus']!()
    expect(res).toEqual({ ok: true, value: { found: true, path: '/opt/homebrew/bin/codeburn' } })
  })
})

describe('createApplicationMenuTemplate', () => {
  it('keeps normal app roles while leaving CmdOrCtrl+R for renderer refresh', () => {
    const items = flattenMenuItems(createApplicationMenuTemplate(false))
    const roles = items.map(item => item.role).filter(Boolean)
    const accelerators = items.map(item => item.accelerator).filter(Boolean)

    expect(roles).toContain('copy')
    expect(roles).toContain('paste')
    expect(roles).toContain('quit')
    expect(roles).toContain('minimize')
    expect(roles).toContain('close')
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forceReload')
    expect(accelerators).not.toContain('CmdOrCtrl+R')
    expect(accelerators).not.toContain('CommandOrControl+R')
  })

  it('keeps DevTools available in dev without adding reload menu items', () => {
    const roles = flattenMenuItems(createApplicationMenuTemplate(true)).map(item => item.role).filter(Boolean)

    expect(roles).toContain('toggleDevTools')
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forceReload')
  })
})
