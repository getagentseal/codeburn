// The tray app and the Capacity Dock, as the desktop app owns them on Windows.
//
// The desktop app ships the matching `windows-v*` build of the Tauri tray app
// (windows/) and puts it on the machine itself, so nobody has to know that
// `codeburn menubar` exists. Two switches in the sidebar turn each surface off:
// "Menu bar" is the tray process, "Sidebar" is the dock rail the tray app
// draws. Both default on.
//
// Two routes, and they share almost nothing:
//
//   NSIS   the staged `CodeBurn.Menubar_<version>_x64_en-US.msi` is installed
//          through the CLI's own installer (src/menubar-installer.ts, reached
//          with `codeburn menubar --staged-msi <path>`). The MSI carries a fixed
//          WiX upgrade code, so a manual `codeburn menubar` install is upgraded
//          in place rather than duplicated, and a newer one is left alone.
//          Launch at login is an HKCU Run value.
//
//   AppX   msiexec is not available to a packaged app and would fight the
//          package manager anyway. The tray exe ships inside the package and
//          is launched from there; launch at login is the manifest's
//          windows.startupTask, so no Run value is written.
//
// The tray app is reached through its own argv: a second launch hands the
// running instance its arguments (windows/src-tauri/src/lib.rs), so `--quit`
// stops it and `--reload-settings` makes it re-read the dock preferences this
// module writes.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, uptime } from 'node:os'
import { join, win32 } from 'node:path'

import { spawnCliAction, type ActionResult } from './cli'
import {
  DEFAULT_TRAY_APP_PREFS, DEFAULT_TRAY_DOCK_PREFS,
  isPatchObject, normalizedPreferred, parseTrayAppPrefs, parseTrayDockPrefs, patchTrayFile,
  readTrayFile, sanitizeAppPatch, sanitizeDockPatch, writeFileAtomic,
  type TrayAppPrefs, type TrayDockPrefs,
} from './tray-settings'

/** How the staged file is named to the CLI's Windows installer: an option on the command
 *  rather than an environment variable, so nothing a stray variable in the environment names
 *  ever reaches msiexec. The source of truth is src/menubar-installer.ts, which rejects the
 *  variable this flag replaced. */
export const STAGED_MSI_FLAG = '--staged-msi'
/** Removes the installed tray app: the CLI reads the product code from its own install marker
 *  (or the uninstall registry) and runs `msiexec /x`. Lifted out of the desktop NSIS
 *  uninstaller so the Plugins card can offer a discrete Uninstall, the way macOS does. */
export const UNINSTALL_FLAG = '--uninstall'
/** One machine-readable line the same installer prints, so this side need not read its prose. */
export const BUNDLED_RESULT_PREFIX = 'CODEBURN_MENUBAR_RESULT '
/** The one line the installer prints for msiexec exit 3010, which its machine-readable result
 *  does not carry a field for. A deferred file replacement leaves the old binary in place, so
 *  this is read from the prose until the CLI reports it in {@link MenubarInstallResult}. */
const REBOOT_NOTICE = /Windows wants a restart to finish the install/i
/** The release asset name, which is also the only version statement that cannot lie. */
const MSI_PATTERN = /^CodeBurn\.Menubar_(.+)_x64_en-US\.msi$/
/** What the Tauri bundle names its executable. */
const TRAY_EXE = 'codeburn-menubar.exe'
/** The tray app's own Run value name, so the two never write a second copy of each other's. */
const RUN_VALUE = 'CodeBurn'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/** A `/passive` msiexec run waits on a UAC prompt, which is a person, not a process. */
const INSTALL_TIMEOUT_MS = 5 * 60_000
/** The env var the tray app honours before anything else it looks at (windows/src-tauri/src/cli.rs). */
export const TRAY_CLI_ENV = 'CODEBURN_BIN'
/** Where the desktop app records the launcher in the tray app's own settings file, so an
 *  autostarted tray app finds it with no desktop app running to tell it. */
export const TRAY_CLI_PATH_KEY = 'desktopCliPath'
/** Where main.ts points at the CLI copy shipped inside a packaged build. */
const BUNDLED_CLI_ENV = 'CODEBURN_BUNDLED_CLI'
/** The tray app's own data directory, which already holds its install marker. */
const COMPANION_DIR = 'codeburn-menubar'
/** A `.cmd`, because that is the one kind of script the tray app can start directly. */
const CLI_LAUNCHER_NAME = 'codeburn-cli.cmd'
/** How long a launch that follows a `--quit` waits for the old process to be gone. */
const QUIT_SETTLE_MS = 4_000

/** Mirrors BundledInstallResult in src/menubar-installer.ts. */
export type MenubarInstallResult = {
  action: 'installed' | 'up-to-date' | 'kept-newer' | 'cancelled' | 'uninstalled'
  bundledVersion: string
  previousVersion: string | null
  exePath: string
  uninstallString: string | null
  installedBy: 'desktop' | 'manual' | null
  /** Whether msiexec exited 3010 and deferred the file replacement to the next restart. The
   *  CLI does not report this field today, so it is read from the installer's own notice
   *  line instead; when the CLI starts sending it, this is what is believed. */
  rebootRequired?: boolean
}

