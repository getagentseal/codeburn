import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WINDOWS_RELEASE,
  installMenubarApp,
  parseInstalledWindowsMenubar,
  resolveLatestMenubarReleaseAssets,
  resolveSystem32Path,
  resolveVersionedMenubarReleaseAssets,
  type ReleaseResponse,
} from '../src/menubar-installer.js'

function asset(name: string) {
  return { name, browser_download_url: `https://example.test/${name}` }
}

const MSI_URL =
  'https://github.com/getagentseal/codeburn/releases/download/windows-v0.9.20/CodeBurn.Menubar_0.9.20_x64_en-US.msi'
const MSI_BYTES = 'msi-bytes'

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

function httpResponse(status: number, body?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: body === undefined ? null : new Response(body).body,
    text: async () => body ?? '',
  }
}

/** reg query /s output, one blank-line separated block per subkey. */
function regBlock(values: Record<string, string>, key = '{9c1e2f0a-0000-0000-0000-000000000001}'): string {
  const lines = Object.entries(values).map(([name, value]) => `    ${name}    REG_SZ    ${value}`)
  return [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{other}',
    '    DisplayName    REG_SZ    Some Other App',
    '',
    `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`,
    ...lines,
    '',
  ].join('\r\n')
}

const INSTALLED_0_9_20 = regBlock({
  DisplayName: 'CodeBurn Menubar',
  DisplayVersion: '0.9.20',
  InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
  Publisher: 'AgentSeal',
})

describe('windows release asset resolution', () => {
  it('builds direct release asset URLs from the CLI version', () => {
    const resolved = resolveVersionedMenubarReleaseAssets('0.9.20', WINDOWS_RELEASE)

    expect(resolved.release.tag_name).toBe('windows-v0.9.20')
    expect(resolved.zip.name).toBe('CodeBurn.Menubar_0.9.20_x64_en-US.msi')
    expect(resolved.zip.browser_download_url).toBe(MSI_URL)
    expect(resolved.checksum.browser_download_url).toBe(`${MSI_URL}.sha256`)
  })

  it('normalizes a leading v', () => {
    expect(resolveVersionedMenubarReleaseAssets('v0.9.20', WINDOWS_RELEASE).release.tag_name).toBe('windows-v0.9.20')
  })

  it('scans for the newest windows-v release that has both assets', () => {
    const releases: ReleaseResponse[] = [
      { tag_name: 'mac-v0.9.20', assets: [asset('CodeBurnMenubar-v0.9.20.zip'), asset('CodeBurnMenubar-v0.9.20.zip.sha256')] },
      { tag_name: 'windows-v0.9.21', assets: [asset('CodeBurn.Menubar_0.9.21_x64_en-US.msi')] },
      {
        tag_name: 'windows-v0.9.20',
        assets: [asset('CodeBurn.Menubar_0.9.20_x64_en-US.msi'), asset('CodeBurn.Menubar_0.9.20_x64_en-US.msi.sha256')],
      },
    ]

    const resolved = resolveLatestMenubarReleaseAssets(releases, WINDOWS_RELEASE)

    expect(resolved.release.tag_name).toBe('windows-v0.9.20')
    expect(resolved.zip.name).toBe('CodeBurn.Menubar_0.9.20_x64_en-US.msi')
  })

  it('reports when no windows release carries both assets', () => {
    expect(() => resolveLatestMenubarReleaseAssets([{ tag_name: 'v0.9.20', assets: [] }], WINDOWS_RELEASE))
      .toThrow(/No windows-v\* release/)
  })
})

