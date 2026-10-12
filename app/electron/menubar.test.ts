import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUNDLED_RESULT_PREFIX,
  MenubarCompanion,
  STAGED_MSI_FLAG,
  TRAY_CLI_ENV,
  TRAY_CLI_PATH_KEY,
  DEFAULT_COMPANION_SETTINGS,
  cliLauncherPath,
  cliLauncherScript,
  companionDataDir,
  dockPrefsPath,
  findPackagedTrayExe,
  findStagedMsi,
  isNewerVersion,
  parseInstallResult,
  parseRunKeyValue,
  readCompanionSettings,
  readDockEnabled,
  runKeyArgs,
  system32Path,
  writeCliLauncher,
  writeCompanionSettings,
  writeDockEnabled,
  type MenubarInstallResult,
} from './menubar'
import { DEFAULT_TRAY_APP_PREFS, DEFAULT_TRAY_DOCK_PREFS, readTrayFile } from './tray-settings'

const VERSION = '0.9.23'
const MSI_NAME = `CodeBurn.Menubar_${VERSION}_x64_en-US.msi`
const TRAY_EXE = 'C:\\Program Files\\CodeBurn Menubar\\codeburn-menubar.exe'

function result(overrides: Partial<MenubarInstallResult> = {}): MenubarInstallResult {
  return {
    action: 'installed',
    bundledVersion: VERSION,
    previousVersion: null,
    exePath: TRAY_EXE,
    uninstallString: 'MsiExec.exe /X{guid}',
    installedBy: 'desktop',
    ...overrides,
  }
}

describe('staged tray app discovery', () => {
  let sandbox: string

  beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), 'companion-')) })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('reads the version out of the staged asset name', () => {
    writeFileSync(join(sandbox, MSI_NAME), 'msi')
    expect(findStagedMsi(sandbox)).toEqual({ path: join(sandbox, MSI_NAME), version: VERSION })
  })

  it('ignores anything that is not the release asset, and a directory that is not there', () => {
    writeFileSync(join(sandbox, 'CodeBurn-Setup-0.9.23.exe'), 'nope')
    expect(findStagedMsi(sandbox)).toBeNull()
    expect(findStagedMsi(join(sandbox, 'missing'))).toBeNull()
  })

  it('finds the packaged tray executable only when it is there', () => {
    expect(findPackagedTrayExe(sandbox)).toBeNull()
    writeFileSync(join(sandbox, 'codeburn-menubar.exe'), 'exe')
    expect(findPackagedTrayExe(sandbox)).toBe(join(sandbox, 'codeburn-menubar.exe'))
  })
})

describe('isNewerVersion', () => {
  it('compares release versions component by component', () => {
    expect(isNewerVersion('0.9.24', '0.9.23')).toBe(true)
    expect(isNewerVersion('0.9.23', '0.9.24')).toBe(false)
    expect(isNewerVersion('0.10.0', '0.9.99')).toBe(true)
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false) // a missing component is zero
    expect(isNewerVersion(null, '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', null)).toBe(true)
  })

  // A `dev` (unparseable) component sorts below every real number, so a real staged release is
  // newer than a dev build already installed, and a dev build is never newer than a release.
  it('treats a dev build as older than any release', () => {
    expect(isNewerVersion('1.2.0', '1.2.dev')).toBe(true)
    expect(isNewerVersion('1.2.dev', '1.2.0')).toBe(false)
  })
})

describe('parseInstallResult', () => {
  it('picks the one machine-readable line out of the installer prose', () => {
    const stdout = [
      'Verifying checksum...',
      'Installing...',
      `${BUNDLED_RESULT_PREFIX}${JSON.stringify(result())}`,
      'Installed CodeBurn Menubar 0.9.23.',
    ].join('\r\n')

    expect(parseInstallResult(stdout)).toEqual(result())
  })

  it('is null when the installer said nothing machine-readable, or said it badly', () => {
    expect(parseInstallResult('Installing...\n')).toBeNull()
    expect(parseInstallResult(`${BUNDLED_RESULT_PREFIX}{not json`)).toBeNull()
  })
})

describe('runKeyArgs', () => {
  it('writes and removes the same value the tray app\u2019s own toggle owns', () => {
    expect(runKeyArgs(true, TRAY_EXE)).toEqual([
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'CodeBurn', '/t', 'REG_SZ', '/d', `"${TRAY_EXE}"`, '/f',
    ])
    expect(runKeyArgs(false, TRAY_EXE)).toEqual([
      'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'CodeBurn', '/f',
    ])
  })
})

describe('parseRunKeyValue', () => {
  it('reads the value out of a reg query, and null when there is none', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      `    CodeBurn    REG_SZ    "${TRAY_EXE}"`,
      '',
    ].join('\r\n')

    expect(parseRunKeyValue(output)).toBe(`"${TRAY_EXE}"`)
    expect(parseRunKeyValue('ERROR: The system was unable to find the specified registry key')).toBeNull()
    // A different value under the same key is not this one.
    expect(parseRunKeyValue('    OneDrive    REG_SZ    "C:\\OneDrive.exe"')).toBeNull()
  })
})

describe('system32Path', () => {
  it('never resolves a system tool by bare name', () => {
    expect(system32Path('reg.exe', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\reg.exe')
    expect(system32Path('reg.exe', {})).toBe('C:\\Windows\\System32\\reg.exe')
  })
})

describe('the dock preference file', () => {
  let home: string

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'companion-home-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('creates the file the tray app reads before its page exists', () => {
    writeDockEnabled(true, home)
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true })
  })

  it('reports whether the tray app has already said something about the rail', () => {
    expect(readDockEnabled(home)).toBeUndefined()

    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ scale: 1.2 }))
    expect(readDockEnabled(home)).toBeUndefined()

    writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: false, scale: 1.2 }))
    expect(readDockEnabled(home)).toBe(false)

    writeFileSync(dockPrefsPath(home), '{ broken')
    expect(readDockEnabled(home)).toBeUndefined()
  })

  it('keeps every key the tray app owns', () => {
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: true, scale: 1.2, preferred: 'claude' }))

    writeDockEnabled(false, home)

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8')))
      .toEqual({ enabled: false, scale: 1.2, preferred: 'claude' })
  })
})

