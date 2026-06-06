import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { spawnSync } from 'child_process'
import { homedir } from 'os'

type UsageWindow = {
  label: string
  usedPercent: number
  resetsAt?: string | null
  resetInSec?: number | null
  status?: string
}

type ProviderResult = {
  name: string
  plan: string
  email?: string | null
  windows: UsageWindow[]
  workspaceID?: string
  updatedAt?: string
}

type PluginOutput = {
  generatedAt: string
  providers: Record<string, ProviderResult>
}

type UsageData = {
  generatedAt: string
  provider: string
  result: ProviderResult
}

function resolveScriptPath(): string {
  // Prefer the script bundled with codeburn, then the opencode plugin copy,
  // then a user-installed copy in ~/.local/bin/usage-limits.
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(currentDir, '..', 'scripts', 'usage-limits.py'),
    resolve(currentDir, '..', '..', 'scripts', 'usage-limits.py'),
    resolve(homedir(), '.config/opencode/plugins/usage-limits/main.py'),
    resolve(homedir(), '.local/bin/usage-limits'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to the bundled path even if missing so the error message is helpful.
  return candidates[0]!
}

function findPythonBinary(): string | null {
  const candidates = ['python3.14', 'python3', 'python']
  for (const bin of candidates) {
    const result = spawnSync(bin, ['--version'], { stdio: 'pipe', timeout: 5000 })
    if (result.status === 0) return bin
  }
  return null
}

function callPlugin(scriptPath: string, pythonBin: string, provider?: string): PluginOutput {
  const args = [scriptPath]
  if (provider) args.push(provider)
  args.push('--json')

  const result = spawnSync(pythonBin, args, { stdio: 'pipe', timeout: 60000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || ''
    const stdout = result.stdout?.toString().trim() || ''
    let detail = stderr || stdout || `exit code ${result.status}`
    try {
      const parsed = JSON.parse(stdout)
      detail = parsed.error || detail
      if (parsed.hint) detail += `\n  Hint: ${parsed.hint}`
    } catch {}
    throw new Error(`usage-limits plugin failed: ${detail}`)
  }

  const output = result.stdout.toString().trim()
  if (!output) throw new Error('usage-limits plugin produced no output')
  try {
    return JSON.parse(output) as PluginOutput
  } catch (err) {
    throw new Error(`Invalid JSON from plugin: ${output.substring(0, 200)}`)
  }
}

function statusIcon(percent: number): string {
  if (percent >= 80) return '🔴'
  if (percent >= 50) return '⚠️ '
  return '✅'
}

function statusLabel(percent: number): string {
  if (percent >= 80) return 'Critical'
  if (percent >= 50) return 'Watch'
  return 'OK    '
}

function formatReset(window: UsageWindow): string {
  if (window.resetInSec != null && window.resetInSec > 0) {
    return formatDuration(window.resetInSec)
  }
  if (window.resetsAt) {
    const dt = new Date(window.resetsAt)
    if (!isNaN(dt.getTime())) {
      const diff = Math.floor((dt.getTime() - Date.now()) / 1000)
      if (diff > 0) return formatDuration(diff)
    }
  }
  return '—'
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`)
  return parts.join(' ')
}

function computeForecast(windows: UsageWindow[]): string[] {
  const lines: string[] = []
  const byNeedle = (needles: string[]) =>
    windows.find((w) => needles.some((n) => w.label.toLowerCase().includes(n)))
  const weekly = byNeedle(['weekly', '7-day', '7d'])
  const monthly = byNeedle(['monthly', '30d', 'month'])
  const rolling = byNeedle(['rolling', '5-hour', '5h', 'session', 'hourly'])

  if (weekly && weekly.resetInSec != null && weekly.usedPercent > 0) {
    const windowSec = 7 * 86400
    const elapsed = windowSec - weekly.resetInSec
    if (elapsed > 0) {
      const rate = weekly.usedPercent / elapsed
      const projected = Math.round(rate * windowSec * 10) / 10
      const ok = projected <= 100
      lines.push(`  Weekly projection: ${projected}% by end of period ${ok ? '(on track)' : '(may exceed limit)'}`)
    }
  }
  if (monthly && monthly.resetInSec != null && monthly.usedPercent > 0) {
    const windowSec = 30 * 86400
    const elapsed = windowSec - monthly.resetInSec
    if (elapsed > 0) {
      const rate = monthly.usedPercent / elapsed
      const projected = Math.round(rate * windowSec * 10) / 10
      const ok = projected <= 100
      lines.push(`  Monthly projection: ${projected}% by end of period ${ok ? '(on track)' : '(may exceed limit)'}`)
    }
  }
  if (rolling && rolling.resetInSec != null && rolling.usedPercent > 0) {
    const windowSec = 5 * 3600
    const elapsed = windowSec - rolling.resetInSec
    if (elapsed > 0) {
      const rate = rolling.usedPercent / elapsed
      const projected = Math.round(rate * windowSec * 10) / 10
      const ok = projected <= 100
      lines.push(`  Rolling projection: ${projected}% by end of window ${ok ? '(on track)' : '(may exceed limit)'}`)
    }
  }
  if (lines.length === 0) lines.push('  No usage data to project.')
  return lines
}

function renderProvider(provider: string, result: ProviderResult, format: 'text' | 'json', allGeneratedAt: string): void {
  if (format === 'json') {
    process.stdout.write(
      JSON.stringify(
        {
          generated: allGeneratedAt,
          provider,
          name: result.name,
          plan: result.plan,
          email: result.email ?? null,
          workspaceID: result.workspaceID,
          updatedAt: result.updatedAt ?? allGeneratedAt,
          windows: result.windows,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }

  const width = 56
  const title = ` ${result.name} — ${result.plan} `
  const padding = Math.max(0, width - title.length)
  const left = Math.floor(padding / 2)
  const right = padding - left
  process.stdout.write(`\n  ${'─'.repeat(left)}${title}${'─'.repeat(right)}\n`)
  process.stdout.write(`  ${'Window'.padEnd(20)} ${'Usage'.padEnd(8)} ${'Status'.padEnd(10)} Reset In\n`)
  process.stdout.write(`  ${'─'.repeat(width)}\n`)

  for (const w of result.windows) {
    const pct = Number.isFinite(w.usedPercent) ? w.usedPercent : 0
    process.stdout.write(
      `  ${w.label.padEnd(20)} ${String(Math.round(pct)).padEnd(4)}%     ${statusIcon(pct)} ${statusLabel(pct)} ${formatReset(w)}\n`,
    )
  }
  process.stdout.write(`  ${'─'.repeat(width)}\n`)

  const forecast = computeForecast(result.windows)
  if (forecast.length > 0) {
    process.stdout.write('  Forecast:\n')
    for (const line of forecast) process.stdout.write(line + '\n')
  }
  if (result.updatedAt) {
    process.stdout.write(`\n  Updated: ${result.updatedAt}\n`)
  }
  process.stdout.write('\n')
}

export async function usageLimits(opts: {
  provider?: string
  format?: string
  json?: boolean
  all?: boolean
  workspace?: string
}): Promise<void> {
  const format: 'text' | 'json' = opts.json ? 'json' : opts.format === 'json' ? 'json' : 'text'
  const scriptPath = resolveScriptPath()
  if (!existsSync(scriptPath)) {
    process.stderr.write(
      `\n  Error: usage-limits script not found. Expected at ${scriptPath}\n` +
      '  Install the opencode usage-limits plugin or copy scripts/usage-limits.py into the codeburn repo.\n\n',
    )
    process.exit(1)
  }

  const pythonBin = findPythonBinary()
  if (!pythonBin) {
    process.stderr.write('\n  Error: Python 3 not found. Install Python to use live usage limits.\n\n')
    process.exit(1)
  }

  let data: PluginOutput
  try {
    data = callPlugin(scriptPath, pythonBin, opts.provider)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`\n  Error: ${message}\n\n`)
    process.exit(1)
  }

  const entries = Object.entries(data.providers)
  if (entries.length === 0) {
    process.stderr.write('\n  No usage data available. Make sure you are signed in to at least one provider.\n\n')
    process.exit(1)
  }

  if (opts.all) {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    } else {
      for (const [provider, result] of entries) {
        renderProvider(provider, result, 'text', data.generatedAt)
      }
    }
    return
  }

  for (const [provider, result] of entries) {
    renderProvider(provider, result, format, data.generatedAt)
  }
}
