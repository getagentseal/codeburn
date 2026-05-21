import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises'
import { join, relative } from 'path'
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

async function writeClaudeSession(
  projectSlug: string,
  sessionId: string,
  cwd: string,
  timestamp: string,
  usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 50 },
  model = 'claude-sonnet-4-5',
): Promise<void> {
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
      model,
      content: [],
      usage,
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

  it('groups git worktrees under the main repository project', async () => {
    const mainRepo = join(tmpDir, 'repos', 'codeburn')
    const worktreeA = join(tmpDir, 'worktrees', 'codeburn-feature-a')
    const worktreeB = join(tmpDir, 'worktrees', 'codeburn-feature-b')
    await mkdir(join(mainRepo, '.git', 'worktrees', 'feature-a'), { recursive: true })
    await mkdir(join(mainRepo, '.git', 'worktrees', 'feature-b'), { recursive: true })
    await mkdir(worktreeA, { recursive: true })
    await mkdir(worktreeB, { recursive: true })
    await writeFile(join(worktreeA, '.git'), `gitdir: ${join(mainRepo, '.git', 'worktrees', 'feature-a')}\n`)
    await writeFile(join(worktreeB, '.git'), `gitdir: ${relative(worktreeB, join(mainRepo, '.git', 'worktrees', 'feature-b'))}\n`)

    await writeClaudeSession(
      'tmp-worktrees-codeburn-feature-a',
      'worktree-a-session',
      worktreeA,
      '2099-05-07T10:00:00.000Z',
    )
    await writeClaudeSession(
      'tmp-worktrees-codeburn-feature-b',
      'worktree-b-session',
      worktreeB,
      '2099-05-07T11:00:00.000Z',
    )

    const projects = await parseAllSessions(dayRange('2099-05-07'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.project).toBe('codeburn')
    expect(projects[0]!.projectPath).toBe(mainRepo)
    expect(projects[0]!.sessions).toHaveLength(2)
    expect(projects[0]!.totalApiCalls).toBe(2)
    expect(projects[0]!.sessions.map(s => s.sessionId).sort()).toEqual([
      'worktree-a-session',
      'worktree-b-session',
    ])
  })

  it('does not group separate-git-dir projects that are not git worktrees', async () => {
    const externalGitDir = join(tmpDir, 'external-git-dirs', 'project.git')
    const projectDir = join(tmpDir, 'standalone', 'separate-git-dir')
    await mkdir(externalGitDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, '.git'), `gitdir: ${externalGitDir}\n`)

    await writeClaudeSession(
      'tmp-standalone-separate-git-dir',
      'separate-git-dir-session',
      projectDir,
      '2099-05-08T10:00:00.000Z',
    )

    const projects = await parseAllSessions(dayRange('2099-05-08'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.projectPath).toBe(projectDir)
    expect(projects[0]!.project).toBe('tmp-standalone-separate-git-dir')
  })
})

describe('Claude cache creation pricing', () => {
  it('prices 1-hour cache writes from usage.cache_creation at the 2x input rate', async () => {
    await writeClaudeSession(
      'cache-pricing',
      'one-hour-cache',
      '/tmp/cache-pricing',
      '2099-05-05T10:00:00.000Z',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 60_120,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 60_120,
        },
      },
      'claude-opus-4-7',
    )

    const projects = await parseAllSessions(dayRange('2099-05-05'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.sessions[0]!.totalCacheWriteTokens).toBe(60_120)
    expect(projects[0]!.totalCostUSD).toBeCloseTo(0.6012, 6)
  })

  it('falls back to the legacy 5-minute cache write rate when split fields are absent', async () => {
    await writeClaudeSession(
      'legacy-cache-pricing',
      'legacy-cache',
      '/tmp/legacy-cache-pricing',
      '2099-05-06T10:00:00.000Z',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 60_120,
      },
      'claude-opus-4-7',
    )

    const projects = await parseAllSessions(dayRange('2099-05-06'), 'claude')

    expect(projects).toHaveLength(1)
    expect(projects[0]!.sessions[0]!.totalCacheWriteTokens).toBe(60_120)
    expect(projects[0]!.totalCostUSD).toBeCloseTo(0.37575, 6)
  })
})
