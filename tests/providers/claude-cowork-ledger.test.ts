import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearSessionCache, parseAllSessions } from '../../src/parser.js'
import { claude } from '../../src/providers/claude.js'
import type { SessionSource } from '../../src/providers/types.js'
import type { DateRange } from '../../src/types.js'

let root: string
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'],
  CLAUDE_CONFIG_DIRS: process.env['CLAUDE_CONFIG_DIRS'],
  CODEBURN_CACHE_DIR: process.env['CODEBURN_CACHE_DIR'],
  CODEBURN_DESKTOP_SESSIONS_DIR: process.env['CODEBURN_DESKTOP_SESSIONS_DIR'],
}

beforeEach(async () => {
  clearSessionCache()
  root = await mkdtemp(join(tmpdir(), 'codeburn-claude-cowork-ledger-'))
  process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude-config')
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(root, 'desktop')
  delete process.env['CLAUDE_CONFIG_DIRS']
  await mkdir(process.env['CLAUDE_CONFIG_DIR'], { recursive: true })
})

afterEach(async () => {
  clearSessionCache()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

function range(day: string): DateRange {
  return {
    start: new Date(`${day}T00:00:00.000Z`),
    end: new Date(`${day}T23:59:59.999Z`),
  }
}

function ledgerLine(
  ts: string,
  sessionId: string,
  surface: string,
  costUSD: number,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ts: Date.parse(ts),
    surface,
    sessionId,
    isError: false,
    models: {
      'us.anthropic.claude-sonnet-5': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        webSearchRequests: 0,
        cost: { usd: costUSD, basis: 'list' },
        ...overrides,
      },
    },
  })
}

async function makeLedger(lines: string[], timestamp = '2099-05-10T12:00:00.000Z'): Promise<string> {
  const path = join(
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR']!,
    'app',
    'workspace',
    'usage-ledger',
    '2099-05-10.ndjson',
  )
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`)
  const mtime = new Date(timestamp)
  await utimes(path, mtime, mtime)
  return path
}

function source(path: string): SessionSource {
  return {
    path,
    project: 'Claude Cowork',
    provider: 'claude',
    sourceId: 'claude-desktop:test',
    sourceLabel: 'Claude Desktop',
    sourcePath: process.env['CODEBURN_DESKTOP_SESSIONS_DIR'],
    sourceKind: 'claude-desktop-ledger',
  }
}

describe('Claude Cowork usage ledger', () => {
  it('discovers usage-ledger NDJSON files as Claude Desktop sources', async () => {
    const path = await makeLedger([ledgerLine('2099-05-10T12:00:00.000Z', 'session-1', 'cowork', 0.25)])

    const sources = await claude.discoverSessions()

    expect(sources).toContainEqual(expect.objectContaining({
      path,
      provider: 'claude',
      sourceKind: 'claude-desktop-ledger',
      sourceLabel: 'Claude Desktop',
    }))
  })

  it('parses Cowork costs and ignores Code-surface records', async () => {
    const path = await makeLedger([
      ledgerLine('2099-05-10T12:00:00.000Z', 'session-1', 'cowork', 0.25),
      ledgerLine('2099-05-10T12:01:00.000Z', 'session-2', 'code', 0.99),
      'not-json',
    ])

    const calls = []
    const parser = claude.createSessionParser(source(path), new Set(), range('2099-05-10'))
    for await (const call of parser.parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'claude',
      model: 'us.anthropic.claude-sonnet-5',
      sessionId: 'session-1',
      project: 'Claude Cowork',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      costUSD: 0.25,
      costFromBilling: true,
    })
  })

  it('merges ledger usage into the normal Claude report', async () => {
    await makeLedger([ledgerLine('2099-05-10T12:00:00.000Z', 'session-1', 'cowork', 0.25)])

    const projects = await parseAllSessions(range('2099-05-10'), 'claude')
    const cowork = projects.find(project => project.project === 'Claude Cowork')

    expect(cowork).toMatchObject({
      totalCostUSD: 0.25,
      totalApiCalls: 1,
      sessions: [{ sessionId: 'session-1', totalCostUSD: 0.25 }],
    })
  })
})
