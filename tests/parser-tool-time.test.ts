import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const readOffsets: Array<{ filePath: string; startByteOffset?: number }> = []
vi.mock('../src/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fs-utils.js')>()
  return {
    ...actual,
    readSessionLines: (filePath: string, skip?: unknown, options?: { startByteOffset?: number }) => {
      readOffsets.push({ filePath, startByteOffset: options?.startByteOffset })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readSessionLines as any)(filePath, skip, options)
    },
  }
})

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { exportJson } from '../src/export.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

let tmpDir: string
let sessionPath: string
const CWD = '/tmp/tool-time-proj'
const T0 = Date.parse('2026-05-01T10:00:00.000Z')
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()

beforeEach(async () => {
  clearSessionCache()
  readOffsets.length = 0
  tmpDir = await mkdtemp(join(tmpdir(), 'tool-time-'))
  const projectDir = join(tmpDir, 'projects', 'tool-time-proj')
  await mkdir(projectDir, { recursive: true })
  sessionPath = join(projectDir, 'sess-1.jsonl')
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

const base = { sessionId: 'sess-1', cwd: CWD }

function prompt(sec: number, text: string, extra: Record<string, unknown> = { origin: { kind: 'human' } }): string {
  return JSON.stringify({ type: 'user', ...base, timestamp: at(sec), ...extra, message: { role: 'user', content: text } })
}

function asst(id: string, sec: number, blocks: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({
    type: 'assistant', ...base, timestamp: at(sec),
    message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: blocks, usage: { input_tokens: 10, output_tokens: 5 } },
  })
}

function results(sec: number, ids: string[], body = 'ok'): string {
  return JSON.stringify({
    type: 'user', ...base, timestamp: at(sec),
    message: { role: 'user', content: ids.map(id => ({ tool_use_id: id, type: 'tool_result', content: body })) },
  })
}

function turnEnd(sec: number): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration', ...base, timestamp: at(sec), durationMs: 1 })
}

const tool = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input })

async function parse(cacheDir: string): Promise<SessionSummary> {
  clearSessionCache()
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  const projects: ProjectSummary[] = await parseAllSessions()
  const sessions = projects.flatMap(p => p.sessions)
  expect(sessions).toHaveLength(1)
  return sessions[0]!
}

async function freshCache(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tool-time-cache-'))
}

