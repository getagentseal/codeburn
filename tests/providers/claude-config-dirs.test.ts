import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { delimiter as pathDelimiter, join } from 'path'
import { tmpdir, homedir } from 'os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { claude } from '../../src/providers/claude.js'
import { parseAllSessions } from '../../src/parser.js'

let tmpRoot: string
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'],
  CLAUDE_CONFIG_DIRS: process.env['CLAUDE_CONFIG_DIRS'],
  HOME: process.env['HOME'],
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'codeburn-claude-multi-'))
  // Point HOME at a scratch dir so the default `~/.claude` fallback resolves
  // somewhere we control. Without this, a stray `~/.claude` on the test
  // machine could leak into discovery.
  process.env['HOME'] = join(tmpRoot, 'home')
  await mkdir(process.env['HOME'], { recursive: true })
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CLAUDE_CONFIG_DIRS']
})

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(tmpRoot, { recursive: true, force: true })
})

async function makeConfigDir(name: string, projectSlugs: string[]): Promise<string> {
  const dir = join(tmpRoot, name)
  for (const slug of projectSlugs) {
    const projectDir = join(dir, 'projects', slug)
    await mkdir(projectDir, { recursive: true })
    // Discovery only checks for the project subdirectory. A real session
    // file is not required; the parser is exercised separately below.
  }
  return dir
}

async function writeSession(configDir: string, slug: string, sessionId: string, lines: string[]): Promise<void> {
  const dir = join(configDir, 'projects', slug)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.join('\n'))
}

function summaryLine(sessionId: string, cwd: string): string {
  return JSON.stringify({
    type: 'summary',
    summary: 'test',
    leafUuid: 'l',
    sessionId,
    cwd,
    timestamp: '2026-05-09T00:00:00.000Z',
  })
}

function userLine(uuid: string, sessionId: string, cwd: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    sessionId,
    cwd,
    timestamp: '2026-05-09T00:00:01.000Z',
    message: { role: 'user', content: text },
  })
}

function assistantLine(uuid: string, parentUuid: string, sessionId: string, cwd: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId,
    cwd,
    timestamp: '2026-05-09T00:00:02.000Z',
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  })
}

describe('claude provider — CLAUDE_CONFIG_DIRS discovery', () => {
  it('falls back to ~/.claude when no env var is set', async () => {
    const homeDir = process.env['HOME']!
    await mkdir(join(homeDir, '.claude', 'projects', '-Users-you-app'), { recursive: true })

    const sources = await claude.discoverSessions()
    const projectDirs = sources.map(s => s.path)
    expect(projectDirs).toContain(join(homeDir, '.claude', 'projects', '-Users-you-app'))
  })

  it('honors CLAUDE_CONFIG_DIR for a single override', async () => {
    const dir = await makeConfigDir('claude-work', ['-Users-you-app'])
    process.env['CLAUDE_CONFIG_DIR'] = dir

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(dir, 'projects', '-Users-you-app'))).toBe(true)
    // The default `~/.claude` should NOT also be scanned when the override is set.
    expect(sources.every(s => !s.path.startsWith(join(process.env['HOME']!, '.claude')))).toBe(true)
  })

  it('CLAUDE_CONFIG_DIRS overrides CLAUDE_CONFIG_DIR and walks every dir in the list', async () => {
    const work = await makeConfigDir('claude-work', ['-Users-you-app'])
    const personal = await makeConfigDir('claude-personal', ['-Users-you-app'])
    const single = await makeConfigDir('claude-other', ['-Users-you-other'])

    process.env['CLAUDE_CONFIG_DIR'] = single
    process.env['CLAUDE_CONFIG_DIRS'] = [work, personal].join(pathDelimiter)

    const sources = await claude.discoverSessions()
    const paths = sources.map(s => s.path)
    expect(paths).toContain(join(work, 'projects', '-Users-you-app'))
    expect(paths).toContain(join(personal, 'projects', '-Users-you-app'))
    // CLAUDE_CONFIG_DIR should be ignored once CLAUDE_CONFIG_DIRS is non-empty.
    expect(paths.some(p => p.startsWith(single))).toBe(false)
  })

  it('emits the same project name for the same slug across dirs (so parser merges)', async () => {
    const work = await makeConfigDir('claude-work', ['-Users-you-app'])
    const personal = await makeConfigDir('claude-personal', ['-Users-you-app'])
    process.env['CLAUDE_CONFIG_DIRS'] = [work, personal].join(pathDelimiter)

    const sources = await claude.discoverSessions()
    const ourSources = sources.filter(s =>
      s.path === join(work, 'projects', '-Users-you-app') ||
      s.path === join(personal, 'projects', '-Users-you-app'),
    )
    expect(ourSources).toHaveLength(2)
    expect(new Set(ourSources.map(s => s.project))).toEqual(new Set(['-Users-you-app']))
  })

  it('tolerates a non-existent dir in the list without dropping the real ones', async () => {
    const real = await makeConfigDir('claude-real', ['-Users-you-app'])
    const fake = join(tmpRoot, 'does-not-exist')
    process.env['CLAUDE_CONFIG_DIRS'] = [real, fake].join(pathDelimiter)

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(real, 'projects', '-Users-you-app'))).toBe(true)
  })

  it('dedupes when the same dir appears twice in CLAUDE_CONFIG_DIRS', async () => {
    const dir = await makeConfigDir('claude-once', ['-Users-you-app'])
    process.env['CLAUDE_CONFIG_DIRS'] = [dir, dir].join(pathDelimiter)

    const sources = await claude.discoverSessions()
    const ourSources = sources.filter(s => s.path === join(dir, 'projects', '-Users-you-app'))
    expect(ourSources).toHaveLength(1)
  })

  it('skips empty entries (leading, trailing, doubled delimiters)', async () => {
    const dir = await makeConfigDir('claude-only', ['-Users-you-app'])
    process.env['CLAUDE_CONFIG_DIRS'] = `${pathDelimiter}${dir}${pathDelimiter}${pathDelimiter}`

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(dir, 'projects', '-Users-you-app'))).toBe(true)
  })

  it('expands ~ in CLAUDE_CONFIG_DIR', async () => {
    const homeDir = process.env['HOME']!
    await mkdir(join(homeDir, 'custom-claude', 'projects', '-Users-you-app'), { recursive: true })
    process.env['CLAUDE_CONFIG_DIR'] = '~/custom-claude'

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(homeDir, 'custom-claude', 'projects', '-Users-you-app'))).toBe(true)
  })

  it('falls back to CLAUDE_CONFIG_DIR when CLAUDE_CONFIG_DIRS is set but empty', async () => {
    const single = await makeConfigDir('claude-fallback', ['-Users-you-app'])
    process.env['CLAUDE_CONFIG_DIR'] = single
    process.env['CLAUDE_CONFIG_DIRS'] = ''

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(single, 'projects', '-Users-you-app'))).toBe(true)
  })

  it('skips entries that point at a file rather than a directory', async () => {
    const real = await makeConfigDir('claude-real', ['-Users-you-app'])
    const filePath = join(tmpRoot, 'not-a-dir.txt')
    await writeFile(filePath, 'this is not a config dir')
    process.env['CLAUDE_CONFIG_DIRS'] = [real, filePath].join(pathDelimiter)

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(real, 'projects', '-Users-you-app'))).toBe(true)
    expect(sources.every(s => !s.path.startsWith(filePath))).toBe(true)
  })
})

