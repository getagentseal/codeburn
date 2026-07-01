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
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      TZ: 'UTC',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

describe('CLI Devin model variants', () => {
  it('keeps Devin GPT-5 variants separate in report JSON', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-devin-models-'))

    try {
      const cliDir = join(home, '.local', 'share', 'devin', 'cli')
      const transcriptsDir = join(cliDir, 'transcripts')
      await mkdir(transcriptsDir, { recursive: true })
      await mkdir(join(home, '.config', 'codeburn'), { recursive: true })
      await writeFile(join(home, '.config', 'codeburn', 'config.json'), JSON.stringify({
        devin: { acuUsdRate: 2.25 },
      }))

      const transcript = {
        schema_version: '1',
        session_id: 'devin-model-variants',
        agent: { model_name: 'GPT-5.3-Codex' },
        steps: [
          {
            step_id: 1,
            source: 'user',
            message: 'compare model variants',
            metadata: {
              is_user_input: true,
              created_at: '2026-06-12T10:00:00.000Z',
            },
          },
          {
            step_id: 2,
            source: 'agent',
            message: '',
            metadata: {
              created_at: '2026-06-12T10:00:01.000Z',
              committed_acu_cost: 0.1,
              generation_model: 'gpt-5-3-codex-xhigh',
              metrics: {
                input_tokens: 100,
                output_tokens: 10,
              },
            },
          },
          {
            step_id: 3,
            source: 'agent',
            message: '',
            metadata: {
              created_at: '2026-06-12T10:00:02.000Z',
              committed_acu_cost: 0.2,
              generation_model: 'gpt-5-4-low',
              metrics: {
                input_tokens: 200,
                output_tokens: 20,
              },
            },
          },
        ],
      }
      await writeFile(
        join(transcriptsDir, 'devin-model-variants.json'),
        JSON.stringify(transcript),
      )

      const result = runCli([
        '--format', 'json',
        '--from', '2026-06-12',
        '--to', '2026-06-12',
        '--provider', 'devin',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const report = JSON.parse(result.stdout) as {
        models: Array<{ name: string; calls: number }>
      }
      const names = report.models.map(m => m.name)
      expect(names).toEqual(expect.arrayContaining([
        'gpt-5-3-codex-xhigh',
        'gpt-5-4-low',
      ]))
      expect(names).not.toContain('GPT-5')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
