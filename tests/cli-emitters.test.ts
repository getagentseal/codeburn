import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { utcDaysAgo } from './fixtures/clock.js'

// These specs spawn the real CLI (tsx compile + full parse) per test, which
// blows the 5s default under full parallel suite load while passing cleanly
// in isolation — the exact flake class #948 documented and CI has hit
// (cli-emitters timed out on a green PR). Same file-level remedy as
// cli-status-menubar.test.ts: a 30s ceiling for spawn-heavy suites only.
vi.setConfig({ testTimeout: 30_000 })

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'implement feature' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string, model: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })
}

const DAY = utcDaysAgo(30)

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-emitters-'))
  const projectDir = join(home, '.claude', 'projects', 'app')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'session-a.jsonl'), [
    userLine('session-a', `${DAY}T09:00:00Z`),
    assistantLine('session-a', `${DAY}T09:01:00Z`, 'msg-a', 'claude-sonnet-4-5'),
  ].join('\n'))
  await writeFile(join(projectDir, 'session-b.jsonl'), [
    userLine('session-b', `${DAY}T10:00:00Z`),
    assistantLine('session-b', `${DAY}T10:01:00Z`, 'msg-b', 'claude-opus-4-5'),
  ].join('\n'))
  return home
}

describe('CLI JSON emitters', () => {
  it('emits compare list mode and full mode as JSON', async () => {
    const home = await makeHome()
    try {
      const listResult = runCli(['compare', '--format', 'json', '--period', 'all', '--provider', 'claude'], home)
      expect(listResult.status, listResult.stderr).toBe(0)
      const models = JSON.parse(listResult.stdout) as Array<{ model: string; selfCorrections: number }>
      expect(models.map(model => model.model)).toEqual(expect.arrayContaining(['claude-sonnet-4-5', 'claude-opus-4-5']))
      expect(models.every(model => typeof model.selfCorrections === 'number')).toBe(true)

      const fullResult = runCli([
        'compare', '--format', 'json', '--period', 'all', '--provider', 'claude',
        '--model-a', 'claude-sonnet-4-5', '--model-b', 'claude-opus-4-5',
      ], home)
      expect(fullResult.status, fullResult.stderr).toBe(0)
      const report = JSON.parse(fullResult.stdout)
      expect(Object.keys(report)).toEqual(['period', 'modelA', 'modelB', 'metrics', 'categories', 'workingStyle'])
      expect(report.period.provider).toBe('claude')
      expect(report.modelA.model).toBe('claude-sonnet-4-5')
      expect(report.modelB.model).toBe('claude-opus-4-5')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  // Issue #767 item 1: --model-a/--model-b used to require the canonical id
  // verbatim, with no way to pass the display name the compare picker itself
  // shows (e.g. "Sonnet 4.5" for claude-sonnet-4-5).
  it('resolves --model-a/--model-b by display name', async () => {
    const home = await makeHome()
    try {
      const result = runCli([
        'compare', '--format', 'json', '--period', 'all', '--provider', 'claude',
        '--model-a', 'Sonnet 4.5', '--model-b', 'Opus 4.5',
      ], home)
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.modelA.model).toBe('claude-sonnet-4-5')
      expect(report.modelB.model).toBe('claude-opus-4-5')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  // Issue #767 item 1: the TUI path (default --format) used to silently
  // ignore --model-a/--model-b entirely. It should at least apply the same
  // "both or neither" validation the JSON path already had, rather than
  // dropping a lone --model-a on the floor.
  it('rejects a lone --model-a for the TUI (default) format same as JSON', async () => {
    const home = await makeHome()
    try {
      const result = runCli(['compare', '--period', 'all', '--provider', 'claude', '--model-a', 'claude-sonnet-4-5'], home)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/--model-a and --model-b must be provided together/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('emits flat session rows as JSON', async () => {
    const home = await makeHome()
    try {
      const result = runCli(['sessions', '--format', 'json', '--period', 'all', '--provider', 'claude'], home)
      expect(result.status, result.stderr).toBe(0)
      const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>
      expect(rows).toHaveLength(2)
      expect(Object.keys(rows[0]!)).toEqual([
        'sessionId', 'title', 'project', 'provider', 'models', 'cost', 'savingsUSD', 'calls', 'turns',
        'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
        'startedAt', 'endedAt', 'durationMs',
      ])
      expect(rows.every(row => row.provider === 'claude')).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
