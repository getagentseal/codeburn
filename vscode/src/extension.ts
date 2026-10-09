import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import * as vscode from 'vscode'

import { createBridgeHandlers, type Handler } from '../../app/electron/bridge-handlers'
import { reapOrphanServe, resolveCodeburnPath, restartServe, shutdownAll, spawnCli, spawnCliAction, startServe } from '../../app/electron/cli'
import { getQuota } from '../../app/electron/quota'
import { resolveSystemLocale, setCurrentLocale, t } from '../../app/renderer/i18n'
import type { MenubarPayload, QuotaProvider } from '../../app/renderer/lib/types'
import type { Boot } from '../../app/renderer/vscode/bridge'
import type { HostMessage, WebviewMessage } from '../../app/renderer/vscode/channels'
import { buildSummary, statusText, summaryText, tooltipMarkdown, type SidebarState, type Summary } from '../../app/renderer/vscode/summary'
import { call, createRouter, type EditorActions } from './host'
import { chooseRuntime, hostProbe, nodeCandidates, probeNode, type Runtime } from './runtime'
import { QUOTA_PROVIDERS, readSettings, refreshIntervalMs, webviewSeed, type Settings } from './settings'
import { STAR_URL, finishStar, recordFirstSeen, showStar } from './star'
import { webviewHtml } from './webviewHtml'
import { scopeFilter, workspaceScope, type WorkspaceScope } from './workspace'

const SUMMARY_KEY = 'codeburn.summary.v1'
const RUNTIME_NOTICE_KEY = 'codeburn.runtimeNotice'
const SETTINGS_QUERY = '@ext:codeburn.codeburn'

type IdeCommand = { section?: string; period?: string; refresh?: boolean }
type CliFailure = { kind: string; message: string }

let controller: Controller | null = null
let servePidFile: string | null = null

/** The returned API is for the smoke test: it proves the dashboard's renderer booted and called the host. */
export function activate(context: vscode.ExtensionContext): { dashboardCalls: () => number } {
  const instance = new Controller(context)
  controller = instance
  instance.start()
  return { dashboardCalls: () => instance.dashboardCalls }
}

export async function deactivate(): Promise<void> {
  controller?.dispose()
  controller = null
  await shutdownAll()
  if (servePidFile) rmSync(servePidFile, { force: true })
  servePidFile = null
}

/** A serve pid file per extension host, so two windows never reap each other's
 *  child. A file whose host is gone belongs to a crashed window: reap it. */
function reapOrphans(dir: string): void {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    const match = /^serve-(\d+)\.pid$/.exec(name)
    if (!match) continue
    const hostPid = Number(match[1])
    if (hostPid === process.pid) continue
    try { process.kill(hostPid, 0); continue } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') continue
    }
    reapOrphanServe(join(dir, name))
  }
}

