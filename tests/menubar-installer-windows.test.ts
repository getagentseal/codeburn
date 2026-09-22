import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_MSI_ENV,
  BUNDLED_RESULT_PREFIX,
  DESKTOP_APP_EXE,
  STAGED_MSI_FLAG,
  STORE_IDENTITY_NAME,
  WINDOWS_RELEASE,
  assertStagedMsiPath,
  compareMenubarVersions,
  decideBundledInstall,
  decideWindowsMenubarSource,
  extractMsiProductCode,
  findStoreMenubar,
  installMenubarApp,
  uninstallMenubarApp,
  menubarMarkerPath,
  parseInstalledWindowsMenubar,
  parseWindowsMsiVersion,
  resolveLatestMenubarReleaseAssets,
  resolveSystem32Path,
  resolveVersionedMenubarReleaseAssets,
  type BundledInstallResult,
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
  // The install directory is named after the product and the binary after the Cargo package,
  // so the two are not the same word. This is exactly what a real install looks like: Tauri
  // writes InstallLocation and leaves DisplayIcon empty.
  it('joins the binary name, not the product name, onto InstallLocation', () => {
    expect(parseInstalledWindowsMenubar(INSTALLED_0_9_20)).toEqual({
      version: '0.9.20',
      exePath: 'C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe',
    })
  })

  it('takes DisplayIcon over InstallLocation, since it names the binary outright', () => {
    const output = regBlock({
      DisplayName: 'CodeBurn Menubar',
      DisplayVersion: '0.9.20',
      InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
      DisplayIcon: 'D:\\Elsewhere\\codeburn-menubar.exe,0',
    })

    expect(parseInstalledWindowsMenubar(output)?.exePath).toBe('D:\\Elsewhere\\codeburn-menubar.exe')
  })

  it('uses DisplayIcon when there is no InstallLocation', () => {
    const output = regBlock({
      DisplayName: 'CodeBurn Menubar',
      DisplayVersion: '0.9.20',
      DisplayIcon: 'C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe,0',
    })

    expect(parseInstalledWindowsMenubar(output)?.exePath).toBe('C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe')
  })

  it('is undefined when neither says where the binary is', () => {
    expect(parseInstalledWindowsMenubar(regBlock({
      DisplayName: 'CodeBurn Menubar',
      DisplayVersion: '0.9.20',
    }))).toBeUndefined()
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
      // LOCALAPPDATA is sandboxed because an install writes its ownership marker under it.
      env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(sandbox, 'Local') },
      log: (message: string) => { logs.push(message) },
      launch: (exePath: string) => { launched.push(exePath) },
      queryRegistry: async () => INSTALLED_0_9_20,
      // No Store package unless a test says otherwise, and never a real PowerShell.
      queryStorePackage: async () => '',
      // No tray running unless a test says otherwise, and never a real tasklist.
      isTrayRunning: async () => false,
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
    expect(launched).toEqual(['C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe'])
    expect(result).toEqual({ installedPath: 'C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe', launched: true })
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
    expect(launched).toEqual(['C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe'])
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

  // The desktop app's uninstaller reads this file and removes only what it installed itself
  // (app/build/installer.nsh), so a tray this route puts on the machine has to say who it
  // belongs to as plainly as the desktop route's does.
  describe('the ownership marker', () => {
    function markerEnv(): NodeJS.ProcessEnv {
      return { LOCALAPPDATA: join(sandbox, 'Local') }
    }

    async function marker(): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(menubarMarkerPath(markerEnv()), 'utf8')) as Record<string, unknown>
    }

    async function writeMarker(record: Record<string, unknown>): Promise<void> {
      const path = menubarMarkerPath(markerEnv())
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(record))
    }

    it('credits a fresh install to the user, not to the desktop app', async () => {
      let queries = 0
      await installMenubarApp({
        platform: 'win32',
        cliVersion: '0.9.20',
        windows: hooks({ queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20) }),
      })

      expect(installerCalls).toHaveLength(1)
      expect(await marker()).toMatchObject({ installedBy: 'manual', version: '0.9.20' })
    })

    // The machine this fixes is one set up before the marker existed: nothing is installed
    // here, but the tray still belongs to whoever ran `codeburn menubar`.
    it('marks a tray that was already installed, on the launch-only path', async () => {
      await installMenubarApp({ platform: 'win32', cliVersion: '0.9.20', windows: hooks() })

      expect(installerCalls).toEqual([])
      expect(await marker()).toMatchObject({ installedBy: 'manual', version: '0.9.20' })
    })

    it('never rewrites a desktop verdict as manual, and refreshes the rest', async () => {
      await writeMarker({
        installedBy: 'desktop',
        version: '0.9.10',
        uninstallString: 'MsiExec.exe /X{9c1e2f0a-0000-0000-0000-000000000001}',
        installedAt: '2020-01-01T00:00:00.000Z',
      })

      await installMenubarApp({ platform: 'win32', cliVersion: '0.9.20', windows: hooks() })

      expect(await marker()).toMatchObject({ installedBy: 'desktop', version: '0.9.20' })
    })
  })

  // msiexec does not fail on a binary that is in use; it defers the swap to the next reboot,
  // which leaves the old tray running and the new one unused.
  describe('stopping a running tray first', () => {
    const TRAY_EXE = 'C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe'

    let events: string[]
    let launches: Array<{ exePath: string; args: string[] | undefined }>
    let running: boolean
    let runningChecks: number

    /** The install route that actually reaches msiexec with a tray already installed. */
    async function reinstall(overrides: Record<string, unknown> = {}) {
      return installMenubarApp({
        platform: 'win32',
        cliVersion: '0.9.20',
        force: true,
        windows: hooks({
          launch: (exePath: string, args?: string[]) => {
            launches.push({ exePath, args })
            events.push(args?.includes('--quit') ? 'quit' : 'launch')
          },
          isTrayRunning: async () => { runningChecks++; return running },
          killTray: async () => { events.push('taskkill'); running = false },
          sleep: async () => {},
          runInstaller: async (exe: string, args: string[]) => {
            installerCalls.push({ exe, args })
            events.push('msiexec')
            return 0
          },
          ...overrides,
        }),
      })
    }

    beforeEach(() => {
      events = []
      launches = []
      running = false
      runningChecks = 0
    })

    it('asks the tray to quit through its own protocol before msiexec runs', async () => {
      running = true
      await reinstall({
        launch: (exePath: string, args?: string[]) => {
          launches.push({ exePath, args })
          events.push(args?.includes('--quit') ? 'quit' : 'launch')
          // The tray app acts on the request, as it does in the real single-instance handoff.
          if (args?.includes('--quit')) running = false
        },
      })

      expect(events).toEqual(['quit', 'msiexec', 'launch'])
      expect(launches[0]).toEqual({ exePath: TRAY_EXE, args: ['--quit'] })
      // And the new binary is what gets started afterwards.
      expect(launches[1]).toEqual({ exePath: TRAY_EXE, args: undefined })
      expect(logs.some(line => line.includes('asking it to quit'))).toBe(true)
      expect(logs).toContain('CodeBurn Menubar stopped.')
    })

    it('installs straight away when no tray is running', async () => {
      await reinstall()

      expect(events).toEqual(['msiexec', 'launch'])
      expect(launches.some(entry => entry.args?.includes('--quit'))).toBe(false)
      // One look, and nothing else asked about the process after that.
      expect(runningChecks).toBe(1)
      expect(logs.some(line => line.includes('quit'))).toBe(false)
    })

    it('falls back to taskkill when the tray ignores the request, and still installs', async () => {
      running = true
      await reinstall()

      expect(events).toEqual(['quit', 'taskkill', 'msiexec', 'launch'])
      expect(logs.some(line => line.includes('did not stop on its own'))).toBe(true)
      expect(logs.some(line => line.includes('restart'))).toBe(false)
    })

    it('gives up on the wait after a bounded number of polls', async () => {
      running = true
      // A tray nothing can stop: the wait still has to end, and the install still has to happen.
      await reinstall({ killTray: async () => { events.push('taskkill') } })

      // One look before the quit, 4000ms / 200ms polls after it, one look after the taskkill.
      expect(runningChecks).toBe(22)
      expect(events).toEqual(['quit', 'taskkill', 'msiexec', 'launch'])
      expect(logs.some(line => line.includes('restart'))).toBe(true)
    })

    it('goes straight to taskkill when the registry cannot say where the tray is', async () => {
      running = true
      let queries = 0
      await reinstall({ queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20) })

      expect(events).toEqual(['taskkill', 'msiexec', 'launch'])
      expect(launches.some(entry => entry.args?.includes('--quit'))).toBe(false)
    })
  })
})

