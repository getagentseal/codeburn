import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchClaudeQuota } from '../src/quota/claude.js'
import { setWslHomes } from '../src/wsl.js'

// #1061: a WSL-only Claude Code login keeps its credential on the distro's 9P
// share, never under the Windows profile. All paths here are fake; no file is read.
const WIN = 'C:\\Users\\alice\\.claude\\.credentials.json'
const UBUNTU = '\\\\wsl$\\Ubuntu\\home\\alice'
const UBUNTU_CRED = `${UBUNTU}\\.claude\\.credentials.json`
const DEBIAN_CRED = '\\\\wsl$\\Debian\\home\\bob\\.claude\\.credentials.json'
const usage = JSON.stringify({ seven_day: { utilization: 40, resets_at: '2026-07-19T12:00:00Z' } })
const stored = (accessToken: string, expiresAt?: number) => JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } })

function run(files: Record<string, string | (() => Promise<string | null>)>, wslPaths: string[]) {
  const readFile = vi.fn(async (file: string) => {
    const entry = files[file]
    return typeof entry === 'function' ? entry() : entry ?? null
  })
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(usage, { status: 200 }))
  const result = fetchClaudeQuota({
    fetch: fetchMock as unknown as typeof fetch,
    credentialPath: WIN,
    wslCredentialPaths: () => wslPaths,
    readFile: readFile as never,
  })
  const token = async () => {
    await result
    return fetchMock.mock.calls.length ? String((fetchMock.mock.calls[0]![1].headers as Record<string, string>).Authorization) : null
  }
  return { result, token, readFile }
}

afterEach(() => {
  vi.useRealTimers()
  setWslHomes(undefined)
})

describe('Claude quota credential from WSL (#1061)', () => {
  it('uses the Windows-home credential when no distro is running', async () => {
    const { result, token } = run({ [WIN]: stored('win', 2) }, [])
    expect((await result).quota.connection).toBe('connected')
    expect(await token()).toBe('Bearer win')
  })

  it('uses a WSL-only credential when the Windows home has none', async () => {
    const { result, token } = run({ [UBUNTU_CRED]: stored('wsl', 2) }, [UBUNTU_CRED])
    expect((await result).quota.connection).toBe('connected')
    expect(await token()).toBe('Bearer wsl')
  })

  it('picks the credential that expires last when both exist', async () => {
    const newer = run({ [WIN]: stored('win', 1_000), [UBUNTU_CRED]: stored('wsl', 2_000) }, [UBUNTU_CRED])
    expect(await newer.token()).toBe('Bearer wsl')
    const older = run({ [WIN]: stored('win', 3_000), [UBUNTU_CRED]: stored('wsl', 2_000) }, [UBUNTU_CRED])
    expect(await older.token()).toBe('Bearer win')
  })

  it('only reads homes of distros the running-only discovery returned', async () => {
    setWslHomes([UBUNTU])
    const readFile = vi.fn(async () => null)
    await fetchClaudeQuota({ fetch: vi.fn() as unknown as typeof fetch, credentialPath: WIN, readFile })
    expect(readFile.mock.calls.map(call => call[0])).toEqual([WIN, UBUNTU_CRED])
  })

  it('gives up on an unreachable share instead of hanging the poll', async () => {
    vi.useFakeTimers()
    const { result, token } = run({ [WIN]: stored('win', 1), [DEBIAN_CRED]: () => new Promise(() => {}) }, [DEBIAN_CRED])
    await vi.advanceTimersByTimeAsync(2_500)
    expect((await result).quota.connection).toBe('connected')
    expect(await token()).toBe('Bearer win')
  })

  it('skips a malformed WSL file and still uses a good one', async () => {
    const { result, token } = run({ [UBUNTU_CRED]: '{not json', [DEBIAN_CRED]: stored('debian', 5) }, [UBUNTU_CRED, DEBIAN_CRED])
    expect((await result).quota.connection).toBe('connected')
    expect(await token()).toBe('Bearer debian')
  })

  it('reports disconnected when the only credential is a malformed WSL file', async () => {
    const { result, token } = run({ [UBUNTU_CRED]: '{not json' }, [UBUNTU_CRED])
    expect((await result).quota.connection).toBe('disconnected')
    expect(await token()).toBeNull()
  })
})
