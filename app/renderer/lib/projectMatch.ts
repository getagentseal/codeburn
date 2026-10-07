/** The project filter rule, restated for the renderer: src/parser.ts reaches
 *  for node:fs, so the pane cannot import it. tests/project-match-parity.test.ts
 *  pins the two against each other, because a switch that disagrees with the
 *  CLI lies. It sits in the CLI suite because it needs both halves, and the
 *  desktop CI job installs only app/ dependencies. */

type MatchTarget = { name: string; path?: string; checkouts?: Array<{ path: string }>; temporary?: boolean }

/** The CLI's pattern (and the path of its row) for every temp-root folder
 *  outside a known repository. */
export const TEMPORARY_PROJECTS = '@temp'

export function isRooted(pattern: string): boolean {
  const raw = pattern.trim().replace(/\\/g, '/')
  return raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw)
}

/** normalizeAbsProjectPathKey: identified Windows paths casefold, POSIX does not. */
export function absProjectPathKey(value: string): string | null {
  const raw = value.trim().replace(/\\/g, '/')
  if (!raw) return null
  if (!raw.startsWith('/') && !/^[a-zA-Z]:\//.test(raw) && !(raw.includes('/') && !raw.startsWith('-'))) return null
  const windows = /^[a-zA-Z]:(\/|$)/.test(raw) || raw.startsWith('//')
  return (windows ? raw.toLowerCase() : raw).replace(/^\/+/, '').replace(/\/+$/, '') || null
}

export function projectMatches(project: MatchTarget, pattern: string): boolean {
  const projectPath = project.path ?? ''
  if (isRooted(pattern)) {
    const anchor = absProjectPathKey(pattern)
    const target = absProjectPathKey(projectPath)
    return anchor !== null && target !== null && (target === anchor || target.startsWith(anchor + '/'))
  }
  const needle = pattern.toLowerCase()
  return project.name.toLowerCase().includes(needle) || projectPath.toLowerCase().includes(needle)
}

/** Two rows can share a name (repo and subdirectory), so the path is the key. */
export function projectPattern(project: MatchTarget): string {
  const raw = (project.path ?? '').trim()
  if (!raw) return project.name
  // A Codex-recorded path can arrive stripped of its leading slash. Rooting it
  // is what routes the pattern through the anchored branch, instead of a
  // substring that would hide the siblings sharing its prefix too.
  const rooted = raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw) || !raw.includes('/')
  return rooted ? raw : `/${raw}`
}

/** A pattern naming any checkout of a repository row names the whole
 *  repository, as in the CLI. */
export function projectNamedBy(project: MatchTarget, pattern: string): boolean {
  if (projectMatches(project, pattern)) return true
  return !project.temporary && (project.checkouts ?? []).some(c => projectMatches({ name: project.name, path: c.path }, pattern))
}

export function projectVisible(project: MatchTarget, filter: { project: string[]; exclude: string[] }): boolean {
  if (filter.exclude.some(pattern => projectNamedBy(project, pattern))) return false
  return filter.project.length === 0 || filter.project.some(pattern => projectNamedBy(project, pattern))
}
