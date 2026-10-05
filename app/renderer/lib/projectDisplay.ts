import { shortenProjectPath } from './format'
import { projectPattern } from './projectMatch'

export type ProjectDisplayTarget = { name: string; path?: string | null }

export type ProjectDisplayLines = {
  primary: string
  pattern: string | null
}

/** The two visible project lines shared by Settings and the scope selector. */
export function projectDisplayLines(project: ProjectDisplayTarget): ProjectDisplayLines {
  const path = project.path?.trim() ?? ''
  return {
    primary: shortenProjectPath(path || project.name, 2),
    pattern: path ? projectPattern({ name: project.name, path }) : null,
  }
}
