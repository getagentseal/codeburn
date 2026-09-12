import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string, locale?: string) {
  // Agent/CI runners often set FORCE_COLOR=1 even when NO_COLOR=1. Chalk then
  // paints table chrome with ESC (U+001B). The hostile-ID assertion below is
  // a source-safety check on model IDs, not on chalk headers, so pin color
  // off in the child. Do not drop the C0/C1 regex.
  const env = { ...process.env }
  delete env.FORCE_COLOR
  env.NO_COLOR = '1'
  env.HOME = home
  env.USERPROFILE = home
  env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  env.CODEBURN_CACHE_DIR = join(home, '.cache', 'codeburn')
  env.TZ = 'UTC'
  if (locale) {
    env.LANG = locale
    env.LC_ALL = locale
  }
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function userLine(timestamp: string): string {
  return JSON.stringify({
    type: 'user', sessionId: 'unpriced-969', timestamp, cwd: '/tmp/unpriced-969',
    message: { role: 'user', content: 'inspect pricing coverage' },
  })
}

function assistantLine(model: string, timestamp: string, messageId: string, input: number): string {
  return JSON.stringify({
    type: 'assistant', sessionId: 'unpriced-969', timestamp, cwd: '/tmp/unpriced-969',
    message: {
      id: messageId, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: input, output_tokens: 100,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    },
  })
}

async function withFixture(lines: string[], run: (home: string) => void): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-models-unpriced-'))
  try {
    const projectDir = join(home, '.claude', 'projects', 'unpriced-969')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'session.jsonl'), `${lines.join('\n')}\n`)
    run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const range = ['--from', '2026-05-20', '--to', '2026-05-20', '--provider', 'claude']

describe('codeburn models --unpriced public CLI', () => {
  it('filters before --top and returns the largest unpriced raw ID deterministically', async () => {
    await withFixture([
      userLine('2026-05-20T10:00:00.000Z'),
      assistantLine('acme/unknown-small-969', '2026-05-20T10:01:00.000Z', 'small', 1_000),
      assistantLine('claude-opus-4-6', '2026-05-20T10:02:00.000Z', 'priced', 20_000),
      assistantLine('acme/unknown-large-969', '2026-05-20T10:03:00.000Z', 'large', 9_000),
    ], home => {
      const result = runCli(['models', '--unpriced', '--top', '1', '--format', 'json', ...range], home)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({ model: 'acme/unknown-large-969', totalTokens: 9_100 }),
      ])
    })
  })

  it('orders tied unpriced rows identically across host locales', async () => {
    await withFixture([
      userLine('2026-05-20T10:00:00.000Z'),
      assistantLine('acme/z-unknown-969', '2026-05-20T10:01:00.000Z', 'z-model', 1_000),
      assistantLine('acme/ä-unknown-969', '2026-05-20T10:02:00.000Z', 'a-umlaut-model', 1_000),
    ], home => {
      const args = ['models', '--unpriced', '--format', 'json', ...range]
      const english = runCli(args, home, 'en_US.UTF-8')
      const swedish = runCli(args, home, 'sv_SE.UTF-8')
      expect(english.status, english.stderr).toBe(0)
      expect(swedish.status, swedish.stderr).toBe(0)
      const models = (stdout: string) => (JSON.parse(stdout) as Array<{ model: string }>).map(row => row.model)
      expect(models(english.stdout)).toEqual(['acme/z-unknown-969', 'acme/ä-unknown-969'])
      expect(models(swedish.stdout)).toEqual(models(english.stdout))
    })
  })

  it('honors an explicitly supplied finite --min-cost threshold', async () => {
    await withFixture([
      userLine('2026-05-20T10:00:00.000Z'),
      assistantLine('acme/unknown-zero-969', '2026-05-20T10:01:00.000Z', 'zero', 1_000),
    ], home => {
      const result = runCli(['models', '--unpriced', '--min-cost', '0.01', '--format', 'json', ...range], home)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual([])
    })
  })

  it('lists every unpriced model in table output with an actionable hint', async () => {
    await withFixture([
      userLine('2026-05-20T10:00:00.000Z'),
      assistantLine('acme/unknown-alpha-969', '2026-05-20T10:01:00.000Z', 'alpha', 1_000),
      assistantLine('acme/unknown-beta-969', '2026-05-20T10:02:00.000Z', 'beta', 2_000),
      assistantLine('claude-opus-4-6', '2026-05-20T10:03:00.000Z', 'priced', 3_000),
    ], home => {
      const result = runCli(['models', '--unpriced', ...range], home)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('acme/unknown-alpha-969')
      expect(result.stdout).toContain('acme/unknown-beta-969')
      expect(result.stdout).not.toContain('claude-opus-4-6')
      expect(result.stdout).toContain('If a model is billed per token, map it with: codeburn model-alias "<model>" <known-model>')
      expect(result.stdout).toContain('codeburn model-flat-rate')
      expect(result.stdout).not.toContain('Fix: codeburn model-alias')
    })
  })

  it('reports a clean period explicitly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-models-unpriced-empty-'))
    try {
      const result = runCli(['models', '--unpriced', ...range], home)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('No unpriced models found for the selected period.\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('sanitizes hostile IDs in human formats while JSON stays lossless', async () => {
    const hostile = `acme/alpha\u001b]0;forged\u0007click\u001b[31m\nforged-row-${'x'.repeat(300)}`
    await withFixture([
      userLine('2026-05-20T10:00:00.000Z'),
      assistantLine(hostile, '2026-05-20T10:01:00.000Z', 'hostile', 1_000),
    ], home => {
      for (const format of ['table', 'markdown', 'csv']) {
        const result = runCli(['models', '--unpriced', '--format', format, ...range], home)
        expect(result.status, `${format}: ${result.stderr}`).toBe(0)
        expect(result.stdout).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/)
        expect(result.stdout).not.toContain('\nforged-row-')
        expect(result.stdout).not.toContain('x'.repeat(201))
      }
      const json = runCli(['models', '--unpriced', '--format', 'json', ...range], home)
      expect(json.status, json.stderr).toBe(0)
      expect((JSON.parse(json.stdout) as Array<{ model: string }>)[0]?.model).toBe(hostile)
    })
    // Four CLI spawns in one test, and a cold tsx spawn costs several seconds,
    // so this one needs more headroom than the 30s config default.
  }, 60_000)
})
