import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { readSettings, refreshIntervalMs, webviewSeed } from '../src/settings'

const from = (values: Record<string, unknown>) => (key: string) => values[key]

describe('readSettings', () => {
  it('fills every default', () => {
    const settings = readSettings(from({}))
    expect(settings).toEqual({
      workspaceOnly: true,
      defaultPeriod: 'today',
      refreshInterval: '1m',
      statusBarFormat: 'cost',
      currency: '',
      provider: 'all',
      quotaProviders: ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'zcode', 'grokbot'],
      nodePath: '',
    })
  })

  it('rejects hand-edited values it cannot use', () => {
    const settings = readSettings(from({
      workspaceOnly: false,
      defaultPeriod: 'yesterday',
      refreshInterval: '2s',
      'statusBar.format': 'loud',
      currency: 'eur',
      provider: '--provider; rm',
      quotaProviders: ['codex', 'nope', 'claude'],
      nodePath: '  /usr/local/bin/node ',
    }))
    expect(settings.workspaceOnly).toBe(false)
    expect(settings.defaultPeriod).toBe('today')
    expect(settings.refreshInterval).toBe('1m')
    expect(settings.statusBarFormat).toBe('cost')
    expect(settings.currency).toBe('')
    expect(settings.provider).toBe('all')
    expect(settings.quotaProviders).toEqual(['claude', 'codex'])
    expect(settings.nodePath).toBe('/usr/local/bin/node')
  })

  it('keeps valid values', () => {
    const settings = readSettings(from({ defaultPeriod: 'month', refreshInterval: 'manual', 'statusBar.format': 'costAndQuota', currency: 'EUR', provider: 'cursor', quotaProviders: [] }))
    expect(settings).toMatchObject({ defaultPeriod: 'month', refreshInterval: 'manual', statusBarFormat: 'costAndQuota', currency: 'EUR', provider: 'cursor', quotaProviders: [] })
  })
})

describe('refreshIntervalMs', () => {
  it('maps the renderer cadence values', () => {
    expect(refreshIntervalMs('30s')).toBe(30_000)
    expect(refreshIntervalMs('10m')).toBe(600_000)
    expect(refreshIntervalMs('manual')).toBeNull()
  })
})

describe('webviewSeed', () => {
  it('writes the renderer keys the editor settings own', () => {
    const seed = webviewSeed(readSettings(from({ defaultPeriod: 'week', refreshInterval: '5m', quotaProviders: ['claude'] })))
    expect(seed['codeburn.defaultPeriod']).toBe('week')
    expect(seed['codeburn.refreshInterval']).toBe('5m')
    expect(JSON.parse(seed['codeburn.quotaDisabled']!)).toEqual(['codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'zcode', 'grokbot'])
  })
})

describe('setting scopes', () => {
  const properties = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).contributes.configuration.properties

  it('keeps credentialed and shared settings out of a workspace', () => {
    for (const key of ['codeburn.currency', 'codeburn.provider', 'codeburn.quotaProviders']) expect(properties[key].scope).toBe('application')
    expect(properties['codeburn.nodePath'].scope).toBe('machine')
  })
})
