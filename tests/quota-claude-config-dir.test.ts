import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { claudeKeychainService, fetchClaudeQuota } from '../src/quota/claude.js'
import { availableReaders } from '../src/quota/index.js'
import { readKeychainPassword } from '../src/quota/security.js'

// Every Keychain lookup is answered here; no test reaches /usr/bin/security.
vi.mock('../src/quota/security.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/quota/security.js')>(),
  readKeychainPassword: vi.fn(),
}))

const keychain = vi.mocked(readKeychainPassword)
const NOW = 1_760_000_000_000
const WORK = '/home/alice/.claude-work'
const usage = JSON.stringify({ seven_day: { utilization: 40, resets_at: '2026-07-19T12:00:00Z' } })
const login = (accessToken: string, expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, rateLimitTier: 'max_20x' } })

function run(options: { configDir: string; file?: string; allowKeychain?: boolean }) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(usage, { status: 200 }))
  const readFile = vi.fn(async (_file: string) => options.file ?? null)
  const result = fetchClaudeQuota({
    configDir: options.configDir,
    allowKeychain: options.allowKeychain ?? true,
    fetch: fetchMock as unknown as typeof fetch,
    readFile: readFile as never,
    wslCredentialPaths: () => [],
    now: () => NOW,
  })
  const token = async () => {
    await result
    return (fetchMock.mock.calls[0]?.[1].headers as Record<string, string> | undefined)?.Authorization
  }
  return { result, token, readFile }
}

describe('Claude login of a non-default config dir', () => {
  const realPlatform = process.platform
  const realUser = process.env.USER
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    if (realUser === undefined) delete process.env.USER
    else process.env.USER = realUser
  })
  beforeEach(() => {
    keychain.mockReset()
    process.env.USER = 'alice'
  })

  it('names the Keychain item the way Claude Code 2.1.314 does', () => {
    expect(claudeKeychainService(path.join(os.homedir(), '.claude'))).toBe('Claude Code-credentials')
    expect(claudeKeychainService(WORK)).toBe('Claude Code-credentials-f0fc2950')
    // The NFD spelling of /Users/rené/.claude-2 hashes as its NFC form.
    expect(claudeKeychainService('/Users/rene\u0301/.claude-2')).toBe('Claude Code-credentials-45281352')
  })

  it("reads a named profile's own file and Keychain item, account first", async () => {
    keychain.mockResolvedValue({ status: 'found', value: login('live', NOW + 3_600_000) })
    const { result, readFile } = run({ configDir: WORK })
    expect((await result).quota).toMatchObject({ connection: 'connected', planLabel: 'Max 20x' })
    expect(readFile.mock.calls.map(call => call[0])).toEqual([path.join(WORK, '.credentials.json')])
    expect(keychain.mock.calls).toEqual([['Claude Code-credentials-f0fc2950', ['alice', null]]])
  })

  it('gives the claude row the first configured dir', async () => {
    const dir = path.join(os.tmpdir(), 'codeburn-no-such-claude-profile')
    process.env.CLAUDE_CONFIG_DIR = dir
    keychain.mockResolvedValue({ status: 'notFound' })
    const claude = availableReaders(() => false).find(entry => entry.id === 'claude')!
    expect((await claude.read(new AbortController().signal)).connection).toBe('disconnected')
    expect(keychain.mock.calls.map(call => call[0])).toEqual([claudeKeychainService(path.resolve(dir))])
  })

  it('prefers a live Keychain login over an expired credential file', async () => {
    keychain.mockResolvedValue({ status: 'found', value: login('live', NOW + 3_600_000) })
    const { token } = run({ configDir: WORK, file: login('stale', NOW - 1) })
    expect(await token()).toBe('Bearer live')
  })

  it('keeps the expired file when the Keychain holds no login', async () => {
    keychain.mockResolvedValue({ status: 'notFound' })
    const { token } = run({ configDir: WORK, file: login('stale', NOW - 1) })
    expect(await token()).toBe('Bearer stale')
  })

  it('reports a denied Keychain instead of sending the expired token', async () => {
    keychain.mockResolvedValue({ status: 'accessDenied' })
    const { result, token } = run({ configDir: WORK, file: login('stale', NOW - 1) })
    expect((await result).quota.connection).toBe('accessDenied')
    expect(await token()).toBeUndefined()
  })

  it('never reads the Keychain unless allowed, nor past a live file', async () => {
    const unallowed = run({ configDir: WORK, file: login('stale', NOW - 1), allowKeychain: false })
    expect(await unallowed.token()).toBe('Bearer stale')
    const live = run({ configDir: WORK, file: login('fresh', NOW + 3_600_000) })
    expect(await live.token()).toBe('Bearer fresh')
    expect(keychain).not.toHaveBeenCalled()
  })
})
