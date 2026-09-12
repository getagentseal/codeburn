// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'

// Stub electron so importing main.ts does not require an Electron runtime.
vi.mock('electron', () => ({
  app: { name: 'CodeBurn', whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: () => {} },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
  shell: { openExternal: vi.fn() },
}))

import { createApplicationMenuTemplate, createBeforeQuitHandler, createBridgeHandlers, externalUrlToOpen, readProjectFilter, writeProjectFilter } from './main'
import { CliError } from './cli'
import { Telemetry } from './telemetry'

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
  'codeburn:getTimeline',
  'codeburn:getQuota',
  'codeburn:getPlans',
  'codeburn:getActReport',
  'codeburn:getModels',
  'codeburn:getSessions',
  'codeburn:getCompareModels',
  'codeburn:getCompare',
  'codeburn:getYield',
  'codeburn:getSpendFlow',
  'codeburn:getOptimizeReport',
  'codeburn:getDevices',
  'codeburn:getDevicesScan',
  'codeburn:getShareStatus',
  'codeburn:getIdentity',
  'codeburn:getAliases',
  'codeburn:getProxyPaths',
  'codeburn:getAudit',
  'codeburn:getPriceOverrides',
  'codeburn:getProjectFilter',
  'codeburn:setProjectFilter',
  'codeburn:getUnfilteredProjects',
  'codeburn:setCurrency',
  'codeburn:resetCurrency',
  'codeburn:addAlias',
  'codeburn:removeAlias',
  'codeburn:setPriceOverride',
  'codeburn:removePriceOverride',
  'codeburn:removeDevice',
  'codeburn:setPlan',
  'codeburn:resetPlan',
  'codeburn:exportData',
  'codeburn:cliStatus',
  'codeburn:telemetryStatus',
  'codeburn:telemetrySetEnabled',
  'codeburn:telemetryOnboarded',
  'codeburn:telemetryTrack',
  'codeburn:getUpdateStatus',
  'codeburn:companionStatus',
  'codeburn:setMenuBarEnabled',
  'codeburn:setSidebarEnabled',
  'codeburn:trayPrefs',
  'codeburn:setTrayAppPref',
  'codeburn:setTrayDockPref',
  'codeburn:setLaunchAtLogin',
  'codeburn:pluginList',
  'codeburn:pluginInfo',
  'codeburn:pluginAdd',
  'codeburn:pluginRemove',
  'codeburn:pluginVerify',
  'codeburn:syncAutoStatus',
  'codeburn:syncAutoEnable',
  'codeburn:syncAutoDisable',
] as const

