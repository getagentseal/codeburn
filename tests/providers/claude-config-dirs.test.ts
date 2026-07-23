import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { delimiter as pathDelimiter, join, resolve, sep } from 'path'
import { homedir, tmpdir } from 'os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { claude, getDesktopSessionsDirs } from '../../src/providers/claude.js'
import { clearSessionCache, filterProjectsByClaudeConfigSource, parseAllSessions } from '../../src/parser.js'

let tmpRoot: string
const savedEnv = {
  CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'],
  CLAUDE_CONFIG_DIRS: process.env['CLAUDE_CONFIG_DIRS'],
  CODEBURN_DESKTOP_SESSIONS_DIR: process.env['CODEBURN_DESKTOP_SESSIONS_DIR'],
  APPDATA: process.env['APPDATA'],
  LOCALAPPDATA: process.env['LOCALAPPDATA'],
  HOME: process.env['HOME'],
}

function withPlatform<T>(platform: typeof process.platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, enumerable: true, configurable: true })
  try {
    return run()
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
    else delete (process as { platform?: NodeJS.Platform }).platform
  }
}

beforeEach(async () => {
  clearSessionCache()
  tmpRoot = await mkdtemp(join(tmpdir(), 'codeburn-claude-multi-'))
  // Point HOME at a scratch dir so the default `~/.claude` fallback resolves
  // somewhere we control. Without this, a stray `~/.claude` on the test
  // machine could leak into discovery.
  process.env['HOME'] = join(tmpRoot, 'home')
  await mkdir(process.env['HOME'], { recursive: true })
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CLAUDE_CONFIG_DIRS']
  delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  delete process.env['APPDATA']
  delete process.env['LOCALAPPDATA']
})

