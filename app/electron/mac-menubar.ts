// The macOS menubar app (mac/, CodeBurnMenubar.app) as seen from the desktop app's Plugins
// page. Nothing here downloads anything: the install is `codeburn menubar`, the same command
// a person runs by hand (src/menubar-installer.ts), which already pins the release to the
// CLI's own version, verifies the checksum and the bundle id, clears quarantine, quits an old
// copy and launches the new one. This module only looks at the result and reports it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { persistedPathFile } from './cli'
import type { ActionResult } from './cli'

/** Set by mac/Scripts/package-app.sh, checked by the CLI installer before it moves anything. */
export const MENUBAR_BUNDLE_ID = 'org.agentseal.codeburn-menubar'
export const MENUBAR_BUNDLE_NAME = 'CodeBurnMenubar.app'
/** CapacityDockPreferences.enabledKey, in the bundle id's own defaults domain. */
export const DOCK_ENABLED_KEY = 'CodeBurnCapacityDockEnabled'
/** The one key the menubar app watches for a quit or uninstall it has to carry out itself:
 *  only it can drop its own login item (SMAppService speaks for the calling app alone). An
 *  older menubar that does not watch the key is killed instead, which is what the CLI's own
 *  installer already does before it replaces a bundle. */
export const REMOTE_COMMAND_KEY = 'CodeBurnMenubarRemoteCommand'
/** What the card says when a menubar was asked to go and never answered. */
export const NO_ANSWER = 'The menu bar app did not respond. Update it and try again.'

/** The steps of an install worth naming while a person waits ~30s for it. */
export type InstallPhase = 'Downloading' | 'Verifying' | 'Installing' | 'Starting'

/**
 * The CLI narrates its own install on stdout (src/menubar-installer.ts). Reading those lines
 * beats inventing a second progress protocol, and a line this does not know simply keeps the
 * phase where it was. The order below is the order they are printed, so the phase only moves
 * forwards.
 */
export function installPhase(line: string): InstallPhase | null {
  if (/^Downloading /.test(line)) return 'Downloading'
  if (/^Verifying checksum/.test(line)) return 'Verifying'
  if (/^Unpacking/.test(line) || /^Verifying app bundle/.test(line)) return 'Installing'
  if (/^Launching /.test(line)) return 'Starting'
  return null
}
/** How long the app is given to answer a quit or uninstall. Nothing is signalled after it:
 *  a menubar that cannot be asked is one the card refuses to drive at all (see OLDEST_ASKABLE). */
const EXIT_TIMEOUT_MS = 5000
const EXIT_POLL_MS = 250

/**
 * The first menubar version that watches its own defaults: it acts on a Capacity Dock change
 * made from outside and answers the quit and uninstall requests. Anything older cannot be
 * driven from here at all, so the card offers an update instead of switches that do nothing.
 * The release these ship in, compared against literally: a dev desktop built at 0.9.24 must
 * still treat a published 0.9.24 menubar as too old, so this never reads the desktop version.
 */
export const OLDEST_ASKABLE = '0.9.25'

/** Numeric-component compare, with anything unparseable (a `dev` build) sorting oldest. */
export function isOlderThan(version: string | null, floor: string): boolean {
  if (!version) return true
  const parts = (v: string) => v.replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10))
  const a = parts(version)
  const b = parts(floor)
  if (a.some(Number.isNaN)) return true
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left < right
  }
  return false
}

/** Where a person is told to get it when this build may not download executables. */
export const MENUBAR_WEBSITE = 'https://github.com/getagentseal/codeburn/releases'

export type MacMenubarStatus = {
  /** False off darwin, which is the whole card's render condition. */
  supported: boolean
  /** False in a Mac App Store build, where downloading an executable is not allowed. */
  canInstall: boolean
  installed: boolean
  path: string | null
  version: string | null
  running: boolean
  /** The Capacity Dock switch. False when nothing is installed to have one. */
  dock: boolean
  /** True for a menubar that predates {@link OLDEST_ASKABLE}: the card offers Update and
   *  disables the switch, Quit and Uninstall rather than pretending they work. */
  outdated: boolean
}

