import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { isWslUncPath, parseWslDistros, setWslHomes, wslMode } from '../src/wsl.js'
import { discoverClaudeConfigSources, getClaudeConfigDirs, claude } from '../src/providers/claude.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { reconcileFile } from '../src/session-cache.js'
import { parseAllSessions } from '../src/parser.js'
import type { DateRange } from '../src/types.js'

/** wsl.exe --list --quiet writes UTF-16LE with CRLF ends. */
function wslOutput(lines: string[], withBom = false): Buffer {
  return Buffer.from((withBom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n', 'utf16le')
}

const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEBURN_DESKTOP_SESSIONS_DIR', 'CODEX_HOME', 'CODEBURN_CACHE_DIR'] as const
let saved: Record<string, string | undefined>
let tmpDir: string

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  tmpDir = await mkdtemp(join(tmpdir(), 'wsl-test-'))
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'no-desktop')
  delete process.env['CLAUDE_CONFIG_DIRS']
})

afterEach(async () => {
  setWslHomes(undefined)
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]!
  }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('wsl.exe distro listing', () => {
  it('decodes UTF-16LE output with NULs and CRLF', () => {
    const raw = wslOutput(['Ubuntu', 'Debian'])
    expect(raw.includes(0)).toBe(true)
    expect(parseWslDistros(raw)).toEqual(['Ubuntu', 'Debian'])
  })

  it('strips the BOM and blank trailing lines', () => {
    expect(parseWslDistros(wslOutput(['Ubuntu-24.04', '', ''], true))).toEqual(['Ubuntu-24.04'])
  })

  it('filters container-runtime utility distros', () => {
    const raw = wslOutput(['docker-desktop', 'docker-desktop-data', 'podman-machine-default', 'rancher-desktop', 'Ubuntu'])
    expect(parseWslDistros(raw)).toEqual(['Ubuntu'])
  })

  it('yields no names from the "no installed distributions" message', () => {
    // Every line of this would otherwise be probed as a distro over UNC.
    expect(parseWslDistros(wslOutput([
      'Windows Subsystem for Linux has no installed distributions.',
      "Use 'wsl.exe --list --online' to list available distributions",
      "and 'wsl.exe --install <Distro>' to install.",
      '',
      'Distributions can also be installed by visiting the Microsoft Store:',
      'https://aka.ms/wslstore',
    ]))).toEqual([])
  })

  it('keeps the punctuation real distro names actually use', () => {
    expect(parseWslDistros(wslOutput(['Ubuntu-24.04', 'openSUSE-Leap-15.6', 'kali-linux', 'FedoraLinux-42'])))
      .toEqual(['Ubuntu-24.04', 'openSUSE-Leap-15.6', 'kali-linux', 'FedoraLinux-42'])
  })

  it('falls back to UTF-8 when the output carries no NULs', () => {
    expect(parseWslDistros(Buffer.from('Ubuntu\nArch\n', 'utf8'))).toEqual(['Ubuntu', 'Arch'])
  })

  it('returns nothing for empty output', () => {
    expect(parseWslDistros(Buffer.from(''))).toEqual([])
  })
})

describe('CODEBURN_WSL mode', () => {
  it('defaults to running-only', () => {
    expect(wslMode({})).toBe('running')
    expect(wslMode({ CODEBURN_WSL: '' })).toBe('running')
    expect(wslMode({ CODEBURN_WSL: 'running' })).toBe('running')
  })

  it('accepts off and all, case-insensitively', () => {
    expect(wslMode({ CODEBURN_WSL: 'off' })).toBe('off')
    expect(wslMode({ CODEBURN_WSL: ' ALL ' })).toBe('all')
  })

  it('treats an unrecognized value as the default rather than disabling discovery', () => {
    expect(wslMode({ CODEBURN_WSL: 'yes' })).toBe('running')
  })
})

describe('UNC path classification', () => {
  it('recognizes both WSL share spellings', () => {
    expect(isWslUncPath('\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\a.jsonl')).toBe(true)
    expect(isWslUncPath('\\\\wsl.localhost\\Debian\\root\\.codex')).toBe(true)
  })

  it('leaves ordinary Windows and POSIX paths alone', () => {
    expect(isWslUncPath('C:\\Users\\me\\.claude')).toBe(false)
    expect(isWslUncPath('\\\\server\\share\\wsl$')).toBe(false)
    expect(isWslUncPath('/home/me/.claude')).toBe(false)
  })
})

