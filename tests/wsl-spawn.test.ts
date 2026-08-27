import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// discoverWslHomes is win32-only and shells out to wsl.exe over a 9P share.
// Mock both so the spawn contract itself is asserted on macOS/Linux CI.
const execFileSync = vi.fn()
const readdirSync = vi.fn()
const existsSync = vi.fn()

vi.mock('child_process', () => ({ execFileSync: (...a: unknown[]) => execFileSync(...a) }))
vi.mock('fs', () => ({
  readdirSync: (...a: unknown[]) => readdirSync(...a),
  existsSync: (...a: unknown[]) => existsSync(...a),
}))

const { setWslHomes, wslDoctorNote, wslHomes } = await import('../src/wsl.js')

function utf16(lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')
}

function dirent(name: string) {
  return { name, isDirectory: () => true }
}

let platform: PropertyDescriptor

beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env['SystemRoot'] = 'C:\\Windows'
  delete process.env['CODEBURN_WSL']
  setWslHomes(undefined)
  execFileSync.mockReset()
  readdirSync.mockReset()
  existsSync.mockReset()
  existsSync.mockReturnValue(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  delete process.env['CODEBURN_WSL']
  setWslHomes(undefined)
})

describe('discoverWslHomes', () => {
  it('runs wsl.exe out of System32 with --list --quiet --running by default', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockReturnValue([dirent('alice')])

    wslHomes()

    expect(execFileSync).toHaveBeenCalledTimes(1)
    const [exe, args, opts] = execFileSync.mock.calls[0]!
    expect(exe).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(args).toEqual(['--list', '--quiet', '--running'])
    expect(opts).toMatchObject({ timeout: 3000, windowsHide: true })
  })

  it('drops --running when CODEBURN_WSL=all', () => {
    process.env['CODEBURN_WSL'] = 'all'
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockReturnValue([])

    wslHomes()

    expect(execFileSync.mock.calls[0]![1]).toEqual(['--list', '--quiet'])
  })

  it('re-probes immediately when the mode changes inside a long-lived process', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockReturnValue([])
    wslHomes(1_000)

    process.env['CODEBURN_WSL'] = 'all'
    wslHomes(1_001)

    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(execFileSync.mock.calls[1]![1]).toEqual(['--list', '--quiet'])
  })

  it('honors off immediately instead of returning a cached running home', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockImplementation((p: string) => (p === '\\\\wsl$\\Ubuntu\\home' ? [dirent('alice')] : []))
    expect(wslHomes(1_000)).toEqual(['\\\\wsl$\\Ubuntu\\home\\alice'])

    process.env['CODEBURN_WSL'] = 'off'
    expect(wslHomes(1_001)).toEqual([])
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })

  it('never spawns anything when CODEBURN_WSL=off', () => {
    process.env['CODEBURN_WSL'] = 'off'
    expect(wslHomes()).toEqual([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('never spawns anything off win32', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(wslHomes()).toEqual([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('enumerates home/* plus root under the \\\\wsl$ prefix', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockImplementation((p: string) => (p === '\\\\wsl$\\Ubuntu\\home' ? [dirent('alice'), dirent('bob')] : []))
    existsSync.mockImplementation((p: string) => p === '\\\\wsl$\\Ubuntu\\root')

    expect(wslHomes()).toEqual([
      '\\\\wsl$\\Ubuntu\\home\\alice',
      '\\\\wsl$\\Ubuntu\\home\\bob',
      '\\\\wsl$\\Ubuntu\\root',
    ])
  })

  it('falls back to \\\\wsl.localhost only when \\\\wsl$ yields nothing, and stops at the first hit', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu', 'Debian']))
    readdirSync.mockImplementation((p: string) => {
      if (p === '\\\\wsl$\\Ubuntu\\home') return [dirent('alice')]
      if (p === '\\\\wsl.localhost\\Debian\\home') return [dirent('bob')]
      return []
    })

    expect(wslHomes()).toEqual(['\\\\wsl$\\Ubuntu\\home\\alice', '\\\\wsl.localhost\\Debian\\home\\bob'])
    // Ubuntu resolved on the first prefix, so the slow spelling is never tried for it.
    expect(readdirSync.mock.calls.map(c => c[0])).not.toContain('\\\\wsl.localhost\\Ubuntu\\home')
  })

  it('probes nothing when wsl.exe reports no installed distributions', () => {
    execFileSync.mockReturnValue(utf16([
      'Windows Subsystem for Linux has no installed distributions.',
      'Use \'wsl.exe --list --online\' to list available distributions',
      'and \'wsl.exe --install <Distro>\' to install.',
      '',
      'Distributions can also be installed by visiting the Microsoft Store:',
      'https://aka.ms/wslstore',
    ]))

    expect(wslHomes()).toEqual([])
    expect(readdirSync).not.toHaveBeenCalled()
  })

  it('returns nothing when wsl.exe is missing or times out', () => {
    execFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(wslHomes()).toEqual([])
  })

  it('memoizes within the TTL so repeated discovery never respawns', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockReturnValue([])
    wslHomes(1_000)
    wslHomes(1_000 + 59_999)
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })

  it('re-probes after the TTL when a distro shuts down, and fails closed', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockImplementation((p: string) => (p === '\\\\wsl$\\Ubuntu\\home' ? [dirent('alice')] : []))
    expect(wslHomes(1_000)).toEqual(['\\\\wsl$\\Ubuntu\\home\\alice'])

    // The distro is gone at the next refresh: the re-probe throws/times out.
    // The stale home must not be served, and no UNC path may be touched.
    execFileSync.mockImplementation(() => { throw new Error('timed out') })
    readdirSync.mockClear()
    expect(wslHomes(1_000 + 60_000)).toEqual([])
    expect(readdirSync).not.toHaveBeenCalled()
  })

  it('drops a shut-down distro from the refreshed result', () => {
    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockImplementation((p: string) => (p === '\\\\wsl$\\Ubuntu\\home' ? [dirent('alice')] : []))
    expect(wslHomes(1_000)).toEqual(['\\\\wsl$\\Ubuntu\\home\\alice'])

    execFileSync.mockReturnValue(utf16([]))
    readdirSync.mockClear()
    expect(wslHomes(1_000 + 60_000)).toEqual([])
    expect(readdirSync).not.toHaveBeenCalled()
  })

  it('discovers a distro started after an initial empty result', () => {
    execFileSync.mockReturnValue(utf16([]))
    expect(wslHomes(1_000)).toEqual([])

    execFileSync.mockReturnValue(utf16(['Ubuntu']))
    readdirSync.mockImplementation((p: string) => (p === '\\\\wsl$\\Ubuntu\\home' ? [dirent('alice')] : []))
    expect(wslHomes(1_000 + 60_000)).toEqual(['\\\\wsl$\\Ubuntu\\home\\alice'])
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  it('pinned test homes never expire', () => {
    setWslHomes(['\\\\wsl$\\Ubuntu\\home\\alice'])
    expect(wslHomes(1_000)).toEqual(['\\\\wsl$\\Ubuntu\\home\\alice'])
    expect(wslHomes(1_000 + 3_600_000)).toEqual(['\\\\wsl$\\Ubuntu\\home\\alice'])
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

describe('doctor note', () => {
  it('names the opt-out when CODEBURN_WSL=off', () => {
    process.env['CODEBURN_WSL'] = 'off'
    expect(wslDoctorNote()).toContain('CODEBURN_WSL=off')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('explains a zero result when no distro is running', () => {
    execFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(wslDoctorNote()).toContain('no running distro')
  })

  it('says nothing when WSL roots were found', () => {
    setWslHomes(['\\\\wsl$\\Ubuntu\\home\\alice'])
    expect(wslDoctorNote()).toBeUndefined()
  })

  it('says nothing off win32', () => {
    expect(wslDoctorNote('darwin')).toBeUndefined()
  })

  it('reaches the rendered doctor output', async () => {
    process.env['CODEBURN_WSL'] = 'off'
    const { renderDoctorTable } = await import('../src/doctor.js')
    const table = renderDoctorTable(
      { generatedAt: '2026-01-01T00:00:00.000Z', providers: [], wslNote: 'WSL scan disabled by CODEBURN_WSL=off.' },
      { color: false },
    )
    expect(table).toContain('WSL scan disabled by CODEBURN_WSL=off.')
  })
})
