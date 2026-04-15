import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { chmod, mkdir, unlink, writeFile } from 'fs/promises'
import { homedir, platform } from 'os'
import { join } from 'path'
import { formatCost, formatTokens } from './format.js'
import { getCurrency } from './currency.js'

const PLUGIN_REFRESH = '5m'

function getSwiftBarPluginDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'SwiftBar', 'plugins')
}

function getXbarPluginDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'xbar', 'plugins')
}

function getCodeburnBin(): string {
  try {
    return execSync('which codeburn', { encoding: 'utf-8' }).trim()
  } catch {
    return 'npx --yes codeburn'
  }
}

function generatePlugin(bin: string): string {
  const home = homedir()
  return `#!/bin/bash
# <xbar.title>CodeBurn</xbar.title>
# <xbar.version>v0.1.0</xbar.version>
# <xbar.author>AgentSeal</xbar.author>
# <xbar.author.github>agentseal</xbar.author.github>
# <xbar.desc>See where your AI coding tokens burn. Tracks cost, activity, and model usage across Claude Code, Cursor, and Codex by task type, tool, MCP server, and project.</xbar.desc>
# <xbar.image>file://${home}/codeburn/assets/logo.png</xbar.image>
# <xbar.abouturl>https://github.com/agentseal/codeburn</xbar.abouturl>
# <xbar.dependencies>node</xbar.dependencies>

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

${bin} status --format menubar 2>/dev/null || echo "-- | sfimage=flame.fill"
`
}

function miniBar(value: number, max: number, width: number = 10): string {
  if (max === 0) return '·'.repeat(width)
  const filled = Math.round((value / max) * width)
  return '█'.repeat(Math.min(filled, width)) + '·'.repeat(Math.max(width - filled, 0))
}

export type PeriodData = {
  label: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  categories: Array<{ name: string; cost: number; turns: number; editTurns: number; oneShotTurns: number }>
  models: Array<{ name: string; cost: number; calls: number }>
}

export type ProviderCost = {
  name: string
  cost: number
}