describe('Claude tool time and waiting on you', () => {
  it('times each tool call from its result, skipping spawns, questions and background launches', async () => {
    await writeFile(sessionPath, [
      prompt(0, 'start'),
      asst('m1', 1, [
        tool('tu1', 'Bash', { command: 'git status && ls' }),
        tool('tu2', 'Agent', { subagent_type: 'Explore' }),
        tool('tu3', 'AskUserQuestion'),
        tool('tu4', 'Bash', { command: 'sleep 99', run_in_background: true }),
      ]),
      results(6, ['tu1', 'tu2', 'tu3', 'tu4']),
      asst('m2', 7, [tool('tu5', 'Read', { file_path: '/a.ts' }), tool('tu7', 'mcp__ctx__search')]),
      // Over 32 KB, so it goes through the large-line scanner.
      results(9, ['tu5'], 'x'.repeat(40_000)),
      results(10, ['tu7']),
      asst('m3', 11, [tool('tu6', 'Bash', { command: 'for i in 1 2; do sleep 1; done' })]),
      results(11 + 40 * 60, ['tu6']),
      turnEnd(11 + 40 * 60),
    ].join('\n') + '\n')

    const cache = await freshCache()
    const s = await parse(cache)
    await rm(cache, { recursive: true, force: true })

    expect(s.toolBreakdown['Bash']).toEqual({ calls: 3, durationMs: 5_000 + 30 * 60_000, timedCalls: 2 })
    expect(s.toolBreakdown['Agent']).toEqual({ calls: 1 })
    expect(s.toolBreakdown['AskUserQuestion']).toEqual({ calls: 1 })
    expect(s.toolBreakdown['Read']).toEqual({ calls: 1, durationMs: 2_000, timedCalls: 1 })
    expect(s.mcpBreakdown['ctx']).toEqual({ calls: 1, durationMs: 3_000, timedCalls: 1 })
    expect(s.bashBreakdown['git']).toEqual({ calls: 1, durationMs: 5_000, timedCalls: 1 })
    expect(s.bashBreakdown['ls']).toEqual({ calls: 1 })
    expect(s.bashBreakdown['sleep']).toEqual({ calls: 1 })
    expect(s.bashBreakdown['for']).toEqual({ calls: 1, durationMs: 30 * 60_000, timedCalls: 1 })
  })

  it('sums the waits before human prompts, counts long ones as away, and keeps a reply-less prompt', async () => {
    await writeFile(sessionPath, [
      prompt(0, 'start'),
      asst('m1', 2),
      turnEnd(3),
      prompt(63, 'second'),
      asst('m2', 64),
      turnEnd(65),
      prompt(65 + 2 * 3600, 'back after lunch'),
      asst('m3', 65 + 2 * 3600 + 1),
      turnEnd(65 + 2 * 3600 + 2),
      prompt(65 + 2 * 3600 + 12, '/model'),
      prompt(65 + 2 * 3600 + 32, 'next'),
      asst('m4', 65 + 2 * 3600 + 33),
      prompt(65 + 2 * 3600 + 40, 'injected', { isMeta: true, origin: { kind: 'human' } }),
      prompt(65 + 2 * 3600 + 50, 'from a peer', { origin: { kind: 'peer' } }),
    ].join('\n') + '\n')

    const cache = await freshCache()
    const s = await parse(cache)
    await rm(cache, { recursive: true, force: true })

    expect(s.waitingMs).toBe(60_000 + 10_000 + 20_000)
    expect(s.awayGaps).toBe(1)
  })

  it('completes a tool call and a prompt wait that straddle an appended region', async () => {
    const lines = [
      prompt(0, 'start'),
      asst('m1', 1, [tool('tu1', 'Bash', { command: 'npm test' })]),
      results(4, ['tu1']),
      asst('m2', 5, [tool('tu2', 'Bash', { command: 'sleep 30' }), tool('tu3', 'Read', { file_path: '/b.ts' })]),
    ]
    const appended = [
      results(35, ['tu2', 'tu3']),
      asst('m3', 36),
      turnEnd(37),
      prompt(97, 'again'),
      asst('m4', 98, [tool('tu4', 'Grep')]),
    ]
    await writeFile(sessionPath, lines.join('\n') + '\n')
    const warmCache = await freshCache()
    await parse(warmCache)

    await appendFile(sessionPath, appended.join('\n') + '\n')
    readOffsets.length = 0
    const warm = await parse(warmCache)
    expect(readOffsets.some(c => c.filePath === sessionPath && (c.startByteOffset ?? 0) > 0)).toBe(true)

    const coldCache = await freshCache()
    const cold = await parse(coldCache)
    await rm(coldCache, { recursive: true, force: true })
    await rm(warmCache, { recursive: true, force: true })

    expect(warm.toolBreakdown['Bash']).toEqual({ calls: 2, durationMs: 3_000 + 30_000, timedCalls: 2 })
    expect(warm.toolBreakdown['Read']).toEqual({ calls: 1, durationMs: 30_000, timedCalls: 1 })
    expect(warm.bashBreakdown['sleep']).toEqual({ calls: 1, durationMs: 30_000, timedCalls: 1 })
    expect(warm.waitingMs).toBe(60_000)
    expect(warm.toolBreakdown).toEqual(cold.toolBreakdown)
    expect(warm.bashBreakdown).toEqual(cold.bashBreakdown)
    expect(warm.waitingMs).toBe(cold.waitingMs)
  })

  it('puts tool time and waiting into the JSON export', async () => {
    await writeFile(sessionPath, [
      prompt(0, 'start'),
      asst('m1', 1, [tool('tu1', 'Bash', { command: 'git status' })]),
      results(5, ['tu1']),
      turnEnd(6),
      prompt(16, 'more'),
      asst('m2', 17),
    ].join('\n') + '\n')
    const cache = await freshCache()
    process.env['CODEBURN_CACHE_DIR'] = cache
    clearSessionCache()
    const projects = await parseAllSessions()
    const out = await exportJson([{ label: '30 Days', projects }], join(tmpDir, 'export.json'))
    const data = JSON.parse(await readFile(out, 'utf-8'))
    await rm(cache, { recursive: true, force: true })

    expect(data.tools.find((r: { tool: string }) => r.tool === 'Bash')).toMatchObject({ calls: 1, durationMs: 4_000, timedCalls: 1 })
    expect(data.shellCommands.find((r: { command: string }) => r.command === 'git')).toMatchObject({ durationMs: 4_000, timedCalls: 1 })
    expect(data.sessions[0]).toMatchObject({ waitingMs: 10_000 })
  })

  it('counts a wait once when its turn moves to another project mid-turn', async () => {
    const inDir = (line: string, cwd: string) => JSON.stringify({ ...JSON.parse(line), cwd })
    await writeFile(sessionPath, [
      prompt(0, 'start'),
      asst('m1', 1),
      turnEnd(2),
      prompt(62, 'go to app'),
      asst('m2', 63),
      inDir(asst('m3', 64), '/work/app'),
    ].join('\n') + '\n')
    const cache = await freshCache()
    process.env['CODEBURN_CACHE_DIR'] = cache
    clearSessionCache()
    const sessions = (await parseAllSessions()).flatMap(p => p.sessions)
    await rm(cache, { recursive: true, force: true })

    expect(sessions).toHaveLength(2)
    expect(sessions.reduce((n, s) => n + (s.waitingMs ?? 0), 0)).toBe(60_000)
  })
})