describe('resolveSystem32Path', () => {
  it('uses an absolute SystemRoot', () => {
    expect(resolveSystem32Path('msiexec.exe', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\msiexec.exe')
  })

  it('falls back to the documented default when SystemRoot is missing or relative', () => {
    expect(resolveSystem32Path('reg.exe', {})).toBe('C:\\Windows\\System32\\reg.exe')
    expect(resolveSystem32Path('reg.exe', { SystemRoot: 'Windows' })).toBe('C:\\Windows\\System32\\reg.exe')
  })
})

describe('parseInstalledWindowsMenubar', () => {
  it('reads the version and joins the exe onto InstallLocation', () => {
    expect(parseInstalledWindowsMenubar(INSTALLED_0_9_20)).toEqual({
      version: '0.9.20',
      exePath: 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe',
    })
  })

  it('falls back to DisplayIcon when there is no InstallLocation', () => {
    const output = regBlock({
      DisplayName: 'CodeBurn Menubar',
      DisplayVersion: '0.9.20',
      DisplayIcon: 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe,0',
    })

    expect(parseInstalledWindowsMenubar(output)?.exePath).toBe('C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe')
  })

  it('returns undefined when the product is not installed', () => {
    expect(parseInstalledWindowsMenubar(regBlock({ DisplayName: 'Something Else', DisplayVersion: '1.0' }))).toBeUndefined()
  })
})

describe('installMenubarApp on windows', () => {
  let sandbox: string
  let logs: string[]
  let launched: string[]
  let installerCalls: Array<{ exe: string; args: string[] }>

  function hooks(overrides: Record<string, unknown> = {}) {
    return {
      stagingDir: sandbox,
      env: { SystemRoot: 'C:\\Windows' },
      log: (message: string) => { logs.push(message) },
      launch: (exePath: string) => { launched.push(exePath) },
      queryRegistry: async () => INSTALLED_0_9_20,
      runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 0 },
      fetchOptions: {
        sleep: async () => {},
        log: (message: string) => { logs.push(message) },
        fetchImpl: async (url: string) => httpResponse(200, url.endsWith('.sha256')
          ? `${sha256(MSI_BYTES)}  CodeBurn.Menubar_0.9.20_x64_en-US.msi`
          : MSI_BYTES),
      },
      ...overrides,
    }
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-windows-'))
    logs = []
    launched = []
    installerCalls = []
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('skips the download and just launches when the pinned version is already installed', async () => {
    let fetches = 0
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({ fetchOptions: { fetchImpl: async () => { fetches++; return httpResponse(500) } } }),
    })

    expect(fetches).toBe(0)
    expect(installerCalls).toEqual([])
    expect(launched).toEqual(['C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe'])
    expect(result).toEqual({ installedPath: 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe', launched: true })
  })

  it('downloads, verifies, runs msiexec from System32 and launches the installed app', async () => {
    let queries = 0
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20),
      }),
    })

    expect(installerCalls).toEqual([{
      exe: 'C:\\Windows\\System32\\msiexec.exe',
      args: ['/i', join(sandbox, 'CodeBurn.Menubar_0.9.20_x64_en-US.msi'), '/passive', '/norestart'],
    }])
    expect(launched).toEqual(['C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe'])
    expect(result.launched).toBe(true)
    expect(logs).toContain('Downloading CodeBurn.Menubar_0.9.20_x64_en-US.msi...')
    expect(logs).toContain('Verifying checksum...')
    expect(logs).toContain('Installing...')
    expect(logs).toContain('Launched CodeBurn Menubar.')
  })

  it('reinstalls the same version when --force is passed', async () => {
    await installMenubarApp({ platform: 'win32', cliVersion: '0.9.20', force: true, windows: hooks() })

    expect(installerCalls).toHaveLength(1)
  })

  it('rejects macOS placement repair flags before touching the Windows installer', async () => {
    await expect(installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      repairPlacement: true,
      windows: hooks(),
    })).rejects.toThrow(/only available for the macOS menu bar app/)
    await expect(installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      resetPlacement: true,
      windows: hooks(),
    })).rejects.toThrow(/only available for the macOS menu bar app/)
    expect(installerCalls).toEqual([])
    expect(launched).toEqual([])
  })

  it('aborts on a checksum mismatch without running the installer', async () => {
    await expect(installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => '',
        fetchOptions: {
          sleep: async () => {},
          log: () => {},
          fetchImpl: async (url: string) =>
            httpResponse(200, url.endsWith('.sha256') ? `${sha256('other-bytes')}  x.msi` : MSI_BYTES),
        },
      }),
    })).rejects.toThrow(/Checksum mismatch/)

    expect(installerCalls).toEqual([])
    expect(launched).toEqual([])
  })

  it('treats 3010 as installed and says a restart is pending', async () => {
    let queries = 0
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20),
        runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 3010 },
      }),
    })

    expect(result.launched).toBe(true)
    expect(logs.some(line => line.includes('restart'))).toBe(true)
  })

  it('treats 1602 as a cancelled install: no launch, no error', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => '',
        runInstaller: async () => 1602,
      }),
    })

    expect(result).toEqual({ installedPath: '', launched: false })
    expect(launched).toEqual([])
    expect(logs.some(line => line.includes('cancelled'))).toBe(true)
  })

  it('fails with the exit code for any other msiexec failure', async () => {
    await expect(installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({ queryRegistry: async () => '', runInstaller: async () => 1603 }),
    })).rejects.toThrow(/msiexec exited with 1603/)

    expect(launched).toEqual([])
  })

  it('falls back to the release API when the pinned assets are missing', async () => {
    let queries = 0
    const requested: string[] = []
    const latest: ReleaseResponse[] = [{
      tag_name: 'windows-v0.9.19',
      assets: [
        { name: 'CodeBurn.Menubar_0.9.19_x64_en-US.msi', browser_download_url: 'https://example.test/msi' },
        { name: 'CodeBurn.Menubar_0.9.19_x64_en-US.msi.sha256', browser_download_url: 'https://example.test/msi.sha256' },
      ],
    }]

    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20),
        apiFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => latest }),
        fetchOptions: {
          sleep: async () => {},
          log: () => {},
          fetchImpl: async (url: string) => {
            requested.push(url)
            if (url.startsWith(MSI_URL)) return httpResponse(404)
            return httpResponse(200, url.endsWith('.sha256') ? `${sha256(MSI_BYTES)}  msi` : MSI_BYTES)
          },
        },
      }),
    })

    expect(requested[0]).toBe(MSI_URL)
    expect(requested).toContain('https://example.test/msi')
    expect(installerCalls[0]?.args[1]).toBe(join(sandbox, 'CodeBurn.Menubar_0.9.19_x64_en-US.msi'))
    expect(result.launched).toBe(true)
  })
})