describe('compareMenubarVersions', () => {
  it('compares field by field, numerically', () => {
    expect(compareMenubarVersions('0.9.9', '0.9.10')).toBe(-1)
    expect(compareMenubarVersions('0.10.0', '0.9.30')).toBe(1)
    expect(compareMenubarVersions('v0.9.23', '0.9.23')).toBe(0)
  })

  it('treats a missing or unreadable field as the oldest thing there is', () => {
    expect(compareMenubarVersions('', '0.0.1')).toBe(-1)
    expect(compareMenubarVersions('0.9', '0.9.0')).toBe(0)
  })
})

describe('parseWindowsMsiVersion', () => {
  it('reads the version out of the release asset name', () => {
    expect(parseWindowsMsiVersion('CodeBurn.Menubar_0.9.23_x64_en-US.msi')).toBe('0.9.23')
    expect(parseWindowsMsiVersion('CodeBurn-Setup-0.9.23.exe')).toBeUndefined()
  })
})

describe('decideBundledInstall', () => {
  it('installs onto a machine that has no menubar', () => {
    expect(decideBundledInstall(undefined, '0.9.23')).toBe('installed')
  })

  it('upgrades an older install and leaves an equal one alone', () => {
    expect(decideBundledInstall('0.9.20', '0.9.23')).toBe('installed')
    expect(decideBundledInstall('0.9.23', '0.9.23')).toBe('up-to-date')
  })

  it('never downgrades', () => {
    expect(decideBundledInstall('0.9.30', '0.9.23')).toBe('kept-newer')
  })

  it('reinstalls the same version under force', () => {
    expect(decideBundledInstall('0.9.23', '0.9.23', true)).toBe('installed')
  })
})

