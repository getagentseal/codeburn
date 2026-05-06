import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
      HOME: home,
      TZ: 'UTC',
    },
    encoding: 'utf-8',
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'add feature' },
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
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
      },
    },
  })
}

describe('codeburn export custom date range', () => {
  it('exports a single custom period filtered by --from/--to', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-export-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'app')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'in-range.jsonl'),
        [
          userLine('in-range', '2026-04-10T09:00:00Z'),
          assistantLine('in-range', '2026-04-10T09:01:00Z', 'msg-in-range'),
        ].join('\n'),
      )
      await writeFile(
        join(projectDir, 'out-of-range.jsonl'),
        [
          userLine('out-of-range', '2026-04-11T09:00:00Z'),
          assistantLine('out-of-range', '2026-04-11T09:01:00Z', 'msg-out-of-range'),
        ].join('\n'),
      )

      const outputPath = join(home, 'custom-export.json')
      const result = runCli([
        'export',
        '--format', 'json',
        '--from', '2026-04-10',
        '--to', '2026-04-10',
        '--provider', 'claude',
        '--output', outputPath,
      ], home)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Exported (2026-04-10 to 2026-04-10)')

      const exported = JSON.parse(await readFile(outputPath, 'utf-8')) as {
        summary: Array<{ Period: string; Sessions: number }>
        sessions: Array<{ 'Session ID': string }>
      }
      expect(exported.summary).toHaveLength(1)
      expect(exported.summary[0]?.Period).toBe('2026-04-10 to 2026-04-10')
      expect(exported.summary[0]?.Sessions).toBe(1)
      expect(exported.sessions.map(s => s['Session ID'])).toEqual(['in-range'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
