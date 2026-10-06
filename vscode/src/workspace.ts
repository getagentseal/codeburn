import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { ProjectFilter } from '../../app/electron/bridge-handlers'

/**
 * The project path the CLI files a session under when it was started in `dir`:
 * the directory itself, except inside a linked git worktree, which the CLI
 * folds into its main repository (src/parser.ts resolveCanonicalProjectPath).
 */
export function canonicalProjectPath(dir: string): string {
  if (!isAbsolute(dir)) return dir
  let current = dir
  for (;;) {
    const gitEntry = resolve(current, '.git')
    let stat
    try { stat = lstatSync(gitEntry) } catch { stat = null }
    if (stat?.isDirectory()) return dir
    if (stat?.isFile()) {
      let gitFile: string
      try { gitFile = readFileSync(gitEntry, 'utf-8') } catch { return dir }
      const match = gitFile.match(/^gitdir:\s*(.+?)\s*$/m)
      if (!match?.[1]) return dir
      const gitDir = resolve(current, match[1])
      const markerIndex = gitDir.replace(/\\/g, '/').lastIndexOf('/.git/worktrees/')
      return markerIndex === -1 ? dir : gitDir.slice(0, markerIndex)
    }
    const parent = dirname(current)
    if (parent === current) return dir
    current = parent
  }
}

export type WorkspaceScope = {
  /** Rooted `--project` patterns, one per workspace folder. */
  paths: string[]
  /** What the scope switch calls this workspace; null with no folder open. */
  label: string | null
  /** Stable id for the paths, used to keep each scope's cached views apart. */
  id: string
}

export function workspaceScope(folders: ReadonlyArray<{ fsPath: string; name: string }>, workspaceName?: string): WorkspaceScope {
  const paths = [...new Set(folders.filter(folder => isAbsolute(folder.fsPath)).map(folder => canonicalProjectPath(folder.fsPath)))]
  if (paths.length === 0) return { paths, label: null, id: 'none' }
  const label = folders.length > 1 && workspaceName ? workspaceName : folders[0]!.name
  return { paths, label, id: createHash('sha256').update(paths.join('\0')).digest('hex').slice(0, 12) }
}

/**
 * The saved project filter narrowed to the workspace. Its excludes still apply;
 * its includes give way, since the workspace already names the projects shown.
 */
export function scopeFilter(paths: readonly string[]): (filter: ProjectFilter) => ProjectFilter {
  return filter => paths.length === 0 ? filter : { project: [...paths], exclude: filter.exclude }
}
