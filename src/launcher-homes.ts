import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'

export type LauncherNote = {
  name: string
  path: string
  billedVia: string
  verdict: string
}

/** True when `dir` is a Codex home nested under a launcher nest, and a distinct
 *  primary Codex home exists. Scanning it would double-count the billed seat. */
export function isNestedLauncherCodexHome(
  dir: string,
  opts: { primaryDir: string; launcherRoots: string[] },
): boolean {
  const resolved = resolve(dir)
  const primary = resolve(opts.primaryDir)
  if (resolved === primary) return false
  const underLauncher = opts.launcherRoots.some(root => {
    const r = resolve(root)
    return resolved === r || resolved.startsWith(r + sep)
  })
  if (!underLauncher) return false
  return existsSync(primary)
}

export function defaultBilledCodexHome(): string {
  return join(homedir(), '.codex')
}

export function defaultLauncherRoots(): string[] {
  return [join(homedir(), '.buzz')]
}

/** Surfaces that drive another billed store. Not providers. No session count. */
export function collectLauncherNotes(home = homedir()): LauncherNote[] {
  const notes: LauncherNote[] = []
  const buzz = join(home, '.buzz')
  if (existsSync(buzz)) {
    notes.push({
      name: 'buzz',
      path: buzz,
      billedVia: 'codex',
      verdict: 'LAUNCHER (no usage store; billed via Codex)',
    })
  }
  const grokStore = join(home, '.grok')
  const grokBot = join(home, 'Library', 'Application Support', 'Grok Bot')
  if (existsSync(grokBot) && existsSync(grokStore)) {
    notes.push({
      name: 'grok-bot',
      path: grokBot,
      billedVia: 'grok',
      verdict: 'LAUNCHER (Electron cache; billed via ~/.grok)',
    })
  }
  return notes
}
