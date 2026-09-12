// The Copilot quota adapter used to look only at ~/.config/github-copilot,
// which does not exist on Windows: the plugins write hosts.json / apps.json
// under %LOCALAPPDATA%\github-copilot there, so a signed-in Windows user read
// as "not connected". These tests pin the per-platform directory order and
// prove the Windows path is actually read.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copilotConfigDirs, fetchCopilotQuota } from '../src/quota/copilot.js'

const realPlatform = process.platform

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function usageResponse(): Response {
  return new Response(
    JSON.stringify({ copilot_plan: 'individual', quota_snapshots: { premium_interactions: { percent_remaining: 70 } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codeburn-copilot-win-'))
})

afterEach(async () => {
  setPlatform(realPlatform)
  await rm(root, { recursive: true, force: true })
})

describe('Copilot credential directories', () => {
  it('prefers %LOCALAPPDATA% on Windows and keeps the XDG path as a fallback', () => {
    const dirs = copilotConfigDirs('win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'C:\\Users\\dev')
    expect(dirs).toEqual([
      path.join('C:\\Users\\dev\\AppData\\Local', 'github-copilot'),
      path.join('C:\\Users\\dev', '.config', 'github-copilot'),
    ])
  })

  it('derives the Windows directory from the home folder when LOCALAPPDATA is unset', () => {
    const dirs = copilotConfigDirs('win32', {}, 'C:\\Users\\dev')
    expect(dirs[0]).toBe(path.join('C:\\Users\\dev', 'AppData', 'Local', 'github-copilot'))
  })

  it('reads only the XDG path off Windows', () => {
    expect(copilotConfigDirs('darwin', { LOCALAPPDATA: 'C:\\ignored' }, '/Users/dev'))
      .toEqual([path.join('/Users/dev', '.config', 'github-copilot')])
  })
})

describe('Copilot quota on Windows', () => {
  it('finds the plugin token under %LOCALAPPDATA% with no explicit path', async () => {
    await mkdir(path.join(root, 'github-copilot'), { recursive: true })
    await writeFile(
      path.join(root, 'github-copilot', 'hosts.json'),
      JSON.stringify({ 'github.com': { oauth_token: 'gho_windowsfixture' } }),
      'utf8',
    )
    setPlatform('win32')
    process.env['LOCALAPPDATA'] = root

    const seen: string[] = []
    const result = await fetchCopilotQuota({
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>)['Authorization']))
        return usageResponse()
      }) as unknown as typeof fetch,
      env: {},
      ghConfigPaths: [],
    })

    expect(result.quota.connection).toBe('connected')
    expect(result.quota.primary).toEqual({ label: 'Premium requests', percent: 0.3, resetsAt: null })
    expect(seen).toEqual(['token gho_windowsfixture'])
  })

  it('falls back to apps.json in the same directory', async () => {
    await mkdir(path.join(root, 'github-copilot'), { recursive: true })
    await writeFile(path.join(root, 'github-copilot', 'hosts.json'), '{ not json', 'utf8')
    await writeFile(
      path.join(root, 'github-copilot', 'apps.json'),
      JSON.stringify({ 'github.com:Iv1.abc': { oauth_token: 'gho_appsfixture' } }),
      'utf8',
    )
    setPlatform('win32')
    process.env['LOCALAPPDATA'] = root

    const seen: string[] = []
    const result = await fetchCopilotQuota({
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>)['Authorization']))
        return usageResponse()
      }) as unknown as typeof fetch,
      env: {},
      ghConfigPaths: [],
    })

    expect(result.quota.connection).toBe('connected')
    expect(seen).toEqual(['token gho_appsfixture'])
  })

  it('ignores the Windows directory on other platforms and never fetches', async () => {
    await mkdir(path.join(root, 'github-copilot'), { recursive: true })
    await writeFile(
      path.join(root, 'github-copilot', 'hosts.json'),
      JSON.stringify({ 'github.com': { oauth_token: 'gho_windowsfixture' } }),
      'utf8',
    )
    setPlatform('darwin')
    process.env['LOCALAPPDATA'] = root

    const result = await fetchCopilotQuota({
      fetch: (() => { throw new Error('the test must not reach the network') }) as unknown as typeof fetch,
      configDirs: copilotConfigDirs('darwin', process.env, root),
      env: {},
      ghConfigPaths: [],
    })

    expect(result.quota.connection).toBe('disconnected')
  })
})
