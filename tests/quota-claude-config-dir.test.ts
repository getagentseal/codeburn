import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { claudeKeychainService, fetchClaudeQuota } from '../src/quota/claude.js'

const usage = JSON.stringify({ seven_day: { utilization: 40, resets_at: '2026-07-19T12:00:00Z' } })
const stored = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } })

describe('Claude quota for a non-default CLAUDE_CONFIG_DIR', () => {
  it('suffixes the Keychain service with the first 8 hex chars of sha256(dir)', () => {
    expect(claudeKeychainService('/home/alice/.claude-work')).toBe('Claude Code-credentials-f0fc2950')
    expect(claudeKeychainService('/home/alice/.claude-personal')).toBe('Claude Code-credentials-37d3c5f5')
  })

  it('keeps the unsuffixed service for ~/.claude', () => {
    expect(claudeKeychainService(path.join(os.homedir(), '.claude'))).toBe('Claude Code-credentials')
  })

  it('reads the named profile file and Keychain item, not ~/.claude', async () => {
    const dir = '/home/alice/.claude-personal'
    const readFile = vi.fn(async () => null)
    const requested: string[] = []
    const keychain = vi.fn()
    const result = await fetchClaudeQuota({
      configDir: dir,
      allowKeychain: true,
      wslCredentialPaths: () => [],
      readFile: readFile as never,
      fetch: vi.fn(async () => new Response(usage, { status: 200 })) as unknown as typeof fetch,
      keychain: async () => { keychain(); return { status: 'found', value: stored } },
    })
    requested.push(...readFile.mock.calls.map(call => String((call as unknown[])[0])))
    expect(requested).toEqual([path.join(dir, '.credentials.json')])
    expect(keychain).toHaveBeenCalledTimes(1)
    expect(result.quota.connection).toBe('connected')
    expect(result.quota.planLabel).toBe('Max 20x')
  })
})

describe('Claude quota with a stale credential file', () => {
  const dir = '/home/alice/.claude-personal'
  const expired = JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: 1 } })
  const live = JSON.stringify({ claudeAiOauth: { accessToken: 'live', expiresAt: Date.now() + 3_600_000 } })
  const run = (keychain: () => Promise<{ status: 'found'; value: string } | { status: 'notFound' }>, allowKeychain = true) => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(usage, { status: 200 }))
    const result = fetchClaudeQuota({
      configDir: dir, allowKeychain, wslCredentialPaths: () => [],
      readFile: (async () => expired) as never,
      fetch: fetchMock as unknown as typeof fetch,
      keychain,
    })
    return { result, auth: async () => { await result; return (fetchMock.mock.calls[0]?.[1].headers as Record<string, string> | undefined)?.Authorization } }
  }

  it.runIf(process.platform === 'darwin')('prefers the Keychain over a file whose token has expired', async () => {
    const { auth } = run(async () => ({ status: 'found', value: live }))
    expect(await auth()).toBe('Bearer live')
  })

  it.runIf(process.platform === 'darwin')('keeps the expired file when the Keychain has nothing', async () => {
    const { auth } = run(async () => ({ status: 'notFound' }))
    expect(await auth()).toBe('Bearer old')
  })

  it('never reads the Keychain unless allowed', async () => {
    const keychain = vi.fn(async () => ({ status: 'found' as const, value: live }))
    const { auth } = run(keychain, false)
    expect(await auth()).toBe('Bearer old')
    expect(keychain).not.toHaveBeenCalled()
  })
})