describe('companion settings', () => {
  let stateDir: string

  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'companion-state-')) })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('defaults both switches on before anything has been written', () => {
    expect(readCompanionSettings(stateDir)).toEqual(DEFAULT_COMPANION_SETTINGS)
  })

  it('round-trips, and falls back to the defaults on an unreadable file', () => {
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    expect(readCompanionSettings(stateDir)).toEqual({ ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: true, trayExePath: TRAY_EXE, seeded: true })

    writeFileSync(join(stateDir, 'companion.v1.json'), '{ broken')
    expect(readCompanionSettings(stateDir).menuBar).toBe(true)
  })

  // Falling back to the defaults means seeding again, which reinstalls the tray app and
  // re-enables the rail. A byte order mark, which anything editing this file by hand on
  // Windows tends to leave, is not a good enough reason for that.
  it('reads a file that was saved with a byte order mark', () => {
    const settings = { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: false, trayExePath: TRAY_EXE, seeded: true }
    writeFileSync(join(stateDir, 'companion.v1.json'), `﻿${JSON.stringify(settings)}`)

    expect(readCompanionSettings(stateDir)).toEqual(settings)
  })
})

// The launcher the desktop app leaves for the tray app, which is the only CLI a machine with
// no global `npm install -g codeburn` has.
describe('the tray app\u2019s CLI launcher', () => {
  const EXEC = 'C:\\Program Files\\CodeBurn\\CodeBurn.exe'
  let sandbox: string
  let home: string
  let entry: string

  function opts(overrides: Record<string, unknown> = {}) {
    return {
      platform: 'win32',
      env: { LOCALAPPDATA: join(sandbox, 'Local'), CODEBURN_BUNDLED_CLI: entry },
      home,
      execPath: EXEC,
      ...overrides,
    }
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'companion-launcher-'))
    home = join(sandbox, 'home')
    entry = join(sandbox, 'resources', 'cli', 'dist', 'launch.js')
    mkdirSync(join(sandbox, 'resources', 'cli', 'dist'), { recursive: true })
    writeFileSync(entry, '// the bundled CLI')
  })

  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('sits beside the tray app\u2019s own install marker', () => {
    // Joined with the host's separator: the helper runs on Windows, the suite everywhere.
    expect(companionDataDir({ LOCALAPPDATA: 'D:\\Local' }, home)).toBe(join('D:\\Local', 'codeburn-menubar'))
    // A Windows session without the variable is not a session without the directory.
    expect(companionDataDir({}, home)).toBe(join(home, 'AppData', 'Local', 'codeburn-menubar'))
    expect(cliLauncherPath({ LOCALAPPDATA: 'D:\\Local' }, home)).toBe(join('D:\\Local', 'codeburn-menubar', 'codeburn-cli.cmd'))
  })

  it('runs the bundled CLI through the desktop app\u2019s executable, forwarding everything', () => {
    const path = writeCliLauncher(opts())

    expect(path).toBe(join(sandbox, 'Local', 'codeburn-menubar', 'codeburn-cli.cmd'))
    const script = readFileSync(path as string, 'utf8')
    expect(script).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(script).toContain(`"${EXEC}" "${entry}" %*`)
    // The tray app reads the exit code of everything it spawns.
    expect(script).toContain('exit /b %ERRORLEVEL%')
  })

  it('is rewritten by an updated desktop app rather than left pointing at the old one', () => {
    writeCliLauncher(opts())
    const path = writeCliLauncher(opts({ execPath: 'C:\\Program Files\\CodeBurn\\CodeBurn2.exe' }))

    expect(readFileSync(path as string, 'utf8')).toContain('CodeBurn2.exe')
  })

  it('writes nothing off Windows, or in a build that carries no CLI', () => {
    expect(writeCliLauncher(opts({ platform: 'darwin' }))).toBeNull()
    expect(existsSync(join(sandbox, 'Local'))).toBe(false)

    // Dev: CODEBURN_BUNDLED_CLI is unset because the repo's own build is used instead.
    expect(writeCliLauncher(opts({ env: { LOCALAPPDATA: join(sandbox, 'Local') } }))).toBeNull()
    // A packaged build whose resources were not staged.
    expect(writeCliLauncher(opts({
      env: { LOCALAPPDATA: join(sandbox, 'Local'), CODEBURN_BUNDLED_CLI: join(sandbox, 'missing.js') },
    }))).toBeNull()
  })

  // The alternative to refusing is writing a batch file that means something other than
  // what it says, which is worse than having no launcher at all.
  it('refuses a path cmd.exe would read rather than pass along', () => {
    expect(cliLauncherScript('C:\\App\\Code"Burn.exe', 'C:\\App\\launch.js')).toBeNull()
    expect(cliLauncherScript('C:\\App\\CodeBurn.exe', 'C:\\App\\%PATH%\\launch.js')).toBeNull()
    expect(cliLauncherScript('', 'C:\\App\\launch.js')).toBeNull()
  })
})