/** The desktop app's own record of the two switches, in its userData directory. */
export type CompanionSettings = {
  menuBar: boolean
  sidebar: boolean
  /** Where the tray app ended up, so starting and stopping it costs no registry read. */
  trayExePath: string | null
  /** The tray app version the last install reported at `trayExePath`. A launch whose staged
   *  .msi carries that same version has nothing to install and nothing to ask, so it skips
   *  the probe entirely rather than spawning a CLI to be told so. */
  trayExeVersion: string | null
  /** The staged .msi version whose install was declined or failed. The same file put in
   *  front of the same person at the next launch is the same admin prompt, and answering it
   *  is their decision rather than something to re-ask until they give in. Cleared when a
   *  newer version is staged, or when they turn Menu bar on themselves. */
  installDeclinedVersion: string | null
  /** When an install left Windows a file replacement it can only finish at the next restart,
   *  as an ISO timestamp. Saved rather than kept in memory: restarting the desktop app is not
   *  the restart being waited for, and forgetting it there would start the old tray app under
   *  the new version name, which is what the flag exists to prevent. Cleared once the machine
   *  has booted since that moment. */
  restartRequiredSince: string | null
  /** False until the first launch has applied the defaults, which is what keeps a later
   *  manual "dock off" from being seeded back on at every launch. */
  seeded: boolean
}

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  menuBar: true,
  sidebar: true,
  trayExePath: null,
  trayExeVersion: null,
  installDeclinedVersion: null,
  restartRequiredSince: null,
  seeded: false,
}

export type MenubarDeps = {
  /** Where the packaged app keeps its extraResources, or null in a build that has none. */
  resourcesPath: string | null
  /** The desktop app's userData directory, which holds the companion settings file. */
  stateDir: string
  /** True inside an AppX package: no msiexec, no Run value, the exe ships with the package. */
  store: boolean
  platform: string
  env: NodeJS.ProcessEnv
  /** The desktop app's own executable, which is also the Node that runs the bundled CLI. */
  execPath?: string
  /** Injected so tests never spawn: the CLI action, a detached launch, and a `reg.exe` run. */
  runCli?: (args: string[], opts: { timeoutMs?: number; extraEnv?: NodeJS.ProcessEnv }) => Promise<ActionResult>
  launch?: (exePath: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => void
  runReg?: (args: string[]) => Promise<void>
  /** The tray app's existing Run value, or null when there is none. */
  readRunKey?: () => Promise<string | null>
  /** Whether the tray app has a process right now. Injected so tests never spawn. */
  isRunning?: () => Promise<boolean>
  /** Whether a path is on disk. Injected so the stale-path handling is testable. */
  exists?: (path: string) => boolean
  home?: string
  /** When Windows last started, in epoch milliseconds. Injected by tests so the pending
   *  restart boundary can be crossed without rebooting. */
  bootedAtMs?: () => number
}

// Where things are ----------------------------------------------------------------------------

/** The staged tray app: `resources/menubar` in a packaged build, `build/menubar` in dev. */
export function menubarResourcesDir(deps: Pick<MenubarDeps, 'resourcesPath'>): string {
  return deps.resourcesPath
    ? join(deps.resourcesPath, 'menubar')
    : join(__dirname, '..', '..', 'build', 'menubar')
}

/** The staged .msi and the version its name declares, or null when nothing was staged. */
export function findStagedMsi(dir: string): { path: string; version: string } | null {
  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  for (const name of names) {
    const version = MSI_PATTERN.exec(name)?.[1]
    if (version) return { path: join(dir, name), version }
  }
  return null
}

/** The tray executable shipped inside an AppX package, or null when it is not there. */
export function findPackagedTrayExe(dir: string): string | null {
  const exe = join(dir, TRAY_EXE)
  return existsSync(exe) ? exe : null
}

/** `~/.config/codeburn/windows-dock.json`, which is where the tray app's dock reads its
 *  preferences from before its page exists (windows/src-tauri/src/dock.rs). */
export function dockPrefsPath(home = homedir()): string {
  return join(home, '.config', 'codeburn', 'windows-dock.json')
}

function companionSettingsPath(stateDir: string): string {
  return join(stateDir, 'companion.v1.json')
}

// The CLI the tray app runs -----------------------------------------------------------------

// The tray app gets everything it shows by spawning `codeburn`, which it looks for on PATH
// and in the usual npm, pnpm, Volta, fnm, scoop and bun locations. Someone who installed only
// the desktop app never ran `npm install -g codeburn`, so there is nothing in any of them, and
// the tray app they were just given has no data to show.
//
// The desktop app has a CLI: the version-matched copy under `resources/cli`, which it runs
// through its own executable with `ELECTRON_RUN_AS_NODE=1` (app/electron/cli.ts). That is not
// something the tray app could spawn on its own, so this side writes a one-line `.cmd` that
// does it and forwards every argument, and records where it put it.
//
// A file rather than an environment variable because the tray app is also started at login, by
// a Run value or the package's startup task, with no desktop app anywhere to hand it an
// environment. The recorded path is consulted last (windows/src-tauri/src/cli.rs), so a real
// global install still wins.

/** `%LOCALAPPDATA%\codeburn-menubar`, the directory the tray app's install marker is in. */
export function companionDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const local = env.LOCALAPPDATA
  const base = local && win32.isAbsolute(local) ? local.replace(/[\\/]+$/, '') : join(home, 'AppData', 'Local')
  return join(base, COMPANION_DIR)
}

export function cliLauncherPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(companionDataDir(env, home), CLI_LAUNCHER_NAME)
}

/**
 * Anything `cmd.exe` would read rather than pass along. Both paths come from the app's own
 * install location, so this never fires in practice; it is here because the alternative to
 * failing is writing a batch file that means something other than what it says.
 */
