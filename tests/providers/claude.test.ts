import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises'
import { delimiter, join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions } from '../../src/parser.js'
import { createClaudeProvider } from '../../src/providers/claude.js'
import type { DateRange } from '../../src/types.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalConfigDirs: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'claude-provider-test-'))
  originalConfigDir = process.env['CLAUDE_CONFIG_DIR']
  originalConfigDirs = process.env['CLAUDE_CONFIG_DIRS']
})

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env['CLAUDE_CONFIG_DIR']
  } else {
    process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir
  }
  if (originalConfigDirs === undefined) {
    delete process.env['CLAUDE_CONFIG_DIRS']
  } else {
    process.env['CLAUDE_CONFIG_DIRS'] = originalConfigDirs
  }
  await rm(tmpDir, { recursive: true, force: true })
})

async function createProjectDir(configDir: string, project: string): Promise<string> {
  const projectDir = join(configDir, 'projects', project)
  await mkdir(projectDir, { recursive: true })
  return projectDir
}

async function createSession(configDir: string, project: string, sessionId: string, timestamp: string): Promise<void> {
  const projectDir = await createProjectDir(configDir, project)
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

describe('claude provider', () => {
  it('discovers projects across multiple Claude config directories', async () => {
    const workDir = join(tmpDir, 'claude-work')
    const personalDir = join(tmpDir, 'claude-personal')
    await createProjectDir(workDir, '-Users-test-work')
    await createProjectDir(personalDir, '-Users-test-personal')

    const provider = createClaudeProvider([workDir, personalDir], join(tmpDir, 'missing-desktop'))
    const sessions = await provider.discoverSessions()

    expect(sessions.map(s => s.provider)).toEqual(['claude', 'claude'])
    expect(sessions.map(s => s.project).sort()).toEqual(['-Users-test-personal', '-Users-test-work'])
    expect(sessions.map(s => s.path).sort()).toEqual([
      join(personalDir, 'projects', '-Users-test-personal'),
      join(workDir, 'projects', '-Users-test-work'),
    ].sort())
  })

  it('tracks Claude sessions from CLAUDE_CONFIG_DIRS', async () => {
    const workDir = join(tmpDir, 'claude-work')
    const personalDir = join(tmpDir, 'claude-personal')
    const ignoredDir = join(tmpDir, 'claude-ignored')

    await createSession(workDir, '-Users-test-work', 'work-session', '2099-04-14T10:00:00.000Z')
    await createSession(personalDir, '-Users-test-personal', 'personal-session', '2099-04-14T11:00:00.000Z')
    await createSession(ignoredDir, '-Users-test-ignored', 'ignored-session', '2099-04-14T12:00:00.000Z')

    process.env['CLAUDE_CONFIG_DIRS'] = [workDir, personalDir].join(delimiter)
    process.env['CLAUDE_CONFIG_DIR'] = ignoredDir

    const range: DateRange = {
      start: new Date('2099-04-14T00:00:00.000Z'),
      end: new Date('2099-04-14T23:59:59.999Z'),
    }
    const projects = await parseAllSessions(range, 'claude')

    expect(projects.map(p => p.project).sort()).toEqual(['-Users-test-personal', '-Users-test-work'])
    expect(projects.reduce((sum, project) => sum + project.totalApiCalls, 0)).toBe(2)
  })
})