describe('MenubarCompanion', () => {
  let sandbox: string
  let resources: string
  let stateDir: string
  let home: string
  let launches: Array<{ exe: string; args: string[] }>
  /** The env each launch was given, in step with `launches`. */
  let launchEnvs: Array<NodeJS.ProcessEnv | undefined>
  let regCalls: string[][]
  let cliCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>
  /** Prose the installer prints before its machine-readable line, which is where the
   *  reboot-pending state is reported: `BundledInstallResult` has no field for it. */
  let cliNotice: string
  let installResult: MenubarInstallResult | null
  let existingRunKey: string | null
  let trayRunning: boolean
  /** What is on disk, as far as the companion is concerned. TRAY_EXE is there by default. */
  let present: Set<string>

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      resourcesPath: resources,
      stateDir,
      store: false,
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      home,
      launch: (exe: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => {
        launches.push({ exe, args })
        launchEnvs.push(extraEnv)
      },
      runReg: async (args: string[]) => { regCalls.push(args) },
      readRunKey: async () => existingRunKey,
      isRunning: async () => trayRunning,
      exists: (path: string) => present.has(path),
      runCli: async (args: string[], opts: { extraEnv?: NodeJS.ProcessEnv }) => {
        cliCalls.push({ args, env: opts.extraEnv })
        const prose = `Installing...\n${cliNotice}`
        return {
          ok: true,
          stdout: installResult ? `${prose}${BUNDLED_RESULT_PREFIX}${JSON.stringify(installResult)}\n` : prose,
          stderr: '',
          code: 0,
        }
      },
      ...overrides,
    }
  }

  function stageMsi(version = VERSION): void {
    mkdirSync(join(resources, 'menubar'), { recursive: true })
    for (const name of readdirSync(join(resources, 'menubar'))) {
      if (name.endsWith('.msi')) rmSync(join(resources, 'menubar', name))
    }
    writeFileSync(join(resources, 'menubar', `CodeBurn.Menubar_${version}_x64_en-US.msi`), 'msi')
  }

  function stageExe(): string {
    mkdirSync(join(resources, 'menubar'), { recursive: true })
    const exe = join(resources, 'menubar', 'codeburn-menubar.exe')
    writeFileSync(exe, 'exe')
    present.add(exe)
    return exe
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'companion-app-'))
    resources = join(sandbox, 'resources')
    stateDir = join(sandbox, 'state')
    home = join(sandbox, 'home')
    mkdirSync(resources, { recursive: true })
    launches = []
    launchEnvs = []
    regCalls = []
    cliCalls = []
    cliNotice = ''
    installResult = result()
    existingRunKey = null
    trayRunning = false
    present = new Set([TRAY_EXE])
  })

  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('is unsupported off Windows and on a build with nothing staged', async () => {
    expect((await new MenubarCompanion(deps()).status()).supported).toBe(false)
    stageMsi()
    expect((await new MenubarCompanion(deps({ platform: 'darwin' })).status()).supported).toBe(false)
    expect((await new MenubarCompanion(deps()).status()).supported).toBe(true)
    // The Store route wants the executable itself; an .msi it cannot run is not support.
    expect((await new MenubarCompanion(deps({ store: true })).status()).supported).toBe(false)
  })

  // The path is an argument rather than an environment variable, so nothing a stray variable
  // in the inherited environment names can reach msiexec. The CLI rejects the variable this
  // flag replaced (src/menubar-installer.ts).
  it('installs through the CLI, naming the staged file on the command line', async () => {
    stageMsi()
    await new MenubarCompanion(deps()).bootstrap()

    expect(cliCalls).toEqual([{
      args: ['menubar', STAGED_MSI_FLAG, join(resources, 'menubar', MSI_NAME)],
      env: undefined,
    }])
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
    expect(readCompanionSettings(stateDir)).toMatchObject({ trayExePath: TRAY_EXE, seeded: true })
  })

  it('seeds the Capacity Dock on first run only', async () => {
    stageMsi()
    await new MenubarCompanion(deps()).bootstrap()
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true })

    // A person turning the rail off in the tray app's own settings must not find it back on.
    writeDockEnabled(false, home)
    await new MenubarCompanion(deps()).bootstrap()
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
  })

  it('leaves a rail preference that was already there, and mirrors it into the switch', async () => {
    stageMsi()
    // A tray app installed by hand, with the rail deliberately off.
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: false, scale: 1.2 }))
    const companion = new MenubarCompanion(deps())

    await companion.bootstrap()

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false, scale: 1.2 })
    expect((await companion.status()).sidebar).toBe(false)
    expect(readCompanionSettings(stateDir).sidebar).toBe(false)
  })

  it('still seeds when the file exists but has never mentioned the rail', async () => {
    stageMsi()
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
    writeFileSync(dockPrefsPath(home), JSON.stringify({ scale: 1.2 }))

    await new MenubarCompanion(deps()).bootstrap()

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true, scale: 1.2 })
  })

  it('seeds launch at login again after this app reinstalls the tray', async () => {
    stageMsi()
    await new MenubarCompanion(deps()).bootstrap()
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])

    // The tray app went away with an uninstall that took its Run value along; the exe is
    // back only once the CLI has installed it again. Seeded once is no reason to leave a
    // freshly placed tray app without launch at login.
    regCalls = []
    present.delete(TRAY_EXE)
    installResult = result({ action: 'installed' })
    await new MenubarCompanion(deps({
      exists: (path: string) => (path === TRAY_EXE ? cliCalls.length > 1 : present.has(path)),
    })).bootstrap()

    expect(cliCalls).toHaveLength(2)
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
  })

  it('leaves an existing launch-at-login value alone', async () => {
    stageMsi()
    existingRunKey = `"${TRAY_EXE}"`

    await new MenubarCompanion(deps()).bootstrap()

    expect(regCalls).toEqual([])
    // Everything else still happens: the install is what carries a version forward.
    expect(cliCalls).toHaveLength(1)
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
  })

  it('writes the launch-at-login value on the first run only', async () => {
    stageMsi()
    await new MenubarCompanion(deps()).bootstrap()
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])

    // A person turning launch at login off in the tray app's settings must not find it back on.
    regCalls = []
    await new MenubarCompanion(deps()).bootstrap()
    expect(regCalls).toEqual([])
  })

  it('does nothing at all with the Menu bar switch off', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: true, trayExePath: null, seeded: true })

    await new MenubarCompanion(deps()).bootstrap()

    expect(cliCalls).toEqual([])
    expect(launches).toEqual([])
    expect(regCalls).toEqual([])
  })

  it('launches the packaged executable and writes no Run value on the Store route', async () => {
    const exe = stageExe()
    await new MenubarCompanion(deps({ store: true })).bootstrap()

    expect(cliCalls).toEqual([])
    // Launch at login is the package manifest's own startup task there.
    expect(regCalls).toEqual([])
    expect(launches).toEqual([{ exe, args: ['--reload-settings'] }])
  })

  it('keeps the switch where it was when the install was cancelled', async () => {
    stageMsi()
    installResult = result({ action: 'cancelled', exePath: '', installedBy: null })

    await new MenubarCompanion(deps()).bootstrap()

    expect(launches).toEqual([])
    expect(regCalls).toEqual([])
    expect(readCompanionSettings(stateDir).trayExePath).toBeNull()
  })

  it('keeps a working tray app when the installer reports nothing at all', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    installResult = null
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await new MenubarCompanion(deps()).bootstrap()

    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
    error.mockRestore()
  })


  // The install probe used to run at every launch. A real install runs msiexec /passive,
  // which is an admin prompt, so a launch with nothing to install must not spawn one and a
  // person who said no must not be asked again for the same file.
  describe('not asking again', () => {
    it('skips the probe entirely once the staged version is the one on disk', async () => {
      stageMsi()
      await new MenubarCompanion(deps()).bootstrap()
      expect(cliCalls).toHaveLength(1)
      expect(readCompanionSettings(stateDir)).toMatchObject({ trayExeVersion: VERSION })

      cliCalls = []
      await new MenubarCompanion(deps()).bootstrap()

      expect(cliCalls).toEqual([])
      // Everything downstream of the install still happens.
      expect(launches).toEqual([
        { exe: TRAY_EXE, args: ['--reload-settings'] },
        { exe: TRAY_EXE, args: ['--reload-settings'] },
      ])
    })

    it('probes again when the recorded tray app is no longer on disk', async () => {
      stageMsi()
      await new MenubarCompanion(deps()).bootstrap()
      cliCalls = []
      present.delete(TRAY_EXE)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})

      await new MenubarCompanion(deps()).bootstrap()

      expect(cliCalls).toHaveLength(1)
      error.mockRestore()
    })

    it('probes again when the desktop app brings a newer tray app with it', async () => {
      stageMsi()
      await new MenubarCompanion(deps()).bootstrap()
      cliCalls = []
      stageMsi('0.9.24')
      installResult = result({ bundledVersion: '0.9.24' })

      await new MenubarCompanion(deps()).bootstrap()

      expect(cliCalls).toHaveLength(1)
      expect(readCompanionSettings(stateDir).trayExeVersion).toBe('0.9.24')
    })

    it('does not put the admin prompt up again after it was declined', async () => {
      stageMsi()
      installResult = result({ action: 'cancelled', exePath: '', installedBy: null })
      await new MenubarCompanion(deps()).bootstrap()
      expect(cliCalls).toHaveLength(1)
      expect(readCompanionSettings(stateDir).installDeclinedVersion).toBe(VERSION)

      cliCalls = []
      await new MenubarCompanion(deps()).bootstrap()

      expect(cliCalls).toEqual([])
      expect(launches).toEqual([])
    })

    // A refusal is a decision; a run that said nothing is not. A spawn that timed out, a CLI
    // that was not there and a run that died before printing its result are all things that
    // come right on their own, so the next launch tries again rather than never installing.
    it('tries again after an install that reported nothing at all', async () => {
      stageMsi()
      installResult = null
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await new MenubarCompanion(deps()).bootstrap()
      expect(readCompanionSettings(stateDir).installDeclinedVersion).toBeNull()

      cliCalls = []
      await new MenubarCompanion(deps()).bootstrap()

      expect(cliCalls).toHaveLength(1)
      error.mockRestore()
    })

    it('asks again when a declined version is superseded by a newer one', async () => {
      stageMsi()
      installResult = result({ action: 'cancelled', exePath: '', installedBy: null })
      await new MenubarCompanion(deps()).bootstrap()
      cliCalls = []
      stageMsi('0.9.24')
      installResult = result({ bundledVersion: '0.9.24' })

      await new MenubarCompanion(deps()).bootstrap()

      expect(cliCalls).toHaveLength(1)
      expect(readCompanionSettings(stateDir).installDeclinedVersion).toBeNull()
    })

    // The one retry left: this time the person asked, rather than being asked.
    it('offers a declined install again when Menu bar is switched on by hand', async () => {
      stageMsi()
      installResult = result({ action: 'cancelled', exePath: '', installedBy: null })
      const companion = new MenubarCompanion(deps())
      await companion.bootstrap()
      cliCalls = []
      installResult = result()

      const status = await companion.setMenuBarEnabled(true)

      expect(cliCalls).toHaveLength(1)
      expect(status.menuBar).toBe(true)
      expect(readCompanionSettings(stateDir)).toMatchObject({
        installDeclinedVersion: null,
        trayExePath: TRAY_EXE,
      })
    })
  })

  // msiexec exit 3010: the install is real but Windows could not replace a file that was in
  // use, so the binary at that path is still the previous tray app until the next restart.
  // Starting it would put the old one in the notification area under the new version's name.
  describe('an install Windows can only finish at the next restart', () => {
    const REBOOT_LINE = 'Windows wants a restart to finish the install.\n'

    it('does not launch the old binary, and says a restart is needed', async () => {
      stageMsi()
      cliNotice = REBOOT_LINE
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const companion = new MenubarCompanion(deps())

      await companion.bootstrap()

      expect(cliCalls).toHaveLength(1)
      expect(launches).toEqual([])
      expect((await companion.status()).restartRequired).toBe(true)
      log.mockRestore()
    })

    // The version is not the question; a field on the result is, so a CLI that grows one is
    // believed without this side having to keep reading prose.
    it('believes a rebootRequired field on the result', async () => {
      stageMsi()
      installResult = result({ rebootRequired: true })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const companion = new MenubarCompanion(deps())

      await companion.bootstrap()

      expect(launches).toEqual([])
      expect((await companion.status()).restartRequired).toBe(true)
      log.mockRestore()
    })

    // The install did happen, so it is not offered again and the switch is not turned off:
    // the only thing missing is the restart.
    it('records the install and leaves the switch on', async () => {
      stageMsi()
      cliNotice = REBOOT_LINE
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})

      const status = await new MenubarCompanion(deps()).setMenuBarEnabled(true)

      expect(status.menuBar).toBe(true)
      expect(readCompanionSettings(stateDir)).toMatchObject({
        installDeclinedVersion: null,
        trayExePath: TRAY_EXE,
        trayExeVersion: VERSION,
      })
      log.mockRestore()
    })

    // Nothing was started, so there is nothing to nudge either: a settings write still lands
    // in the file, and the tray app reads it when the restart finally starts it.
    it('writes tray settings without nudging a tray app that is not running', async () => {
      stageMsi()
      cliNotice = REBOOT_LINE
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const companion = new MenubarCompanion(deps())
      await companion.bootstrap()

      await companion.setTrayAppPref({ accent: 'blue' })

      expect(launches).toEqual([])
      expect(readTrayFile('app', home).accent).toBe('blue')
      log.mockRestore()
    })

    // A launch after the restart has an ordinary install ahead of it: the recorded version is
    // the staged one and the exe is there, so nothing is spawned and the tray app starts.
    it('starts the tray app at the launch after the restart', async () => {
      stageMsi()
      cliNotice = REBOOT_LINE
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await new MenubarCompanion(deps()).bootstrap()
      cliCalls = []
      cliNotice = ''

      // Windows has started since the install, which is what finished the file replacement.
      const companion = new MenubarCompanion(deps({ bootedAtMs: () => Date.now() + 1_000 }))
      await companion.bootstrap()

      expect(cliCalls).toEqual([])
      expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
      expect((await companion.status()).restartRequired).toBe(false)
      // The pending mark is spent, so a later launch does not have to derive it again.
      expect(readCompanionSettings(stateDir).restartRequiredSince).toBeNull()
      log.mockRestore()
    })

    // Quitting the desktop app and opening it again is not the restart being waited for. The
    // flag used to live only in memory, so the second launch started the old binary under the
    // new version's name, which is the confusion this whole path exists to avoid.
    it('keeps waiting when the app is restarted but Windows is not', async () => {
      stageMsi()
      cliNotice = REBOOT_LINE
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await new MenubarCompanion(deps()).bootstrap()
      cliCalls = []
      cliNotice = ''
      launches = []

      // The machine last booted a day before the install, so nothing has finished it.
      const companion = new MenubarCompanion(deps({ bootedAtMs: () => Date.now() - 86_400_000 }))
      await companion.bootstrap()

      expect(launches).toEqual([])
      expect((await companion.status()).restartRequired).toBe(true)
      expect(readCompanionSettings(stateDir).restartRequiredSince).not.toBeNull()
      log.mockRestore()
    })
  })

  // Launch at login on the Store route is the package manifest's own startup task
  // (app/build/appx-extensions.xml), which only Windows can turn on and off.
  describe('launch at login', () => {
    it('is this app’s to set on the NSIS route', async () => {
      stageMsi()
      existingRunKey = `"${TRAY_EXE}"`
      const companion = new MenubarCompanion(deps())

      expect(await companion.trayPrefs()).toMatchObject({ launchAtLogin: true, launchAtLoginManaged: false })

      await companion.setLaunchAtLogin(false)
      expect(regCalls).toContainEqual(runKeyArgs(false, TRAY_EXE))
    })

    it('is Windows’ to set on the Store route, and this app writes no Run value for it', async () => {
      stageExe()
      const companion = new MenubarCompanion(deps({ store: true }))

      const prefs = await companion.trayPrefs()
      expect(prefs.launchAtLoginManaged).toBe(true)

      // The switch is not rendered there, but the method must not half-do it either.
      expect(await companion.setLaunchAtLogin(true)).toMatchObject({ launchAtLoginManaged: true })
      expect(regCalls).toEqual([])
    })
  })

  // A stored path can be wrong: written by a build that derived the binary name from the
  // product name, or left behind by a tray app that has since been uninstalled.
  const STALE_EXE = 'C:\\Program Files\\CodeBurn Menubar\\CodeBurn Menubar.exe'

  it('re-resolves a stored path that is not on disk rather than launching it', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: true, trayExePath: STALE_EXE, seeded: true })

    await new MenubarCompanion(deps()).setMenuBarEnabled(true)

    // The install re-reads the registry and installs nothing when the version matches.
    expect(cliCalls).toHaveLength(1)
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
    expect(readCompanionSettings(stateDir).trayExePath).toBe(TRAY_EXE)
  })

  it('does not send --quit into the void when the stored path is stale', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: STALE_EXE, seeded: true })

    await new MenubarCompanion(deps()).setMenuBarEnabled(false)

    expect(launches).toEqual([])
    expect(regCalls).toEqual([runKeyArgs(false, STALE_EXE)])
  })

  it('gives up rather than storing a path the installer reported but nothing is at', async () => {
    stageMsi()
    installResult = result({ exePath: STALE_EXE })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await new MenubarCompanion(deps()).bootstrap()

    expect(launches).toEqual([])
    expect(regCalls).toEqual([])
    expect(readCompanionSettings(stateDir).trayExePath).toBeNull()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('repairs a Run value that points at a file which is not there', async () => {
    stageMsi()
    // Not a first run, so the seed rule would normally leave an existing value alone.
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    existingRunKey = `"${STALE_EXE}"`

    await new MenubarCompanion(deps()).bootstrap()

    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
  })

  it('still leaves a Run value alone when it points at something real', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    const other = 'C:\\Somewhere\\else.exe'
    present.add(other)
    existingRunKey = `"${other}"`

    await new MenubarCompanion(deps()).bootstrap()

    expect(regCalls).toEqual([])
  })

  it('Menu bar off quits the tray app and drops the Run value', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    const companion = new MenubarCompanion(deps())

    const status = await companion.setMenuBarEnabled(false)

    expect(status).toMatchObject({ supported: true, menuBar: false, sidebar: false, store: false, restartRequired: false })
    expect(regCalls).toEqual([runKeyArgs(false, TRAY_EXE)])
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--quit'] }])
  })

  it('Menu bar on right after off waits for the old process before starting again', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: false, trayExePath: TRAY_EXE, seeded: true })
    const companion = new MenubarCompanion(deps())
    await companion.setMenuBarEnabled(false)
    trayRunning = true
    setTimeout(() => { trayRunning = false }, 250)

    const started = Date.now()
    const status = await companion.setMenuBarEnabled(true)

    expect(status.menuBar).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(launches).toEqual([
      { exe: TRAY_EXE, args: ['--quit'] },
      { exe: TRAY_EXE, args: ['--reload-settings'] },
    ])
  })

  it('Menu bar on installs if it has to, then starts the tray app again', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: true, trayExePath: null, seeded: true })

    const status = await new MenubarCompanion(deps()).setMenuBarEnabled(true)

    expect(status.menuBar).toBe(true)
    expect(cliCalls).toHaveLength(1)
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
  })

  // The rail is a window of the tray app, so the two switches cannot disagree.
  it('Menu bar off turns Sidebar off with it, writing the preference before the quit', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    writeDockEnabled(true, home)
    const companion = new MenubarCompanion(deps())

    const status = await companion.setMenuBarEnabled(false)

    expect(status).toMatchObject({ supported: true, menuBar: false, sidebar: false, store: false, restartRequired: false })
    // Written before --quit, so what the tray app finds next time is what the switches show.
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--quit'] }])
    expect(readCompanionSettings(stateDir).sidebar).toBe(false)
  })

  it('Sidebar on with Menu bar off turns the tray app on first', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: false, trayExePath: null, seeded: true })

    const status = await new MenubarCompanion(deps()).setSidebarEnabled(true)

    expect(status).toMatchObject({ menuBar: true, sidebar: true })
    expect(cliCalls).toHaveLength(1)
    expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: true })
    // Started for the Menu bar switch, then nudged again for the rail.
    expect(launches).toEqual([
      { exe: TRAY_EXE, args: ['--reload-settings'] },
      { exe: TRAY_EXE, args: ['--reload-settings'] },
    ])
  })

  it('leaves both switches off when the tray app cannot be turned on', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: false, trayExePath: null, seeded: true })
    installResult = result({ action: 'cancelled', exePath: '', installedBy: null })

    const status = await new MenubarCompanion(deps()).setSidebarEnabled(true)

    expect(status).toMatchObject({ menuBar: false, sidebar: false })
    expect(launches).toEqual([])
    expect(() => readFileSync(dockPrefsPath(home), 'utf8')).toThrow()
  })

  it('Sidebar off writes the preference and asks a running tray app to notice', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })

    const status = await new MenubarCompanion(deps()).setSidebarEnabled(false)

    expect(status.sidebar).toBe(false)
    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
    expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
  })

  // The discrete Plugins-card actions, mirroring the macOS card.
  describe('discrete actions', () => {
    it('install stages and runs the bundled MSI, then seeds launch-at-login', async () => {
      stageMsi()
      const companion = new MenubarCompanion(deps())

      const res = await companion.install()

      expect(res.ok).toBe(true)
      expect(cliCalls.some(c => c.args.join(' ') === `menubar ${STAGED_MSI_FLAG} ${join(resources, 'menubar', MSI_NAME)}`)).toBe(true)
      expect(regCalls).toContainEqual(runKeyArgs(true, TRAY_EXE))
      expect(launches).toContainEqual({ exe: TRAY_EXE, args: ['--reload-settings'] })
      expect(res.status.installed).toBe(true)
    })

    it('treats a cancelled elevation prompt as a no-op, not a failure', async () => {
      stageMsi()
      installResult = result({ action: 'cancelled' })
      const companion = new MenubarCompanion(deps())

      const res = await companion.install()

      // The person declined the UAC prompt: no error, nothing installed, and the declined
      // version is remembered so it is not re-offered until they ask again.
      expect(res.ok).toBe(true)
      expect(res.status.installed).toBe(false)
      expect(readCompanionSettings(stateDir).installDeclinedVersion).toBe(VERSION)
    })

    it('install passes --force when a copy is already there (Reinstall)', async () => {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, trayExePath: TRAY_EXE, trayExeVersion: VERSION, seeded: true })
      const companion = new MenubarCompanion(deps())

      await companion.install()

      expect(cliCalls.some(c => c.args.includes('--force'))).toBe(true)
    })

    it('open shows the tray popover with a bare relaunch', async () => {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, trayExePath: TRAY_EXE, seeded: true })
      const companion = new MenubarCompanion(deps())

      await companion.open()

      expect(launches).toContainEqual({ exe: TRAY_EXE, args: [] })
    })

    it('quit stops the tray without dropping the Run value or turning the switch off', async () => {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, trayExePath: TRAY_EXE, seeded: true })
      let calls = 0
      const companion = new MenubarCompanion(deps({ isRunning: async () => { calls++; return calls === 1 } }))

      const res = await companion.quit()

      expect(launches).toContainEqual({ exe: TRAY_EXE, args: ['--quit'] })
      expect(regCalls).toEqual([])
      expect(res.ok).toBe(true)
      expect(readCompanionSettings(stateDir).menuBar).toBe(true)
    })

    it('uninstall runs the CLI uninstall, drops the Run value and clears the recorded path', async () => {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, trayExePath: TRAY_EXE, trayExeVersion: VERSION, seeded: true })
      installResult = result({ action: 'uninstalled' })
      let calls = 0
      const companion = new MenubarCompanion(deps({ isRunning: async () => { calls++; return calls === 1 } }))

      const res = await companion.uninstall()

      expect(cliCalls.some(c => c.args.join(' ') === 'menubar --uninstall')).toBe(true)
      expect(regCalls).toContainEqual(runKeyArgs(false, ''))
      expect(readCompanionSettings(stateDir).trayExePath).toBeNull()
      expect(res.ok).toBe(true)
      expect(res.status.installed).toBe(false)
    })

    it('leaves the tray recorded and launch-at-login intact when the CLI uninstall fails', async () => {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, trayExePath: TRAY_EXE, trayExeVersion: VERSION, seeded: true })
      const companion = new MenubarCompanion(deps({
        runCli: async () => ({ ok: false, stdout: '', stderr: 'msiexec exited with 1603', code: 1 }),
      }))

      const res = await companion.uninstall()

      // The tray app is still on disk, so its path, version and Run value must survive: dropping
      // them would orphan a working install and wrongly show the card as uninstalled.
      expect(res.ok).toBe(false)
      expect(regCalls).not.toContainEqual(runKeyArgs(false, ''))
      const saved = readCompanionSettings(stateDir)
      expect(saved.trayExePath).toBe(TRAY_EXE)
      expect(saved.menuBar).toBe(true)
    })
  })

  // The tray app's own settings, which the two panes in the desktop app's Settings render.
  describe('tray preferences', () => {
    const settingsPath = () => join(home, '.config', 'codeburn', 'windows-settings.json')

    function running(): MenubarCompanion {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
      return new MenubarCompanion(deps())
    }

    it('reads both files and the Run value', async () => {
      const companion = running()
      mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
      writeFileSync(settingsPath(), JSON.stringify({ metric: 'tokens', accent: 'green' }))
      writeDockEnabled(true, home)
      existingRunKey = `"${TRAY_EXE}"`

      const prefs = await companion.trayPrefs()

      expect(prefs.app).toMatchObject({ metric: 'tokens', accent: 'green', terminal: 'windowsTerminal' })
      expect(prefs.dock).toMatchObject({ enabled: true, scale: 0.6 })
      expect(prefs.launchAtLogin).toBe(true)
    })

    it('writes a setting and nudges the running tray app to re-read it', async () => {
      const companion = running()

      const prefs = await companion.setTrayAppPref({ metric: 'iconOnly' })

      expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({ metric: 'iconOnly' })
      expect(prefs.app.metric).toBe('iconOnly')
      expect(launches).toEqual([{ exe: TRAY_EXE, args: ['--reload-settings'] }])
    })

    it('writes nothing and nudges nobody for a patch it will not accept', async () => {
      const companion = running()

      await companion.setTrayAppPref({ placement: { docked: 'left' } })

      expect(launches).toEqual([])
      expect(readTrayFile('app', home)).toEqual({})
    })

    // Both setters take whatever the renderer sent over IPC. `'enabled' in patch` is the
    // first thing setTrayDockPref reads, and it throws a TypeError on a primitive, so the
    // shape is settled before anything looks inside it.
    it('answers a patch that is not an object without writing or throwing', async () => {
      const companion = running()

      for (const patch of [null, undefined, 'enabled', 42, ['enabled'], true]) {
        expect(await companion.setTrayDockPref(patch)).toEqual(await companion.trayPrefs())
        expect(await companion.setTrayAppPref(patch)).toEqual(await companion.trayPrefs())
      }

      expect(launches).toEqual([])
      expect(readTrayFile('app', home)).toEqual({})
      expect(readTrayFile('dock', home)).toEqual({})
    })

    it('keeps the rail placement while writing a dock setting', async () => {
      const companion = running()
      mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
      writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: true, placement: { docked: 'right' } }))

      await companion.setTrayDockPref({ scale: 1.1, theme: 'glass' })

      expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({
        enabled: true, placement: { docked: 'right' }, scale: 1.1, theme: 'glass',
      })
    })

    it('moves the resting provider when it leaves the set', async () => {
      const companion = running()
      mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
      writeFileSync(dockPrefsPath(home), JSON.stringify({ enabled: true, preferred: 'gemini' }))

      await companion.setTrayDockPref({ providers: ['claude', 'codex'] })

      expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toMatchObject({
        providers: ['claude', 'codex'], preferred: 'claude', manualSelection: true,
      })
    })

    // Showing the rail is the Sidebar switch under another name, so it takes the same path
    // and keeps the rule that the rail cannot outlive the tray app.
    it('routes the show switch through the Sidebar rule', async () => {
      const companion = running()

      const prefs = await companion.setTrayDockPref({ enabled: false })

      expect(prefs.dock.enabled).toBe(false)
      expect((await companion.status()).sidebar).toBe(false)
    })

    it('writes launch at login to the Run value this app owns', async () => {
      const companion = running()

      await companion.setLaunchAtLogin(true)
      expect(regCalls).toEqual([runKeyArgs(true, TRAY_EXE)])

      await companion.setLaunchAtLogin(false)
      expect(regCalls[1]).toEqual(runKeyArgs(false, TRAY_EXE))
    })
  })

  // A machine with only the desktop app on it has no `codeburn` anywhere the tray app looks,
  // so the desktop app leaves it one and says where.
  describe('the CLI it leaves for the tray app', () => {
    const EXEC = 'C:\\Program Files\\CodeBurn\\CodeBurn.exe'
    let entry: string

    function withCli(overrides: Record<string, unknown> = {}) {
      return deps({
        execPath: EXEC,
        env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(sandbox, 'Local'), CODEBURN_BUNDLED_CLI: entry },
        ...overrides,
      })
    }

    beforeEach(() => {
      entry = join(sandbox, 'resources', 'cli', 'dist', 'launch.js')
      mkdirSync(join(sandbox, 'resources', 'cli', 'dist'), { recursive: true })
      writeFileSync(entry, '// the bundled CLI')
      present.add(entry)
    })

    it('writes the launcher and records it where an autostarted tray app will read it', async () => {
      stageMsi()
      // A key the tray app owns, which the record must not cost it.
      mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
      writeFileSync(join(home, '.config', 'codeburn', 'windows-settings.json'), JSON.stringify({ accent: 'green' }))

      await new MenubarCompanion(withCli()).bootstrap()

      const launcher = cliLauncherPath({ LOCALAPPDATA: join(sandbox, 'Local') }, home)
      expect(readFileSync(launcher, 'utf8')).toContain(`"${EXEC}" "${entry}" %*`)
      expect(readTrayFile('app', home)).toEqual({ accent: 'green', [TRAY_CLI_PATH_KEY]: launcher })
    })

    // Reading the file is what covers a login start; this is what covers the very first
    // launch, before the tray app has read anything at all.
    it('hands the launcher to every tray app it starts', async () => {
      stageMsi()
      const companion = new MenubarCompanion(withCli())

      await companion.bootstrap()
      await companion.setSidebarEnabled(false)

      const launcher = cliLauncherPath({ LOCALAPPDATA: join(sandbox, 'Local') }, home)
      expect(launches).toHaveLength(2)
      expect(launchEnvs).toEqual([{ [TRAY_CLI_ENV]: launcher }, { [TRAY_CLI_ENV]: launcher }])
    })

    it('leaves a CODEBURN_BIN of the person\'s own in charge', async () => {
      stageMsi()

      await new MenubarCompanion(withCli({
        env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: join(sandbox, 'Local'), CODEBURN_BUNDLED_CLI: entry, [TRAY_CLI_ENV]: 'D:\\Data\\Volta\\bin\\codeburn.cmd' },
      })).bootstrap()

      expect(launches).toHaveLength(1)
      expect(launchEnvs).toEqual([undefined])
    })

    it('leaves the switch off out of it: a login start needs the launcher either way', async () => {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: false, trayExePath: null, seeded: true })

      await new MenubarCompanion(withCli()).bootstrap()

      expect(launches).toEqual([])
      expect(readTrayFile('app', home)[TRAY_CLI_PATH_KEY])
        .toBe(cliLauncherPath({ LOCALAPPDATA: join(sandbox, 'Local') }, home))
    })

    it('writes nothing and records nothing in a build that carries no CLI', async () => {
      stageMsi()

      await new MenubarCompanion(deps({ execPath: EXEC })).bootstrap()

      expect(readTrayFile('app', home)).toEqual({})
      expect(launchEnvs).toEqual([undefined])
    })
  })

  // These four are registered as IPC handlers on every platform, and every one of them
  // reads or writes a file, or a registry value, that only a Windows tray app owns.
  describe('the tray preference methods where there is no tray app', () => {
    const NEUTRAL = { app: DEFAULT_TRAY_APP_PREFS, dock: DEFAULT_TRAY_DOCK_PREFS, launchAtLogin: false, launchAtLoginManaged: false }

    function unsupported(): MenubarCompanion {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
      existingRunKey = `"${TRAY_EXE}"`
      return new MenubarCompanion(deps({ platform: 'darwin' }))
    }

    it('trayPrefs reads no file and answers with the defaults', async () => {
      const companion = unsupported()
      mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
      writeFileSync(join(home, '.config', 'codeburn', 'windows-settings.json'), JSON.stringify({ metric: 'tokens' }))
      writeDockEnabled(true, home)

      expect(await companion.trayPrefs()).toEqual(NEUTRAL)
    })

    it('setTrayAppPref writes nothing', async () => {
      expect(await unsupported().setTrayAppPref({ metric: 'iconOnly' })).toEqual(NEUTRAL)
      expect(readTrayFile('app', home)).toEqual({})
      expect(launches).toEqual([])
    })

    it('setTrayDockPref writes nothing, and cannot reach the Sidebar switch either', async () => {
      const companion = unsupported()

      expect(await companion.setTrayDockPref({ scale: 1.1 })).toEqual(NEUTRAL)
      expect(await companion.setTrayDockPref({ enabled: false })).toEqual(NEUTRAL)

      expect(readDockEnabled(home)).toBeUndefined()
      expect((await companion.status()).sidebar).toBe(true)
      expect(launches).toEqual([])
    })

    it('setLaunchAtLogin runs no reg.exe', async () => {
      expect(await unsupported().setLaunchAtLogin(true)).toEqual(NEUTRAL)
      expect(regCalls).toEqual([])
    })

    it('status treats a leftover trayExePath as not installed, and never probes for the process', async () => {
      stageMsi()
      writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: true, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
      const isRunning = vi.fn(async () => true)
      const status = await new MenubarCompanion(deps({ platform: 'darwin', isRunning })).status()

      expect(status).toMatchObject({ supported: false, installed: false, running: false })
      expect(isRunning).not.toHaveBeenCalled()
    })
  })

  it('Sidebar off with the tray app off writes the preference and tells nobody', async () => {
    stageMsi()
    writeCompanionSettings(stateDir, { ...DEFAULT_COMPANION_SETTINGS, menuBar: false, sidebar: true, trayExePath: TRAY_EXE, seeded: true })
    writeDockEnabled(true, home)

    await new MenubarCompanion(deps()).setSidebarEnabled(false)

    expect(JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))).toEqual({ enabled: false })
    // Nothing is running to be told, and turning the rail off never starts the tray app.
    expect(launches).toEqual([])
    expect(cliCalls).toEqual([])
  })
})
