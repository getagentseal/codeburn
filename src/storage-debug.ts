import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat, readdir } from 'node:fs/promises'

export type StorageEntry = {
  provider: string
  label: string
  path: string
  exists: boolean
  sizeBytes: number | null
  truncated: boolean
}

type StorageCandidate = {
  provider: string
  label: string
  path: string
}

const MAX_SCANNED_ENTRIES = 100_000

function supportDir(home = homedir(), platform = process.platform): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  if (platform === 'win32') return process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
  return process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
}

function cacheDir(home = homedir(), platform = process.platform): string {
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  if (platform === 'win32') return process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
  return process.env['XDG_CACHE_HOME'] ?? join(home, '.cache')
}

function dataDir(home = homedir(), platform = process.platform): string {
  if (platform === 'win32') return process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
  return process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share')
}

function expandHomePath(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function vscodeGlobalStoragePaths(home: string, platform: NodeJS.Platform, extensionId: string): string[] {
  if (platform === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', extensionId),
      join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }
  if (platform === 'win32') {
    return [
      join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', extensionId),
      join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage', extensionId),
      join(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }
  return [
    join(home, '.config', 'Code', 'User', 'globalStorage', extensionId),
    join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', extensionId),
    join(home, '.config', 'VSCodium', 'User', 'globalStorage', extensionId),
  ]
}

function vscodeWorkspaceStoragePaths(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
      join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  if (platform === 'win32') {
    return [
      join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
      join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
      join(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  return [
    join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
    join(home, '.config', 'VSCodium', 'User', 'workspaceStorage'),
    join(home, '.vscode-server', 'data', 'User', 'workspaceStorage'),
  ]
}

export function storageCandidates(home = homedir(), platform = process.platform): StorageCandidate[] {
  const support = supportDir(home, platform)
  const nativeCache = cacheDir(home, platform)
  const data = dataDir(home, platform)
  const codeburnCache = process.env['CODEBURN_CACHE_DIR'] ?? join(home, '.cache', 'codeburn')
  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
  const vibeHome = expandHomePath(process.env['VIBE_HOME'] ?? join(home, '.vibe'), home)
  const clineGlobalStorage = vscodeGlobalStoragePaths(home, platform, 'saoudrizwan.claude-dev')
  const rooGlobalStorage = vscodeGlobalStoragePaths(home, platform, 'rooveterinaryinc.roo-cline')
  const kiloGlobalStorage = vscodeGlobalStoragePaths(home, platform, 'kilocode.kilo-code')
  const copilotWorkspaceStorage = vscodeWorkspaceStoragePaths(home, platform)
  const ibmBobRoots = platform === 'darwin'
    ? [
        join(support, 'IBM Bob', 'User', 'globalStorage', 'ibm.bob-code'),
        join(support, 'Bob-IDE', 'User', 'globalStorage', 'ibm.bob-code'),
      ]
    : platform === 'win32'
    ? [
        join(support, 'IBM Bob', 'User', 'globalStorage', 'ibm.bob-code'),
        join(support, 'Bob-IDE', 'User', 'globalStorage', 'ibm.bob-code'),
      ]
    : [
        join(xdgConfig, 'IBM Bob', 'User', 'globalStorage', 'ibm.bob-code'),
        join(xdgConfig, 'Bob-IDE', 'User', 'globalStorage', 'ibm.bob-code'),
      ]
  const warpRoots = [
    join(home, 'Library', 'Group Containers', '2BBY89MBSN.dev.warp', 'Library', 'Application Support', 'dev.warp.Warp-Stable', 'warp.sqlite'),
    join(home, 'Library', 'Group Containers', '2BBY89MBSN.dev.warp', 'Library', 'Application Support', 'dev.warp.Warp-Preview', 'warp.sqlite'),
  ]
  const candidates: StorageCandidate[] = [
    { provider: 'codeburn', label: 'Config', path: join(xdgConfig, 'codeburn') },
    { provider: 'codeburn', label: 'CLI cache', path: codeburnCache },
    { provider: 'codeburn', label: 'Application Support', path: join(support, 'CodeBurn') },
    { provider: 'codeburn', label: 'Menubar cache', path: join(nativeCache, 'CodeBurn') },
    { provider: 'claude', label: 'Claude config', path: process.env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude') },
    { provider: 'claude', label: 'Claude desktop sessions', path: platform === 'darwin'
      ? join(support, 'Claude', 'local-agent-mode-sessions')
      : platform === 'win32'
      ? join(support, 'Claude', 'local-agent-mode-sessions')
      : join(home, '.config', 'Claude', 'local-agent-mode-sessions') },
    { provider: 'codex', label: 'Codex home', path: process.env['CODEX_HOME'] ?? join(home, '.codex') },
    { provider: 'cline', label: 'Cline data', path: join(home, '.cline', 'data') },
    ...clineGlobalStorage.map((path, idx) => ({ provider: 'cline', label: `Cline VS Code ${idx + 1}`, path })),
    { provider: 'droid', label: 'Factory/Droid data', path: process.env['FACTORY_DIR'] ?? join(home, '.factory') },
    { provider: 'antigravity', label: 'Antigravity application support', path: join(support, 'Antigravity') },
    { provider: 'antigravity', label: 'Antigravity Google application support', path: join(support, 'Google', 'Antigravity') },
    { provider: 'antigravity', label: 'Antigravity IDE conversations', path: join(home, '.gemini', 'antigravity', 'conversations') },
    { provider: 'antigravity', label: 'Antigravity IDE implicit', path: join(home, '.gemini', 'antigravity', 'implicit') },
    { provider: 'antigravity', label: 'Antigravity CLI conversations', path: join(home, '.gemini', 'antigravity-cli', 'conversations') },
    { provider: 'antigravity', label: 'Antigravity CLI implicit', path: join(home, '.gemini', 'antigravity-cli', 'implicit') },
    { provider: 'antigravity', label: 'Status line cache', path: join(codeburnCache, 'antigravity-statusline.jsonl') },
    { provider: 'gemini', label: 'Gemini tmp chats', path: join(home, '.gemini', 'tmp') },
    { provider: 'gemini', label: 'Gemini home', path: join(home, '.gemini') },
    { provider: 'kimi', label: 'Kimi share', path: process.env['KIMI_SHARE_DIR'] ?? join(home, '.kimi') },
    { provider: 'cursor', label: 'Cursor user data', path: platform === 'darwin'
      ? join(support, 'Cursor', 'User')
      : platform === 'win32'
      ? join(support, 'Cursor', 'User')
      : join(home, '.config', 'Cursor', 'User') },
    { provider: 'cursor', label: 'Cursor parse cache', path: join(codeburnCache, 'cursor-results.json') },
    { provider: 'cursor-agent', label: 'Cursor Agent home', path: join(home, '.cursor') },
    { provider: 'copilot', label: 'Copilot legacy sessions', path: join(home, '.copilot', 'session-state') },
    ...copilotWorkspaceStorage.map((path, idx) => ({ provider: 'copilot', label: `Copilot workspace storage ${idx + 1}`, path })),
    ...ibmBobRoots.map((path, idx) => ({ provider: 'ibm-bob', label: idx === 0 ? 'IBM Bob tasks' : 'Bob-IDE tasks', path })),
    { provider: 'kiro', label: 'Kiro user data', path: platform === 'darwin'
      ? join(support, 'Kiro', 'User')
      : platform === 'win32'
      ? join(support, 'Kiro', 'User')
      : join(home, '.config', 'Kiro', 'User') },
    { provider: 'openclaw', label: 'OpenClaw home', path: join(home, '.openclaw') },
    { provider: 'openclaw', label: 'ClawDBot legacy', path: join(home, '.clawdbot') },
    { provider: 'openclaw', label: 'Moltbot legacy', path: join(home, '.moltbot') },
    { provider: 'openclaw', label: 'Moldbot legacy', path: join(home, '.moldbot') },
    { provider: 'opencode', label: 'OpenCode data', path: join(data, 'opencode') },
    { provider: 'pi', label: 'Pi sessions', path: join(home, '.pi', 'agent', 'sessions') },
    { provider: 'omp', label: 'OMP sessions', path: join(home, '.omp', 'agent', 'sessions') },
    { provider: 'roo-code', label: 'Roo Code global storage', path: rooGlobalStorage[0]! },
    ...rooGlobalStorage.slice(1).map((path, idx) => ({ provider: 'roo-code', label: `Roo Code global storage ${idx + 2}`, path })),
    { provider: 'kilo-code', label: 'KiloCode global storage', path: kiloGlobalStorage[0]! },
    ...kiloGlobalStorage.slice(1).map((path, idx) => ({ provider: 'kilo-code', label: `KiloCode global storage ${idx + 2}`, path })),
    { provider: 'qwen', label: 'Qwen projects', path: process.env['QWEN_DATA_DIR'] ?? join(home, '.qwen', 'projects') },
    { provider: 'mistral-vibe', label: 'Vibe sessions', path: join(vibeHome, 'logs', 'session') },
    { provider: 'forge', label: 'Forge database', path: join(home, '.forge', '.forge.db') },
    { provider: 'codebuff', label: 'Codebuff stable', path: process.env['CODEBUFF_DATA_DIR'] ?? join(xdgConfig, 'manicode') },
    { provider: 'codebuff', label: 'Codebuff dev', path: join(xdgConfig, 'manicode-dev') },
    { provider: 'codebuff', label: 'Codebuff staging', path: join(xdgConfig, 'manicode-staging') },
    { provider: 'crush', label: 'Crush global data', path: process.env['CRUSH_GLOBAL_DATA'] ?? join(data, 'crush') },
    { provider: 'goose', label: 'Goose sessions database', path: process.env['GOOSE_PATH_ROOT']
      ? join(process.env['GOOSE_PATH_ROOT'], 'data', 'sessions', 'sessions.db')
      : platform === 'win32'
      ? join(support, 'Block', 'goose', 'sessions', 'sessions.db')
      : join(data, 'goose', 'sessions', 'sessions.db') },
    ...warpRoots.map((path, idx) => ({ provider: 'warp', label: idx === 0 ? 'Warp Stable database' : 'Warp Preview database', path })),
  ]
  return candidates
}

async function apparentSize(path: string): Promise<{ exists: boolean; sizeBytes: number | null; truncated: boolean }> {
  let root
  try {
    root = await lstat(path)
  } catch {
    return { exists: false, sizeBytes: null, truncated: false }
  }
  if (root.isSymbolicLink()) return { exists: true, sizeBytes: 0, truncated: false }
  if (!root.isDirectory()) return { exists: true, sizeBytes: root.size, truncated: false }

  let total = 0
  let scanned = 0
  let truncated = false
  const stack = [path]

  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      scanned += 1
      if (scanned > MAX_SCANNED_ENTRIES) {
        truncated = true
        stack.length = 0
        break
      }
      const child = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(child)
      } else if (entry.isFile()) {
        try {
          total += (await lstat(child)).size
        } catch {
          // Ignore files removed during the scan.
        }
      }
    }
  }

  return { exists: true, sizeBytes: total, truncated }
}

export async function collectStorageEntries(provider = 'all'): Promise<StorageEntry[]> {
  const normalized = provider.toLowerCase()
  const candidates = storageCandidates().filter(candidate => normalized === 'all' || candidate.provider === normalized)
  const entries: StorageEntry[] = []
  for (const candidate of candidates) {
    const size = await apparentSize(candidate.path)
    entries.push({ ...candidate, ...size })
  }
  return entries
}

export function storageProviderNames(): string[] {
  return [...new Set(storageCandidates().map(candidate => candidate.provider))].sort()
}

export function isStorageProvider(provider: string): boolean {
  return provider.toLowerCase() === 'all' || storageProviderNames().includes(provider.toLowerCase())
}

export function formatBytes(value: number | null): string {
  if (value == null) return '-'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = value / 1024
  let idx = 0
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024
    idx += 1
  }
  return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[idx]}`
}

export function formatStorageTable(entries: StorageEntry[]): string {
  const rows = entries.map(entry => [
    entry.provider,
    entry.label,
    entry.exists ? formatBytes(entry.sizeBytes) + (entry.truncated ? '+' : '') : 'missing',
    entry.path,
  ])
  const widths = [8, 28, 10, 0]
  const lines = [
    ['Provider', 'Location', 'Size', 'Path'],
    ...rows,
  ].map(cols => cols.map((value, idx) => idx === 3 ? value : value.padEnd(widths[idx]!)).join('  ').trimEnd())
  return lines.join('\n')
}
