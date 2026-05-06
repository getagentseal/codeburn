import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, it, expect } from 'vitest'

async function createClaudeSession(configDir: string, project: string, sessionId: string, timestamp: string): Promise<void> {
  const projectDir = join(configDir, 'projects', project)
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(filePath, JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: `msg-${sessionId}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
  }) + '\n')
  const mtime = new Date(timestamp)
  await utimes(filePath, mtime, mtime)
}

describe('codeburn report --format json', () => {
  it('includes Claude account labels on projects and top sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-json-'))
    const workDir = join(home, 'claude-work')

    try {
      await createClaudeSession(workDir, '-Users-alice-app', 'sess-001', '2099-04-20T10:00:00.000Z')
      const result = spawnSync(process.execPath, [
        '--import',
        'tsx',
        'src/cli.ts',
        'report',
        '--format',
        'json',
        '--provider',
        'claude',
        '--from',
        '2099-04-20',
        '--to',
        '2099-04-20',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_CONFIG_DIRS: workDir,
          CLAUDE_CONFIG_DIR: '',
        },
        encoding: 'utf-8',
      })

      expect(result.status).toBe(0)
      const report = JSON.parse(result.stdout) as {
        projects: Array<{ account?: string; accountPath?: string }>
        topSessions: Array<{ account?: string }>
      }
      expect(report.projects).toHaveLength(1)
      expect(report.projects[0]).toMatchObject({ account: 'work', accountPath: workDir })
      expect(report.topSessions[0]).toMatchObject({ account: 'work' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
