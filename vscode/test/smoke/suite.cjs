// Runs inside the editor's extension host (see run.mjs). Plain CommonJS so it
// needs no build step.
const assert = require('node:assert')
const { writeFileSync } = require('node:fs')
const vscode = require('vscode')

const COMMANDS = [
  'codeburn.openDashboard', 'codeburn.refresh', 'codeburn.showToday', 'codeburn.showWorkspace',
  'codeburn.showAllProjects', 'codeburn.openOptimize', 'codeburn.copySummary', 'codeburn.openSettings', 'codeburn.starOnGitHub',
]

function dashboardTabs() {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('codeburn.dashboard'))
}

/** The tab model updates after the command returns. */
async function waitFor(check, label) {
  for (let i = 0; i < 50; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}; tabs: ${JSON.stringify(vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => [t.label, t.input && t.input.viewType])))}`)
}

async function step(name, results, fn) {
  try { await fn(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, error: String(error && error.stack || error) }) }
}

exports.run = async function run() {
  const results = []
  let api = null
  await step('activates', results, async () => {
    const ext = vscode.extensions.getExtension('codeburn.codeburn')
    assert.ok(ext, 'extension codeburn.codeburn is installed')
    api = await ext.activate()
    assert.ok(ext.isActive)
  })
  await step('registers every command', results, async () => {
    const all = new Set(await vscode.commands.getCommands(true))
    for (const id of COMMANDS) assert.ok(all.has(id), `${id} is registered`)
  })
  await step('reads usage through the bundled CLI and scopes the workspace', results, async () => {
    await vscode.commands.executeCommand('codeburn.refresh')
    const saved = await vscode.env.clipboard.readText()
    try {
      await vscode.commands.executeCommand('codeburn.copySummary')
      const text = await vscode.env.clipboard.readText()
      results.push({ name: 'summary', ok: true, text })
      assert.match(text, /^CodeBurn ·/m)
      assert.match(text, new RegExp(`^${process.env.CODEBURN_SMOKE_TODAY_LINE.replace(/[$.]/g, '\\$&')}$`, 'm'))
      assert.match(text, new RegExp(`^${process.env.CODEBURN_SMOKE_WORKSPACE_LINE.replace(/[$.]/g, '\\$&')}`, 'm'))
    } finally {
      await vscode.env.clipboard.writeText(saved)
    }
  })
  await step('opens the dashboard and switches scope and section', results, async () => {
    await vscode.commands.executeCommand('codeburn.openDashboard')
    await waitFor(() => dashboardTabs().length === 1 && dashboardTabs()[0].label === 'CodeBurn · smoke-app', 'the workspace dashboard')
    // The renderer only calls the host once React has booted inside the webview.
    await waitFor(() => api.dashboardCalls() > 0, 'the dashboard renderer to call the host')
    await vscode.commands.executeCommand('codeburn.showAllProjects')
    await waitFor(() => dashboardTabs().length === 1 && dashboardTabs()[0].label === 'CodeBurn', 'the all-projects dashboard')
    await vscode.commands.executeCommand('codeburn.openOptimize')
    await vscode.commands.executeCommand('codeburn.showToday')
    await vscode.commands.executeCommand('codeburn.showWorkspace')
    await waitFor(() => dashboardTabs().length === 1 && dashboardTabs()[0].label === 'CodeBurn · smoke-app', 'the workspace dashboard again')
  })
  await step('shows the activity bar summary', results, async () => {
    await vscode.commands.executeCommand('workbench.view.extension.codeburn')
  })
  if (process.env.CODEBURN_SMOKE_OUT) writeFileSync(process.env.CODEBURN_SMOKE_OUT, JSON.stringify(results, null, 2))
  const failed = results.filter(result => !result.ok)
  if (failed.length) throw new Error(failed.map(result => `${result.name}: ${result.error}`).join('\n'))
}
