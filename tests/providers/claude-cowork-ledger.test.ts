import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearSessionCache, filterProjectsByClaudeConfigSource, parseAllSessions } from '../../src/parser.js'
import { calculateCost, setPriceOverrides } from '../../src/models.js'
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
  setPriceOverrides({
    'us.anthropic.claude-sonnet-5': {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
    },
  })
  root = await mkdtemp(join(tmpdir(), 'codeburn-claude-cowork-ledger-'))
  process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude-config')
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(root, 'desktop')
  delete process.env['CLAUDE_CONFIG_DIRS']
  await mkdir(process.env['CLAUDE_CONFIG_DIR'], { recursive: true })
})

afterEach(async () => {
  clearSessionCache()
  setPriceOverrides({})
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
  model = 'us.anthropic.claude-sonnet-5',
): string {
  return JSON.stringify({
    ts: Date.parse(ts),
    surface,
    sessionId,
    isError: false,
    models: {
      [model]: {
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

async function makeTranscript(timestamp = '2099-05-10T12:00:00.120Z', model = 'claude-sonnet-5'): Promise<string> {
  const projectDir = join(process.env['CLAUDE_CONFIG_DIR']!, 'projects', '-Users-test')
  const path = join(projectDir, 'code-session.jsonl')
  await mkdir(projectDir, { recursive: true })
  await writeFile(path, JSON.stringify({
    type: 'assistant',
    sessionId: 'code-session',
    timestamp,
    cwd: '/Users/test',
    message: {
      id: 'message-code',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 30,
      },
    },
  }) + '\n')
  const mtime = new Date(timestamp)
  await utimes(path, mtime, mtime)
  return path
}

async function makeCoworkTranscript(timestamp = '2099-05-10T12:02:00.120Z', model = 'claude-sonnet-5'): Promise<string> {
  const projectDir = join(
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR']!,
    'app',
    'workspace',
    'local_cowork-session',
    '.claude',
    'projects',
    '-Users-test',
  )
  const path = join(projectDir, 'cowork-session.jsonl')
  await mkdir(projectDir, { recursive: true })
  await writeFile(path, JSON.stringify({
    type: 'assistant',
    sessionId: 'cowork-transcript-session',
    timestamp,
    message: {
      id: 'message-cowork',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 30,
      },
    },
  }) + '\n')
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

  it('parses Cowork and Code records with surface labels and CodeBurn pricing', async () => {
    const path = await makeLedger([
      ledgerLine('2099-05-10T12:00:00.000Z', 'session-1', 'cowork', 0.25),
      ledgerLine('2099-05-10T12:01:00.000Z', 'session-2', 'code', 0.99),
      'not-json',
    ])

    const calls = []
    const parser = claude.createSessionParser(source(path), new Set(), range('2099-05-10'))
    for await (const call of parser.parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      provider: 'claude',
      model: 'us.anthropic.claude-sonnet-5',
      sessionId: 'session-1',
      project: 'Claude Cowork',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      costUSD: calculateCost('us.anthropic.claude-sonnet-5', 10, 20, 40, 30, 0, 'standard', 0, 'claude'),
    })
    expect(calls[0]).not.toHaveProperty('costFromBilling')
    expect(calls[1]).toMatchObject({
      sessionId: 'session-2',
      project: 'Claude Code',
      costUSD: calls[0]!.costUSD,
    })
    expect(calls[1]).not.toHaveProperty('costFromBilling')
  })

  it('merges ledger usage into the normal Claude report', async () => {
    await makeLedger([ledgerLine('2099-05-10T12:00:00.000Z', 'session-1', 'cowork', 0.25)])

    const projects = await parseAllSessions(range('2099-05-10'), 'claude')
    const cowork = projects.find(project => project.project === 'Claude Cowork')

    expect(cowork).toMatchObject({
      totalCostUSD: calculateCost('us.anthropic.claude-sonnet-5', 10, 20, 40, 30, 0, 'standard', 0, 'claude'),
      totalApiCalls: 1,
      sessions: [{ sessionId: 'session-1', totalCostUSD: calculateCost('us.anthropic.claude-sonnet-5', 10, 20, 40, 30, 0, 'standard', 0, 'claude') }],
    })
  })

  it('counts a matching transcript and ledger request once, then keeps it after transcript deletion', async () => {
    const transcriptPath = await makeTranscript()
    await makeLedger([ledgerLine('2099-05-10T12:00:00.000Z', 'session-code', 'code', 0.99)])

    const expectedCost = calculateCost('us.anthropic.claude-sonnet-5', 10, 20, 40, 30, 0, 'standard', 0, 'claude')
    const first = await parseAllSessions(range('2099-05-10'), 'claude')
    expect(first.reduce((total, project) => total + project.totalApiCalls, 0)).toBe(1)
    expect(first.flatMap(project => project.sessions.map(session => session.sessionId))).toEqual(['code-session'])

    await rm(transcriptPath)
    clearSessionCache()

    const afterDeletion = await parseAllSessions(range('2099-05-10'), 'claude')
    expect(afterDeletion.reduce((total, project) => total + project.totalApiCalls, 0)).toBe(1)
    expect(afterDeletion).toContainEqual(expect.objectContaining({
      project: 'Claude Code',
      totalApiCalls: 1,
      totalCostUSD: expectedCost,
    }))
  })

  it('keeps ledger usage in Claude Desktop source-filtered views', async () => {
    await makeLedger([ledgerLine('2099-05-10T12:00:00.000Z', 'session-code', 'code', 0.99)])

    const projects = await parseAllSessions(range('2099-05-10'), 'claude')
    const ledgerSource = (await claude.discoverSessions()).find(source =>
      source.sourceKind === 'claude-desktop-ledger'
    )
    expect(ledgerSource?.sourceId).toBeTruthy()

    const filtered = filterProjectsByClaudeConfigSource(projects, ledgerSource!.sourceId!)
    const code = filtered.find(project => project.project === 'Claude Code')
    expect(code).toMatchObject({
      totalApiCalls: 1,
      sessions: [{
        source: {
          id: ledgerSource!.sourceId,
          kind: 'claude-desktop-ledger',
        },
      }],
    })
  })

  it('deduplicates a matching Cowork transcript and ledger request', async () => {
    await makeCoworkTranscript()
    await makeLedger([ledgerLine('2099-05-10T12:02:00.000Z', 'session-cowork', 'cowork', 0.99)])

    const projects = await parseAllSessions(range('2099-05-10'), 'claude')
    expect(projects.reduce((total, project) => total + project.totalApiCalls, 0)).toBe(1)
    expect(projects.flatMap(project => project.sessions.map(session => session.sessionId))).toEqual(['cowork-session'])
  })

  it('caches the whole ledger file even when the first parse is range-limited', async () => {
    await makeLedger([
      ledgerLine('2099-05-10T12:00:00.000Z', 'session-1', 'cowork', 0.25),
      ledgerLine('2099-05-11T12:00:00.000Z', 'session-2', 'cowork', 0.25),
    ])

    await parseAllSessions(range('2099-05-10'), 'claude')
    clearSessionCache()
    const nextDay = await parseAllSessions(range('2099-05-11'), 'claude')

    expect(nextDay.flatMap(project => project.sessions.map(session => session.sessionId))).toEqual(['session-2'])
  })

  it('does not deduplicate calls more than 30 seconds apart', async () => {
    await makeTranscript('2099-05-10T12:00:30.001Z')
    await makeLedger([ledgerLine('2099-05-10T12:00:00.000Z', 'session-code', 'code', 0.99)])

    const projects = await parseAllSessions(range('2099-05-10'), 'claude')
    expect(projects.reduce((total, project) => total + project.totalApiCalls, 0)).toBe(2)
  })

  it('keeps different explicit model routes separate during deduplication', async () => {
    await makeTranscript('2099-05-10T12:00:00.120Z', 'us.anthropic.claude-sonnet-5')
    await makeLedger([
      ledgerLine(
        '2099-05-10T12:00:00.000Z',
        'session-code',
        'code',
        0.99,
        {},
        'global.anthropic.claude-sonnet-5',
      ),
    ])

    const projects = await parseAllSessions(range('2099-05-10'), 'claude')
    expect(projects.reduce((total, project) => total + project.totalApiCalls, 0)).toBe(2)
  })

  it('reprices cached ledger usage when CodeBurn overrides change', async () => {
    await makeLedger([ledgerLine('2099-05-10T12:00:00.000Z', 'session-code', 'code', 0.99)])

    const first = await parseAllSessions(range('2099-05-10'), 'claude')
    const firstCost = first.find(project => project.project === 'Claude Code')!.totalCostUSD

    setPriceOverrides({
      'us.anthropic.claude-sonnet-5': {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheCreation: 40,
      },
    })
    clearSessionCache()

    const second = await parseAllSessions(range('2099-05-10'), 'claude')
    const expectedCost = calculateCost('us.anthropic.claude-sonnet-5', 10, 20, 40, 30, 0, 'standard', 0, 'claude')
    expect(second.find(project => project.project === 'Claude Code')!.totalCostUSD).toBe(expectedCost)
    expect(second.find(project => project.project === 'Claude Code')!.totalCostUSD).toBeGreaterThan(firstCost)
  })
})
