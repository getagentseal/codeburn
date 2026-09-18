import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

// Each test spawns `tsx src/cli.ts`, which re-transpiles the CLI per spawn.
vi.setConfig({ testTimeout: 120_000 })

// #1451's first slice: the four reporting commands can slice by the door a
// call was billed through and by whether that door charges per call. The
// corpus below is one of each shape the classifier has to tell apart, and the
// same four doors are asserted through every command's real output.
//
// The two Hermes rows mirror the sessions of 2026-09-18 that put usage through
// OpenRouter: `billing_provider = openrouter`, a `:free` model, a recorded $0.

const requireForTest = createRequire(import.meta.url)

const CLAUDE_SESSIONS = [
  { id: 's-direct', model: 'claude-haiku-4-5-20251001' },
  { id: 's-bedrock', model: 'anthropic.claude-haiku-4-5-20251001-v1:0' },
] as const

let homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home) await rm(home, { recursive: true, force: true })
  }
})

function yesterdayNoonMs(): number {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  d.setUTCHours(12, 0, 0, 0)
  return d.getTime()
}

async function seedClaude(home: string): Promise<void> {
  const dir = join(home, '.claude', 'projects', '-Users-gone-app')
  await mkdir(dir, { recursive: true })
  for (const [index, session] of CLAUDE_SESSIONS.entries()) {
    const ts = new Date(yesterdayNoonMs() + index * 60_000).toISOString()
    const user = JSON.stringify({ type: 'user', uuid: `${session.id}-u`, parentUuid: null, sessionId: session.id, timestamp: ts, cwd: '/Users/gone/app', message: { role: 'user', content: 'hello' } })
    const assistant = JSON.stringify({
      type: 'assistant', uuid: `${session.id}-a`, parentUuid: `${session.id}-u`, sessionId: session.id, timestamp: ts, cwd: '/Users/gone/app',
      message: {
        type: 'message', role: 'assistant', model: session.model, id: `${session.id}-m`, content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    await writeFile(join(dir, `${session.id}.jsonl`), `${user}\n${assistant}\n`, 'utf-8')
  }
}

async function seedHermes(home: string): Promise<void> {
  const hermesHome = join(home, '.hermes')
  await mkdir(hermesHome, { recursive: true })
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(join(hermesHome, 'state.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, model TEXT, cwd TEXT, git_repo_root TEXT,
      billing_provider TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, actual_cost_usd REAL,
      cost_status TEXT, api_call_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      started_at REAL, ended_at REAL, title TEXT
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_calls TEXT, timestamp REAL NOT NULL
    )
  `)
  const startedAt = yesterdayNoonMs() / 1000
  const rows: Array<[string, string, string, string | null, number | null]> = [
    // An OpenRouter `:free` model: the door is registered, the recorded $0 is
    // still a recorded amount, so the call is metered.
    ['h-openrouter', 'cohere/north-mini-code:free', 'openrouter', null, 0],
    // A ChatGPT plan covering the usage: subscription, through no route.
    ['h-included', 'gpt-5.6-sol', 'openai-codex', 'included', null],
  ]
  for (const [id, model, billingProvider, costStatus, actualCost] of rows) {
    db.prepare(
      `INSERT INTO sessions (id, source, model, cwd, billing_provider, input_tokens, output_tokens,
        cost_status, actual_cost_usd, api_call_count, started_at, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 'cli', model, '/Users/gone/hermes-app', billingProvider, 15_001, 69, costStatus, actualCost, 1, startedAt, id)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(id, 'user', 'read src/models.ts', startedAt)
  }
  db.close()
}

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-billing-filters-'))
  homes.push(home)
  await seedClaude(home)
  await seedHermes(home)
  return home
}

function runCli(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, 'cache'),
      HERMES_HOME: join(home, '.hermes'),
      CODEX_HOME: join(home, 'no-codex'),
      TZ: 'UTC',
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function ok(args: string[], home: string): string {
  const result = runCli(args, home)
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

type ModelRow = { modelDisplayName: string; costUSD: number; calls: number; rawModels: string[]; route: string | null }

function modelRows(args: string[], home: string): ModelRow[] {
  const parsed = JSON.parse(ok(['models', '--period', 'week', '--format', 'json', '--min-cost', '0', ...args], home)) as unknown
  return (Array.isArray(parsed) ? parsed : (parsed as { rows?: ModelRow[] }).rows ?? []) as ModelRow[]
}

function rawModelsOf(rows: ModelRow[]): string[] {
  return rows.flatMap(row => row.rawModels).sort()
}

describe('codeburn --route / --billing: the four commands slice by call', () => {
  it('slices models by door and by mode, and composes the two with --provider', async () => {
    const home = await seedHome()

    // The unfiltered corpus is one call through each of the four doors.
    expect(rawModelsOf(modelRows([], home))).toEqual([
      'anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001', 'cohere/north-mini-code:free', 'gpt-5.6-sol',
    ])

    // A door named by the model id alone.
    const bedrock = modelRows(['--route', 'bedrock'], home)
    expect(rawModelsOf(bedrock)).toEqual(['anthropic.claude-haiku-4-5-20251001-v1:0'])
    expect(bedrock[0]!.route).toBe('bedrock')

    // A door named by the provider's own column, and never by a model id.
    const openrouter = modelRows(['--route', 'openrouter'], home)
    expect(rawModelsOf(openrouter)).toEqual(['cohere/north-mini-code:free'])
    expect(openrouter[0]!.route).toBe('openrouter')
    expect(openrouter[0]!.modelDisplayName).toContain('(OpenRouter)')

    // Direct is the complement: the Bedrock-shaped id must not slip in.
    expect(rawModelsOf(modelRows(['--route', 'direct'], home))).toEqual(['claude-haiku-4-5-20251001', 'gpt-5.6-sol'])

    // Modes: an included session is subscription-covered; the two metered rows
    // are the ones a registered door or a recorded amount named. The direct
    // Claude call is unknown and answers to neither.
    expect(rawModelsOf(modelRows(['--billing', 'subscription'], home))).toEqual(['gpt-5.6-sol'])
    expect(rawModelsOf(modelRows(['--billing', 'metered'], home))).toEqual([
      'anthropic.claude-haiku-4-5-20251001-v1:0', 'cohere/north-mini-code:free',
    ])

    // AND with each other and with --provider.
    expect(rawModelsOf(modelRows(['--route', 'direct', '--billing', 'subscription'], home))).toEqual(['gpt-5.6-sol'])
    expect(modelRows(['--route', 'bedrock', '--billing', 'subscription'], home)).toEqual([])
    expect(rawModelsOf(modelRows(['--billing', 'metered', '--provider', 'hermes'], home))).toEqual(['cohere/north-mini-code:free'])
    expect(modelRows(['--route', 'bedrock', '--provider', 'hermes'], home)).toEqual([])
  })

  it('keeps zero-cost route and subscription rows without an explicit min-cost override', async () => {
    const home = await seedHome()
    const rows = (args: string[]): ModelRow[] => {
      const parsed = JSON.parse(ok(['models', '--period', 'week', '--format', 'json', ...args], home)) as unknown
      return (Array.isArray(parsed) ? parsed : (parsed as { rows?: ModelRow[] }).rows ?? []) as ModelRow[]
    }

    expect(rawModelsOf(rows(['--route', 'openrouter']))).toEqual(['cohere/north-mini-code:free'])
    expect(rawModelsOf(rows(['--billing', 'subscription']))).toEqual(['gpt-5.6-sol'])
    expect(rows(['--route', 'openrouter', '--min-cost', '0.01'])).toEqual([])
    expect(rawModelsOf(rows([]))).not.toContain('cohere/north-mini-code:free')
    expect(rawModelsOf(rows([]))).not.toContain('gpt-5.6-sol')
  })

  it('slices sessions and audit by the same rule', async () => {
    const home = await seedHome()

    const sessions = (args: string[]): string[] =>
      (JSON.parse(ok(['sessions', '--period', 'week', '--format', 'json', '--no-pager', ...args], home)) as Array<{ sessionId: string }>)
        .map(row => row.sessionId).sort()
    expect(sessions([])).toEqual(['h-included', 'h-openrouter', 's-bedrock', 's-direct'])
    expect(sessions(['--route', 'openrouter'])).toEqual(['h-openrouter'])
    expect(sessions(['--billing', 'subscription'])).toEqual(['h-included'])
    expect(sessions(['--route', 'direct'])).toEqual(['h-included', 's-direct'])

    const audit = (args: string[]): string[] =>
      (JSON.parse(ok(['audit', '--period', 'week', '--format', 'json', ...args], home)) as Array<{ model: string }>)
        .map(row => row.model).sort()
    expect(audit(['--billing', 'metered'])).toEqual(['anthropic.claude-haiku-4-5-20251001-v1:0', 'cohere/north-mini-code:free'])
    expect(audit(['--route', 'bedrock'])).toEqual(['anthropic.claude-haiku-4-5-20251001-v1:0'])
  })

  it('slices what export writes', async () => {
    const home = await seedHome()
    const out = join(home, 'metered-only')
    ok(['export', '--format', 'json', '-o', out, '--from', '2026-01-01', '--to', '2030-01-01', '--billing', 'metered'], home)

    const written = JSON.parse(await readFile(`${out}.json`, 'utf-8')) as {
      periods: Array<{ models: Array<{ Model: string }> }>
    }
    const models = written.periods.flatMap(p => p.models.map(m => m.Model)).sort()
    expect(models).not.toContain('Haiku 4.5')
    expect(models.some(m => m.includes('Bedrock'))).toBe(true)
    expect(models.some(m => m.includes('OpenRouter'))).toBe(true)
  })
})

describe('codeburn --route / --billing: validation happens before anything is read or written', () => {
  it('rejects an unknown value on every command that takes the flags', async () => {
    const home = await seedHome()
    for (const command of ['models', 'sessions', 'export', 'audit']) {
      const badRoute = runCli([command, '--route', 'bedrok'], home)
      expect(badRoute.status, command).toBe(1)
      expect(badRoute.stderr, command).toContain(`codeburn ${command}: unknown route "bedrok"`)
      expect(badRoute.stderr, command).toContain('Valid values: direct, bedrock, openrouter.')

      const badBilling = runCli([command, '--billing', 'included'], home)
      expect(badBilling.status, command).toBe(1)
      expect(badBilling.stderr, command).toContain(`codeburn ${command}: unknown billing mode "included"`)
      expect(badBilling.stderr, command).toContain('Valid values: metered, subscription.')
    }
  })

  it('rejects route or billing filters with work-unit grouping', async () => {
    const home = await seedHome()
    for (const args of [
      ['sessions', '--route', 'openrouter', '--by-work-unit'],
      ['sessions', '--billing', 'metered', '--by-work-unit'],
    ]) {
      const result = runCli(args, home)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('--by-work-unit cannot be combined with --route or --billing')
    }
  })

  it('documents that direct includes unknown routes', async () => {
    const home = await seedHome()
    for (const command of ['models', 'sessions', 'export', 'audit']) {
      const help = runCli([command, '--help'], home)
      expect(help.status, command).toBe(0)
      expect(help.stdout, command).toContain('direct includes unknown')
    }
  })

  it('writes no export file when the value is invalid', async () => {
    const home = await seedHome()
    const out = join(home, 'never-written')
    const result = runCli(['export', '--format', 'json', '-o', out, '--billing', 'included'], home)
    expect(result.status).toBe(1)
    expect(existsSync(`${out}.json`)).toBe(false)
    expect(existsSync(out)).toBe(false)
  })
})
