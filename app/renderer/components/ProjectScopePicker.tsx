import { useState } from 'react'

import { t } from '../i18n'
import { shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { isRooted, projectVisible } from '../lib/projectMatch'
import type { ProjectFilter, ProjectRow } from '../lib/types'
import { Dropdown, type DropdownOption } from './Dropdown'

/** `path` is one checkout; the CLI widens it to its whole repository. */
export type TransientProject = { name: string; path: string; label?: string }

const ALL = ''
const MAX_SHOWN = 100

/** Projects the saved filter shows, costliest first. Only rows with an
 *  absolute path, and the temporary-folders row: a bucket with no session cwd (an import, a provider's label
 *  fallback) reports its label as the path, and no rooted filter selects it.
 *  Rows that round to $0.00 are left out too, they would show nothing. */
export function projectScopeOptions(projects: ProjectRow[], filter: ProjectFilter): Array<DropdownOption & { name: string }> {
  const byPath = new Map<string, ProjectRow>()
  for (const project of projects) {
    if ((!isRooted(project.path) && !project.temporary) || !projectVisible(project, filter)) continue
    const path = project.path.trim()
    const held = byPath.get(path)
    if (!held || (held.cost ?? 0) < (project.cost ?? 0)) byPath.set(path, project)
  }
  const rows = [...byPath].filter(([, project]) => Math.round((project.cost ?? 0) * 100) > 0).sort((a, b) => (b[1].cost ?? 0) - (a[1].cost ?? 0))
  const labels = new Map<string, number>()
  for (const [path] of rows) {
    const label = shortenProjectPath(path, 2)
    labels.set(label, (labels.get(label) ?? 0) + 1)
  }
  return rows.map(([path, project]) => {
    const label = shortenProjectPath(path, 2)
    return {
      value: path,
      label: project.temporary ? t('shell.project.temporary') : project.checkouts ? project.name : labels.get(label)! > 1 ? path : label,
      name: project.name,
      ...(project.checkouts?.some(c => c.matchedByFolderName) ? { title: t('shell.project.matchedByFolderName') } : {}),
    }
  })
}

export function matchProjectOptions<T extends DropdownOption>(options: T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return options
  return options.filter(option => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle))
}

// The lifetime list is the heaviest read the app makes, so it runs on the first
// open only and is kept for the session, like the Projects pane's.
let catalog: Promise<ProjectRow[]> | null = null
function loadCatalog(): Promise<ProjectRow[]> {
  catalog ??= codeburn.getUnfilteredProjects().then(report => report.projects).catch(err => {
    catalog = null
    throw err
  })
  return catalog
}

/** Scopes every report to one project until cleared or the app restarts. */
export function ProjectScopePicker({ value, onSelect }: { value: TransientProject | null; onSelect: (project: TransientProject | null) => void }) {
  const [options, setOptions] = useState<Array<DropdownOption & { name: string }> | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')

  const load = () => {
    setFailed(false)
    void Promise.all([loadCatalog(), codeburn.getProjectFilter()])
      .then(([projects, filter]) => setOptions(projectScopeOptions(projects, filter)))
      .catch(() => setFailed(true))
  }

  const matches = matchProjectOptions(options ?? [], query)
  const shown = matches.slice(0, MAX_SHOWN)
  const selected = value ? { value: value.path, label: value.label ?? shortenProjectPath(value.path, 2), name: value.name } : null
  const list: DropdownOption[] = query.trim()
    ? shown
    : [
      { value: ALL, label: t('shell.project.all') },
      ...(selected && !shown.some(option => option.value === selected.value) ? [selected] : []),
      ...shown,
    ]
  const footer = failed ? t('shell.project.error')
    : options === null ? t('shell.project.loading')
    : matches.length === 0 ? t('shell.project.noMatch')
    : matches.length > shown.length ? t('shell.project.more', { shown: shown.length.toLocaleString(), total: matches.length.toLocaleString() })
    : undefined

  return (
    <Dropdown
      id="project-scope"
      ariaLabel={t('shell.project.ariaLabel')}
      value={value?.path ?? ALL}
      options={list}
      onChange={path => {
        if (path === ALL) { onSelect(null); return }
        const option = options?.find(entry => entry.value === path) ?? selected
        if (!option) return
        // Only a repository row is named apart from its path.
        const named = option.label !== option.value && option.label !== shortenProjectPath(option.value, 2)
        onSelect({ name: option.name, path: option.value, ...(named ? { label: option.label } : {}) })
      }}
      footer={footer}
      search={{ value: query, onChange: setQuery, placeholder: t('shell.project.search'), ariaLabel: t('shell.project.search') }}
      onOpen={load}
    />
  )
}