export type MacMenubarDeps = {
  platform: string
  /** `process.mas` is true only inside a Mac App Store build. */
  mas: boolean
  home?: string
  runCli?: (args: string[], opts?: { timeoutMs?: number; onStdout?: (chunk: string) => void }) => Promise<ActionResult>
  /** Named steps of a running install, pushed to the card so a 30-second wait says something. */
  onPhase?: (phase: InstallPhase) => void
  /** The desktop app's own executable, which is also the Node that runs the CLI it carries. */
  execPath?: string
  /** `resources/cli/dist/launch.js` in a packaged build, absent in dev. */
  bundledCli?: string
  /** Where the launcher is written. The desktop app's userData directory. */
  stateDir?: string
  /** Injected so tests never spawn. Resolves stdout, or null when the command failed. */
  run?: (command: string, args: string[]) => Promise<string | null>
  /** Injected so a test can cross the exit timeout without waiting it out. */
  now?: () => number
  exists?: (path: string) => boolean
}

const NOT_SUPPORTED: MacMenubarStatus = {
  supported: false, canInstall: false, installed: false, path: null, version: null, running: false, dock: false, outdated: false,
}

export const NO_MAC_MENUBAR: MacMenubarStatus = NOT_SUPPORTED

/** An install takes a download, an unzip and a launch; the default action cap is far shorter. */
const INSTALL_TIMEOUT_MS = 5 * 60_000

function capture(command: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.resume()
    child.on('error', () => resolve(null))
    child.on('close', code => resolve(code === 0 ? out.trim() : null))
  })
}

/**
 * One plain sentence for the card. The CLI prints prose and, on a crash, a stack; neither is
 * something to put in front of a person, and a stack in a card is a bug report they did not
 * ask to write. Everything unrecognised falls back to the first line of what the CLI said.
 */
export function installErrorMessage(result: Pick<ActionResult, 'stdout' | 'stderr'>): string {
  const text = `${result.stderr}\n${result.stdout}`
  const lower = text.toLowerCase()
  if (/getaddrinfo|enotfound|econnrefused|fetch failed|network|etimedout|dns/.test(lower)) {
    return 'No connection to github.com. Try again when you are back online.'
  }
  if (/no codeburnmenubar versioned zip|no mac-v\*|404|not found in release/.test(lower)) {
    return 'The menu bar app has not been published for this CodeBurn version yet.'
  }
  if (/checksum|sha-?256|did not contain|unexpected menubar bundle id|codesign/.test(lower)) {
    return 'The download was damaged and was not installed. Try again.'
  }
  if (/eacces|eperm|permission denied|operation not permitted|read-only/.test(lower)) {
    return 'CodeBurn could not write to your Applications folder.'
  }
  if (/persistent codeburn command/.test(lower)) {
    return 'The menu bar app needs the codeburn command on your PATH. Install it with: npm install -g codeburn'
  }
  const first = text
    .split('\n')
    .map(line => line.trim().replace(/^Menubar install failed:\s*/i, ''))
    .find(line => line.length > 0 && !line.startsWith('at '))
  return first || 'The menu bar app could not be installed.'
}

export class MacMenubar {
  private readonly run: (command: string, args: string[]) => Promise<string | null>
  private readonly exists: (path: string) => boolean
  private readonly home: string
  private readonly now: () => number

  constructor(private readonly deps: MacMenubarDeps) {
    this.run = deps.run ?? capture
    this.exists = deps.exists ?? existsSync
    this.home = deps.home ?? homedir()
    this.now = deps.now ?? Date.now
  }

  supported(): boolean {
    return this.deps.platform === 'darwin'
  }

  /** The two places an install puts it, then Spotlight for a copy someone moved elsewhere. */
  private async locate(): Promise<string | null> {
    for (const dir of [join(this.home, 'Applications'), '/Applications']) {
      const candidate = join(dir, MENUBAR_BUNDLE_NAME)
      if (this.exists(candidate)) return candidate
    }
    const found = await this.run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${MENUBAR_BUNDLE_ID}'`])
    const path = (found ?? '').split('\n').map(line => line.trim()).find(line => line.endsWith('.app'))
    return path && this.exists(path) ? path : null
  }

  async status(): Promise<MacMenubarStatus> {
    if (!this.supported()) return NOT_SUPPORTED
    const base = { supported: true, canInstall: !this.deps.mas }
    const path = await this.locate()
    if (!path) return { ...NOT_SUPPORTED, ...base }
    const [version, running, dock] = await Promise.all([
      this.version(path),
      this.isRunning(path),
      this.dockEnabled(),
    ])
    return { ...base, installed: true, path, version, running, dock, outdated: isOlderThan(version, OLDEST_ASKABLE) }
  }