afterEach(async () => {
  clearSessionCache()
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
    expect(new Set(ourSources.map(s => s.sourceKind))).toEqual(new Set(['claude-config']))
    expect(new Set(ourSources.map(s => s.sourceLabel))).toEqual(new Set(['claude-work', 'claude-personal']))
    expect(ourSources.every(s => typeof s.sourceId === 'string' && s.sourceId.startsWith('claude-config:'))).toBe(true)
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

describe('claude provider — Desktop sessions dir', () => {
  async function makeMsixSessionsDir(localAppData: string, packageName: string): Promise<string> {
    const sessionsDir = join(
      localAppData,
      'Packages',
      packageName,
      'LocalCache',
      'Roaming',
      'Claude',
      'local-agent-mode-sessions',
    )
    await mkdir(sessionsDir, { recursive: true })
    return resolve(sessionsDir)
  }

  it('returns the classic Windows root first and discovers an MSIX sessions root', async () => {
    const appData = join(tmpRoot, 'roaming-profile')
    const localAppData = join(tmpRoot, 'local-profile')
    const classic = join(appData, 'Claude', 'local-agent-mode-sessions')
    const msix = await makeMsixSessionsDir(localAppData, 'Claude_fresh9k2m')
    await mkdir(classic, { recursive: true })
    process.env['APPDATA'] = appData
    process.env['LOCALAPPDATA'] = localAppData

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([resolve(classic), msix])
    })
  })

  it('filters MSIX package names and keeps both supported Claude name shapes', async () => {
    const appData = join(tmpRoot, 'roaming-profile')
    const localAppData = join(tmpRoot, 'local-profile')
    const classic = resolve(join(appData, 'Claude', 'local-agent-mode-sessions'))
    const direct = await makeMsixSessionsDir(localAppData, 'Claude_new7v4p')
    const publisher = await makeMsixSessionsDir(localAppData, 'SomePublisher.Claude_q8w3e')
    await makeMsixSessionsDir(localAppData, 'ClaudeXtra_foo')
    await makeMsixSessionsDir(localAppData, 'NotClaude_x')
    process.env['APPDATA'] = appData
    process.env['LOCALAPPDATA'] = localAppData

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([classic, direct, publisher])
    })
  })

  it('returns only the classic root when LOCALAPPDATA is unset and Packages is missing', () => {
    const appData = join(tmpRoot, 'roaming-profile')
    process.env['APPDATA'] = appData
    delete process.env['LOCALAPPDATA']

    withPlatform('win32', () => {
      expect(() => getDesktopSessionsDirs()).not.toThrow()
      expect(getDesktopSessionsDirs()).toEqual([
        resolve(join(appData, 'Claude', 'local-agent-mode-sessions')),
      ])
    })
  })

  it('falls back to the legacy Windows roaming path when APPDATA is unset or empty', () => {
    const expected = resolve(join(homedir(), 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions'))
    delete process.env['APPDATA']
    delete process.env['LOCALAPPDATA']

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([expected])
      process.env['APPDATA'] = ''
      expect(getDesktopSessionsDirs()).toEqual([expected])
    })
  })

  it('excludes an MSIX package whose sessions subpath is missing', async () => {
    const appData = join(tmpRoot, 'roaming-profile')
    const localAppData = join(tmpRoot, 'local-profile')
    await mkdir(join(localAppData, 'Packages', 'Claude_empty6r1t', 'LocalCache'), { recursive: true })
    process.env['APPDATA'] = appData
    process.env['LOCALAPPDATA'] = localAppData

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([
        resolve(join(appData, 'Claude', 'local-agent-mode-sessions')),
      ])
    })
  })

  it('returns exactly the resolved override without platform discovery', async () => {
    const override = join(tmpRoot, 'desktop-override')
    const localAppData = join(tmpRoot, 'local-profile')
    await makeMsixSessionsDir(localAppData, 'Claude_shouldnotappear5n8d')
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = override
    process.env['APPDATA'] = join(tmpRoot, 'roaming-profile')
    process.env['LOCALAPPDATA'] = localAppData

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([resolve(override)])
    })
  })

  it('resolves an override containing a parent segment and trailing separator', () => {
    const override = join(tmpRoot, 'desktop-parent', 'nested') + `${sep}..${sep}sessions${sep}`
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = override

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([resolve(override)])
    })
  })

  it('returns one platform root on darwin and linux without including MSIX packages', async () => {
    const localAppData = join(tmpRoot, 'local-profile')
    await makeMsixSessionsDir(localAppData, 'Claude_crossplatform3b7j')
    process.env['LOCALAPPDATA'] = localAppData

    withPlatform('darwin', () => {
      expect(getDesktopSessionsDirs()).toEqual([
        resolve(join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')),
      ])
    })
    withPlatform('linux', () => {
      expect(getDesktopSessionsDirs()).toEqual([
        resolve(join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions')),
      ])
    })
  })

  it('sorts two valid MSIX roots by package entry name', async () => {
    const appData = join(tmpRoot, 'roaming-profile')
    const localAppData = join(tmpRoot, 'local-profile')
    const later = await makeMsixSessionsDir(localAppData, 'Claude_zulu4c9x')
    const earlier = await makeMsixSessionsDir(localAppData, 'Alpha.Claude_alpha2m6v')
    process.env['APPDATA'] = appData
    process.env['LOCALAPPDATA'] = localAppData

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([
        resolve(join(appData, 'Claude', 'local-agent-mode-sessions')),
        earlier,
        later,
      ])
    })
  })

  it('dedupes classic and MSIX candidates that resolve to the same path', async () => {
    const localAppData = join(tmpRoot, 'local-profile')
    const packageName = 'Claude_duplicate8h3s'
    const sessionsDir = await makeMsixSessionsDir(localAppData, packageName)
    process.env['APPDATA'] = join(localAppData, 'Packages', packageName, 'LocalCache', 'Roaming')
    process.env['LOCALAPPDATA'] = localAppData

    withPlatform('win32', () => {
      expect(getDesktopSessionsDirs()).toEqual([sessionsDir])
    })
  })
})