export function renderMenubarFormat(
  today: PeriodData,
  week: PeriodData,
  month: PeriodData,
  todayProviders?: ProviderCost[],
): string {
  const lines: string[] = []

  lines.push(`${formatCost(today.cost)} | sfimage=flame.fill color=#FF8C42`)
  lines.push('---')

  lines.push(`CodeBurn | size=15 color=#FF8C42`)
  lines.push(`AI Coding Cost Tracker | size=11`)
  if (todayProviders && todayProviders.length > 1) {
    for (const p of todayProviders) {
      lines.push(`  ${p.name.padEnd(10)} ${formatCost(p.cost).padStart(10)} | font=Menlo size=11`)
    }
  }
  lines.push('---')

  lines.push(`Today      ${formatCost(today.cost)}      ${today.calls.toLocaleString()} calls | size=14`)
  lines.push('---')

  const maxCat = Math.max(...today.categories.map(c => c.cost), 0.01)
  lines.push(`Activity - Today | size=12 color=#FF8C42`)
  for (const cat of today.categories.slice(0, 8)) {
    const bar = miniBar(cat.cost, maxCat)
    const name = cat.name.padEnd(14)
    lines.push(`${bar}  ${name} ${formatCost(cat.cost).padStart(8)}  ${String(cat.turns).padStart(4)} turns | font=Menlo size=11`)
  }
  lines.push('---')

  const maxModel = Math.max(...today.models.filter(m => m.name !== '<synthetic>').map(m => m.cost), 0.01)
  lines.push(`Models - Today | size=12 color=#FF8C42`)
  for (const model of today.models.slice(0, 5)) {
    if (model.name === '<synthetic>') continue
    const bar = miniBar(model.cost, maxModel)
    const name = model.name.padEnd(14)
    lines.push(`${bar}  ${name} ${formatCost(model.cost).padStart(8)}  ${String(model.calls).padStart(5)} calls | font=Menlo size=11`)
  }

  const cacheHit = today.inputTokens + today.cacheReadTokens > 0
    ? ((today.cacheReadTokens / (today.inputTokens + today.cacheReadTokens)) * 100).toFixed(0)
    : '0'
  lines.push(`Tokens: ${formatTokens(today.inputTokens)} in · ${formatTokens(today.outputTokens)} out · ${cacheHit}% cache hit | font=Menlo size=10`)
  lines.push('---')

  lines.push(`7 Days     ${formatCost(week.cost)}    ${week.calls.toLocaleString()} calls | size=14`)
  const weekMaxCat = Math.max(...week.categories.map(c => c.cost), 0.01)
  const weekMaxModel = Math.max(...week.models.filter(m => m.name !== '<synthetic>').map(m => m.cost), 0.01)
  lines.push(`--Activity | size=12 color=#FF8C42`)
  for (const cat of week.categories.slice(0, 8)) {
    const bar = miniBar(cat.cost, weekMaxCat)
    const name = cat.name.padEnd(14)
    lines.push(`--${bar}  ${name} ${formatCost(cat.cost).padStart(8)}  ${String(cat.turns).padStart(4)} turns | font=Menlo size=11`)
  }
  lines.push(`-----`)
  lines.push(`--Models | size=12 color=#FF8C42`)
  for (const model of week.models.slice(0, 5)) {
    if (model.name === '<synthetic>') continue
    const bar = miniBar(model.cost, weekMaxModel)
    const name = model.name.padEnd(14)
    lines.push(`--${bar}  ${name} ${formatCost(model.cost).padStart(8)}  ${String(model.calls).padStart(5)} calls | font=Menlo size=11`)
  }

  lines.push(`Month      ${formatCost(month.cost)}    ${month.calls.toLocaleString()} calls | size=14`)
  const monthMaxCat = Math.max(...month.categories.map(c => c.cost), 0.01)
  const monthMaxModel = Math.max(...month.models.filter(m => m.name !== '<synthetic>').map(m => m.cost), 0.01)
  lines.push(`--Activity | size=12 color=#FF8C42`)
  for (const cat of month.categories.slice(0, 8)) {
    const bar = miniBar(cat.cost, monthMaxCat)
    const name = cat.name.padEnd(14)
    lines.push(`--${bar}  ${name} ${formatCost(cat.cost).padStart(8)}  ${String(cat.turns).padStart(4)} turns | font=Menlo size=11`)
  }
  lines.push(`-----`)
  lines.push(`--Models | size=12 color=#FF8C42`)
  for (const model of month.models.slice(0, 5)) {
    if (model.name === '<synthetic>') continue
    const bar = miniBar(model.cost, monthMaxModel)
    const name = model.name.padEnd(14)
    lines.push(`--${bar}  ${name} ${formatCost(model.cost).padStart(8)}  ${String(model.calls).padStart(5)} calls | font=Menlo size=11`)
  }

  lines.push('---')
  const home = process.env.HOME ?? '~'
  const bin = getCodeburnBin()
  // Invoke the resolved `codeburn` binary directly. SwiftBar/xbar deliver
  // each `paramN=` value as its own argv entry, so there's no shell
  // quoting involved — and we don't ship the user to a `~/codeburn`
  // checkout that only exists when running from a dev clone (#32).
  lines.push(`Open Full Report | terminal=true shell=${bin} param1=report`)
  lines.push(`Export CSV to Desktop | terminal=false shell=${bin} param1=export param2=-o param3=${home}/Desktop/codeburn-report.csv`)

  // Currency submenu -- common currencies as clickable items.
  // Clicking one runs 'codeburn currency XXX' and refreshes the plugin.
  const activeCurrency = getCurrency().code
  const currencies = [
    { code: 'USD', name: 'US Dollar' },
    { code: 'GBP', name: 'British Pound' },
    { code: 'EUR', name: 'Euro' },
    { code: 'AUD', name: 'Australian Dollar' },
    { code: 'CAD', name: 'Canadian Dollar' },
    { code: 'NZD', name: 'New Zealand Dollar' },
    { code: 'JPY', name: 'Japanese Yen' },
    { code: 'CHF', name: 'Swiss Franc' },
    { code: 'INR', name: 'Indian Rupee' },
    { code: 'BRL', name: 'Brazilian Real' },
    { code: 'SEK', name: 'Swedish Krona' },
    { code: 'SGD', name: 'Singapore Dollar' },
    { code: 'HKD', name: 'Hong Kong Dollar' },
    { code: 'KRW', name: 'South Korean Won' },
    { code: 'MXN', name: 'Mexican Peso' },
    { code: 'ZAR', name: 'South African Rand' },
    { code: 'DKK', name: 'Danish Krone' },
  ]
  lines.push(`Currency: ${activeCurrency} | size=14`)
  for (const { code, name } of currencies) {
    const check = code === activeCurrency ? ' *' : ''
    // The real CLI subcommand is `codeburn currency [code]` (with `--reset`
    // for USD), not `codeburn config currency` — the latter doesn't exist
    // and silently fails when SwiftBar runs it. Fixes #27.
    if (code === 'USD') {
      lines.push(`--${name} (${code})${check} | terminal=false refresh=true shell=${bin} param1=currency param2=--reset`)
    } else {
      lines.push(`--${name} (${code})${check} | terminal=false refresh=true shell=${bin} param1=currency param2=${code}`)
    }
  }

  lines.push(`Refresh | refresh=true`)

  return lines.join('\n')
}