describe('installMenubarApp from a staged msi', () => {
  const BUNDLED_VERSION = '0.9.23'
  const MSI_NAME = `CodeBurn.Menubar_${BUNDLED_VERSION}_x64_en-US.msi`
  const INSTALLED_0_9_23 = regBlock({
    DisplayName: 'CodeBurn Menubar',
    DisplayVersion: '0.9.23',
    InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
    UninstallString: 'MsiExec.exe /X{9c1e2f0a-0000-0000-0000-000000000001}',
  })
  const INSTALLED_0_9_30 = regBlock({
    DisplayName: 'CodeBurn Menubar',
    DisplayVersion: '0.9.30',
    InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
  })

  let sandbox: string
  let appDir: string
  let msiPath: string
  let logs: string[]
  let installerCalls: Array<{ exe: string; args: string[] }>

  function env(): NodeJS.ProcessEnv {
    return { SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(sandbox, 'Local') }
  }

  function hooks(overrides: Record<string, unknown> = {}) {
    return {
      env: env(),
      log: (message: string) => { logs.push(message) },
      queryRegistry: async () => '',
      isTrayRunning: async () => false,
      runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 0 },
      fetchOptions: { fetchImpl: async () => { throw new Error('a staged install must not reach the network') } },
      ...overrides,
    }
  }

  function reported(): BundledInstallResult {
    const line = logs.find(entry => entry.startsWith(BUNDLED_RESULT_PREFIX))
    if (!line) throw new Error(`no result line in:\n${logs.join('\n')}`)
    return JSON.parse(line.slice(BUNDLED_RESULT_PREFIX.length)) as BundledInstallResult
  }

  async function marker(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(menubarMarkerPath(env()), 'utf8')) as Record<string, unknown>
  }

  // The layout a packaged desktop app has on disk, which is the only one --staged-msi accepts:
  // the installer under the app's resources/menubar, with the desktop binary two levels up.
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-staged-'))
    appDir = join(sandbox, 'CodeBurn')
    msiPath = join(appDir, 'resources', 'menubar', MSI_NAME)
    logs = []
    installerCalls = []
    await mkdir(dirname(msiPath), { recursive: true })
    await writeFile(join(appDir, DESKTOP_APP_EXE), 'desktop')
    await writeFile(msiPath, MSI_BYTES)
    await writeFile(`${msiPath}.sha256`, `${sha256(MSI_BYTES)}  ${MSI_NAME}\n`)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('verifies the staged file, installs it and credits the desktop app', async () => {
    let queries = 0
    const result = await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_23) }),
    })

    expect(installerCalls).toEqual([{
      exe: 'C:\\Windows\\System32\\msiexec.exe',
      args: ['/i', msiPath, '/passive', '/norestart'],
    }])
    expect(result.installedPath).toBe('C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe')
    // The caller that staged the MSI owns the tray app's process, so nothing is launched here.
    expect(result.launched).toBe(false)
    expect(reported()).toMatchObject({
      action: 'installed',
      bundledVersion: BUNDLED_VERSION,
      previousVersion: null,
      installedBy: 'desktop',
      uninstallString: 'MsiExec.exe /X{9c1e2f0a-0000-0000-0000-000000000001}',
    })
    expect(await marker()).toMatchObject({ installedBy: 'desktop', version: '0.9.23' })
  })

  it('upgrades a manual install in place without claiming it', async () => {
    let queries = 0
    await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ queryRegistry: async () => (queries++ === 0 ? INSTALLED_0_9_20 : INSTALLED_0_9_23) }),
    })

    expect(installerCalls).toHaveLength(1)
    expect(reported()).toMatchObject({ action: 'installed', previousVersion: '0.9.20', installedBy: 'manual' })
    expect(await marker()).toMatchObject({ installedBy: 'manual' })
  })

  it('keeps a newer install and runs no installer', async () => {
    await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_30 }),
    })

    expect(installerCalls).toEqual([])
    expect(reported()).toMatchObject({ action: 'kept-newer', previousVersion: '0.9.30', installedBy: 'manual' })
    expect(logs.some(line => line.includes('newer than the bundled'))).toBe(true)
  })

  it('does nothing when the bundled version is already installed', async () => {
    await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_23 }),
    })

    expect(installerCalls).toEqual([])
    expect(reported()).toMatchObject({ action: 'up-to-date' })
  })

  it('never rewrites a marker that already credits the desktop app', async () => {
    let queries = 0
    await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_23) }),
    })
    logs = []
    await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_23 }),
    })

    expect(reported()).toMatchObject({ action: 'up-to-date', installedBy: 'desktop' })
  })

  it('refuses a staged file whose digest does not match', async () => {
    await writeFile(`${msiPath}.sha256`, `${sha256('other-bytes')}  ${MSI_NAME}\n`)

    await expect(installMenubarApp({ platform: 'win32', stagedMsi: msiPath, windows: hooks() })).rejects.toThrow(/Checksum mismatch/)
    expect(installerCalls).toEqual([])
  })

  // Refused by the path check now, before the route starts; verifyStagedChecksum still guards
  // the same thing for a digest that goes missing after that.
  it('refuses a staged file with no digest beside it', async () => {
    await rm(`${msiPath}.sha256`)

    await expect(installMenubarApp({ platform: 'win32', stagedMsi: msiPath, windows: hooks() })).rejects.toThrow(/no .sha256 file beside it/)
    expect(installerCalls).toEqual([])
  })

  // The desktop app stages the file and hands it to this route without stopping anything
  // itself, so the same in-use binary problem is here too.
  it('asks a running tray to quit before msiexec runs', async () => {
    const events: string[] = []
    let running = true
    let queries = 0

    await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({
        queryRegistry: async () => (queries++ === 0 ? INSTALLED_0_9_20 : INSTALLED_0_9_23),
        isTrayRunning: async () => running,
        sleep: async () => {},
        launch: (exePath: string, args?: string[]) => {
          events.push(`quit ${exePath} ${args?.join(' ') ?? ''}`)
          running = false
        },
        runInstaller: async (exe: string, args: string[]) => {
          installerCalls.push({ exe, args })
          events.push('msiexec')
          return 0
        },
      }),
    })

    expect(events).toEqual(['quit C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe --quit', 'msiexec'])
  })

  // Stopping the tray is a cost to the user, so nothing pays it for a file that is about to be
  // refused anyway.
  it('stops nothing when the staged file fails its checksum', async () => {
    let consulted = 0
    await writeFile(`${msiPath}.sha256`, `${sha256('other-bytes')}  ${MSI_NAME}\n`)

    await expect(installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ isTrayRunning: async () => { consulted++; return true } }),
    })).rejects.toThrow(/Checksum mismatch/)

    expect(consulted).toBe(0)
  })

  it('reports a cancelled install rather than failing', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ runInstaller: async () => 1602 }),
    })

    expect(result).toEqual({ installedPath: '', launched: false })
    expect(reported()).toMatchObject({ action: 'cancelled', installedBy: null })
  })

  // The route the flag replaced. An environment variable is set by anything that can start this
  // process, so honouring it at all is the finding; it is answered, not obeyed.
  it('refuses the legacy environment variable and names the flag instead', async () => {
    const failure = installMenubarApp({
      platform: 'win32',
      windows: hooks({ env: { ...env(), [BUNDLED_MSI_ENV]: msiPath } }),
    })

    await expect(failure).rejects.toThrow(new RegExp(`${BUNDLED_MSI_ENV}.+no longer honoured`))
    await expect(failure).rejects.toThrow(new RegExp(STAGED_MSI_FLAG))
    expect(installerCalls).toEqual([])
  })

  it('refuses the legacy environment variable even beside a valid flag', async () => {
    await expect(installMenubarApp({
      platform: 'win32',
      stagedMsi: msiPath,
      windows: hooks({ env: { ...env(), [BUNDLED_MSI_ENV]: msiPath } }),
    })).rejects.toThrow(new RegExp(BUNDLED_MSI_ENV))
    expect(installerCalls).toEqual([])
  })

  it('refuses a staged path that is not in an installed desktop app, before msiexec', async () => {
    const loose = join(sandbox, MSI_NAME)
    await writeFile(loose, MSI_BYTES)
    await writeFile(`${loose}.sha256`, `${sha256(MSI_BYTES)}  ${MSI_NAME}\n`)

    await expect(installMenubarApp({
      platform: 'win32',
      stagedMsi: loose,
      windows: hooks(),
    })).rejects.toThrow(/Refusing --staged-msi/)
    expect(installerCalls).toEqual([])
  })

  it('is a Windows option only', async () => {
    await expect(installMenubarApp({ platform: 'darwin', stagedMsi: msiPath })).rejects.toThrow(/Windows option/)
  })
})