describe('claude provider — config.json claudeConfigDirs (menubar-driven)', () => {
  async function writeConfigJson(value: unknown): Promise<void> {
    const dir = join(process.env['HOME']!, '.config', 'codeburn')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'config.json'), JSON.stringify({ claudeConfigDirs: value }))
  }

  it('honors claudeConfigDirs from config.json when no env var is set', async () => {
    const work = await makeConfigDir('claude-work', ['-Users-you-app'])
    const personal = await makeConfigDir('claude-personal', ['-Users-you-app'])
    await writeConfigJson([work, personal])

    const sources = await claude.discoverSessions()
    const paths = sources.map(s => s.path)
    expect(paths).toContain(join(work, 'projects', '-Users-you-app'))
    expect(paths).toContain(join(personal, 'projects', '-Users-you-app'))
  })

  it('lets env CLAUDE_CONFIG_DIRS override config.json', async () => {
    const fromEnv = await makeConfigDir('claude-env', ['-Users-you-app'])
    const fromFile = await makeConfigDir('claude-file', ['-Users-you-app'])
    await writeConfigJson([fromFile])
    process.env['CLAUDE_CONFIG_DIRS'] = fromEnv

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(fromEnv, 'projects', '-Users-you-app'))).toBe(true)
    expect(sources.every(s => !s.path.startsWith(fromFile))).toBe(true)
  })

  it('lets env CLAUDE_CONFIG_DIR override config.json', async () => {
    const fromEnv = await makeConfigDir('claude-env', ['-Users-you-app'])
    const fromFile = await makeConfigDir('claude-file', ['-Users-you-app'])
    await writeConfigJson([fromFile])
    process.env['CLAUDE_CONFIG_DIR'] = fromEnv

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(fromEnv, 'projects', '-Users-you-app'))).toBe(true)
    expect(sources.every(s => !s.path.startsWith(fromFile))).toBe(true)
  })

  it('falls back to ~/.claude when config.json claudeConfigDirs is empty', async () => {
    const homeDir = process.env['HOME']!
    await mkdir(join(homeDir, '.claude', 'projects', '-Users-you-app'), { recursive: true })
    await writeConfigJson([])

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(homeDir, '.claude', 'projects', '-Users-you-app'))).toBe(true)
  })

  it('expands ~ in config.json entries', async () => {
    const homeDir = process.env['HOME']!
    await mkdir(join(homeDir, 'cfg-claude', 'projects', '-Users-you-app'), { recursive: true })
    await writeConfigJson(['~/cfg-claude'])

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(homeDir, 'cfg-claude', 'projects', '-Users-you-app'))).toBe(true)
  })

  it('ignores non-string and blank entries in config.json', async () => {
    const real = await makeConfigDir('claude-real', ['-Users-you-app'])
    await writeConfigJson([real, 42, '', '   ', null])

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(real, 'projects', '-Users-you-app'))).toBe(true)
  })

  it('falls back to ~/.claude when claudeConfigDirs is not an array', async () => {
    const homeDir = process.env['HOME']!
    await mkdir(join(homeDir, '.claude', 'projects', '-Users-you-app'), { recursive: true })
    await writeConfigJson('not-an-array')

    const sources = await claude.discoverSessions()
    expect(sources.some(s => s.path === join(homeDir, '.claude', 'projects', '-Users-you-app'))).toBe(true)
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

  it('keeps source metadata on merged sessions so one Claude config can be selected', async () => {
    const work = await makeConfigDir('claude-work', [])
    const personal = await makeConfigDir('claude-personal', [])
    process.env['CLAUDE_CONFIG_DIRS'] = [work, personal].join(pathDelimiter)

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
    const merged = projects.find(p => p.project === slug)
    expect(merged).toBeDefined()
    expect(merged!.sessions).toHaveLength(2)

    const sourceIds = new Map(merged!.sessions.map(s => [s.source?.label, s.source?.id]))
    const workSourceId = sourceIds.get('claude-work')
    expect(workSourceId).toBeDefined()

    const workOnly = filterProjectsByClaudeConfigSource(projects, workSourceId!)
    expect(workOnly).toHaveLength(1)
    expect(workOnly[0]!.project).toBe(slug)
    expect(workOnly[0]!.totalApiCalls).toBe(1)
    expect(workOnly[0]!.sessions.map(s => s.sessionId)).toEqual(['sess-work'])
    expect(workOnly[0]!.sessions[0]!.source?.label).toBe('claude-work')
  })

  // Documents the path-aware merge behavior: the mergedMap in parseAllSessions
  // now keys by normalized cwd path (crossProviderKey), not by slug. Two dirs
  // can share the same slug but have different underlying cwds — those stay
  // separate because they represent genuinely different repositories. In real
  // Claude usage different cwds always produce different slugs anyway, so this
  // scenario is contrived, but the test pins the new behavior explicitly.
  it('keeps sessions with the same slug but different cwds as separate projects', async () => {
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
    // Different cwds → different crossProviderKey → two separate project rows.
    expect(matches).toHaveLength(2)
    expect(matches.every(m => m.totalApiCalls === 1)).toBe(true)
  })
})
