import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
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
      const result = runCli(['devices', 'scan', '--format', 'json'], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        found: Array<{ name: string; host: string; port: number; fingerprint: string; code: string; paired: boolean }>
      }
      expect(Array.isArray(payload.found)).toBe(true)
      for (const device of payload.found) {
        expect(typeof device.name).toBe('string')
        expect(typeof device.host).toBe('string')
        expect(typeof device.port).toBe('number')
        expect(typeof device.fingerprint).toBe('string')
        expect(typeof device.code).toBe('string')
        expect(typeof device.paired).toBe('boolean')
      }
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