/// Every one of these is a path that reaches msiexec if it is not refused here.
describe('assertStagedMsiPath', () => {
  const MSI_NAME = 'CodeBurn.Menubar_0.9.23_x64_en-US.msi'

  let sandbox: string
  let appDir: string
  let msiPath: string

  async function stage(
    parts: { dir?: string[]; name?: string; file?: boolean; checksum?: boolean; exe?: boolean } = {},
  ): Promise<string> {
    const dir = join(appDir, ...(parts.dir ?? ['resources', 'menubar']))
    const target = join(dir, parts.name ?? MSI_NAME)
    await mkdir(dir, { recursive: true })
    if (parts.exe !== false) await writeFile(join(appDir, DESKTOP_APP_EXE), 'desktop')
    if (parts.file !== false) await writeFile(target, MSI_BYTES)
    if (parts.checksum !== false) await writeFile(`${target}.sha256`, `${sha256(MSI_BYTES)}  ${MSI_NAME}\n`)
    return target
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-staged-path-'))
    appDir = join(sandbox, 'CodeBurn')
    msiPath = join(appDir, 'resources', 'menubar', MSI_NAME)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('accepts an installer staged inside an installed desktop app', async () => {
    await stage()

    expect(await assertStagedMsiPath(msiPath)).toBe(msiPath)
  })

  // Windows paths do not distinguish case, so a caller that built the path with different
  // capitals named the same directory.
  it('accepts the staging directory whatever its capitals', async () => {
    const staged = await stage({ dir: ['Resources', 'Menubar'] })

    expect(await assertStagedMsiPath(staged)).toBe(staged)
  })

  it('refuses an empty path', async () => {
    await expect(assertStagedMsiPath('')).rejects.toThrow(/no path was given/)
    await expect(assertStagedMsiPath('   ')).rejects.toThrow(/no path was given/)
  })

  it('refuses a relative path', async () => {
    await stage()

    await expect(assertStagedMsiPath(join('resources', 'menubar', MSI_NAME))).rejects.toThrow(/not absolute/)
  })

  it('refuses a file that is not named like the release asset', async () => {
    const staged = await stage({ name: 'payload.msi' })

    await expect(assertStagedMsiPath(staged)).rejects.toThrow(/release asset/)
  })

  it('refuses a file outside a resources/menubar directory', async () => {
    const staged = await stage({ dir: ['resources'] })

    await expect(assertStagedMsiPath(staged)).rejects.toThrow(/resources\\menubar directory/)
  })

  // The directory name alone is anyone's to write; the desktop binary beside it is what makes
  // this an installed app rather than a folder someone shaped like one.
  it('refuses a staging directory with no desktop app above it', async () => {
    const staged = await stage({ exe: false })

    await expect(assertStagedMsiPath(staged)).rejects.toThrow(new RegExp(`no ${DESKTOP_APP_EXE}`))
  })

  it('refuses a path with nothing at it', async () => {
    const staged = await stage({ file: false })

    await expect(assertStagedMsiPath(staged)).rejects.toThrow(/no regular file/)
  })

  it('refuses a directory standing where the installer should be', async () => {
    await stage({ file: false })
    await mkdir(msiPath, { recursive: true })

    await expect(assertStagedMsiPath(msiPath)).rejects.toThrow(/no regular file/)
  })

  it('refuses an installer with no digest beside it', async () => {
    const staged = await stage({ checksum: false })

    await expect(assertStagedMsiPath(staged)).rejects.toThrow(/no .sha256 file beside it/)
  })

  // Otherwise a path shaped like the accepted one walks out of it before it is used.
  it('refuses a path that traverses out of the staging directory', async () => {
    await stage()
    const outside = join(sandbox, MSI_NAME)
    await writeFile(outside, MSI_BYTES)
    await writeFile(`${outside}.sha256`, `${sha256(MSI_BYTES)}  ${MSI_NAME}\n`)

    const traversal = join(appDir, 'resources', 'menubar', '..', '..', '..', MSI_NAME)
    await expect(assertStagedMsiPath(traversal)).rejects.toThrow(/resources\\menubar directory/)
  })
})

describe('the microsoft store identity', () => {
  // The identity lives in app/package.json and is mirrored in src/ because app/ sits outside
  // the CLI's rootDir and is not published with it. This is what keeps the two from drifting.
  it('matches build.appx.identityName in app/package.json', async () => {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'package.json')
    const appPackage = JSON.parse(await readFile(packagePath, 'utf8')) as {
      build?: { appx?: { identityName?: string } }
    }

    expect(STORE_IDENTITY_NAME).toBe(appPackage.build?.appx?.identityName)
  })
})