describe('WSL homes as extra provider roots', () => {
  it('appends <wslHome>/.claude to the configured Claude dirs', async () => {
    const windowsHome = join(tmpDir, 'win', '.claude')
    const wslHome = join(tmpDir, 'wsl', 'ubuntu-me')
    process.env['CLAUDE_CONFIG_DIR'] = windowsHome
    setWslHomes([wslHome])

    expect(await getClaudeConfigDirs()).toEqual([windowsHome, join(wslHome, '.claude')])
  })

  it('adds them alongside an explicit CLAUDE_CONFIG_DIRS list instead of being overridden', async () => {
    const wslHome = join(tmpDir, 'wsl', 'ubuntu-me')
    process.env['CLAUDE_CONFIG_DIRS'] = [join(tmpDir, 'work'), join(tmpDir, 'personal')].join(process.platform === 'win32' ? ';' : ':')
    setWslHomes([wslHome])

    expect(await getClaudeConfigDirs()).toContain(join(wslHome, '.claude'))
  })

  it('adds nothing when no WSL homes were discovered', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'win', '.claude')
    setWslHomes([])
    expect(await getClaudeConfigDirs()).toEqual([join(tmpDir, 'win', '.claude')])
  })

  it('discovers Claude sessions living under a WSL home', async () => {
    const wslHome = join(tmpDir, 'wsl', 'ubuntu-me')
    process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'win', '.claude')
    await mkdir(join(wslHome, '.claude', 'projects', '-home-me-proj'), { recursive: true })
    await writeFile(join(wslHome, '.claude', 'projects', '-home-me-proj', 's.jsonl'), '')
    setWslHomes([wslHome])

    const sources = await claude.discoverSessions()
    expect(sources.map(s => s.path)).toContain(join(wslHome, '.claude', 'projects', '-home-me-proj'))
  })

  it('labels each WSL config source by its distro instead of numbering ".claude"', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'win', '.claude')
    setWslHomes(['\\\\wsl$\\Ubuntu\\home\\me', '\\\\wsl.localhost\\Debian\\root'])

    const labels = (await discoverClaudeConfigSources()).map(s => s.label)
    expect(labels).toEqual(expect.arrayContaining(['Ubuntu (WSL)', 'Debian (WSL)']))
  })

  it('names the user too when one distro contributes several homes', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'win', '.claude')
    setWslHomes([
      '\\\\wsl$\\Ubuntu\\home\\alice',
      '\\\\wsl$\\Ubuntu\\home\\bob',
      '\\\\wsl$\\Ubuntu\\root',
      '\\\\wsl$\\Debian\\home\\carol',
    ])

    const labels = (await discoverClaudeConfigSources()).map(s => s.label)
    // Debian has a single home, so it keeps the plain distro label.
    expect(labels).toEqual(expect.arrayContaining([
      'Ubuntu (WSL, alice)', 'Ubuntu (WSL, bob)', 'Ubuntu (WSL, root)', 'Debian (WSL)',
    ]))
    // No WSL label was left for makeUniqueLabels to number.
    expect(labels.filter(l => l.includes('(WSL')).some(l => / \d$/.test(l))).toBe(false)
  })

  it('reports each WSL root in probeRoots so doctor can show a missing one', async () => {
    const wslHome = join(tmpDir, 'wsl', 'ubuntu-me')
    process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'win', '.claude')
    setWslHomes([wslHome])

    const roots = await claude.probeRoots!()
    expect(roots.map(r => r.path)).toContain(join(wslHome, '.claude', 'projects'))
  })

  it('discovers Codex rollouts under a WSL home and probes both roots', async () => {
    const winCodex = join(tmpDir, 'win', '.codex')
    const wslHome = join(tmpDir, 'wsl', 'ubuntu-me')
    process.env['CODEX_HOME'] = winCodex
    const dayDir = join(wslHome, '.codex', 'sessions', '2099', '05', '01')
    await mkdir(dayDir, { recursive: true })
    await writeFile(join(dayDir, 'rollout-2099-05-01T10-00-00-abc.jsonl'), JSON.stringify({
      type: 'session_meta',
      timestamp: '2099-05-01T10:00:00Z',
      payload: { cwd: '/home/me/proj', originator: 'codex-cli', session_id: 'sess-wsl', model: 'gpt-5.3-codex' },
    }) + '\n')
    setWslHomes([wslHome])

    const provider = createCodexProvider()
    expect((await provider.discoverSessions()).map(s => s.path))
      .toContain(join(dayDir, 'rollout-2099-05-01T10-00-00-abc.jsonl'))
    expect((await provider.probeRoots!()).map(r => r.path))
      .toEqual(expect.arrayContaining([join(winCodex, 'sessions'), join(wslHome, '.codex', 'sessions')]))
  })

  it('leaves an explicitly constructed Codex provider scanning exactly its dir', async () => {
    setWslHomes([join(tmpDir, 'wsl', 'ubuntu-me')])
    const roots = await createCodexProvider(join(tmpDir, 'fixture')).probeRoots!()
    expect(roots.map(r => r.path)).toEqual([join(tmpDir, 'fixture', 'sessions'), join(tmpDir, 'fixture', 'archived_sessions')])
  })
})