const ARGV_CASES: Array<{ channel: string; args: unknown[]; argv: string[] }> = [
  { channel: 'codeburn:getOverview', args: ['30days', 'claude'], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--provider', 'claude'] },
  { channel: 'codeburn:getOverview', args: ['30days', 'all'], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline'] },
  { channel: 'codeburn:getPlans', args: ['week'], argv: ['status', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getActReport', args: [], argv: ['act', 'report', '--json'] },
  { channel: 'codeburn:getModels', args: ['week', 'claude', true], argv: ['models', '--format', 'json', '--period', 'week', '--provider', 'claude', '--by-task'] },
  { channel: 'codeburn:getModels', args: ['week', 'all', false], argv: ['models', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getSessions', args: ['week', 'all'], argv: ['sessions', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getSessions', args: ['30days', 'claude', { from: '2026-07-01', to: '2026-07-11' }], argv: ['sessions', '--format', 'json', '--period', '30days', '--provider', 'claude', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getCompareModels', args: ['month', 'codex'], argv: ['compare', '--format', 'json', '--period', 'month', '--provider', 'codex'] },
  { channel: 'codeburn:getCompare', args: ['month', 'all', 'model-a', 'model-b'], argv: ['compare', '--format', 'json', '--period', 'month', '--model-a', 'model-a', '--model-b', 'model-b'] },
  { channel: 'codeburn:getYield', args: ['today', 'all'], argv: ['yield', '--format', 'json', '--period', 'today'] },
  { channel: 'codeburn:getYield', args: ['today', 'claude'], argv: ['yield', '--format', 'json', '--period', 'today', '--provider', 'claude'] },
  { channel: 'codeburn:getSpendFlow', args: ['month', 'openai'], argv: ['spend', '--format', 'flow-json', '--period', 'month', '--provider', 'openai'] },
  { channel: 'codeburn:getOptimizeReport', args: ['month', 'openai'], argv: ['optimize', '--format', 'json', '--period', 'month', '--provider', 'openai'] },
  { channel: 'codeburn:getOverview', args: ['30days', 'all', { from: '2026-07-01', to: '2026-07-11' }], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getOverview', args: ['30days', 'all', undefined, 'claude-config:91dda17e8cf35193'], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--claude-config-source', 'claude-config:91dda17e8cf35193'] },
  { channel: 'codeburn:getOverview', args: ['month', 'claude', { from: '2026-07-01', to: '2026-07-11' }, 'claude-desktop:980e1e488a654830'], argv: ['status', '--format', 'menubar-json', '--period', 'month', '--no-timeline', '--provider', 'claude', '--from', '2026-07-01', '--to', '2026-07-11', '--claude-config-source', 'claude-desktop:980e1e488a654830'] },
  // Combined scope emits --scope combined; an explicit local scope is identical
  // to the default (no flag). The CLI rejects --scope with --provider, so a
  // provider passed alongside combined is dropped (the renderer forces 'all').
  { channel: 'codeburn:getOverview', args: ['30days', 'all', undefined, undefined, undefined, 'combined'], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--scope', 'combined'] },
  { channel: 'codeburn:getOverview', args: ['30days', 'claude', undefined, undefined, undefined, 'combined'], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--scope', 'combined'] },
  { channel: 'codeburn:getOverview', args: ['30days', 'claude', undefined, undefined, undefined, 'local'], argv: ['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--provider', 'claude'] },
  { channel: 'codeburn:getModels', args: ['week', 'claude', true, { from: '2026-07-01', to: '2026-07-11' }], argv: ['models', '--format', 'json', '--period', 'week', '--provider', 'claude', '--by-task', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getYield', args: ['today', 'all', { from: '2026-07-01', to: '2026-07-11' }], argv: ['yield', '--format', 'json', '--period', 'today', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getSpendFlow', args: ['month', 'all', { from: '2026-07-01', to: '2026-07-11' }], argv: ['spend', '--format', 'flow-json', '--period', 'month', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getOptimizeReport', args: ['month', 'all', { from: '2026-07-01', to: '2026-07-11' }], argv: ['optimize', '--format', 'json', '--period', 'month', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getDevices', args: ['week'], argv: ['devices', '--format', 'json', '--period', 'week'] },
  { channel: 'codeburn:getDevicesScan', args: [], argv: ['devices', 'scan', '--format', 'json'] },
  { channel: 'codeburn:getShareStatus', args: [], argv: ['share', 'status', '--format', 'json'] },
  { channel: 'codeburn:getIdentity', args: [], argv: ['identity', '--format', 'json'] },
  { channel: 'codeburn:getAliases', args: [], argv: ['model-alias', '--list', '--format', 'json'] },
  { channel: 'codeburn:getProxyPaths', args: [], argv: ['proxy-path', '--list', '--format', 'json'] },
  { channel: 'codeburn:getAudit', args: ['month', 'claude'], argv: ['audit', '--format', 'json', '--period', 'month', '--provider', 'claude'] },
  { channel: 'codeburn:getAudit', args: ['30days', 'all', { from: '2026-07-01', to: '2026-07-11' }], argv: ['audit', '--format', 'json', '--period', '30days', '--from', '2026-07-01', '--to', '2026-07-11'] },
  { channel: 'codeburn:getPriceOverrides', args: [], argv: ['price-override', '--list', '--format', 'json'] },
  { channel: 'codeburn:getUnfilteredProjects', args: ['month'], argv: ['report', '--format', 'json', '--period', 'month'] },
  { channel: 'codeburn:setPriceOverride', args: ['unpriced/test-model', { input: 0.27, output: 1.1 }], argv: ['price-override', 'unpriced/test-model', '--input', '0.27', '--output', '1.1'] },
  { channel: 'codeburn:setPriceOverride', args: ['unpriced/test-model', { input: 0.27, output: 1.1, cacheRead: 0.03, cacheCreation: 0.42 }], argv: ['price-override', 'unpriced/test-model', '--input', '0.27', '--output', '1.1', '--cache-read', '0.03', '--cache-creation', '0.42'] },
  { channel: 'codeburn:removePriceOverride', args: ['unpriced/test-model'], argv: ['price-override', '--remove', 'unpriced/test-model'] },
  { channel: 'codeburn:setCurrency', args: ['EUR'], argv: ['currency', 'EUR'] },
  { channel: 'codeburn:resetCurrency', args: [], argv: ['currency', '--reset'] },
  { channel: 'codeburn:addAlias', args: ['unknown-model', 'priced-model'], argv: ['model-alias', 'unknown-model', 'priced-model'] },
  { channel: 'codeburn:removeAlias', args: ['unknown-model'], argv: ['model-alias', '--remove', 'unknown-model'] },
  { channel: 'codeburn:removeDevice', args: ['studio-mac'], argv: ['devices', 'rm', 'studio-mac'] },
  { channel: 'codeburn:setPlan', args: ['claude-max', 'claude'], argv: ['plan', 'set', 'claude-max', '--provider', 'claude'] },
  { channel: 'codeburn:resetPlan', args: ['cursor'], argv: ['plan', 'reset', '--provider', 'cursor'] },
  { channel: 'codeburn:exportData', args: ['json', 'all', '/tmp/codeburn-export'], argv: ['export', '-f', 'json', '-o', '/tmp/codeburn-export', '--provider', 'all'] },
  // Plugin management
  { channel: 'codeburn:pluginList', args: [], argv: ['plugin', 'list', '--json'] },
  { channel: 'codeburn:pluginInfo', args: ['test-plugin'], argv: ['plugin', 'info', 'test-plugin', '--json'] },
  { channel: 'codeburn:pluginAdd', args: ['/path/to/plugin'], argv: ['plugin', 'add', '/path/to/plugin'] },
  { channel: 'codeburn:pluginAdd', args: ['teams'], argv: ['plugin', 'add', 'teams'] },
  { channel: 'codeburn:pluginRemove', args: ['test-plugin'], argv: ['plugin', 'remove', 'test-plugin', '--confirm'] },
  { channel: 'codeburn:pluginVerify', args: ['test-plugin'], argv: ['plugin', 'verify', 'test-plugin'] },
  // Sync auto
  { channel: 'codeburn:syncAutoStatus', args: [], argv: ['sync', 'auto', 'status', '--json'] },
  { channel: 'codeburn:syncAutoEnable', args: ['daily', false, false], argv: ['sync', 'auto', 'enable', '--cadence', 'daily'] },
  { channel: 'codeburn:syncAutoEnable', args: ['hourly', true, false], argv: ['sync', 'auto', 'enable', '--cadence', 'hourly', '--attribution'] },
  { channel: 'codeburn:syncAutoEnable', args: ['daily', false, true], argv: ['sync', 'auto', 'enable', '--cadence', 'daily', '--accept'] },
  { channel: 'codeburn:syncAutoEnable', args: ['hourly', true, true], argv: ['sync', 'auto', 'enable', '--cadence', 'hourly', '--attribution', '--accept'] },
  { channel: 'codeburn:syncAutoDisable', args: [], argv: ['sync', 'auto', 'disable'] },
]

function flattenMenuItems(items: any[]): any[] {
  return items.flatMap(item => {
    const submenu = Array.isArray(item.submenu) ? flattenMenuItems(item.submenu) : []
    return [item, ...submenu]
  })
}

describe('createBridgeHandlers (channel → argv for all channels)', () => {
  const deps = (extra = {}) => ({ spawnCli: vi.fn(), spawnCliAction: vi.fn(), resolveCodeburnPath: () => null, getQuota: vi.fn(async () => []), ...extra })
  it('exposes exactly the bridge channels', () => {
    const handlers = createBridgeHandlers(deps())
    expect(Object.keys(handlers).sort()).toEqual([...CHANNELS].sort())
  })

  it.each(ARGV_CASES)('$channel with $args spawns the expected argv', async ({ channel, args, argv }) => {
    const { spawnCli, spawnCliAction, calls } = fakeSpawn()
    const handlers = createBridgeHandlers(deps({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
    const res = await handlers[channel]!(...args)
    expect(calls[0]).toEqual(argv)
    expect(res).toMatchObject({ ok: true })
  })

  it('codeburn:cliStatus resolves from resolveCodeburnPath without spawning', async () => {
    const spawnCli = vi.fn()
    const handlers = createBridgeHandlers(deps({ spawnCli, resolveCodeburnPath: () => '/opt/homebrew/bin/codeburn' }))
    const res = await handlers['codeburn:cliStatus']!()
    expect(spawnCli).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, value: { found: true, path: '/opt/homebrew/bin/codeburn' } })
  })
})

describe('createBridgeHandlers (IPC wiring)', () => {
  const withQuota = <T extends object>(value: T) => ({ ...value, getQuota: vi.fn(async () => []) })
  it('returns normalized quota through its own IPC channel and sanitizes unexpected failures', async () => {
    const base = { spawnCli: vi.fn(), spawnCliAction: vi.fn(), resolveCodeburnPath: () => null }
    const value = [{ provider: 'claude' as const, connection: 'connected' as const, primary: null, details: [], planLabel: 'Pro', footerLines: [] }]
    const ok = createBridgeHandlers({ ...base, getQuota: vi.fn(async () => value) })
    expect(await ok['codeburn:getQuota']!()).toEqual({ ok: true, value })

    const failed = createBridgeHandlers({ ...base, getQuota: vi.fn(async () => { throw new Error('Bearer secret sk-ant-leak') }) })
    const result = await failed['codeburn:getQuota']!()
    expect(result).toMatchObject({ ok: false, error: { kind: 'nonzero' } })
    expect(JSON.stringify(result)).not.toMatch(/secret|sk-ant-leak/)
  })
  it('getOverview spawns menubar-json for the period, omitting --provider for "all"', async () => {
    const { spawnCli, spawnCliAction, calls } = fakeSpawn()
    const handlers = createBridgeHandlers(withQuota({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
    const res = await handlers['codeburn:getOverview']!('30days', 'all')
    expect(calls[0]).toEqual(['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline'])
    expect(res).toEqual({ ok: true, value: { current: { cost: 12.34 } } })
  })

  it('adds --provider and --by-task when requested', async () => {
    const { spawnCli, spawnCliAction, calls } = fakeSpawn([])
    const handlers = createBridgeHandlers(withQuota({ spawnCli, spawnCliAction, resolveCodeburnPath: () => null }))
    await handlers['codeburn:getModels']!('week', 'claude', true)
    expect(calls[0]).toEqual(['models', '--format', 'json', '--period', 'week', '--provider', 'claude', '--by-task'])
  })

  it('returns an error envelope carrying the CliError kind', async () => {
    const spawnCli = vi.fn(async () => {
      throw new CliError('nonzero', 'boom')
    })
    const handlers = createBridgeHandlers(withQuota({ spawnCli, spawnCliAction: vi.fn(), resolveCodeburnPath: () => '/bin/codeburn' }))
    const res = await handlers['codeburn:getYield']!('today', 'all')
    expect(res).toEqual({ ok: false, error: { kind: 'nonzero', message: 'boom' } })
  })

  it('cliStatus reports the resolved binary path', async () => {
    const handlers = createBridgeHandlers(withQuota({
      spawnCli: vi.fn(),
      spawnCliAction: vi.fn(),
      resolveCodeburnPath: () => '/opt/homebrew/bin/codeburn',
    }))
    const res = await handlers['codeburn:cliStatus']!()
    expect(res).toEqual({ ok: true, value: { found: true, path: '/opt/homebrew/bin/codeburn' } })
  })
})

describe('createBridgeHandlers (IPC input validation)', () => {
  const withQuota = <T extends object>(value: T) => ({ ...value, getQuota: vi.fn(async () => []) })
  const REJECTIONS: Array<{ name: string; channel: string; args: unknown[] }> = [
    { name: 'unknown period', channel: 'codeburn:getOverview', args: ['yesterday', 'all'] },
    { name: 'provider with shell metacharacters', channel: 'codeburn:getOverview', args: ['30days', 'claude; rm -rf'] },
    { name: 'uppercase provider', channel: 'codeburn:getModels', args: ['week', 'Claude', false] },
    { name: 'malformed date range', channel: 'codeburn:getYield', args: ['today', 'all', { from: '2026/07/01', to: '2026-07-11' }] },
    { name: 'lowercase currency code', channel: 'codeburn:setCurrency', args: ['eur'] },
    { name: 'alias token that looks like a flag', channel: 'codeburn:addAlias', args: ['--evil', 'safe'] },
    { name: 'device name that looks like a flag', channel: 'codeburn:removeDevice', args: ['-rf'] },
    { name: 'relative export path', channel: 'codeburn:exportData', args: ['json', 'all', 'relative/out'] },
    { name: 'compare model that looks like a flag', channel: 'codeburn:getCompare', args: ['month', 'all', '-a', 'model-b'] },
    { name: 'price override model that looks like a flag', channel: 'codeburn:setPriceOverride', args: ['-x', { input: 1, output: 2 }] },
    { name: 'non-positive price override rate', channel: 'codeburn:setPriceOverride', args: ['my-model', { input: 0, output: 2 }] },
    { name: 'non-finite price override rate', channel: 'codeburn:setPriceOverride', args: ['my-model', { input: 1, output: Number.POSITIVE_INFINITY }] },
    { name: 'remove price override model that looks like a flag', channel: 'codeburn:removePriceOverride', args: ['--all'] },
    { name: 'claude config source that looks like a flag', channel: 'codeburn:getOverview', args: ['30days', 'all', undefined, '-rf'] },
    { name: 'claude config source with shell metacharacters', channel: 'codeburn:getOverview', args: ['30days', 'all', undefined, 'id; rm -rf'] },
    { name: 'unknown scope', channel: 'codeburn:getOverview', args: ['30days', 'all', undefined, undefined, undefined, 'everything'] },
  ]

  it.each(REJECTIONS)('rejects $name with a bad-args envelope and never spawns', async ({ channel, args }) => {
    const { spawnCli, spawnCliAction } = fakeSpawn()
    const handlers = createBridgeHandlers(withQuota({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
    const res = await handlers[channel]!(...args)
    expect(res).toMatchObject({ ok: false, error: { kind: 'bad-args' } })
    expect(spawnCli).not.toHaveBeenCalled()
    expect(spawnCliAction).not.toHaveBeenCalled()
  })

  it('still accepts the valid values those cases mutate', async () => {
    const { spawnCli, spawnCliAction, calls } = fakeSpawn()
    const handlers = createBridgeHandlers(withQuota({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
    await handlers['codeburn:exportData']!('json', 'all', '/tmp/out')
    expect(calls[0]).toEqual(['export', '-f', 'json', '-o', '/tmp/out', '--provider', 'all'])
  })
})

describe('createBridgeHandlers (quota force + redaction)', () => {
  it('threads the renderer force flag into getQuota', async () => {
    const base = { spawnCli: vi.fn(), spawnCliAction: vi.fn(), resolveCodeburnPath: () => null }
    const getQuota = vi.fn(async () => [])
    const handlers = createBridgeHandlers({ ...base, getQuota })
    await handlers['codeburn:getQuota']!(true)
    expect(getQuota).toHaveBeenLastCalledWith({ force: true })
    await handlers['codeburn:getQuota']!()
    expect(getQuota).toHaveBeenLastCalledWith({ force: false })
  })

  it('redacts secrets in ActionResult.stderr before it crosses IPC', async () => {
    const spawnCliAction = vi.fn(async () => ({ ok: false, stdout: '', stderr: 'auth failed: Bearer sk-ant-leak12345', code: 1 }))
    const handlers = createBridgeHandlers({ spawnCli: vi.fn(), spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn', getQuota: vi.fn(async () => []) })
    const res = await handlers['codeburn:setCurrency']!('EUR') as { ok: true; value: { stderr: string } }
    expect(res.ok).toBe(true)
    expect(res.value.stderr).not.toMatch(/sk-ant-leak|Bearer sk-ant/)
    expect(res.value.stderr).toContain('[REDACTED]')
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

describe('createBeforeQuitHandler', () => {
  it('flushes app_close to a fast endpoint before allowing quit', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cb-main-quit-'))
    try {
      const posts: Array<{ events: Array<{ name: string }> }> = []
      const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        posts.push(JSON.parse(String(init?.body)) as { events: Array<{ name: string }> })
        return { ok: true } as Response
      }) as unknown as typeof fetch
      const telemetry = new Telemetry({ stateDir, country: 'US', isPackaged: true, appVersion: '1', fetchFn })
      telemetry.completeOnboarding(true)
      await telemetry.flush() // isolate the final beat from the onboarding app_open
      posts.length = 0

      const quit = vi.fn()
      const killChildren = vi.fn()
      const handler = createBeforeQuitHandler({ getTelemetry: () => telemetry, killAll: killChildren, quit })
      const firstEvent = { preventDefault: vi.fn() }
      handler(firstEvent)

      expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
      expect(killChildren).toHaveBeenCalledOnce()
      expect(posts).toHaveLength(1)
      expect(posts[0]!.events.map(event => event.name)).toContain('app_close')

      const finalEvent = { preventDefault: vi.fn() }
      handler(finalEvent)
      expect(finalEvent.preventDefault).not.toHaveBeenCalled()
      expect(quit).toHaveBeenCalledOnce()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('allows quit at 1500ms when the endpoint never resolves and does not re-enter', async () => {
    vi.useFakeTimers()
    try {
      const trackClose = vi.fn()
      const flush = vi.fn(() => new Promise<boolean>(() => {}))
      const quit = vi.fn()
      const handler = createBeforeQuitHandler({
        getTelemetry: () => ({ trackClose, flush }),
        killAll: vi.fn(),
        quit,
      })

      const firstEvent = { preventDefault: vi.fn() }
      handler(firstEvent)
      const repeatedEvent = { preventDefault: vi.fn() }
      handler(repeatedEvent)

      expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
      expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
      expect(trackClose).toHaveBeenCalledOnce()
      expect(flush).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1499)
      expect(quit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(quit).toHaveBeenCalledOnce()

      const finalEvent = { preventDefault: vi.fn() }
      handler(finalEvent)
      expect(finalEvent.preventDefault).not.toHaveBeenCalled()
      expect(quit).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for asynchronous child cleanup before the final exit', async () => {
    let releaseCleanup: (() => void) | undefined
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
    const quit = vi.fn()
    const handler = createBeforeQuitHandler({
      getTelemetry: () => null,
      killAll: () => cleanup,
      quit,
    })

    handler({ preventDefault: vi.fn() })
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()

    releaseCleanup?.()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  })

  it('still flushes and quits when trackClose throws synchronously', async () => {
    const trackClose = vi.fn(() => { throw new Error('track close failed') })
    const flush = vi.fn(async () => true)
    const quit = vi.fn()
    const handler = createBeforeQuitHandler({
      getTelemetry: () => ({ trackClose, flush }),
      killAll: vi.fn(),
      quit,
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(trackClose).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
  })

  it('still quits when synchronous child cleanup throws', async () => {
    const quit = vi.fn()
    const handler = createBeforeQuitHandler({
      getTelemetry: () => null,
      killAll: () => { throw new Error('child cleanup failed') },
      quit,
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  })

  it('still quits when synchronous telemetry lookup throws', async () => {
    const quit = vi.fn()
    const handler = createBeforeQuitHandler({
      getTelemetry: () => { throw new Error('telemetry lookup failed') },
      killAll: vi.fn(),
      quit,
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  })

  it('does not wait for the timeout when telemetry cannot send yet', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cb-main-no-consent-'))
    try {
      const fetchFn = vi.fn() as unknown as typeof fetch
      const telemetry = new Telemetry({ stateDir, country: 'US', isPackaged: true, appVersion: '1', fetchFn })
      const quit = vi.fn()
      const handler = createBeforeQuitHandler({ getTelemetry: () => telemetry, killAll: vi.fn(), quit })

      handler({ preventDefault: vi.fn() })
      await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('createBridgeHandlers (cold-start warmup)', () => {
  const base = (extra: object) => ({ spawnCli: vi.fn(), spawnCliAction: vi.fn(), resolveCodeburnPath: () => '/bin/codeburn', getQuota: vi.fn(async () => []), ...extra })

  it('gives the first overview a long timeout + progress env, then reverts once warmed', async () => {
    const opts: Array<Record<string, unknown> | undefined> = []
    const spawnCli = vi.fn(async (_args: string[], o?: Record<string, unknown>) => { opts.push(o); return { current: { cost: 1 } } })
    const emitProgress = vi.fn()
    const handlers = createBridgeHandlers(base({ spawnCli, emitProgress }))

    await handlers['codeburn:getOverview']!('30days', 'all')
    expect(opts[0]?.timeoutMs).toBe(10 * 60_000)
    expect((opts[0]?.extraEnv as Record<string, string> | undefined)?.CODEBURN_PROGRESS).toBe('1')
    expect(typeof opts[0]?.onStderr).toBe('function')
    expect(emitProgress).toHaveBeenCalledWith({ kind: 'done' })

    await handlers['codeburn:getOverview']!('30days', 'all')
    expect(opts[1]?.timeoutMs).toBeUndefined()
    expect(opts[1]?.extraEnv).toBeUndefined()
  })

  it('drops a warmed overview to background priority only when the prefetch flag is set', async () => {
    const opts: Array<Record<string, unknown> | undefined> = []
    const spawnCli = vi.fn(async (_args: string[], o?: Record<string, unknown>) => { opts.push(o); return { current: { cost: 1 } } })
    const handlers = createBridgeHandlers(base({ spawnCli, emitProgress: vi.fn() }))

    await handlers['codeburn:getOverview']!('30days', 'all') // cold warmup → interactive
    await handlers['codeburn:getOverview']!('30days', 'claude') // warmed, no flag → interactive
    await handlers['codeburn:getOverview']!('30days', 'grok', undefined, null, true) // prefetch → background

    expect(opts[0]?.priority).toBeUndefined()
    expect(opts[1]?.priority).toBeUndefined()
    expect(opts[2]?.priority).toBe('background')
  })

  it('classifies every first-click report warm as background without leaking the scheduler flag into argv', async () => {
    const calls: Array<{ args: string[]; opts?: Record<string, unknown> }> = []
    const spawnCli = vi.fn(async (args: string[], opts?: Record<string, unknown>) => {
      calls.push({ args, opts })
      return []
    })
    const handlers = createBridgeHandlers(base({ spawnCli }))
    const cases: Array<[string, unknown[]]> = [
      ['codeburn:getPlans', ['today', true]],
      ['codeburn:getModels', ['today', 'all', false, undefined, true]],
      ['codeburn:getSessions', ['today', 'all', undefined, true]],
      ['codeburn:getCompareModels', ['today', 'all', true]],
      ['codeburn:getYield', ['today', 'all', undefined, true]],
      ['codeburn:getSpendFlow', ['today', 'all', undefined, true]],
      ['codeburn:getOptimizeReport', ['today', 'all', undefined, true]],
    ]

    for (const [channel, args] of cases) await handlers[channel]!(...args)

    expect(calls).toHaveLength(cases.length)
    expect(calls.every(call => call.opts?.priority === 'background')).toBe(true)
    expect(calls.every(call => !call.args.includes('true'))).toBe(true)
  })

  it('re-arms the long timeout when the first overview fails (cache is still cold)', async () => {
    const opts: Array<{ timeoutMs?: number } | undefined> = []
    let n = 0
    const spawnCli = vi.fn(async (_args: string[], o?: { timeoutMs?: number }) => {
      opts.push(o)
      if (++n === 1) throw new CliError('timeout', 'timed out')
      return { current: { cost: 1 } }
    })
    const handlers = createBridgeHandlers(base({ spawnCli, emitProgress: vi.fn() }))

    expect(await handlers['codeburn:getOverview']!('30days', 'all')).toMatchObject({ ok: false })
    expect(await handlers['codeburn:getOverview']!('30days', 'all')).toMatchObject({ ok: true })
    expect(opts[0]?.timeoutMs).toBe(10 * 60_000)
    expect(opts[1]?.timeoutMs).toBe(10 * 60_000)
  })

  it('gives every section read the cold floor while hydration is still running', async () => {
    // The repro: the moment `ready` flipped, act report / plan spawned with the
    // plain 45s cap and were killed waiting behind the cold parse's lock.
    const opts: Array<{ timeoutMs?: number } | undefined> = []
    const spawnCli = vi.fn(async (_args: string[], o?: { timeoutMs?: number }) => {
      opts.push(o)
      return { current: { cost: 1 } }
    })
    const handlers = createBridgeHandlers(base({ spawnCli, emitProgress: vi.fn() }))

    await handlers['codeburn:getActReport']!()
    await handlers['codeburn:getPlans']!('30days')
    await handlers['codeburn:getOptimizeReport']!('30days', 'all')
    expect(opts.map(o => o?.timeoutMs)).toEqual([10 * 60_000, 10 * 60_000, 10 * 60_000])

    // Once the overview lands, the cold cache is hot and reads revert to the
    // plain default so a genuinely stuck child is still caught quickly.
    await handlers['codeburn:getOverview']!('30days', 'all')
    await handlers['codeburn:getActReport']!()
    expect(opts[4]?.timeoutMs).toBeUndefined()
  })

  it('flags a cold-hydration timeout so the renderer keeps the splash', async () => {
    const spawnCli = vi.fn(async () => { throw new CliError('timeout', 'no output for 45000ms') })
    const handlers = createBridgeHandlers(base({ spawnCli, emitProgress: vi.fn() }))

    expect(await handlers['codeburn:getActReport']!())
      .toMatchObject({ ok: false, error: { kind: 'timeout', cold: true } })
    expect(await handlers['codeburn:getOverview']!('30days', 'all'))
      .toMatchObject({ ok: false, error: { kind: 'timeout', cold: true } })
  })

  it('gives up the cold claim once the cold window itself has elapsed', async () => {
    // Without a bound this is a forever-splash: overviewWarmed only flips on
    // success, so an install that can never hydrate would keep every timeout
    // tagged cold and never reach the real error panel (or its CLI recovery).
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-16T00:00:00Z'))
      const spawnCli = vi.fn(async () => { throw new CliError('timeout', 'no output for 45000ms') })
      const handlers = createBridgeHandlers(base({ spawnCli, emitProgress: vi.fn() }))

      expect(await handlers['codeburn:getOverview']!('30days', 'all'))
        .toMatchObject({ ok: false, error: { cold: true } })

      // Past the 10-minute cold floor, still failing: this is an error, not news
      // that indexing is in progress.
      vi.setSystemTime(new Date('2026-08-16T00:10:01Z'))
      const late = await handlers['codeburn:getOverview']!('30days', 'all') as { error: { kind: string; cold?: true } }
      expect(late.error.kind).toBe('timeout')
      expect(late.error.cold).toBeUndefined()
      expect((await handlers['codeburn:getActReport']!() as { error: { cold?: true } }).error.cold).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never flags a non-timeout failure as cold (a real error is real news)', async () => {
    const spawnCli = vi.fn(async () => { throw new CliError('nonzero', 'permission denied') })
    const handlers = createBridgeHandlers(base({ spawnCli, emitProgress: vi.fn() }))

    const res = await handlers['codeburn:getActReport']!() as { error: { cold?: true } }
    expect(res.error.cold).toBeUndefined()
  })

  it('parses CLI scan-progress stderr lines and forwards them to emitProgress', async () => {
    const spawnCli = vi.fn(async (_args: string[], o?: { onStderr?: (chunk: string) => void }) => {
      // A split line proves the reader buffers across chunks.
      o?.onStderr?.('CODEBURN_PROGRESS {"kind":"providers","providers":["claude","codex"]}\nCODEBURN_PROG')
      o?.onStderr?.('RESS {"kind":"tick","provider":"claude","done":5,"total":10}\nnoise line\n')
      return { current: { cost: 1 } }
    })
    const emitProgress = vi.fn()
    const handlers = createBridgeHandlers(base({ spawnCli, emitProgress }))
    await handlers['codeburn:getOverview']!('30days', 'all')

    expect(emitProgress).toHaveBeenCalledWith({ kind: 'providers', providers: ['claude', 'codex'] })
    expect(emitProgress).toHaveBeenCalledWith({ kind: 'tick', provider: 'claude', done: 5, total: 10 })
  })
})

describe('createBridgeHandlers (telemetry wiring)', () => {
  const fakeTelemetry = () => ({
    status: vi.fn(() => ({ installId: 'id-1', country: 'US', enabled: true, defaultEnabled: true, onboarded: false })),
    setEnabled: vi.fn((enabled: boolean) => ({ installId: 'id-2', country: 'US', enabled, defaultEnabled: true, onboarded: false })),
    completeOnboarding: vi.fn((enabled: boolean) => ({ installId: 'id-1', country: 'US', enabled, defaultEnabled: true, onboarded: true })),
    track: vi.fn(),
  })
  const deps = (telemetry: ReturnType<typeof fakeTelemetry> | null) => ({
    spawnCli: vi.fn(async () => ({ current: { cost: 1 } })),
    spawnCliAction: vi.fn(),
    resolveCodeburnPath: () => '/bin/codeburn',
    getQuota: vi.fn(async () => []),
    emitProgress: vi.fn(),
    telemetry,
  })

  it('exposes status/consent/track channels and forwards to the telemetry service', async () => {
    const telemetry = fakeTelemetry()
    const handlers = createBridgeHandlers(deps(telemetry))

    expect(await handlers['codeburn:telemetryStatus']!()).toMatchObject({ ok: true, value: { installId: 'id-1', onboarded: false } })
    expect(await handlers['codeburn:telemetrySetEnabled']!(false)).toMatchObject({ ok: true, value: { enabled: false } })
    expect(telemetry.setEnabled).toHaveBeenCalledWith(false)
    expect(await handlers['codeburn:telemetryOnboarded']!(true)).toMatchObject({ ok: true, value: { onboarded: true } })
    expect(telemetry.completeOnboarding).toHaveBeenCalledWith(true)
    await handlers['codeburn:telemetryTrack']!('section_view', { section: 'spend' })
    expect(telemetry.track).toHaveBeenCalledWith('section_view', { section: 'spend' })
  })

  it('returns null (not an error) when telemetry is unavailable', async () => {
    const handlers = createBridgeHandlers(deps(null))
    expect(await handlers['codeburn:telemetryStatus']!()).toEqual({ ok: true, value: null })
    expect(await handlers['codeburn:telemetryTrack']!('section_view', {})).toEqual({ ok: true, value: true })
  })

  it('tracks cold_start once on the first overview success, with duration', async () => {
    const telemetry = fakeTelemetry()
    const handlers = createBridgeHandlers(deps(telemetry))
    await handlers['codeburn:getOverview']!('30days', 'all')
    await handlers['codeburn:getOverview']!('30days', 'all')
    const coldStarts = telemetry.track.mock.calls.filter(([name]) => name === 'cold_start')
    expect(coldStarts.length).toBe(1)
    expect(coldStarts[0]![1]).toMatchObject({ timedOut: false })
    expect(typeof (coldStarts[0]![1] as { ms: number }).ms).toBe('number')
  })

  it('records cold_start exactly once across coalesced re-polls, with the first-attempt duration (no cumulative ladder)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const telemetry = fakeTelemetry()
      // Coalescing: every same-arg cold re-poll joins the ONE in-flight child.
      let release!: (v: unknown) => void
      const shared = new Promise(res => { release = res })
      const spawnCli = vi.fn(() => shared)
      const handlers = createBridgeHandlers({ ...deps(telemetry), spawnCli })

      const p1 = handlers['codeburn:getOverview']!('30days', 'all') // anchors cold clock at t=0
      vi.setSystemTime(30_000)
      const p2 = handlers['codeburn:getOverview']!('30days', 'all')
      vi.setSystemTime(60_000)
      const p3 = handlers['codeburn:getOverview']!('30days', 'all')

      // The stuck child finally settles ~102.8s after launch.
      vi.setSystemTime(102_801)
      release({ current: { cost: 1 } })
      await Promise.all([p1, p2, p3])

      const coldStarts = telemetry.track.mock.calls.filter(([name]) => name === 'cold_start')
      expect(coldStarts.length).toBe(1)
      // One row, first-attempt duration — not the old 42801→72800→102801 ladder.
      expect(coldStarts[0]![1]).toMatchObject({ ms: 102_801, timedOut: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('records cold_start with timedOut:true when the first (cold) overview attempt times out', async () => {
    const telemetry = fakeTelemetry()
    const spawnCli = vi.fn(async () => { throw new CliError('timeout', 'timed out') })
    const handlers = createBridgeHandlers({ ...deps(telemetry), spawnCli })
    await handlers['codeburn:getOverview']!('30days', 'all')
    const coldStarts = telemetry.track.mock.calls.filter(([name]) => name === 'cold_start')
    expect(coldStarts.length).toBe(1)
    expect(coldStarts[0]![1]).toMatchObject({ timedOut: true })
  })

  it('does not re-emit cold_start on a warmup re-arm, keeping the first attempt timedOut:true', async () => {
    const telemetry = fakeTelemetry()
    let n = 0
    const spawnCli = vi.fn(async () => {
      if (++n === 1) throw new CliError('timeout', 'timed out') // first cold attempt: final timeout
      return { current: { cost: 1 } } // re-armed cold attempt succeeds
    })
    const handlers = createBridgeHandlers({ ...deps(telemetry), spawnCli })
    await handlers['codeburn:getOverview']!('30days', 'all')
    await handlers['codeburn:getOverview']!('30days', 'all')
    const coldStarts = telemetry.track.mock.calls.filter(([name]) => name === 'cold_start')
    expect(coldStarts.length).toBe(1)
    expect(coldStarts[0]![1]).toMatchObject({ timedOut: true })
  })

  it('tracks cli_error with the failing kind and the CLI subcommand (cmd = argv[0])', async () => {
    const telemetry = fakeTelemetry()
    const failing = {
      ...deps(telemetry),
      spawnCli: vi.fn(async () => { throw new CliError('timeout', 'timed out') }),
    }
    const handlers = createBridgeHandlers(failing)
    await handlers['codeburn:getSessions']!('week', 'all')
    expect(telemetry.track).toHaveBeenCalledWith('cli_error', { cmd: 'sessions', kind: 'timeout' })
  })

  it('includes the resolution-stage detail for a not-found (self-diagnosing without a repro)', async () => {
    const telemetry = fakeTelemetry()
    const failing = {
      ...deps(telemetry),
      // Mirrors the Windows P0: bundled path present but rejected by the resolver.
      spawnCli: vi.fn(async () => { throw new CliError('not-found', 'codeburn CLI not found', 'bundled-not-absolute') }),
    }
    const handlers = createBridgeHandlers(failing)
    await handlers['codeburn:getPlans']!('week')
    expect(telemetry.track).toHaveBeenCalledWith('cli_error', { cmd: 'status', kind: 'not-found', detail: 'bundled-not-absolute' })
  })

  it('never leaks a path or message into cli_error telemetry, even when the error carries one', async () => {
    const telemetry = fakeTelemetry()
    const failing = {
      ...deps(telemetry),
      // A spawn-time ENOENT whose message embeds a filesystem path.
      spawnCli: vi.fn(async () => {
        throw new CliError('not-found', 'spawn C:\\Users\\alice\\secret\\codeburn.exe ENOENT', 'spawn-error')
      }),
    }
    const handlers = createBridgeHandlers(failing)
    await handlers['codeburn:getSessions']!('week', 'all')
    const props = telemetry.track.mock.calls.find(([name]) => name === 'cli_error')![1] as Record<string, unknown>
    expect(props).toEqual({ cmd: 'sessions', kind: 'not-found', detail: 'spawn-error' })
    expect(JSON.stringify(props)).not.toContain('secret')
    expect(JSON.stringify(props)).not.toContain('C:\\')
  })
})

// The renderer hands this a URL and the main process hands it to the shell, so the guard is
// what keeps a page from opening anything but the web. See app/electron/main.ts.
describe('externalUrlToOpen', () => {
  it('allows the web and nothing else', () => {
    expect(externalUrlToOpen('https://github.com/getagentseal/codeburn')).toBe('https://github.com/getagentseal/codeburn')
    expect(externalUrlToOpen('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(externalUrlToOpen('file:///etc/passwd')).toBeNull()
    expect(externalUrlToOpen('javascript:alert(1)')).toBeNull()
    expect(externalUrlToOpen('not a url')).toBeNull()
    expect(externalUrlToOpen('')).toBeNull()
  })

  // The one exception, by exact value: the Store build's Menu bar pane opens the Windows page
  // that owns launch at login there.
  it('allows the Windows startup-apps page on Windows, by exact value', () => {
    expect(externalUrlToOpen('ms-settings:startupapps', 'win32')).toBe('ms-settings:startupapps')
    expect(externalUrlToOpen('ms-settings:startupapps', 'darwin')).toBeNull()
    expect(externalUrlToOpen('ms-settings:privacy-webcam', 'win32')).toBeNull()
    expect(externalUrlToOpen('ms-settings:startupapps&more', 'win32')).toBeNull()
  })
})

describe('project filter', () => {
  const deps = (extra = {}) => ({ spawnCli: vi.fn(), spawnCliAction: vi.fn(), resolveCodeburnPath: () => null, getQuota: vi.fn(async () => []), ...extra })

  // The suite runs with CODEBURN_APP_FILTER='' (vitest.config.ts): a real
  // filter file must not reach any other assertion.
  async function withFilterFile<T>(body: (filterPath: string) => T | Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'codeburn-filter-'))
    const previous = process.env.CODEBURN_APP_FILTER
    process.env.CODEBURN_APP_FILTER = join(dir, 'app-filter.json')
    try {
      // Awaited, or the finally would undo it at the body's first await.
      return await body(process.env.CODEBURN_APP_FILTER)
    } finally {
      if (previous === undefined) delete process.env.CODEBURN_APP_FILTER
      else process.env.CODEBURN_APP_FILTER = previous
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('reads an empty filter when no file exists', async () => {
    await withFilterFile(() => {
      expect(readProjectFilter()).toEqual({ project: [], exclude: [] })
    })
  })

  it('round-trips a saved filter and scopes every fetch by it', async () => {
    await withFilterFile(async () => {
      expect(writeProjectFilter({ project: ['my-company'], exclude: ['scratch'] }))
        .toEqual({ project: ['my-company'], exclude: ['scratch'] })
      expect(readProjectFilter()).toEqual({ project: ['my-company'], exclude: ['scratch'] })

      const { spawnCli, spawnCliAction, calls } = fakeSpawn()
      const handlers = createBridgeHandlers(deps({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
      await handlers['codeburn:getSessions']!('week', 'all')
      expect(calls[0]).toEqual(['sessions', '--format', 'json', '--period', 'week', '--project=my-company', '--exclude=scratch'])
    })
  })

  it('leaves the Projects pane fetch unfiltered so hidden projects stay listable', async () => {
    await withFilterFile(async () => {
      writeProjectFilter({ project: [], exclude: ['my-company'] })
      const { spawnCli, spawnCliAction, calls } = fakeSpawn()
      const handlers = createBridgeHandlers(deps({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
      await handlers['codeburn:getUnfilteredProjects']!('30days')
      expect(calls[0]).toEqual(['report', '--format', 'json', '--period', '30days'])
    })
  })

  it('serves the local filtered overview when combined is asked for with a filter set', async () => {
    await withFilterFile(async () => {
      writeProjectFilter({ project: [], exclude: ['my-company'] })
      const { spawnCli, spawnCliAction, calls } = fakeSpawn()
      const handlers = createBridgeHandlers(deps({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
      await handlers['codeburn:getOverview']!('30days', 'all', undefined, undefined, undefined, 'combined')
      // No --scope combined: the CLI rejects it next to --exclude.
      expect(calls[0]).toEqual(['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--exclude=my-company'])
    })
  })

  it('still emits combined scope once the filter is empty again', async () => {
    await withFilterFile(async () => {
      writeProjectFilter({ project: [], exclude: [] })
      const { spawnCli, spawnCliAction, calls } = fakeSpawn()
      const handlers = createBridgeHandlers(deps({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
      await handlers['codeburn:getOverview']!('30days', 'all', undefined, undefined, undefined, 'combined')
      expect(calls[0]).toEqual(['status', '--format', 'menubar-json', '--period', '30days', '--no-timeline', '--scope', 'combined'])
    })
  })

  it('drops blanks and duplicates on write, but keeps encoded names starting with "-"', async () => {
    await withFilterFile(() => {
      expect(writeProjectFilter({ project: ['  my-company  ', 'my-company', '', '-Users-me-Web-my-company', 7], exclude: 7 }))
        .toEqual({ project: ['my-company', '-Users-me-Web-my-company'], exclude: [] })
    })
  })

  it('expands a leading ~ so the pane and the CLI resolve the same path', async () => {
    await withFilterFile(filterPath => {
      const home = homedir().replace(/\\/g, '/')
      expect(writeProjectFilter({ project: ['~/work/app'], exclude: ['~'] }))
        .toEqual({ project: [`${home}/work/app`], exclude: [home] })
      // Also on the way out: the file can be hand-edited with a tilde the
      // renderer has no way to resolve.
      writeFileSync(filterPath, JSON.stringify({ exclude: ['~/work/other'] }))
      expect(readProjectFilter()).toEqual({ project: [], exclude: [`${home}/work/other`] })
    })
  })

  it('reads a hand-written bare string as one pattern instead of dropping it', async () => {
    await withFilterFile(filterPath => {
      writeFileSync(filterPath, JSON.stringify({ exclude: 'my-company' }))
      expect(readProjectFilter()).toEqual({ project: [], exclude: ['my-company'] })
    })
  })

  it('carries the filter into an export, which writes project names to a file', async () => {
    await withFilterFile(async () => {
      writeProjectFilter({ project: [], exclude: ['my-company'] })
      const { spawnCli, spawnCliAction, calls } = fakeSpawn()
      const handlers = createBridgeHandlers(deps({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
      await handlers['codeburn:exportData']!('csv', 'all', '/tmp/out')
      expect(calls[0]).toContain('--exclude=my-company')
    })
  })

  it('passes a pattern starting with "-" as --opt=value so it cannot parse as a flag', async () => {
    await withFilterFile(async () => {
      writeProjectFilter({ project: [], exclude: ['-Users-me-Web-Github-notes-app'] })
      const { spawnCli, spawnCliAction, calls } = fakeSpawn()
      const handlers = createBridgeHandlers(deps({ spawnCli, spawnCliAction, resolveCodeburnPath: () => '/bin/codeburn' }))
      await handlers['codeburn:getSessions']!('week', 'all')
      expect(calls[0]).toEqual(['sessions', '--format', 'json', '--period', 'week', '--exclude=-Users-me-Web-Github-notes-app'])
    })
  })

  it('keeps the last known filter when the file is malformed rather than unhiding', async () => {
    await withFilterFile(filterPath => {
      writeProjectFilter({ project: [], exclude: ['my-company'] })
      expect(readProjectFilter()).toEqual({ project: [], exclude: ['my-company'] })
      writeFileSync(filterPath, '{ not json')
      expect(readProjectFilter()).toEqual({ project: [], exclude: ['my-company'] })
    })
  })

  it('shows everything again once the file is gone', async () => {
    await withFilterFile(filterPath => {
      writeProjectFilter({ project: [], exclude: ['my-company'] })
      expect(readProjectFilter()).toEqual({ project: [], exclude: ['my-company'] })
      rmSync(filterPath)
      expect(readProjectFilter()).toEqual({ project: [], exclude: [] })
    })
  })

  it('picks up an edit made outside the app', async () => {
    await withFilterFile(filterPath => {
      writeProjectFilter({ project: ['my-company'], exclude: [] })
      expect(readProjectFilter()).toEqual({ project: ['my-company'], exclude: [] })
      // No utimes bump: same millisecond, so only size and inode catch it.
      writeFileSync(filterPath, JSON.stringify({ project: ['side-project'], exclude: [] }))
      expect(readProjectFilter()).toEqual({ project: ['side-project'], exclude: [] })
    })
  })

  it('persists nothing while the filter is disabled by env', () => {
    const previous = process.env.CODEBURN_APP_FILTER
    process.env.CODEBURN_APP_FILTER = ''
    try {
      expect(writeProjectFilter({ project: ['my-company'], exclude: [] })).toEqual({ project: [], exclude: [] })
      expect(readProjectFilter()).toEqual({ project: [], exclude: [] })
    } finally {
      if (previous === undefined) delete process.env.CODEBURN_APP_FILTER
      else process.env.CODEBURN_APP_FILTER = previous
    }
  })
})