/// The desktop app spawns this command and passes the staged installer by flag, so the flag's
/// spelling is an interface between two trees rather than an implementation detail.
describe('the codeburn menubar command line', () => {
  // A CLI spawn through tsx costs several seconds on a slow machine; the file default is not
  // enough for it.
  it('takes the staged installer as --staged-msi <path>', { timeout: 30_000 }, () => {
    const help = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'menubar', '--help'], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
      encoding: 'utf8',
    })

    expect(help.status).toBe(0)
    expect(`${help.stdout}${help.stderr}`).toContain(`${STAGED_MSI_FLAG} <path>`)
  })
})

describe('decideWindowsMenubarSource', () => {
  it('uses the store copy when only the store package is installed', () => {
    expect(decideWindowsMenubarSource(true, false)).toEqual({ source: 'store', storePresent: true, msiPresent: false })
  })

  it('uses the msi route when only the msi is installed', () => {
    expect(decideWindowsMenubarSource(false, true)).toEqual({ source: 'msi', storePresent: false, msiPresent: true })
  })

  it('prefers the store copy when both are installed', () => {
    expect(decideWindowsMenubarSource(true, true)).toEqual({ source: 'store', storePresent: true, msiPresent: true })
  })

  it('takes the msi route when neither is installed', () => {
    expect(decideWindowsMenubarSource(false, false)).toEqual({ source: 'msi', storePresent: false, msiPresent: false })
  })

  it('lets force ask for the msi even with a store copy present', () => {
    expect(decideWindowsMenubarSource(true, true, true)).toEqual({ source: 'msi', storePresent: true, msiPresent: true })
  })
})

