import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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
      HOME: home, USERPROFILE: home,
      TZ: 'UTC',
    },
    encoding: 'utf-8',
  })
}

function sessionLines(sessionId: string, timestamp: string): string {
  return [
    JSON.stringify({
      type: 'user',
      sessionId,
      timestamp,
      message: { role: 'user', content: 'add feature' },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp,
      message: {
        id: `msg-${sessionId}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    }),
  ].join('\n')
}

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

// An empty export exits 0 and prints prose, so the exit code alone cannot tell a
// written folder from a skipped one. The desktop app reads the saved-path line
// instead (app/electron/main.ts, EXPORT_SAVED_MARKER), which only holds while
// both halves below stay true.
describe('codeburn export under a project filter', () => {
  it('writes nothing, and says so, when the filter excludes every project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-export-filter-'))
    try {
      const projectDir = join(home, '.claude', 'projects', 'notes-app')
      await mkdir(projectDir, { recursive: true })
      await writeFile(join(projectDir, 'today.jsonl'), sessionLines('today', new Date().toISOString()))

      const excluded = join(home, 'excluded-export')
      const filtered = runCli(['export', '-f', 'csv', '-o', excluded, '--exclude', 'notes-app'], home)
      expect(filtered.status).toBe(0)
      expect(filtered.stdout).toContain('No usage data found.')
      expect(filtered.stdout).not.toContain('Exported (')
      expect(await exists(excluded)).toBe(false)

      const kept = join(home, 'kept-export')
      const unfiltered = runCli(['export', '-f', 'csv', '-o', kept], home)
      expect(unfiltered.status).toBe(0)
      expect(unfiltered.stdout).toContain('Exported (')
      expect(await exists(join(kept, 'summary.csv'))).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})
