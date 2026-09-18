import { delimiter, join, resolve } from 'path'
import { homedir } from 'os'

// Match CLAUDE_CONFIG_DIRS: empty entries are ignored; an empty list falls
// through to the legacy single home. Only multi-dir paths are normalized so
// existing HOME overrides retain their original semantics.
export function getProviderHomes(multiVar: string, singleVar: string, defaultDir: string): string[] {
  const dirs = (process.env[multiVar] ?? '')
    .split(delimiter)
    .map(dir => dir.trim())
    .filter(Boolean)
    .map(dir => {
      if (dir === '~') return homedir()
      if (dir.startsWith('~/') || dir.startsWith('~\\')) return join(homedir(), dir.slice(2))
      return dir
    })
    .map(dir => resolve(dir))
  if (dirs.length > 0) return [...new Set(dirs)]
  return [process.env[singleVar] ?? join(homedir(), defaultDir)]
}

export function getCodexHomes(): string[] {
  return getProviderHomes('CODEX_HOMES', 'CODEX_HOME', '.codex')
}

export function getGrokHomes(): string[] {
  return getProviderHomes('GROK_HOMES', 'GROK_HOME', '.grok')
}

export function getHermesHomes(): string[] {
  return getProviderHomes('HERMES_HOMES', 'HERMES_HOME', '.hermes')
}