describe('findStoreMenubar', () => {
  let sandbox: string
  let packageDir: string
  let packagedExe: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-store-'))
    packageDir = join(sandbox, 'WindowsApps', `${STORE_IDENTITY_NAME}_0.9.23.0_x64__8wekyb3d8bbwe`)
    packagedExe = join(packageDir, 'app', 'resources', 'menubar', 'codeburn-menubar.exe')
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  async function stagePackagedExe(): Promise<void> {
    await mkdir(dirname(packagedExe), { recursive: true })
    await writeFile(packagedExe, 'tray')
  }

  it('finds the tray app the package carries', async () => {
    await stagePackagedExe()

    expect(await findStoreMenubar(async () => packageDir)).toEqual({
      installLocation: packageDir,
      exePath: packagedExe,
    })
  })

  it('reads a quoted, padded, multi-line answer', async () => {
    await stagePackagedExe()

    const output = `\r\n  "${packageDir}"  \r\n\r\n`
    expect((await findStoreMenubar(async () => output))?.exePath).toBe(packagedExe)
  })

  it('is undefined when no store package is installed', async () => {
    expect(await findStoreMenubar(async () => '')).toBeUndefined()
    expect(await findStoreMenubar(async () => '\r\n  \r\n')).toBeUndefined()
  })

  it('is undefined when the package has no tray app inside it', async () => {
    await mkdir(packageDir, { recursive: true })

    expect(await findStoreMenubar(async () => packageDir)).toBeUndefined()
  })

  it('treats a failed query as no store install', async () => {
    expect(await findStoreMenubar(async () => { throw new Error('powershell is not on this machine') }))
      .toBeUndefined()
  })
})