class Controller {
  private settings: Settings
  private scope: WorkspaceScope
  private runtime: Runtime | null = null
  private summary: Summary | null
  private failure: CliFailure | null = null
  private loading = false
  private readonly status: vscode.StatusBarItem
  private readonly handlersAll: Record<string, Handler>
  private readonly handlersWorkspace: Record<string, Handler>
  private dashboard: vscode.WebviewPanel | null = null
  private dashboardWorkspace = false
  private sidebar: vscode.WebviewView | null = null
  private timer: NodeJS.Timeout | undefined
  private inflight: Promise<void> | null = null
  dashboardCalls = 0
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly context: vscode.ExtensionContext) {
    setCurrentLocale(resolveSystemLocale(vscode.env.language))
    this.settings = this.readSettings()
    this.scope = this.readScope()
    this.summary = context.globalState.get<Summary>(SUMMARY_KEY) ?? null
    this.dashboardWorkspace = this.settings.workspaceOnly && this.scope.paths.length > 0
    this.status = vscode.window.createStatusBarItem('codeburn.status', vscode.StatusBarAlignment.Right, 100)
    this.status.name = 'CodeBurn'
    this.status.command = 'codeburn.openDashboard'
    this.disposables.push(this.status)

    const stateDir = context.globalStorageUri.fsPath
    mkdirSync(stateDir, { recursive: true })
    const base = {
      spawnCli,
      spawnCliAction,
      resolveCodeburnPath,
      getQuota,
      emitProgress: (event: unknown) => this.postDashboard({ type: 'progress', event }),
      telemetry: null,
      companion: null,
      macMenubar: null,
      stateDir,
      appVersion: String(context.extension.packageJSON.version ?? '0'),
    }
    this.handlersAll = createBridgeHandlers(base)
    this.handlersWorkspace = createBridgeHandlers({ ...base, scopeProjectFilter: filter => scopeFilter(this.scope.paths)(filter) })
  }

  start(): void {
    const { context } = this
    // The bundled CLI, with the desktop's launch shim (dist/launch.js), which
    // corrects Commander's argv under Electron-as-Node.
    process.env.CODEBURN_BUNDLED_CLI = vscode.Uri.joinPath(context.extensionUri, 'cli', 'dist', 'launch.js').fsPath
    // Several editor windows each hold a serve child; an unfocused one stops
    // polling, so let its child go sooner than the desktop's 15 minutes.
    process.env.CODEBURN_SERVE_IDLE_MS = '300000'
    this.applyRuntime()
    recordFirstSeen(context.globalState)
    const stateDir = context.globalStorageUri.fsPath
    reapOrphans(stateDir)
    servePidFile = join(stateDir, `serve-${process.pid}.pid`)
    startServe(servePidFile)

    this.renderStatus()
    this.registerCommands()
    this.disposables.push(
      vscode.window.registerWebviewViewProvider('codeburn.summary', { resolveWebviewView: view => this.resolveSidebar(view) }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('codeburn')) void this.onSettingsChanged(event) }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.onFoldersChanged()),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) void this.refreshIfStale() }),
    )
    void vscode.commands.executeCommand('setContext', 'codeburn.workspaceScope', this.dashboardWorkspace)
    this.schedule()
    // The editor setting wins over the CLI's shared currency, at startup too.
    void this.refresh().then(() => this.applyCurrency())
  }

  dispose(): void {
    clearInterval(this.timer)
    for (const disposable of this.disposables) disposable.dispose()
    this.dashboard?.dispose()
  }

  private readSettings(): Settings {
    const config = vscode.workspace.getConfiguration('codeburn')
    return readSettings(key => config.get(key))
  }

  private readScope(): WorkspaceScope {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
    return workspaceScope(folders.map(folder => ({ fsPath: folder.uri.fsPath, name: folder.name })), vscode.workspace.name)
  }

  // ── Runtime ─────────────────────────────────────────────────────────────

  private applyRuntime(): void {
    const host = hostProbe()
    this.runtime = chooseRuntime({ host, configured: this.settings.nodePath, candidates: nodeCandidates(), probe: probeNode })
    if (this.runtime.kind === 'node') process.env.CODEBURN_NODE_BIN = this.runtime.bin
    else delete process.env.CODEBURN_NODE_BIN
    if (this.runtime.kind === 'degraded' && this.context.globalState.get(RUNTIME_NOTICE_KEY) !== this.runtime.version) {
      void this.context.globalState.update(RUNTIME_NOTICE_KEY, this.runtime.version)
      void vscode.window.showWarningMessage(this.runtimeNote()!, t('ide.runtime.install'), t('ide.settings.open')).then(choice => {
        if (choice === t('ide.runtime.install')) void vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'))
        else if (choice) void this.openSettings('codeburn.nodePath')
      })
    }
  }

  private runtimeNote(): string | null {
    return this.runtime?.kind === 'degraded' ? t('ide.runtime.degraded', { version: this.runtime.version }) : null
  }

  // ── Data ────────────────────────────────────────────────────────────────

  private schedule(): void {
    clearInterval(this.timer)
    const ms = refreshIntervalMs(this.settings.refreshInterval)
    if (ms === null) return
    this.timer = setInterval(() => {
      // An unfocused window nobody is looking at does not need live numbers.
      if (vscode.window.state.focused || this.sidebar?.visible) void this.refresh()
    }, ms)
  }

  private async refreshIfStale(): Promise<void> {
    const ms = refreshIntervalMs(this.settings.refreshInterval) ?? 5 * 60_000
    if (!this.summary || Date.now() - this.summary.at >= ms) await this.refresh()
  }

  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = this.load(force).finally(() => { this.inflight = null })
    return this.inflight
  }

  private async load(force: boolean): Promise<void> {
    this.loading = true
    this.renderSidebar()
    const all = this.handlersAll
    const ws = this.handlersWorkspace
    const provider = this.settings.provider
    const overview = (handlers: Record<string, Handler>, period: string) => call<MenubarPayload>(handlers['codeburn:getOverview'], period, provider)
    const optional = <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null)
    try {
      const today = await overview(all, 'today')
      const week = await optional(overview(all, 'week'))
      const month = await optional(overview(all, 'month'))
      const workspace = this.scope.label && this.scope.paths.length > 0
        ? await optional((async () => ({
            label: this.scope.label!,
            today: await overview(ws, 'today'),
            week: await optional(overview(ws, 'week')),
          }))())
        : null
      const disabled = QUOTA_PROVIDERS.filter(name => !this.settings.quotaProviders.includes(name))
      const quota = this.settings.quotaProviders.length === 0
        ? []
        : await optional(call<QuotaProvider[]>(all['codeburn:getQuota'], force, disabled))
      const snapshot = await optional(call<{ optimize: { findingCount: number; savingsUSD: number } }>(all['codeburn:getOptimizeSnapshot'], 'week', provider))
      this.summary = buildSummary({ today, week, month, workspace, quota, optimize: snapshot ? { findingCount: snapshot.optimize.findingCount, savingsUSD: snapshot.optimize.savingsUSD } : null })
      this.failure = null
      void this.context.globalState.update(SUMMARY_KEY, this.summary)
    } catch (error) {
      this.failure = toFailure(error)
    } finally {
      this.loading = false
      this.renderStatus()
      this.renderSidebar()
    }
  }

  // ── Status bar ──────────────────────────────────────────────────────────

  private renderStatus(): void {
    const format = this.settings.statusBarFormat
    if (format === 'hidden') { this.status.hide(); return }
    const summary = this.summary
    this.status.text = this.failure && !summary ? '$(flame) $(warning)' : statusText(summary, format)
    const tooltip = new vscode.MarkdownString(undefined, true)
    tooltip.isTrusted = { enabledCommands: ['codeburn.openDashboard'] }
    if (summary) tooltip.appendMarkdown(tooltipMarkdown(summary))
    else tooltip.appendMarkdown(this.failure ? `**CodeBurn**\n\n${t('ide.status.error')}` : `**CodeBurn**\n\n${t('ide.status.loading')}`)
    if (this.failure && summary) tooltip.appendMarkdown(`\n\n$(warning) ${t('ide.status.error')}`)
    const note = this.runtimeNote()
    if (note) tooltip.appendMarkdown(`\n\n$(info) ${note}`)
    this.status.tooltip = tooltip
    this.status.accessibilityInformation = { label: summary ? `CodeBurn, ${statusText(summary, format).replace(/\$\([a-z-]+\)\s*/g, '')}` : 'CodeBurn', role: 'button' }
    this.status.show()
  }

  // ── Sidebar ─────────────────────────────────────────────────────────────

  private resolveSidebar(view: vscode.WebviewView): void {
    this.sidebar = view
    view.webview.options = { enableScripts: true, localResourceRoots: [this.webviewRoot()] }
    view.webview.html = this.html(view.webview, 'sidebar', this.dashboardWorkspace)
    view.webview.onDidReceiveMessage((message: WebviewMessage) => this.onAction(message))
    view.onDidChangeVisibility(() => { if (view.visible) void this.refreshIfStale() })
    view.onDidDispose(() => { if (this.sidebar === view) this.sidebar = null })
  }

  private renderSidebar(): void {
    if (!this.sidebar) return
    const state: SidebarState = {
      status: this.loading ? 'loading' : this.failure ? 'error' : 'ok',
      error: this.failure,
      summary: this.summary,
      workspaceLabel: this.scope.label,
      runtimeNote: this.runtimeNote(),
      star: showStar(this.context.globalState),
    }
    void this.sidebar.webview.postMessage({ type: 'summary', state } satisfies HostMessage)
  }

  private onAction(message: WebviewMessage): void {
    if (!message || message.type !== 'action') return
    if (message.name === 'refresh') {
      if (message.arg === 'ready') { this.renderSidebar(); void this.refreshIfStale() }
      else void this.refresh(true)
    } else if (message.name === 'openDashboard') this.openDashboard()
    else if (message.name === 'openSection' && message.arg === 'optimize') this.openDashboard({ section: 'optimize' })
    else if (message.name === 'openSettings') void this.openSettings()
    else if (message.name === 'star') void this.starOnGitHub()
    else if (message.name === 'dismissStar') void finishStar(this.context.globalState).then(() => this.renderSidebar())
  }

  // ── Dashboard ───────────────────────────────────────────────────────────

  openDashboard(command?: IdeCommand, workspace?: boolean): void {
    const wantWorkspace = (workspace ?? this.dashboardWorkspace) && this.scope.paths.length > 0
    if (this.dashboard) {
      if (wantWorkspace !== this.dashboardWorkspace) this.loadDashboard(wantWorkspace, command)
      else if (command) this.postDashboard({ type: 'command', command })
      this.dashboard.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel('codeburn.dashboard', 'CodeBurn', vscode.ViewColumn.Active, {
      enableScripts: true,
      // Keeps the parsed reports and the open drawer across tab switches.
      retainContextWhenHidden: true,
      localResourceRoots: [this.webviewRoot()],
    })
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tab-icon.svg')
    this.dashboard = panel
    const editor: EditorActions = {
      chooseDirectory: async () => (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }))?.[0]?.fsPath ?? null,
      openExternal: async url => { await vscode.env.openExternal(vscode.Uri.parse(url)) },
      openSettings: () => this.openSettings(),
      setScope: async next => { this.openDashboard(undefined, next) },
    }
    const routers = { all: createRouter(this.handlersAll, editor), workspace: createRouter(this.handlersWorkspace, editor) }
    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (!message || message.type !== 'invoke' || typeof message.id !== 'number') return
      this.dashboardCalls++
      const envelope = await (this.dashboardWorkspace ? routers.workspace : routers.all)(message.channel, message.args)
      void panel.webview.postMessage({ type: 'result', id: message.id, envelope } satisfies HostMessage)
      if (envelope.ok && /^codeburn:(setCurrency|resetCurrency|setPlan|resetPlan|addAlias|removeAlias|setPriceOverride|removePriceOverride|setProjectFilter)$/.test(String(message.channel))) {
        void this.refresh()
      }
    })
    panel.onDidDispose(() => { if (this.dashboard === panel) this.dashboard = null })
    this.loadDashboard(wantWorkspace, command)
  }

  private loadDashboard(workspace: boolean, command?: IdeCommand): void {
    if (!this.dashboard) return
    this.dashboardWorkspace = workspace
    void vscode.commands.executeCommand('setContext', 'codeburn.workspaceScope', workspace)
    this.dashboard.title = workspace && this.scope.label ? `CodeBurn · ${this.scope.label}` : 'CodeBurn'
    this.dashboard.webview.html = this.html(this.dashboard.webview, 'dashboard', workspace, command)
  }

  private postDashboard(message: HostMessage): void {
    void this.dashboard?.webview.postMessage(message)
  }

  private webviewRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
  }

  private html(webview: vscode.Webview, view: 'dashboard' | 'sidebar', workspace: boolean, command?: IdeCommand): string {
    const root = this.webviewRoot()
    const boot: Boot = {
      view,
      version: String(this.context.extension.packageJSON.version ?? ''),
      platform: process.platform,
      arch: process.arch,
      locale: vscode.env.language,
      scope: { workspace, label: this.scope.label, id: this.scope.id },
      seed: webviewSeed(this.settings),
      ...(command ? { command } : {}),
    }
    return webviewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(root, `${view}.js`)).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(root, `${view}.css`)).toString(),
      boot,
      title: 'CodeBurn',
      lang: resolveSystemLocale(vscode.env.language),
    })
  }

  /** Sets the CLI's own currency, shared with every CodeBurn surface. */
  private async setCliCurrency(code: string): Promise<boolean> {
    const result = await call<{ ok: boolean; stderr: string }>(this.handlersAll['codeburn:setCurrency'], code).catch(error => ({ ok: false, stderr: toFailure(error).message }))
    if (!result.ok) void vscode.window.showErrorMessage(result.stderr || `CodeBurn: ${code}`)
    return result.ok
  }

  private async applyCurrency(): Promise<void> {
    const wanted = this.settings.currency
    if (!wanted || !this.summary || this.summary.currency.code === wanted) return
    if (await this.setCliCurrency(wanted)) await this.refresh()
  }

  private async starOnGitHub(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(STAR_URL))
    await finishStar(this.context.globalState)
    this.renderSidebar()
  }

  // ── Settings and folders ────────────────────────────────────────────────

  private openSettings(setting = ''): Promise<void> {
    return Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', setting || SETTINGS_QUERY)).then(() => undefined)
  }

  private async onSettingsChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const before = this.settings
    this.settings = this.readSettings()
    if (event.affectsConfiguration('codeburn.nodePath')) {
      this.applyRuntime()
      if (servePidFile) restartServe(servePidFile)
    }
    if (event.affectsConfiguration('codeburn.refreshInterval')) this.schedule()
    if (event.affectsConfiguration('codeburn.currency') && this.settings.currency && this.settings.currency !== before.currency) {
      await this.setCliCurrency(this.settings.currency)
    }
    if (event.affectsConfiguration('codeburn.workspaceOnly') && !this.dashboard) {
      this.dashboardWorkspace = this.settings.workspaceOnly && this.scope.paths.length > 0
    }
    this.renderStatus()
    if (this.dashboard && ['codeburn.defaultPeriod', 'codeburn.refreshInterval', 'codeburn.quotaProviders', 'codeburn.currency'].some(key => event.affectsConfiguration(key))) {
      this.loadDashboard(this.dashboardWorkspace)
    }
    await this.refresh()
  }

  private onFoldersChanged(): void {
    this.scope = this.readScope()
    if (this.scope.paths.length === 0 && this.dashboardWorkspace) this.dashboardWorkspace = false
    if (this.dashboard) this.loadDashboard(this.dashboardWorkspace)
    if (this.sidebar) this.sidebar.webview.html = this.html(this.sidebar.webview, 'sidebar', this.dashboardWorkspace)
    void this.refresh()
  }

  // ── Commands ────────────────────────────────────────────────────────────

  private registerCommands(): void {
    const register = (id: string, run: () => unknown) => this.disposables.push(vscode.commands.registerCommand(id, run))
    register('codeburn.openDashboard', () => this.openDashboard())
    register('codeburn.refresh', () => {
      this.postDashboard({ type: 'command', command: { refresh: true } })
      return this.refresh(true)
    })
    register('codeburn.showToday', () => this.openDashboard({ section: 'overview', period: 'today' }))
    register('codeburn.showWorkspace', () => this.openDashboard({ section: 'overview' }, true))
    register('codeburn.showAllProjects', () => this.openDashboard(undefined, false))
    register('codeburn.openOptimize', () => this.openDashboard({ section: 'optimize' }))
    register('codeburn.openSettings', () => this.openSettings())
    register('codeburn.starOnGitHub', () => this.starOnGitHub())
    register('codeburn.copySummary', async () => {
      if (!this.summary) { void vscode.window.showInformationMessage(t('ide.copy.empty')); return }
      await vscode.env.clipboard.writeText(summaryText(this.summary))
      void vscode.window.showInformationMessage(t('ide.copy.done'))
    })
  }
}

function toFailure(error: unknown): CliFailure {
  if (error && typeof error === 'object' && 'kind' in error) {
    const { kind, message } = error as { kind: unknown; message?: unknown }
    return { kind: String(kind), message: typeof message === 'string' ? message : '' }
  }
  return { kind: 'nonzero', message: error instanceof Error ? error.message : String(error) }
}