const CMD_UNQUOTABLE = /["%\r\n]/

/** The launcher's contents. `%*` forwards the arguments verbatim, stdio is inherited, and
 *  the CLI's exit code becomes the launcher's. */
export function cliLauncherScript(execPath: string, entry: string): string | null {
  if (!execPath || !entry || CMD_UNQUOTABLE.test(execPath) || CMD_UNQUOTABLE.test(entry)) return null
  return [
    '@echo off',
    'rem Written by the CodeBurn desktop app, and rewritten at every one of its launches.',
    'rem It runs the CLI the desktop app carries, through the desktop app\'s own executable.',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${execPath}" "${entry}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

/**
 * Write the launcher and hand back its path, or null when there is nothing to point it at:
 * off Windows, or in a dev build, where `CODEBURN_BUNDLED_CLI` is unset because the repo's
 * own CLI is used instead and is already on the machine.
 */
export function writeCliLauncher(opts: {
  platform: string
  env: NodeJS.ProcessEnv
  home: string
  execPath: string
  exists?: (path: string) => boolean
}): string | null {
  if (opts.platform !== 'win32') return null
  const entry = opts.env[BUNDLED_CLI_ENV]
  const exists = opts.exists ?? existsSync
  if (!entry || !exists(entry)) return null
  const script = cliLauncherScript(opts.execPath, entry)
  if (!script) return null

  const path = cliLauncherPath(opts.env, opts.home)
  try {
    // Rewritten at every launch while an autostarted tray app may be reading it.
    writeFileAtomic(path, script)
    return path
  } catch (err) {
    console.error('the tray app could not be given a CLI to run:', err)
    return null
  }
}

// Settings -------------------------------------------------------------------------------------

export function readCompanionSettings(stateDir: string): CompanionSettings {
  try {
    // An unreadable file falls back to the defaults, which means seeding again: reinstalling
    // the tray app and re-enabling the rail. A byte order mark is not a good enough reason
    // for that, and anything that edits this file by hand on Windows tends to leave one.
    const text = readFileSync(companionSettingsPath(stateDir), 'utf8').replace(/^﻿/, '')
    const raw = JSON.parse(text) as Partial<CompanionSettings>
    return {
      menuBar: raw.menuBar ?? DEFAULT_COMPANION_SETTINGS.menuBar,
      sidebar: raw.sidebar ?? DEFAULT_COMPANION_SETTINGS.sidebar,
      trayExePath: typeof raw.trayExePath === 'string' ? raw.trayExePath : null,
      trayExeVersion: typeof raw.trayExeVersion === 'string' ? raw.trayExeVersion : null,
      installDeclinedVersion: typeof raw.installDeclinedVersion === 'string' ? raw.installDeclinedVersion : null,
      restartRequiredSince: typeof raw.restartRequiredSince === 'string' ? raw.restartRequiredSince : null,
      seeded: raw.seeded === true,
    }
  } catch {
    return { ...DEFAULT_COMPANION_SETTINGS }
  }
}

export function writeCompanionSettings(stateDir: string, settings: CompanionSettings): void {
  try {
    writeFileAtomic(companionSettingsPath(stateDir), `${JSON.stringify(settings, null, 2)}\n`)
  } catch (err) {
    console.error('companion settings could not be saved:', err)
  }
}

/** Whether the tray app already has an opinion about the rail, or undefined when nobody has
 *  said. The difference matters exactly once: a default is for a machine that has made no
 *  choice, never an override of one already made. */
export function readDockEnabled(home = homedir()): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(dockPrefsPath(home), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const enabled = (parsed as Record<string, unknown>).enabled
    return typeof enabled === 'boolean' ? enabled : undefined
  } catch {
    return undefined
  }
}

/** Read, change one key, write back. The tray app owns every other key in this file (the
 *  rail's placement, size and provider set), so the whole object is preserved. The cycle goes
 *  through {@link patchTrayFile} rather than being done here, because the tray app writes this
 *  same file: a read/modify/write outside the cross-process lock erases whatever the tray app
 *  stored between this side's read and its rename, which is the rail's placement more often
 *  than not. */
export function writeDockEnabled(enabled: boolean, home = homedir()): void {
  patchTrayFile('dock', { enabled }, home)
}

// Talking to the tray app ----------------------------------------------------------------------

/** The CLI's install path prints one JSON line; everything else it says is for a person. */
export function parseInstallResult(stdout: string): MenubarInstallResult | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(BUNDLED_RESULT_PREFIX)) continue
    try { return JSON.parse(line.slice(BUNDLED_RESULT_PREFIX.length)) as MenubarInstallResult } catch { return null }
  }
  return null
}

/** `reg.exe` argv for the tray app's launch-at-login value. The tray app's own toggle writes
 *  the same value name (windows/src-tauri/src/autostart.rs), so the two agree by construction
 *  instead of leaving two entries behind. */
export function runKeyArgs(enabled: boolean, exePath: string): string[] {
  return enabled
    ? ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exePath}"`, '/f']
    : ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']
}

/** `reg query <key> /v CodeBurn` prints the value on its own indented line. Null means the
 *  value is not there, which is the only thing the caller acts on. */
export function parseRunKeyValue(regOutput: string): string | null {
  const match = new RegExp(`^\\s+${RUN_VALUE}\\s{4}REG_\\w+\\s{4}(.*)$`, 'm').exec(regOutput)
  const value = match?.[1]?.trim()
  return value ? value : null
}

/** The executable a Run value points at: it is stored quoted, and only the file matters. */
export function runKeyTarget(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1')
}

/** Windows searches the current directory before PATH, so `reg` by bare name lets anything
 *  dropped beside the app impersonate it. Same rule as src/menubar-installer.ts. */
