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
      HOME: home, USERPROFILE: home,
      TZ: 'UTC',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function userLine(content: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 'deepseek-v4-session',
    timestamp,
    cwd: '/tmp/deepseek-v4-validation',
    message: { role: 'user', content },
  })
}

function assistantLine(model: string, timestamp: string, messageId: string, usage: Record<string, number>): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'deepseek-v4-session',
    timestamp,
    cwd: '/tmp/deepseek-v4-validation',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [
        { type: 'text', text: 'updated pricing code' },
        { type: 'tool_use', id: `tu-${messageId}`, name: 'Edit', input: { file_path: '/tmp/deepseek-v4-validation/pricing.ts', old_string: 'old', new_string: 'new' } },
      ],
      usage,
    },
  })
}

describe('CLI DeepSeek v4 Claude pricing regression', () => {
  it('prices DeepSeek v4 Claude sessions even when the runtime LiteLLM cache lacks those models', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-deepseek-v4-cli-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'deepseek-v4-validation')
      const cacheDir = join(home, '.cache', 'codeburn')
      await mkdir(projectDir, { recursive: true })
      await mkdir(cacheDir, { recursive: true })

      await writeFile(join(cacheDir, 'litellm-pricing.json'), JSON.stringify({
        timestamp: Date.now(),
        data: {
          'gpt-4o-mini': {
            inputCostPerToken: 1.5e-7,
            outputCostPerToken: 6e-7,
            cacheWriteCostPerToken: 0,
            cacheReadCostPerToken: 7.5e-8,
            webSearchCostPerRequest: 0.01,
            fastMultiplier: 1,
          },
        },
      }))

      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('Use DeepSeek v4 through the Claude-compatible endpoint.', '2026-05-20T10:00:00.000Z'),
          assistantLine('deepseek-v4-pro', '2026-05-20T10:01:00.000Z', 'deepseek-v4-pro', {
            input_tokens: 2_477_914,
            output_tokens: 762_994,
            cache_read_input_tokens: 258_556_928,
            cache_creation_input_tokens: 0,
          }),
          userLine('Validate the flash model path too.', '2026-05-20T10:02:00.000Z'),
          assistantLine('deepseek-v4-flash', '2026-05-20T10:03:00.000Z', 'deepseek-v4-flash', {
            input_tokens: 1_552_573,
            output_tokens: 353_914,
            cache_read_input_tokens: 48_388_608,
            cache_creation_input_tokens: 0,
          }),
        ].join('\n') + '\n',
      )

      const result = runCli([
        '--format', 'json',
        '--from', '2026-05-20',
        '--to', '2026-05-20',
        '--provider', 'claude',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const report = JSON.parse(result.stdout) as {
        overview: { cost: number; calls: number; tokens: { cacheRead: number } }
        models: Array<{ name: string; cost: number; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>
      }
      const pro = report.models.find(m => m.name === 'DeepSeek v4 Pro')
      const flash = report.models.find(m => m.name === 'DeepSeek v4 Flash')

      expect(report.overview.calls).toBe(2)
      expect(report.overview.tokens.cacheRead).toBe(306_945_536)
      // The bundled snapshot now carries DeepSeek's official peak pricing
      // (#1134): $1.32/$3.96 per million on pro, $0.30/$1.20 on flash.
      expect(report.overview.cost).toBeCloseTo(18.849608, 5)

      expect(pro).toBeDefined()
      expect(pro!.calls).toBe(1)
      expect(pro!.inputTokens).toBe(2_477_914)
      expect(pro!.outputTokens).toBe(762_994)
      expect(pro!.cacheReadTokens).toBe(258_556_928)
      expect(pro!.cost).toBeCloseTo(17.668808, 6)

      expect(flash).toBeDefined()
      expect(flash!.calls).toBe(1)
      expect(flash!.inputTokens).toBe(1_552_573)
      expect(flash!.outputTokens).toBe(353_914)
      expect(flash!.cacheReadTokens).toBe(48_388_608)
      expect(flash!.cost).toBeCloseTo(1.1808, 6)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
