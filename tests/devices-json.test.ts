import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

const DISCOVERY_MOCK_REGISTER = join(process.cwd(), 'tests', 'fixtures', 'mock-discovery-register.mjs')

const bonjourMock = vi.hoisted(() => ({
  destroy: vi.fn((cb: () => void) => cb()),
  find: vi.fn(),
  mdnsOn: vi.fn(),
  stop: vi.fn(),
  serviceCallback: undefined as ((service: {
    txt?: Record<string, string>
    addresses?: string[]
    host?: string
    name?: string
    port: number
  }) => void) | undefined,
  errorCallback: undefined as ((err?: unknown) => void) | undefined,
}))

vi.mock('bonjour-service', () => ({
  Bonjour: class {
    server = {
      mdns: {
        on: bonjourMock.mdnsOn.mockImplementation((_event: string, cb: (err?: unknown) => void) => {
          bonjourMock.errorCallback = cb
        }),
      },
    }

    destroy = bonjourMock.destroy

    find(_opts: unknown, cb: NonNullable<typeof bonjourMock.serviceCallback>) {
      bonjourMock.serviceCallback = cb
      bonjourMock.find(_opts, cb)
      return { stop: bonjourMock.stop }
    }
  },
}))

function runCli(args: string[], home: string, opts: { mockDiscovery?: boolean } = {}) {
  const nodeArgs = ['--import', 'tsx']
  if (opts.mockDiscovery) nodeArgs.push('--import', DISCOVERY_MOCK_REGISTER)
  return spawnSync(process.execPath, [...nodeArgs, 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      HOME: home,
      TZ: 'UTC',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'check usage' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })
}

describe('sharing discovery', () => {
  it('logs mDNS errors and returns devices found before the error', async () => {
    vi.resetModules()
    bonjourMock.destroy.mockClear()
    bonjourMock.find.mockClear()
    bonjourMock.mdnsOn.mockClear()
    bonjourMock.stop.mockClear()
    bonjourMock.serviceCallback = undefined
    bonjourMock.errorCallback = undefined
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { browse } = await import('../src/sharing/discovery.js')
      const pending = browse(10_000)
      bonjourMock.serviceCallback?.({
        txt: { fp: 'fixture-fingerprint', dn: 'Fixture Mac' },
        addresses: ['192.168.1.25'],
        port: 7777,
      })
      bonjourMock.errorCallback?.(new Error('bind EPERM'))

      await expect(pending).resolves.toEqual([
        {
          name: 'Fixture Mac',
          host: '192.168.1.25',
          port: 7777,
          fingerprint: 'fixture-fingerprint',
        },
      ])
      expect(stderr).toHaveBeenCalledWith('codeburn devices scan: mDNS discovery failed: bind EPERM')
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('devices/share/identity JSON CLI output', () => {
  it('devices --format json returns CombinedUsage with the local device', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-devices-json-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'app')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s1', '2026-04-10T09:00:00Z'),
          assistantLine('s1', '2026-04-10T09:01:00Z', 'msg-1'),
        ].join('\n'),
      )

      const result = runCli(['devices', '--format', 'json', '--period', 'all'], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        perDevice: Array<{ id: string; name: string; local: boolean; cost: number; calls: number; sessions: number }>
        combined: { cost: number; calls: number; sessions: number; deviceCount: number; reachableCount: number }
      }
      expect(payload.perDevice).toHaveLength(1)
      expect(payload.perDevice[0]).toMatchObject({
        id: 'local',
        local: true,
        calls: 1,
        sessions: 1,
      })
      expect(payload.perDevice[0]?.name).toBeTruthy()
      expect(payload.perDevice[0]?.cost).toBeGreaterThan(0)
      expect(payload.combined).toMatchObject({
        calls: 1,
        sessions: 1,
        deviceCount: 1,
        reachableCount: 1,
      })
      expect(payload.combined.cost).toBeCloseTo(payload.perDevice[0]!.cost, 10)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('identity --format json returns the public identity subset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-identity-json-'))

    try {
      const result = runCli(['identity', '--format', 'json'], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(['fingerprint', 'name'])
      expect(typeof payload['name']).toBe('string')
      expect(typeof payload['fingerprint']).toBe('string')
      expect(payload['fingerprint']).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('devices scan --format json returns the documented scan envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-devices-scan-json-'))

    try {
      const result = runCli(['devices', 'scan', '--format', 'json'], home, { mockDiscovery: true })

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        found: Array<{ name: string; host: string; port: number; fingerprint: string; code: string; paired: boolean }>
      }
      expect(payload.found).toHaveLength(1)
      expect(payload.found[0]).toMatchObject({
        name: 'Fixture Mac',
        host: 'fixture.local',
        port: 7777,
        fingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        paired: false,
      })
      expect(payload.found[0]?.code).toMatch(/^\d{3}$/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('devices add --format json is rejected as a mutation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-devices-add-json-'))

    try {
      const result = runCli(['devices', 'add', '--format', 'json'], home)

      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('--format json is only supported for read-only devices output and scan')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('share --format json is rejected without the status action', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-share-json-guard-'))

    try {
      const result = runCli(['share', '--format', 'json'], home)

      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('--format json is only supported for `share status`')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('share status --format json returns ShareStatus without starting sharing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-share-status-json-'))

    try {
      const result = runCli(['share', 'status', '--format', 'json'], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        sharing: boolean
        name: string
        port: number
        always: boolean
        peers: number
        pending: Array<{ id: string; name: string; code: string }>
      }
      expect(payload).toMatchObject({
        sharing: false,
        port: 7777,
        always: false,
        peers: 0,
        pending: [],
      })
      expect(typeof payload.name).toBe('string')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
