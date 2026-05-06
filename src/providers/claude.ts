import { readdir, stat } from 'fs/promises'
import { basename, delimiter, join, resolve } from 'path'
import { homedir } from 'os'

import type { Provider, SessionSource, SessionParser } from './types.js'

const shortNames: Record<string, string> = {
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-opus-4': 'Opus 4',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-5-haiku': 'Haiku 3.5',
}

type ClaudeRoot = {
  path: string
  account?: string
  accountPath?: string
}

function expandHome(dir: string): string {
  if (dir === '~') return homedir()
  if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    return join(homedir(), dir.slice(2))
  }
  return dir
}

function normalizeDirs(dirs: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const dir of dirs) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    const resolved = resolve(expandHome(trimmed))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    normalized.push(resolved)
  }
  return normalized
}

function accountLabelForClaudeDir(dir: string): string {
  const raw = basename(dir).replace(/^\.+/, '')
  let label = /^claude$/i.test(raw) ? 'default' : raw.replace(/^claude[-_.]/i, '')
  if (!label) label = 'default'
  return (label || 'default').toLowerCase()
}

function withClaudeAccounts(dirs: string[], forceLabel = false): ClaudeRoot[] {
  const shouldLabel = forceLabel || dirs.length > 1
  const assigned = new Set<string>()
  return dirs.map(dir => {
    if (!shouldLabel) return { path: dir }
    const baseLabel = accountLabelForClaudeDir(dir)
    let account = baseLabel
    let suffix = 2
    while (assigned.has(account)) {
      account = `${baseLabel}-${suffix}`
      suffix++
    }
    assigned.add(account)
    return { path: dir, account, accountPath: dir }
  })
}

function getClaudeRoots(overrideDirs?: string | string[]): ClaudeRoot[] {
  if (overrideDirs !== undefined) {
    return withClaudeAccounts(normalizeDirs(Array.isArray(overrideDirs) ? overrideDirs : [overrideDirs]))
  }

  const configDirs = process.env['CLAUDE_CONFIG_DIRS']
  if (configDirs) {
    const dirs = normalizeDirs(configDirs.split(delimiter))
    if (dirs.length > 0) return withClaudeAccounts(dirs, true)
  }

  return withClaudeAccounts(normalizeDirs([process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')]))
}

function getDesktopSessionsDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions')
  return join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions')
}

async function findDesktopProjectDirs(base: string): Promise<string[]> {
  const results: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    const entries = await readdir(dir).catch(() => [])
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      const s = await stat(full).catch(() => null)
      if (!s?.isDirectory()) continue
      if (entry === 'projects') {
        const projectDirs = await readdir(full).catch(() => [])
        for (const pd of projectDirs) {
          const pdFull = join(full, pd)
          const pdStat = await stat(pdFull).catch(() => null)
          if (pdStat?.isDirectory()) results.push(pdFull)
        }
      } else {
        await walk(full, depth + 1)
      }
    }
  }
  await walk(base, 0)
  return results
}

export function createClaudeProvider(claudeDirs?: string | string[], desktopSessionsDir?: string): Provider {
  return {
    name: 'claude',
    displayName: 'Claude',

    modelDisplayName(model: string): string {
      const canonical = model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
      for (const [key, name] of Object.entries(shortNames)) {
        if (canonical.startsWith(key)) return name
      }
      return canonical
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      const seenPaths = new Set<string>()

      const roots = getClaudeRoots(claudeDirs)
      const shouldLabelDesktop = roots.some(root => root.account)

      for (const root of roots) {
        const claudeDir = root.path
        const projectsDir = join(claudeDir, 'projects')
        try {
          const entries = await readdir(projectsDir)
          for (const dirName of entries) {
            const dirPath = join(projectsDir, dirName)
            if (seenPaths.has(dirPath)) continue
            const dirStat = await stat(dirPath).catch(() => null)
            if (dirStat?.isDirectory()) {
              sources.push({
                path: dirPath,
                project: dirName,
                provider: 'claude',
                ...(root.account ? { account: root.account, accountPath: root.accountPath } : {}),
              })
              seenPaths.add(dirPath)
            }
          }
        } catch {}
      }

      const desktopDirs = await findDesktopProjectDirs(desktopSessionsDir ?? getDesktopSessionsDir())
      for (const dirPath of desktopDirs) {
        if (!seenPaths.has(dirPath)) {
          sources.push({
            path: dirPath,
            project: basename(dirPath),
            provider: 'claude',
            ...(shouldLabelDesktop ? { account: 'desktop', accountPath: desktopSessionsDir ?? getDesktopSessionsDir() } : {}),
          })
          seenPaths.add(dirPath)
        }
      }

      return sources
    },

    createSessionParser(): SessionParser {
      return {
        async *parse() {},
      }
    },
  }
}

export const claude = createClaudeProvider()