describe('9P fingerprint carve-out', () => {
  // fingerprintFile zeroes dev/ino for \\wsl$ paths; these assert that a
  // fingerprint pair carrying zeros still reconciles on mtime+size alone.
  const base = { dev: 0, ino: 0, mtimeMs: 1000, sizeBytes: 500 }

  it('treats an unchanged WSL file as unchanged', () => {
    expect(reconcileFile(base, { fingerprint: base, calls: [] })).toEqual({ action: 'unchanged' })
  })

  it('still detects an append', () => {
    const grown = { ...base, mtimeMs: 2000, sizeBytes: 900 }
    expect(reconcileFile(grown, { fingerprint: base, calls: [], lastCompleteLineOffset: 500 }))
      .toEqual({ action: 'appended', readFromOffset: 500 })
  })

  it('without the carve-out an unstable inode would force a re-parse', () => {
    const sameFileNewInode = { dev: 5, ino: 42, mtimeMs: 1000, sizeBytes: 500 }
    expect(reconcileFile(sameFileNewInode, { fingerprint: { ...base, dev: 5, ino: 7 }, calls: [] }))
      .toEqual({ action: 'modified' })
  })
})

describe('Linux cwd recorded on a Windows host', () => {
  function dayRange(day: string): DateRange {
    return { start: new Date(`${day}T00:00:00.000Z`), end: new Date(`${day}T23:59:59.999Z`) }
  }

  async function writeClaudeSession(configDir: string, cwd: string): Promise<void> {
    const projectDir = join(configDir, 'projects', '-home-me-proj')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'wsl-session.jsonl'), JSON.stringify({
      type: 'assistant',
      sessionId: 'wsl-session',
      timestamp: '2099-05-01T12:00:00.000Z',
      cwd,
      message: {
        id: 'msg-wsl',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n')
  }

  async function parseAsWin32(): Promise<string[]> {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      return (await parseAllSessions(dayRange('2099-05-01'), 'claude')).map(p => p.projectPath)
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  }

  it('keeps a /home/... cwd that has no counterpart on the Windows filesystem', async () => {
    const configDir = join(tmpDir, 'win', '.claude')
    process.env['CLAUDE_CONFIG_DIR'] = configDir
    await writeClaudeSession(configDir, '/home/me/proj')
    setWslHomes([])

    expect(await parseAsWin32()).toContain('/home/me/proj')
  })

  it('does not walk a POSIX cwd on win32, so a worktree marker cannot rewrite it', async () => {
    // A real POSIX tree the walk WOULD canonicalize to `main` if it ran: the
    // #984 guard must reject the path before that, because on Windows a
    // /home/... cwd names nothing on the local filesystem.
    const configDir = join(tmpDir, 'win2', '.claude')
    const worktree = join(tmpDir, 'wt')
    process.env['CLAUDE_CONFIG_DIR'] = configDir
    await mkdir(join(tmpDir, 'main', '.git', 'worktrees', 'wt'), { recursive: true })
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), `gitdir: ${join(tmpDir, 'main', '.git', 'worktrees', 'wt')}\n`)
    await writeClaudeSession(configDir, worktree)
    setWslHomes([])

    const paths = await parseAsWin32()
    expect(paths).toContain(worktree)
    expect(paths).not.toContain(join(tmpDir, 'main'))
  })
})
