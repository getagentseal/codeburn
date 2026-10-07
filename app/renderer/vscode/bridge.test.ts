// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { createBridge, scopedStorage, themeFromBody, type Boot } from './bridge'

const boot: Boot = {
  view: 'dashboard',
  version: '1.0.0',
  platform: 'darwin',
  arch: 'arm64',
  locale: 'ja',
  scope: { workspace: true, label: 'codeburn', id: 'abc' },
  seed: {},
}

function setup(overrides: Partial<Boot> = {}) {
  const posted: unknown[] = []
  const api = { postMessage: vi.fn((message: unknown) => { posted.push(message) }) }
  const bridge = createBridge(api as never, { ...boot, ...overrides }, window)
  const reply = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }))
  return { bridge, posted, reply }
}

describe('createBridge', () => {
  it('sends each call as a numbered invoke on the codeburn: channel', async () => {
    const { bridge, posted, reply } = setup()
    const pending = bridge.getOverview('today', 'all')
    expect(posted[0]).toEqual({ type: 'invoke', id: 1, channel: 'codeburn:getOverview', args: ['today', 'all'] })
    reply({ type: 'result', id: 1, envelope: { ok: true, value: { current: { cost: 3 } } } })
    await expect(pending).resolves.toEqual({ current: { cost: 3 } })
  })

  it('rejects with the structured error so the renderer keeps its kind', async () => {
    const { bridge, reply } = setup()
    const pending = bridge.getSessions('week', 'all')
    reply({ type: 'result', id: 1, envelope: { ok: false, error: { kind: 'timeout', message: 'slow', cold: true } } })
    await expect(pending).rejects.toEqual({ kind: 'timeout', message: 'slow', cold: true })
  })

  it('answers telemetry and update checks itself, without a message', async () => {
    const { bridge, posted } = setup()
    expect(await bridge.telemetryStatus()).toBeNull()
    expect(await bridge.telemetryTrack('section_view', { section: 'overview' })).toBe(true)
    expect((await bridge.getUpdateStatus()).updateAvailable).toBe(false)
    expect(posted).toEqual([])
    expect(bridge.companionInstall).toBeUndefined()
    expect(bridge.macMenubarInstall).toBeUndefined()
  })

  it('exposes the host, platform, locale and scope', () => {
    const { bridge } = setup()
    expect(bridge.host).toBe('vscode')
    expect(bridge.hostVersion).toBe('1.0.0')
    expect(bridge.platform).toBe('darwin')
    expect(bridge.appLocale).toBe('ja')
    expect(bridge.ideScope).toEqual({ workspace: true, label: 'codeburn' })
  })

  it('streams progress to subscribers until they unsubscribe', () => {
    const { bridge, reply } = setup()
    const seen: unknown[] = []
    const off = bridge.onProgress(event => seen.push(event))
    reply({ type: 'progress', event: { kind: 'done' } })
    off()
    reply({ type: 'progress', event: { kind: 'late' } })
    expect(seen).toEqual([{ kind: 'done' }])
  })

  it('holds editor commands until the app subscribes, the boot command first', () => {
    const { bridge, reply } = setup({ command: { section: 'optimize' } })
    reply({ type: 'command', command: { refresh: true } })
    const seen: unknown[] = []
    bridge.onIdeCommand!(command => seen.push(command))
    reply({ type: 'command', command: { period: 'today' } })
    expect(seen).toEqual([{ section: 'optimize' }, { refresh: true }, { period: 'today' }])
  })

  it('ignores results for calls it never made', () => {
    const { reply } = setup()
    expect(() => reply({ type: 'result', id: 99, envelope: { ok: true, value: 1 } })).not.toThrow()
    expect(() => reply(null)).not.toThrow()
  })
})

describe('scopedStorage', () => {
  it('keeps each scope to its own keys, length and key() included', () => {
    localStorage.clear()
    const all = scopedStorage(localStorage, 'all|')
    const ws = scopedStorage(localStorage, 'abc|')
    all.setItem('codeburn.navState.v1', 'A')
    ws.setItem('codeburn.navState.v1', 'B')
    ws.setItem('codeburn.snapshot.x', 'C')
    expect(all.getItem('codeburn.navState.v1')).toBe('A')
    expect(ws.getItem('codeburn.navState.v1')).toBe('B')
    expect(all.length).toBe(1)
    expect(ws.length).toBe(2)
    expect([ws.key(0), ws.key(1)].sort()).toEqual(['codeburn.navState.v1', 'codeburn.snapshot.x'])
    ws.clear()
    expect(ws.length).toBe(0)
    expect(all.getItem('codeburn.navState.v1')).toBe('A')
  })
})

describe('themeFromBody', () => {
  const body = (className: string) => Object.assign(document.createElement('body'), { className })
  it('maps every VS Code theme kind', () => {
    expect(themeFromBody(body('vscode-light'))).toEqual({ theme: 'light', highContrast: false })
    expect(themeFromBody(body('vscode-dark'))).toEqual({ theme: 'dark', highContrast: false })
    expect(themeFromBody(body('vscode-high-contrast'))).toEqual({ theme: 'dark', highContrast: true })
    expect(themeFromBody(body('vscode-high-contrast-light'))).toEqual({ theme: 'light', highContrast: true })
  })
})