  private async version(path: string): Promise<string | null> {
    const printed = await this.run('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleShortVersionString', join(path, 'Contents', 'Info.plist'),
    ])
    return printed || null
  }

  /** Matched on the bundle's own executable path, so a copy in the other Applications folder
   *  is not mistaken for this one. */
  private async isRunning(path: string): Promise<boolean> {
    const pids = await this.run('/usr/bin/pgrep', ['-f', join(path, 'Contents', 'MacOS', 'CodeBurnMenubar')])
    return Boolean(pids)
  }

  private async dockEnabled(): Promise<boolean> {
    const value = await this.run('/usr/bin/defaults', ['read', MENUBAR_BUNDLE_ID, DOCK_ENABLED_KEY])
    return value === '1' || value === 'true'
  }

  /**
   * `codeburn menubar`, with `--force` only when there is already a copy to replace: without
   * it the CLI treats an existing bundle as done and just launches it, which is the wrong
   * answer for a person who pressed Reinstall. The CLI quits the old copy before the move and
   * the app's own SingleInstanceGuard retires anything that outlived that, so this cannot end
   * with two.
   */
  async install(): Promise<{ ok: boolean; error: string | null; status: MacMenubarStatus }> {
    if (!this.supported()) return { ok: false, error: 'The menu bar app is macOS only.', status: NOT_SUPPORTED }
    if (this.deps.mas) {
      return { ok: false, error: 'Get the menu bar app from the website.', status: await this.status() }
    }
    const runCli = this.deps.runCli
    if (!runCli) return { ok: false, error: 'The codeburn CLI is not available.', status: await this.status() }
    // Before the install, not after: the CLI records a persistent codeburn path for the
    // menubar and refuses to go on without one, and a desktop-only user has none on PATH.
    await this.writeCliLauncher()
    const already = Boolean(await this.locate())
    this.deps.onPhase?.('Downloading')
    let pending = ''
    const result = await runCli(already ? ['menubar', '--force'] : ['menubar'], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      onStdout: chunk => {
        // Chunks split mid-line, so only whole lines are read and the tail is kept.
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const phase = installPhase(line.trim())
          if (phase) this.deps.onPhase?.(phase)
        }
      },
    })
    const status = await this.status()
    if (result.ok && status.installed) return { ok: true, error: null, status }
    return { ok: false, error: installErrorMessage(result), status }
  }

  /** `open` on a running LSUIElement app activates the one that is up rather than starting a
   *  second, so there is no separate focus path. */
  async open(): Promise<MacMenubarStatus> {
    const path = await this.locate()
    if (path) await this.run('/usr/bin/open', [path])
    return this.status()
  }

  async setDockEnabled(enabled: boolean): Promise<MacMenubarStatus> {
    await this.run('/usr/bin/defaults', ['write', MENUBAR_BUNDLE_ID, DOCK_ENABLED_KEY, '-bool', enabled ? 'true' : 'false'])
    return this.status()
  }

  /**
   * Ask the app to show its own Settings window. Unlike quit and uninstall the app stays up,
   * so what is waited for is the command being consumed: the menubar clears the key as it
   * acts, and a key still sitting there after the timeout means nobody was listening. `open`
   * first so a command written while the app is down is answered at its launch rather than
   * timing out (CodeBurnApp answers the key on startup too).
   */
  async settings(): Promise<{ ok: boolean; error: string | null; status: MacMenubarStatus }> {
    const path = await this.locate()
    if (!path) return { ok: false, error: NO_ANSWER, status: await this.status() }
    await this.run('/usr/bin/defaults', ['write', MENUBAR_BUNDLE_ID, REMOTE_COMMAND_KEY, '-string', 'settings'])
    await this.run('/usr/bin/open', [path])
    if (await this.waitForConsumed(EXIT_TIMEOUT_MS)) return { ok: true, error: null, status: await this.status() }
    await this.run('/usr/bin/defaults', ['delete', MENUBAR_BUNDLE_ID, REMOTE_COMMAND_KEY])
    return { ok: false, error: NO_ANSWER, status: await this.status() }
  }

  async quit(): Promise<{ ok: boolean; error: string | null; status: MacMenubarStatus }> {
    const path = await this.locate()
    const answered = path ? await this.requestExit('quit', path) : true
    const status = await this.status()
    return answered ? { ok: true, error: null, status } : { ok: false, error: NO_ANSWER, status }
  }

  /**
   * Quit it, take the bundle away from wherever it was found, and let it drop its own login
   * item on the way out. Removing the bundle is the one step that cannot be taken back, so the
   * path is checked to be a CodeBurnMenubar.app before anything is deleted: `locate` can return
   * a Spotlight answer, and a wrong answer must fail rather than delete the wrong directory.
   */
  async uninstall(): Promise<{ ok: boolean; error: string | null; status: MacMenubarStatus }> {
    const path = await this.locate()
    if (!path) return { ok: true, error: null, status: await this.status() }
    if (basename(path) !== MENUBAR_BUNDLE_NAME) {
      return { ok: false, error: 'CodeBurn could not find the menu bar app to remove.', status: await this.status() }
    }
    if (!(await this.requestExit('uninstall', path))) {
      return { ok: false, error: NO_ANSWER, status: await this.status() }
    }
    try {
      await rm(path, { recursive: true, force: true })
    } catch {
      return { ok: false, error: 'CodeBurn could not remove the menu bar app. Check its permissions in Finder.', status: await this.status() }
    }
    const status = await this.status()
    return status.installed
      ? { ok: false, error: 'CodeBurn could not remove the menu bar app.', status }
      : { ok: true, error: null, status }
  }

  /**
   * Ask the app to go, and take no for an answer. Killing it was the obvious fallback and is
   * deliberately not here: a SIGTERM skips `applicationWillTerminate`, and on an uninstall it
   * would leave the login item registered pointing at a bundle about to be deleted. A menubar
   * that cannot be asked is `outdated`, which the card never offers Quit or Uninstall for.
   */
  private async requestExit(command: 'quit' | 'uninstall', path: string): Promise<boolean> {
    await this.run('/usr/bin/defaults', ['write', MENUBAR_BUNDLE_ID, REMOTE_COMMAND_KEY, '-string', command])
    const executable = join(path, 'Contents', 'MacOS', 'CodeBurnMenubar')
    if (await this.waitForExit(executable, EXIT_TIMEOUT_MS)) return true
    // A command nobody consumed would quit the next launch, which is not what was asked.
    await this.run('/usr/bin/defaults', ['delete', MENUBAR_BUNDLE_ID, REMOTE_COMMAND_KEY])
    return false
  }

  /**
   * A `sh` launcher for the CLI the desktop app carries, recorded where the menubar looks for
   * a codeburn first (CodeburnCLI.persistedCLIPath). The Windows mirror of this is
   * writeCliLauncher in menubar.ts; the difference is only the file it writes.
   * Returns the launcher path, or null in a dev build, which has no bundled CLI to point at.
   */
  async writeCliLauncher(): Promise<string | null> {
    const { execPath, bundledCli, stateDir } = this.deps
    if (!execPath || !bundledCli || !stateDir) return null
    // Anything `sh` would read rather than pass along. Both paths come from the app's own
    // install location, so this never fires in practice; the alternative to failing is
    // writing a script that means something other than what it says.
    if (/["\\$`\n]/.test(execPath) || /["\\$`\n]/.test(bundledCli)) return null
    const launcher = join(stateDir, 'codeburn-desktop-cli.sh')
    // The menubar rejects a path with a shell metacharacter in it (CodeburnCLI.isSafe), and a
    // path it rejects is worse than none: it would sit in the file and never resolve.
    if (!/^[A-Za-z0-9 ._/-]+$/.test(launcher)) return null
    await mkdir(stateDir, { recursive: true })
    await writeFile(launcher, [
      '#!/bin/sh',
      '# Written by the CodeBurn desktop app. It runs the CLI the desktop app carries,',
      '# through the desktop app\'s own executable.',
      `ELECTRON_RUN_AS_NODE=1 exec "${execPath}" "${bundledCli}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 })
    await chmod(launcher, 0o755)
    const record = persistedPathFile()
    await mkdir(dirname(record), { recursive: true })
    await writeFile(record, `${launcher}\n`, { mode: 0o600 })
    return launcher
  }

  /** True once the menubar has taken the command out of its defaults. */
  private async waitForConsumed(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    for (;;) {
      if (!(await this.run('/usr/bin/defaults', ['read', MENUBAR_BUNDLE_ID, REMOTE_COMMAND_KEY]))) return true
      if (this.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, EXIT_POLL_MS))
    }
  }

  private async waitForExit(executable: string, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    for (;;) {
      if (!(await this.run('/usr/bin/pgrep', ['-f', executable]))) return true
      if (this.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, EXIT_POLL_MS))
    }
  }
}