describe('claude parser — multi-dir aggregation (issue #208 option 1)', () => {
  it('merges sessions from two config dirs into a single ProjectSummary when the canonical cwd matches', async () => {
    const work = await makeConfigDir('claude-work', [])
    const personal = await makeConfigDir('claude-personal', [])
    process.env['CLAUDE_CONFIG_DIRS'] = [work, personal].join(pathDelimiter)

    // Both accounts touch the same real project path. Same cwd -> same merge key.
    const slug = '-Users-you-shared-app'
    const cwd = '/Users/you/shared-app'
    await writeSession(work, slug, 'sess-work', [
      summaryLine('sess-work', cwd),
      userLine('u1', 'sess-work', cwd, 'hi from work'),
      assistantLine('a1', 'u1', 'sess-work', cwd),
    ])
    await writeSession(personal, slug, 'sess-personal', [
      summaryLine('sess-personal', cwd),
      userLine('u2', 'sess-personal', cwd, 'hi from personal'),
      assistantLine('a2', 'u2', 'sess-personal', cwd),
    ])

    const projects = await parseAllSessions(undefined, 'claude')
    const matches = projects.filter(p => p.project === slug)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.totalApiCalls).toBe(2)
    // Two sessions, one from each dir, both rolled up.
    expect(matches[0]!.sessions.map(s => s.sessionId).sort()).toEqual(['sess-personal', 'sess-work'])
    // No `account` or `accountPath` field should appear on the ProjectSummary
    // — option 1 explicitly avoids attribution.
    expect((matches[0]! as Record<string, unknown>)['account']).toBeUndefined()
    expect((matches[0]! as Record<string, unknown>)['accountPath']).toBeUndefined()
  })

  // Documents the option-1 behavior at the project-merge layer: the final
  // mergedMap in parseAllSessions keys by the sanitized project slug. If two
  // dirs both contain a slug `-Users-you-app/` whose underlying canonical
  // cwds differ, the slug-level merge collapses them into one row. In real
  // Claude usage this is unreachable because Claude derives the slug from
  // the cwd, so different cwds always produce different slugs. The test
  // pins the behavior so a future refactor cannot quietly swap to cwd-aware
  // merging without explicitly opting in.
  it('merges by sanitized slug even when sessions carry different canonical cwds', async () => {
    const work = await makeConfigDir('claude-work', [])
    const personal = await makeConfigDir('claude-personal', [])
    process.env['CLAUDE_CONFIG_DIRS'] = [work, personal].join(pathDelimiter)

    const slug = '-Users-you-app'
    await writeSession(work, slug, 'sess-work', [
      summaryLine('sess-work', '/Users/you/work-app'),
      userLine('u1', 'sess-work', '/Users/you/work-app', 'work'),
      assistantLine('a1', 'u1', 'sess-work', '/Users/you/work-app'),
    ])
    await writeSession(personal, slug, 'sess-personal', [
      summaryLine('sess-personal', '/Users/you/personal-app'),
      userLine('u2', 'sess-personal', '/Users/you/personal-app', 'personal'),
      assistantLine('a2', 'u2', 'sess-personal', '/Users/you/personal-app'),
    ])

    const projects = await parseAllSessions(undefined, 'claude')
    const matches = projects.filter(p => p.project === slug)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.totalApiCalls).toBe(2)
  })
})
