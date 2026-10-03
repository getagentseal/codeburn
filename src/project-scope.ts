import { createHash } from 'node:crypto'

import {
  foldIdentifiedWindowsPath,
  normalizeProjectPathKey,
  type ProjectFilterTarget,
} from './parser.js'

export type DesktopProjectId = string
export type DesktopProjectScopeKey = string
export type ProjectBucketKey = string
export type ProjectScopeProvenance = 'exact' | 'legacy'

export type ProjectScopeOption = {
  id: DesktopProjectId
  name: string
  path: string | null
}

const INVALID_DESKTOP_PROJECT_ID = 'Invalid Desktop project ID: expected a non-empty string without NUL bytes.'

function normalizedAbsoluteProjectPath(projectPath: unknown): string | null {
  if (typeof projectPath !== 'string') return null
  const slashNormalized = projectPath.trim().replace(/\\/g, '/')
  if (!slashNormalized) return null

  const isAbsolute = slashNormalized.startsWith('/') || /^[a-zA-Z]:\//.test(slashNormalized)
  if (!isAbsolute) return null

  return foldIdentifiedWindowsPath(normalizeProjectPathKey(slashNormalized))
}

export function canonicalDesktopProjectId(target: ProjectFilterTarget): DesktopProjectId {
  const path = normalizedAbsoluteProjectPath(target.projectPath)
  return path === null ? `label:${target.project}` : `path:${path}`
}

export function matchesDesktopProjectId(target: ProjectFilterTarget, id: DesktopProjectId): boolean {
  return canonicalDesktopProjectId(target) === id
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

export function desktopProjectScopeKey(id: DesktopProjectId | null | undefined): DesktopProjectScopeKey {
  return id === null || id === undefined ? 'all' : `project:${base64url(id)}`
}

export function exactProjectBucketKey(id: DesktopProjectId): ProjectBucketKey {
  return `exact:${base64url(id)}`
}

export function legacyProjectBucketKey(label: string): ProjectBucketKey {
  return `legacy:${base64url(label)}`
}

export function validateDesktopProjectId(value: unknown): DesktopProjectId {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) {
    throw new TypeError(INVALID_DESKTOP_PROJECT_ID)
  }
  return value
}

export function catalogRevision(
  include: readonly string[] = [],
  exclude: readonly string[] = [],
  generation: string | number = '',
): string {
  const normalizePatterns = (patterns: readonly string[]): string[] => patterns
    .map(pattern => pattern.trim().replace(/\\/g, '/'))
    .sort()

  const payload = JSON.stringify({
    include: normalizePatterns(include),
    exclude: normalizePatterns(exclude),
    generation: String(generation),
  })
  return createHash('sha256').update(payload, 'utf8').digest('base64url')
}
