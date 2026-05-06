import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions } from '../src/parser.js'
import type { DateRange } from '../src/types.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'claude-cwd-test-'))
  originalConfigDir = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env['CLAUDE_CONFIG_DIR']
  } else {
    process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir
  }
  await rm(tmpDir, { recursive: true, force: true })
})

function dayRange(day: string): DateRange {
  return {
    start: new Date(`${day}T00:00:00.000Z`),
    end: new Date(`${day}T23:59:59.999Z`),
  }
}

async function writeClaudeSession(projectSlug: string, sessionId: string, cwd: string, timestamp: string): Promise<void> {
  const projectDir = join(tmpDir, 'projects', projectSlug)
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(filePath, JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    cwd,
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

describe('Claude cwd project paths', () => {
  it('uses the JSONL cwd as the canonical project path instead of the lossy directory slug', async () => {
    await writeClaudeSession(
      'c--AI-LAB-OPENCLAW',
      'windows-session',
      'C:\\AI_LAB\\OPENCLAW',
      '2099-05-01T12:00:00.000Z',
    )

    const projects = await parseAllSessions(dayRange('2099-05-01'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.projectPath).toBe('C:\\AI_LAB\\OPENCLAW')
    expect(projects[0]!.projectPath).not.toBe('c//AI/LAB/OPENCLAW')
    expect(projects[0]!.totalApiCalls).toBe(1)
  })

  it('groups Windows cwd case and slash variants into one project', async () => {
    await writeClaudeSession(
      'windows-openclaw-a',
      'upper-backslash',
      'C:\\AI_LAB\\OPENCLAW',
      '2099-05-02T10:00:00.000Z',
    )
    await writeClaudeSession(
      'windows-openclaw-b',
      'lower-forward-slash',
      'c:/AI_LAB/OPENCLAW/',
      '2099-05-02T11:00:00.000Z',
    )

    const projects = await parseAllSessions(dayRange('2099-05-02'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.sessions).toHaveLength(2)
    expect(projects[0]!.totalApiCalls).toBe(2)
    expect(projects[0]!.sessions.map(s => s.sessionId).sort()).toEqual([
      'lower-forward-slash',
      'upper-backslash',
    ])
  })

  it('prefers the canonical cwd path even when mixed with slug-only sessions in the same directory', async () => {
    const slug = 'c--AI-LAB-OPENCLAW'
    const projectDir = join(tmpDir, 'projects', slug)
    await mkdir(projectDir, { recursive: true })
    const noCwdPath = join(projectDir, 'a-no-cwd.jsonl')
    await writeFile(noCwdPath, JSON.stringify({
      type: 'assistant',
      sessionId: 'no-cwd',
      timestamp: '2099-05-03T10:00:00.000Z',
      message: {
        id: 'msg-no-cwd', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-5', content: [],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n')
    await utimes(noCwdPath, new Date('2099-05-03T10:00:00.000Z'), new Date('2099-05-03T10:00:00.000Z'))

    await writeClaudeSession(slug, 'b-with-cwd', 'C:\\AI_LAB\\OPENCLAW', '2099-05-03T11:00:00.000Z')

    const projects = await parseAllSessions(dayRange('2099-05-03'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.sessions).toHaveLength(2)
    expect(projects[0]!.projectPath).toBe('C:\\AI_LAB\\OPENCLAW')
    expect(projects[0]!.projectPath).not.toBe('c//AI/LAB/OPENCLAW')
  })

  it('falls back to the slug-derived path when cwd is null, missing, or empty', async () => {
    const slug = 'fallback-slug'
    const projectDir = join(tmpDir, 'projects', slug)
    await mkdir(projectDir, { recursive: true })

    async function writeWith(name: string, sessionId: string, cwdField: unknown, ts: string) {
      const filePath = join(projectDir, `${name}.jsonl`)
      const obj: Record<string, unknown> = {
        type: 'assistant', sessionId, timestamp: ts,
        message: {
          id: `msg-${sessionId}`, type: 'message', role: 'assistant',
          model: 'claude-sonnet-4-5', content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }
      if (cwdField !== undefined) obj.cwd = cwdField
      await writeFile(filePath, JSON.stringify(obj) + '\n')
      await utimes(filePath, new Date(ts), new Date(ts))
    }

    await writeWith('null-cwd', 's-null', null, '2099-05-04T10:00:00.000Z')
    await writeWith('empty-cwd', 's-empty', '', '2099-05-04T10:30:00.000Z')
    await writeWith('whitespace-cwd', 's-ws', '   ', '2099-05-04T11:00:00.000Z')
    await writeWith('missing-cwd', 's-miss', undefined, '2099-05-04T11:30:00.000Z')

    const projects = await parseAllSessions(dayRange('2099-05-04'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.sessions).toHaveLength(4)
    expect(projects[0]!.projectPath).toBe('fallback/slug')
  })
})