export function system32Path(exe: string, env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\${exe}`
}

function detachedLaunch(exePath: string, args: string[], extraEnv?: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    })
    child.on('error', err => console.error(`could not launch ${exePath}: ${err.message}`))
    child.unref()
  } catch (err) {
    console.error(`could not launch ${exePath}:`, err)
  }
}

function regRun(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise(resolve => {
    const child = spawn(system32Path('reg.exe', env), args, { stdio: 'ignore', windowsHide: true })
    // Deleting a value that is not there is the state we wanted anyway, so no exit code is
    // read: a failure here must never stop a toggle the person just flipped.
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
}

/** `tasklist` filtered to the tray exe prints its name when it is running and a "No tasks"
 *  line when it is not. Anything going wrong reads as not running, which only shortens a wait. */
function trayHasProcess(env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(system32Path('tasklist.exe', env), ['/FI', `IMAGENAME eq ${TRAY_EXE}`, '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', () => resolve(false))
      child.on('close', () => resolve(out.toLowerCase().includes(TRAY_EXE)))
    } catch {
      resolve(false)
    }
  })
}

function regQueryRunValue(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(system32Path('reg.exe', env), ['query', RUN_KEY, '/v', RUN_VALUE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', () => resolve(null))
    // reg exits non-zero for a value that is not there, which is the answer rather than a
    // failure; anything else that goes wrong reads the same way, and the only cost of
    // guessing "absent" is one write of a value that already said the same thing.
    child.on('close', code => resolve(code === 0 ? parseRunKeyValue(out) : null))
  })
}

// The controller ---------------------------------------------------------------------------------

/** What the two tray panes in the desktop app's Settings render from. */
export type TrayPrefs = {
  app: TrayAppPrefs
  dock: TrayDockPrefs
  launchAtLogin: boolean
  /**
   * True where launch at login is not this app's to set. The Store package declares it as a
   * `windows.startupTask` (app/build/appx-extensions.xml) and Windows owns both the state and
   * the switch, in Settings > Apps > Startup. Reaching a startup task from here would take
   * the WinRT `Windows.ApplicationModel.StartupTask` API, which Electron has no binding for
   * and which this app ships no native code to reach; and a Run value written beside the
   * startup task would start the tray app twice. So the pane names the owner and points at
   * that page rather than offering a switch that moves nothing.
   */
  launchAtLoginManaged: boolean
}

/** The Windows Settings page listing every startup app, the Store package's own included.
 *  Named here because the desktop app's external-open guard allows it by exact value. */
export const STARTUP_APPS_SETTINGS_URL = 'ms-settings:startupapps'

/**
 * What the four tray-preference methods answer where there is no tray app. Every one of them
 * reads or writes `~/.config/codeburn/windows-*.json` or `reg.exe`, all of which belong to a
 * Windows tray app that a macOS or Linux build has never installed; their IPC handlers are
 * registered on every platform, so the guard has to be here rather than at the call site.
 * The defaults are what the same files parse to when they are not there, so a pane rendering
 * this shows the same thing it would on a Windows machine with nothing written yet.
 */
export function unsupportedTrayPrefs(): TrayPrefs {
  return {
    app: { ...DEFAULT_TRAY_APP_PREFS },
    dock: { ...DEFAULT_TRAY_DOCK_PREFS },
    launchAtLogin: false,
    launchAtLoginManaged: false,
  }
}

export type CompanionStatus = {
  /** False on every platform but Windows, and on a Windows build with nothing staged. */
  supported: boolean
  menuBar: boolean
  sidebar: boolean
  /** The Store route, where launch at login is the package's own startup task. */
  store: boolean
  /** True when this run installed a tray app that Windows can only finish putting in place
   *  at the next restart. Nothing is started until then, so the switches say why rather than
   *  looking on with nothing running. Absent on a preload that predates it. */
  restartRequired?: boolean
  // The fields below mirror MacMenubarStatus so the Plugins card can render one companion card
  // per platform. All reflect on-disk truth, never intent.
  /** False on the Store route (install and removal are the package's, not msiexec's). */
  canInstall: boolean
  /** A tray app is on the machine (NSIS: the recorded exe is on disk; Store: the packaged exe). */
  installed: boolean
  /** The tray process is up right now. */
  running: boolean
  /** The installed tray app's version, or null when nothing is installed. */
  version: string | null
  /** A newer tray app is staged in this build than the one installed, so the card offers Update. */
  outdated: boolean
}

/** The shape the discrete actions (install, quit, uninstall) return: the outcome plus the
 *  status that followed, so the card renders what took rather than what was asked. Mirrors
 *  MacMenubarInstall. `error` is null on success, else a short reason (the card falls back to a
 *  localized message when it is null). */
export type CompanionActionResult = { ok: boolean; error: string | null; status: CompanionStatus }

/** True when `candidate` is a higher version than `installed`. Any unparseable component sorts
 *  low, so a `dev` build never reads as newer than a real one. Lights the Update affordance
 *  only; the CLI installer owns the real never-downgrade decision. */
export function isNewerVersion(candidate: string | null, installed: string | null): boolean {
  if (!candidate) return false
  if (!installed) return true
  // A missing component is 0 (so "1.2" == "1.2.0"); an unparseable one (a `dev` build) sorts
  // below every real number, so a dev build never reads as newer than a release, and a real
  // staged release does read as newer than a dev build already installed.
  const norm = (part: string | undefined): number => {
    if (part === undefined) return 0
    const n = Number.parseInt(part, 10)
    return Number.isNaN(n) ? -1 : n
  }
  const a = candidate.split('.')
  const b = installed.split('.')
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = norm(a[i])
    const y = norm(b[i])
    if (x !== y) return x > y
  }
  return false
}

export class MenubarCompanion {
  private settings: CompanionSettings
  /** When `--quit` was last sent, so a launch right after it can wait for the exit. */
  private quitAskedAt = 0
  /** Set by an install msiexec could only half apply; see {@link MenubarCompanion.launchTray}.
   *  Read from the saved timestamp rather than a field, so quitting the desktop app and
   *  opening it again is not mistaken for the Windows restart that actually finishes the
   *  install. It clears itself once the machine has booted since the install. */
  private get restartRequired(): boolean {
    const since = this.settings.restartRequiredSince
    if (!since) return false
    const at = Date.parse(since)
    // An unreadable timestamp counts as still pending: not launching is the safe side, since
    // the worst it costs is a tray app that starts one session late.
    if (Number.isNaN(at)) return true
    if (this.bootedAtMs() > at) {
      this.save({ restartRequiredSince: null })
      return false
    }
    return true
  }

  /** When Windows last started, which is what tells a finished file replacement from one
   *  still pending. Injectable so the boundary is testable without rebooting. */
  private bootedAtMs(): number {
    return this.deps.bootedAtMs?.() ?? Date.now() - uptime() * 1000
  }
  /** The launcher written for the tray app this run, or null when there is no bundled CLI
   *  to point one at. Handed to every tray app this side starts. */
  private cliLauncher: string | null = null

  constructor(private readonly deps: MenubarDeps) {
    this.settings = readCompanionSettings(deps.stateDir)
  }

  private get home(): string { return this.deps.home ?? homedir() }
  private get launch(): (exe: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => void {
    return this.deps.launch ?? detachedLaunch
  }

  /**
   * What a tray app started from here inherits. The recorded path in the settings file is
   * what an autostarted tray app reads, and it is read after PATH; this makes the very first
   * launch work too, before the tray app has read anything at all. A CODEBURN_BIN of the
   * person's own is left to reach the tray app as it is.
   */
  private launchEnv(): NodeJS.ProcessEnv | undefined {
    return this.cliLauncher && !this.deps.env[TRAY_CLI_ENV] ? { [TRAY_CLI_ENV]: this.cliLauncher } : undefined
  }

  /**
   * Start the tray app, or say nothing at all when a restart is owed.
   *
   * An install that could not replace a running binary is finished by Windows at the next
   * restart, and until then the file at that path is the previous tray app. Starting it would
   * put the old one in the notification area under the new version's name, which is the exact
   * confusion the install path takes trouble to avoid elsewhere. Stopping one is still fine,
   * so `--quit` does not come through here.
   */
  private launchTray(exePath: string): void {
    if (this.restartRequired) return
    this.launch(exePath, ['--reload-settings'], this.launchEnv())
  }

  /**
   * Rewrite the launcher and record where it is. Runs at every bootstrap, so a desktop app
   * that has been updated points the tray app at its new copy of the CLI rather than at the
   * one the previous version installed.
   */
  private refreshCliLauncher(): void {
    this.cliLauncher = writeCliLauncher({
      platform: this.deps.platform,
      env: this.deps.env,
      home: this.home,
      execPath: this.deps.execPath ?? process.execPath,
      exists: this.exists,
    })
    if (!this.cliLauncher) return
    try {
      patchTrayFile('app', { [TRAY_CLI_PATH_KEY]: this.cliLauncher }, this.home)
    } catch (err) {
      console.error('the tray app could not be told where its CLI is:', err)
    }
  }
  private get isRunning(): () => Promise<boolean> {
    return this.deps.isRunning ?? (() => trayHasProcess(this.deps.env))
  }

  /**
   * A `--quit` takes the tray app a moment to act on, and a launch that arrives while the old
   * process is still on its way out hands its request to that process (its single-instance
   * window is still there) and exits with it, leaving the switch on and nothing running. So a
   * launch that follows a quit waits for the process to be gone first, within reason.
   */
  private async awaitQuit(): Promise<void> {
    if (Date.now() - this.quitAskedAt > QUIT_SETTLE_MS) return
    const deadline = Date.now() + QUIT_SETTLE_MS
    while (Date.now() < deadline && await this.isRunning()) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  private get runCli() { return this.deps.runCli ?? spawnCliAction }
  private runReg(args: string[]): Promise<void> {
    return this.deps.runReg ? this.deps.runReg(args) : regRun(args, this.deps.env)
  }

  /** Windows only, and only where a tray app was actually staged into the build. */
  supported(): boolean {
    if (this.deps.platform !== 'win32') return false
    const dir = menubarResourcesDir(this.deps)
    return this.deps.store ? findPackagedTrayExe(dir) !== null : findStagedMsi(dir) !== null
  }

  async status(): Promise<CompanionStatus> {
    const supported = this.supported()
    const store = this.deps.store
    const installedExe = store
      ? findPackagedTrayExe(menubarResourcesDir(this.deps))
      : (this.settings.trayExePath && this.exists(this.settings.trayExePath) ? this.settings.trayExePath : null)
    const installed = supported && installedExe !== null
    const staged = supported && !store ? findStagedMsi(menubarResourcesDir(this.deps)) : null
    return {
      supported,
      menuBar: this.settings.menuBar,
      sidebar: this.settings.sidebar,
      store,
      restartRequired: this.restartRequired,
      canInstall: supported && !store,
      installed,
      running: installed ? await this.isRunning() : false,
      version: installed ? this.settings.trayExeVersion : null,
      outdated: installed && !store ? isNewerVersion(staged?.version ?? null, this.settings.trayExeVersion) : false,
    }
  }

  private save(patch: Partial<CompanionSettings>): void {
    this.settings = { ...this.settings, ...patch }
    writeCompanionSettings(this.deps.stateDir, this.settings)
  }

  /**
   * Put the tray app on the machine and bring both surfaces in line with the switches. Runs
   * at every launch, which is also what covers a desktop-app update: the staged .msi moves
   * with the app, and the installer decides for itself whether it is newer than what is
   * installed. The install itself is not re-run at every launch; see
   * {@link MenubarCompanion.installIfNeeded}.
   */
  async bootstrap(): Promise<void> {
    if (!this.supported()) return

    // Before anything else, and whether or not the switch is on: a tray app started at the
    // next login has to find a CLI without this process being there to tell it.
    this.refreshCliLauncher()

    // The defaults are seeded once, and only onto a machine that has made no choice. A tray
    // app someone installed by hand has preferences of its own, and a default that overrode
    // them would be this app deciding something the person already decided.
    const firstRun = !this.settings.seeded
    const existingDock = firstRun ? readDockEnabled(this.home) : undefined
    if (firstRun) {
      // An existing rail preference is mirrored into the switch rather than overwritten, so
      // the corner opens saying what the rail is actually doing.
      this.save({ seeded: true, ...(existingDock === undefined ? {} : { sidebar: existingDock }) })
    }

    if (!this.settings.menuBar) return

    const exePath = this.deps.store
      ? findPackagedTrayExe(menubarResourcesDir(this.deps))
      : await this.installIfNeeded()
    if (!exePath) return
    if (!this.exists(exePath)) {
      // Storing a path to nothing is what made the switches send arguments into the void.
      console.error(`the tray app was reported at ${exePath}, which is not there`)
      return
    }
    this.save({ trayExePath: exePath })

    if (firstRun && existingDock === undefined && this.settings.sidebar) this.applyDockSetting(true)
    // A tray app this launch just put on the machine has no Run value yet: the previous
    // one's uninstall took it, and that was the installer's doing, not the person's choice.
    await this.reconcileRunKey(firstRun || this.placedTray)
    this.placedTray = false
    this.launchTray(exePath)
  }

  /** True between an install that placed a tray app and the seeding that follows it. */
  private placedTray = false

  /**
   * Launch at login, without overriding a choice. An existing Run value was written by the
   * tray app's own toggle or by an earlier launch of this one, so it is left alone; only a
   * first run, or a tray app freshly installed by this launch, seeds one. The exception is a
   * value pointing at a file that is not there, which is not a preference but the old wrong
   * path, and would fail silently at every login.
   */
  private async reconcileRunKey(seed: boolean): Promise<void> {
    const existing = await this.existingRunKey()
    if (existing === null) {
      if (seed) await this.setRunKey(true)
      return
    }
    if (!this.exists(runKeyTarget(existing))) await this.setRunKey(true)
  }

  private existingRunKey(): Promise<string | null> {
    if (this.deps.readRunKey) return this.deps.readRunKey()
    // The Store route has no Run value at all, so there is nothing to ask about.
    return this.deps.store ? Promise.resolve(null) : regQueryRunValue(this.deps.env)
  }

  private get exists(): (path: string) => boolean {
    return this.deps.exists ?? existsSync
  }

  /**
   * Where the tray app actually is, checked rather than remembered. A stored path can be
   * wrong: written by a build that derived the binary name from the product name, or left
   * behind by a tray app that has since been uninstalled. Re-resolving costs one
   * `codeburn menubar`, which re-reads the registry and installs nothing when the version
   * already matches.
   */
  private async resolveTrayExe(): Promise<string | null> {
    if (this.deps.store) return findPackagedTrayExe(menubarResourcesDir(this.deps))
    const stored = this.settings.trayExePath
    if (stored && this.exists(stored)) return stored
    const resolved = await this.installIfNeeded()
    return resolved && this.exists(resolved) ? resolved : null
  }

  /**
   * The install, minus the launches that have nothing to install.
   *
   * `codeburn menubar` is not free and it is not quiet: a real install runs msiexec
   * `/passive`, which puts an admin prompt in front of the person. Two launches are skipped
   * outright:
   *
   *   - the tray app recorded on this machine is already the version this build stages, and
   *     it is still on disk, so the CLI would read the registry and answer "up to date";
   *   - this exact staged version was already declined or failed. Putting the same prompt up
   *     again at every launch is asking the same question until the answer changes, and the
   *     first answer was theirs to give.
   *
   * A newer staged version is a different question and is always asked. So is the Menu bar
   * switch going on by hand, which clears the record before it gets here.
   */
  private async installIfNeeded(): Promise<string | null> {
    const staged = findStagedMsi(menubarResourcesDir(this.deps))
    if (!staged) return null

    const stored = this.settings.trayExePath
    if (stored && this.settings.trayExeVersion === staged.version && this.exists(stored)) return stored
    if (this.settings.installDeclinedVersion === staged.version) return stored

    return this.installStaged(staged)
  }

  /** The install itself belongs to the CLI: it owns the registry read, the checksum, the
   *  msiexec call and the never-downgrade rule, and this side only stages the file and
   *  records what came back. `force` reinstalls over a matching version (the Reinstall path),
   *  which the CLI would otherwise report as up to date. */
  private async installStaged(staged: { path: string; version: string }, force = false): Promise<string | null> {
    const result = await this.runCli(['menubar', STAGED_MSI_FLAG, staged.path, ...(force ? ['--force'] : [])], {
      timeoutMs: INSTALL_TIMEOUT_MS,
    })
    const parsed = parseInstallResult(result.stdout)
    if (!parsed) {
      console.error(`menubar install did not report a result: ${result.stderr.trim() || `exit ${String(result.code)}`}`)
      // Not remembered as a refusal. Nothing was put in front of anyone here: the spawn timed
      // out, the CLI was not there, or it died before it could say anything, and all three are
      // the kind of thing that comes right on its own. Writing the version down would turn one
      // bad launch into a tray app that is never installed again.
      // A failed install must not orphan a working tray app that was already there.
      return this.settings.trayExePath
    }
    if (parsed.action === 'cancelled') {
      // This one is a decision, and it was theirs. The same file put in front of the same
      // person at the next launch is the same admin prompt, so it is not offered again until
      // a newer version is staged or they turn the switch on themselves.
      this.save({ installDeclinedVersion: staged.version })
      return null
    }
    // Windows Installer does not fail on a file that is in use: it installs what it can and
    // leaves the rest to the next restart. The uninstall registry then reports the new
    // version while the binary on disk is still the old one, so launching it would start the
    // old tray app under the new version's name. Nothing is launched until the restart.
    if (parsed.rebootRequired === true || REBOOT_NOTICE.test(result.stdout)) {
      this.save({ restartRequiredSince: new Date().toISOString() })
      console.log('CodeBurn Menubar was installed; Windows needs a restart to finish it.')
    }
    const exePath = parsed.exePath || this.settings.trayExePath
    this.placedTray = parsed.action === 'installed'
    this.save({
      installDeclinedVersion: null,
      // What is actually on disk now, which is the staged version except under
      // 'kept-newer', where a newer tray app was left alone.
      trayExeVersion: exePath ? (parsed.action === 'kept-newer' ? parsed.previousVersion : staged.version) : null,
    })
    return exePath
  }

  /**
   * Menu bar off stops the process and drops the Run value; on installs if it has to, then
   * starts it again.
   *
   * The rail is a window of the tray app, so it cannot outlive it: turning Menu bar off turns
   * Sidebar off with it. The preference is written before the process is asked to quit, so
   * what the tray app finds the next time it starts is the state the switches are showing,
   * rather than a rail that comes back on its own.
   */
  async setMenuBarEnabled(enabled: boolean): Promise<CompanionStatus> {
    this.save({ menuBar: enabled })
    if (!this.supported()) return this.status()

    if (!enabled) {
      this.save({ sidebar: false })
      this.applyDockSetting(false)
      await this.setRunKey(false)
      const exePath = this.settings.trayExePath
      if (exePath && this.exists(exePath)) {
        this.launch(exePath, ['--quit'])
        this.quitAskedAt = Date.now()
      }
      return this.status()
    }

    // Turning the switch on by hand is the retry: an install that was declined or failed is
    // offered again, because this time they asked for it rather than being asked.
    this.save({ installDeclinedVersion: null })
    const exePath = await this.resolveTrayExe()
    if (!exePath) {
      // Nothing to turn on. The switch says so rather than claiming a tray app that is not
      // there, and Sidebar cannot be on without one either.
      this.save({ menuBar: false })
      return this.status()
    }
    this.save({ trayExePath: exePath })
    await this.setRunKey(true)
    await this.awaitQuit()
    this.launchTray(exePath)
    return this.status()
  }

  /**
   * The rail is a window of the tray app and every setting it reads belongs to the tray app,
   * so there is no rail without one. Turning Sidebar on with Menu bar off turns Menu bar on
   * first, installing and starting the tray app if it has to; if that cannot be done there is
   * nothing to show a rail in, and the switch stays off.
   */
  async setSidebarEnabled(enabled: boolean): Promise<CompanionStatus> {
    if (!this.supported()) {
      this.save({ sidebar: enabled })
      return this.status()
    }

    if (enabled && !this.settings.menuBar) {
      await this.setMenuBarEnabled(true)
      if (!this.settings.menuBar) return this.status()
    }

    this.save({ sidebar: enabled })
    this.applyDockSetting(enabled)
    if (!this.settings.menuBar) return this.status()
    // The file is written either way; this only decides whether a running rail hears about
    // it now or at the next launch, so a tray app that cannot be found is not worth an
    // install here.
    const exePath = await this.resolveTrayExe()
    if (exePath) {
      this.save({ trayExePath: exePath })
      this.launchTray(exePath)
    }
    return this.status()
  }

  // Discrete actions for the Plugins card ---------------------------------------------------
  //
  // These mirror the macOS card's install / open / quit / uninstall so both platforms configure
  // the companion the same way. They are the on-demand counterparts of bootstrap: where the
  // toggles couple install with launch-at-login and the dock, these do one thing each.

  /**
   * Install or reinstall the tray app now (the card's Install / Update / Reinstall button).
   * Unlike bootstrap this always asks: the declined-version memory is cleared first, and an
   * existing install is replaced with `--force` rather than reported as up to date. Turns Menu
   * bar on and seeds launch-at-login, the way the switch going on does.
   */
  async install(): Promise<CompanionActionResult> {
    if (!this.supported() || this.deps.store) return { ok: false, error: null, status: await this.status() }
    const staged = findStagedMsi(menubarResourcesDir(this.deps))
    if (!staged) return { ok: false, error: null, status: await this.status() }
    this.save({ installDeclinedVersion: null })
    const already = Boolean(this.settings.trayExePath && this.exists(this.settings.trayExePath))
    const exePath = await this.installStaged(staged, already)
    if (!exePath || !this.exists(exePath)) {
      // A cancelled elevation prompt is the person's own decision, not a failure: installStaged
      // records the declined version, and this leaves the card as it was (still offering Install)
      // with no error banner, the way the sidebar switch used to treat a cancelled install.
      const cancelled = this.settings.installDeclinedVersion === staged.version
      return { ok: cancelled, error: null, status: await this.status() }
    }
    this.save({ menuBar: true, trayExePath: exePath })
    await this.setRunKey(true)
    await this.awaitQuit()
    this.launchTray(exePath)
    return { ok: true, error: null, status: await this.status() }
  }

  /**
   * Bring the tray UI forward. The tray app has no main window; a launch with no arguments is
   * its "show the popover" (windows/src-tauri/src/lib.rs), handed to the running instance by
   * the single-instance plugin. Nothing to open while a restart is owed or nothing is on disk.
   */
  async open(): Promise<CompanionStatus> {
    if (this.supported() && !this.restartRequired) {
      const exePath = this.settings.trayExePath
      if (exePath && this.exists(exePath)) this.launch(exePath, [], this.launchEnv())
    }
    return this.status()
  }

  /**
   * Stop the tray process without uninstalling it or turning the switch off: the Menu bar
   * setting and the Run value stay, so it comes back at the next login (and the card offers
   * Open meanwhile). Distinct from `setMenuBarEnabled(false)`, which also drops the Run value
   * and the dock.
   */
  async quit(): Promise<CompanionActionResult> {
    if (!this.supported()) return { ok: false, error: null, status: await this.status() }
    const exePath = this.settings.trayExePath
    if (!exePath || !this.exists(exePath) || !(await this.isRunning())) {
      return { ok: true, error: null, status: await this.status() }
    }
    this.launch(exePath, ['--quit'])
    this.quitAskedAt = Date.now()
    await this.awaitQuit()
    const running = await this.isRunning()
    return { ok: !running, error: null, status: await this.status() }
  }

  /**
   * Remove the tray app from the machine: quit it, then hand the CLI `menubar --uninstall`,
   * which reads the product code from the install marker (or the uninstall registry) and runs
   * `msiexec /x`. Drops the Run value and clears the recorded path so the card returns to its
   * uninstalled state. Store builds cannot uninstall from here (the package owns it).
   */
  async uninstall(): Promise<CompanionActionResult> {
    if (!this.supported() || this.deps.store) return { ok: false, error: null, status: await this.status() }
    const exePath = this.settings.trayExePath
    if (exePath && this.exists(exePath) && await this.isRunning()) {
      this.launch(exePath, ['--quit'])
      this.quitAskedAt = Date.now()
      await this.awaitQuit()
    }
    const result = await this.runCli(['menubar', UNINSTALL_FLAG], { timeoutMs: INSTALL_TIMEOUT_MS })
    const parsed = parseInstallResult(result.stdout)
    const ok = parsed ? parsed.action === 'uninstalled' : result.code === 0
    // Only forget the tray app once it is actually gone. An uninstall that failed (msiexec
    // errored, or the product code could not be read) leaves it installed on disk, so dropping
    // the Run value and the recorded path would orphan a working tray app and wrongly show the
    // card as uninstalled. The same rule installStaged follows for a failed install.
    if (ok) {
      await this.setRunKey(false)
      this.save({ menuBar: false, sidebar: false, trayExePath: null, trayExeVersion: null, installDeclinedVersion: null })
    }
    return { ok, error: null, status: await this.status() }
  }

  /** The card's Capacity Dock toggle, named to match the macOS card; the same path as the
   *  Sidebar switch, so the rail still cannot outlive the tray app. */
  setDockEnabled(enabled: boolean): Promise<CompanionStatus> {
    return this.setSidebarEnabled(enabled)
  }

  // The tray app's own settings ------------------------------------------------------------

  /** Everything the two tray panes render from, read straight out of the files the tray app
   *  reads them from, so the panes and the tray app can never be showing different answers. */
  async trayPrefs(): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    return {
      app: parseTrayAppPrefs(readTrayFile('app', this.home)),
      dock: parseTrayDockPrefs(readTrayFile('dock', this.home)),
      // On the Store route there is no Run value and no way to ask Windows about the
      // package's startup task, so this is not a state to render: `launchAtLoginManaged`
      // is what the pane goes by there.
      launchAtLogin: (await this.existingRunKey()) !== null,
      launchAtLoginManaged: this.deps.store,
    }
  }

  /** A setting the tray app keeps in `windows-settings.json`. Every other key in that file
   *  is left alone, and the running tray app is told to re-read it. */
  async setTrayAppPref(patch: unknown): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    const clean = sanitizeAppPatch(patch)
    if (Object.keys(clean).length > 0) {
      try {
        patchTrayFile('app', clean, this.home)
        await this.nudgeTray()
      } catch (err) {
        console.error('tray settings could not be saved:', err)
      }
    }
    return this.trayPrefs()
  }

  /**
   * A Capacity Dock setting. `enabled` is the Sidebar switch under another name, so it goes
   * through the same path and keeps the rule that the rail cannot outlive the tray app.
   * A provider set that no longer holds the resting provider moves it, as the rail would.
   */
  async setTrayDockPref(patch: unknown): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    // The `in` below is the first thing that reads the argument, and it reaches here straight
    // off an IPC message, so what it is has to be settled before it is asked about a key.
    if (!isPatchObject(patch)) return this.trayPrefs()
    if ('enabled' in patch) {
      await this.setSidebarEnabled(patch.enabled === true)
      return this.trayPrefs()
    }
    const clean = sanitizeDockPatch(patch)
    if (Object.keys(clean).length > 0) {
      try {
        if (Array.isArray(clean.providers)) {
          const current = parseTrayDockPrefs(readTrayFile('dock', this.home))
          clean.preferred = normalizedPreferred(current.preferred, clean.providers as string[])
        }
        patchTrayFile('dock', clean, this.home)
        await this.nudgeTray()
      } catch (err) {
        console.error('Capacity Dock settings could not be saved:', err)
      }
    }
    return this.trayPrefs()
  }

  /** Launch at login is the one tray setting that is not in a file: it is the Run value, and
   *  this app owns it, so the pane writes it here rather than through the tray app. Not on
   *  the Store route, where Windows owns it: see {@link TrayPrefs.launchAtLoginManaged}. */
  async setLaunchAtLogin(enabled: boolean): Promise<TrayPrefs> {
    if (!this.supported()) return unsupportedTrayPrefs()
    if (!this.deps.store) await this.setRunKey(enabled)
    return this.trayPrefs()
  }

  /** Makes a running tray app re-read both preference files and repaint. Nothing to do when
   *  the switch is off or the executable is not there; the files are read at the next start. */
  private async nudgeTray(): Promise<void> {
    if (!this.settings.menuBar) return
    const exePath = this.settings.trayExePath
    if (exePath && this.exists(exePath)) this.launchTray(exePath)
  }

  private applyDockSetting(enabled: boolean): void {
    try {
      writeDockEnabled(enabled, this.home)
    } catch (err) {
      console.error('Capacity Dock preference could not be saved:', err)
    }
  }

  /** One Run value for the tray app, owned here. The Store route has the manifest's own
   *  startup task instead, and writing a Run value beside it would start it twice. */
  private async setRunKey(enabled: boolean): Promise<void> {
    if (this.deps.store) return
    const exePath = this.settings.trayExePath
    if (enabled && !exePath) return
    await this.runReg(runKeyArgs(enabled, exePath ?? ''))
  }
}
