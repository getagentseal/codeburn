import { mkdir, open, readFile, rename, unlink } from 'fs/promises'
import { randomBytes } from 'crypto'
import { dirname, join } from 'path'
import { homedir } from 'os'

import {
  recordAntigravityStatusLinePayload,
  snapshotAntigravityStatusLinePayload,
} from './providers/antigravity.js'
import {
  buildPersistentCodeburnLookupPath,
  resolvePersistentCodeburnPathFromPath,
} from './persistent-codeburn.js'

export { buildPersistentCodeburnLookupPath as buildAntigravityHookLookupPath } from './persistent-codeburn.js'
export { resolvePersistentCodeburnPathFromPath } from './persistent-codeburn.js'

type Settings = Record<string, unknown> & {
  statusLine?: {
    type?: string
    command?: string
    padding?: number
  }
}

type StatusLineSettings = NonNullable<Settings['statusLine']>

const PERSISTENT_CLI_REQUIRED_MESSAGE =
  'The Antigravity hook needs a persistent codeburn command. Install CodeBurn globally first: npm install -g codeburn'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCodeBurnHook(command: unknown): boolean {
  return typeof command === 'string' && /(?:^|\s)agy-statusline-hook$/.test(command.trim())
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/(["\\])/g, '\\$1')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function hookCommand(): Promise<string> {
  const codeburnPath = await resolvePersistentCodeburnPathFromPath(
    buildPersistentCodeburnLookupPath(),
    PERSISTENT_CLI_REQUIRED_MESSAGE,
  )
  return `${shellQuote(codeburnPath)} agy-statusline-hook`
}

function settingsPath(): string {
  return process.env['CODEBURN_ANTIGRAVITY_SETTINGS_PATH']
    ?? join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
}

function codeburnCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function previousStatusLinePath(): string {
  return join(codeburnCacheDir(), 'antigravity-statusline-previous.json')
}

async function readSettings(): Promise<Settings> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return isObject(parsed) ? parsed as Settings : {}
  } catch {
    return {}
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, path)
  } catch (err) {
    try { await unlink(tempPath) } catch { /* cleanup */ }
    throw err
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await writeJsonAtomic(settingsPath(), settings)
}

async function savePreviousStatusLine(statusLine: StatusLineSettings): Promise<void> {
  await writeJsonAtomic(previousStatusLinePath(), {
    savedAt: new Date().toISOString(),
    statusLine,
  })
}

async function readPreviousStatusLine(): Promise<StatusLineSettings | null> {
  try {
    const raw = await readFile(previousStatusLinePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isObject(parsed) || !isObject(parsed.statusLine)) return null
    return parsed.statusLine as StatusLineSettings
  } catch {
    return null
  }
}

async function clearPreviousStatusLine(): Promise<void> {
  try {
    await unlink(previousStatusLinePath())
  } catch { /* no previous hook backup */ }
}

export async function installAntigravityStatusLineHook(force = false): Promise<'installed' | 'already-installed'> {
  const settings = await readSettings()
  const existing = settings.statusLine
  if (existing && !isCodeBurnHook(existing.command) && !force) {
    throw new Error(
      'Antigravity CLI already has a custom statusLine command. Re-run with --force to replace it.'
    )
  }

  const command = await hookCommand()
  if (isCodeBurnHook(existing?.command) && existing?.command === command && existing.type === 'command' && existing.padding === 0) {
    return 'already-installed'
  }
  if (existing && !isCodeBurnHook(existing.command)) await savePreviousStatusLine(existing)

  settings.statusLine = {
    type: 'command',
    command,
    padding: 0,
  }
  await writeSettings(settings)
  return 'installed'
}

export async function uninstallAntigravityStatusLineHook(): Promise<'removed' | 'restored' | 'not-installed'> {
  const settings = await readSettings()
  if (!isCodeBurnHook(settings.statusLine?.command)) return 'not-installed'

  const previous = await readPreviousStatusLine()
  if (previous) settings.statusLine = previous
  else delete settings.statusLine

  await writeSettings(settings)
  await clearPreviousStatusLine()
  return previous ? 'restored' : 'removed'
}

const MAX_STDIN_BYTES = 1024 * 1024

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = ''
    let bytes = 0
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_STDIN_BYTES) { process.stdin.destroy(); reject(new Error('stdin too large')); return }
      input += chunk
    })
    process.stdin.on('end', () => resolve(input))
    process.stdin.on('error', reject)
  })
}

export async function runAgyStatusLineHook(): Promise<void> {
  try {
    const input = await readStdin()
    const payload = input.trim() ? JSON.parse(input) : null
    await recordAntigravityStatusLinePayload(payload)
    await snapshotAntigravityStatusLinePayload(payload)
  } catch {
    // Status line hooks run inside the user's terminal UI. Never surface parser
    // or transient RPC failures there; the next status line update can retry.
  }
}