export async function installMenubar(): Promise<string> {
  if (platform() !== 'darwin') {
    return 'Menu bar integration is only available on macOS. Use `codeburn watch` or `codeburn status` instead.'
  }

  const bin = getCodeburnBin()
  const pluginContent = generatePlugin(bin)

  let pluginDir: string
  let appName: string

  if (existsSync(getSwiftBarPluginDir())) {
    pluginDir = getSwiftBarPluginDir()
    appName = 'SwiftBar'
  } else if (existsSync(getXbarPluginDir())) {
    pluginDir = getXbarPluginDir()
    appName = 'xbar'
  } else {
    pluginDir = getSwiftBarPluginDir()
    appName = 'SwiftBar'
    await mkdir(pluginDir, { recursive: true })
  }

  const pluginPath = join(pluginDir, `codeburn.${PLUGIN_REFRESH}.sh`)
  await writeFile(pluginPath, pluginContent, 'utf-8')
  await chmod(pluginPath, 0o755)

  const swiftbarInstalled = existsSync('/Applications/SwiftBar.app') || existsSync(join(homedir(), 'Applications', 'SwiftBar.app'))
  const xbarInstalled = existsSync('/Applications/xbar.app') || existsSync(join(homedir(), 'Applications', 'xbar.app'))

  const lines: string[] = []
  lines.push(`\n  Plugin installed to: ${pluginPath}`)

  if (swiftbarInstalled || xbarInstalled) {
    lines.push(`  ${appName} detected - plugin should appear in your menu bar shortly.`)
    lines.push(`  If not, open ${appName} and refresh plugins.\n`)
  } else {
    lines.push(`\n  To see CodeBurn in your menu bar, install SwiftBar:`)
    lines.push(`    brew install --cask swiftbar`)
    lines.push(`\n  Then launch SwiftBar - the plugin will load automatically.\n`)
  }

  return lines.join('\n')
}

export async function uninstallMenubar(): Promise<string> {
  const paths = [
    join(getSwiftBarPluginDir(), `codeburn.${PLUGIN_REFRESH}.sh`),
    join(getXbarPluginDir(), `codeburn.${PLUGIN_REFRESH}.sh`),
  ]

  let removed = false
  for (const p of paths) {
    if (existsSync(p)) {
      await unlink(p)
      removed = true
    }
  }

  return removed
    ? '\n  Menu bar plugin removed.\n'
    : '\n  No menu bar plugin found.\n'
}