describe('installMenubarApp with a store install', () => {
  const MSI_EXE = 'C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe'

  let sandbox: string
  let packageDir: string
  let packagedExe: string
  let logs: string[]
  let launched: string[]
  let installerCalls: Array<{ exe: string; args: string[] }>
  let consulted: string[]

  function hooks(overrides: Record<string, unknown> = {}) {
    return {
      stagingDir: sandbox,
      env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(sandbox, 'Local') },
      log: (message: string) => { logs.push(message) },
      launch: (exePath: string) => { launched.push(exePath) },
      queryStorePackage: async () => { consulted.push('store'); return packageDir },
      queryRegistry: async () => { consulted.push('registry'); return '' },
      isTrayRunning: async () => false,
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
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-store-install-'))
    packageDir = join(sandbox, 'WindowsApps', `${STORE_IDENTITY_NAME}_0.9.23.0_x64__8wekyb3d8bbwe`)
    packagedExe = join(packageDir, 'app', 'resources', 'menubar', 'codeburn-menubar.exe')
    await mkdir(dirname(packagedExe), { recursive: true })
    await writeFile(packagedExe, 'tray')
    logs = []
    launched = []
    installerCalls = []
    consulted = []
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('launches the packaged tray app instead of downloading an msi', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        fetchOptions: { fetchImpl: async () => { throw new Error('a store install must not reach the network') } },
      }),
    })

    expect(installerCalls).toEqual([])
    expect(launched).toEqual([packagedExe])
    expect(result).toEqual({ installedPath: packagedExe, launched: true })
    expect(logs.some(line => line.includes('Microsoft Store'))).toBe(true)
    expect(logs).toContain('Launched CodeBurn Menubar.')
  })

  // The uninstall registry is the one place a store install is invisible, so it must not be
  // what decides the route.
  it('asks about the store package before reading the uninstall registry', async () => {
    await installMenubarApp({ platform: 'win32', cliVersion: '0.9.20', windows: hooks() })

    expect(consulted[0]).toBe('store')
  })

  it('says so when an msi copy is installed too, and still prefers the store copy', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_20 }),
    })

    expect(installerCalls).toEqual([])
    expect(launched).toEqual([packagedExe])
    expect(result.installedPath).toBe(packagedExe)
    expect(logs.some(line => line.includes(MSI_EXE) && line.includes('leaving it in place'))).toBe(true)
  })

  it('installs the msi anyway under force and leaves the store copy alone', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      force: true,
      windows: hooks({ queryRegistry: async () => INSTALLED_0_9_20 }),
    })

    expect(installerCalls).toEqual([{
      exe: 'C:\\Windows\\System32\\msiexec.exe',
      args: ['/i', join(sandbox, 'CodeBurn.Menubar_0.9.20_x64_en-US.msi'), '/passive', '/norestart'],
    }])
    expect(launched).toEqual([MSI_EXE])
    expect(result).toEqual({ installedPath: MSI_EXE, launched: true })
    expect(logs.some(line => line.includes('--force') && line.includes('leaves the Store copy in place'))).toBe(true)
  })

  it('tells the user to start the store copy from the start menu when the spawn fails', async () => {
    const promise = installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({ launch: async () => 'Could not launch tray: spawn EPERM' }),
    })

    await expect(promise).rejects.toThrow(/Start CodeBurn Menubar from the Start menu instead/)
    expect(installerCalls).toEqual([])
  })

  it('says the install itself succeeded when the launch after an msi install fails', async () => {
    let queries = 0
    const promise = installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryStorePackage: async () => '',
        queryRegistry: async () => (queries++ === 0 ? '' : INSTALLED_0_9_20),
        launch: async () => 'Could not launch tray: spawn EPERM',
      }),
    })

    await expect(promise).rejects.toThrow(/install itself succeeded/)
    expect(installerCalls).toHaveLength(1)
  })

  it('takes the msi route when the store package is not installed', async () => {
    const result = await installMenubarApp({
      platform: 'win32',
      cliVersion: '0.9.20',
      windows: hooks({
        queryStorePackage: async () => '',
        queryRegistry: async () => INSTALLED_0_9_20,
      }),
    })

    expect(installerCalls).toEqual([])
    expect(launched).toEqual([MSI_EXE])
    expect(result).toEqual({ installedPath: MSI_EXE, launched: true })
    expect(logs.some(line => line.includes('Microsoft Store'))).toBe(false)
  })
})

describe('extractMsiProductCode', () => {
  it('reads the product code out of an MSI uninstall string', () => {
    const code = '{9c1e2f0a-0000-0000-0000-000000000001}'
    expect(extractMsiProductCode(`MsiExec.exe /X${code}`)).toBe(code)
    expect(extractMsiProductCode(`MsiExec.exe /I${code}`)).toBe(code)
  })

  it('is null for a missing or non-MSI string', () => {
    expect(extractMsiProductCode(null)).toBeNull()
    expect(extractMsiProductCode(undefined)).toBeNull()
    expect(extractMsiProductCode('C:/some/uninstaller.exe /quiet')).toBeNull()
  })
})

describe('uninstallMenubarApp on windows', () => {
  const PRODUCT_CODE = '{9c1e2f0a-0000-0000-0000-000000000001}'
  const INSTALLED_WITH_UNINSTALL = regBlock({
    DisplayName: 'CodeBurn Menubar',
    DisplayVersion: '0.9.24',
    InstallLocation: 'C:\\Program Files\\CodeBurn Menubar\\',
    UninstallString: `MsiExec.exe /X${PRODUCT_CODE}`,
  })

  let sandbox: string
  let logs: string[]
  let installerCalls: Array<{ exe: string; args: string[] }>

  function env() {
    return { SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(sandbox, 'Local') }
  }

  function lastResult(): BundledInstallResult {
    const line = logs.find(entry => entry.startsWith(BUNDLED_RESULT_PREFIX))
    if (!line) throw new Error('no CODEBURN_MENUBAR_RESULT line was printed')
    return JSON.parse(line.slice(BUNDLED_RESULT_PREFIX.length)) as BundledInstallResult
  }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-uninstall-'))
    logs = []
    installerCalls = []
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('runs msiexec /x with the product code from the registry and reports uninstalled', async () => {
    await uninstallMenubarApp({
      platform: 'win32',
      windows: {
        env: env(),
        log: (message: string) => { logs.push(message) },
        queryRegistry: async () => INSTALLED_WITH_UNINSTALL,
        isTrayRunning: async () => false,
        runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 0 },
      },
    })

    expect(installerCalls).toEqual([{
      exe: resolveSystem32Path('msiexec.exe', env()),
      args: ['/x', PRODUCT_CODE, '/passive', '/norestart'],
    }])
    expect(lastResult().action).toBe('uninstalled')
  })

  it('reports uninstalled and touches msiexec nowhere when nothing is installed', async () => {
    await uninstallMenubarApp({
      platform: 'win32',
      windows: {
        env: env(),
        log: (message: string) => { logs.push(message) },
        queryRegistry: async () => '',
        isTrayRunning: async () => false,
        runInstaller: async (exe: string, args: string[]) => { installerCalls.push({ exe, args }); return 0 },
      },
    })

    expect(installerCalls).toEqual([])
    expect(lastResult().action).toBe('uninstalled')
  })

  it('is a Windows-only option', async () => {
    await expect(uninstallMenubarApp({ platform: 'darwin' })).rejects.toThrow(/Windows option/)
  })
})
