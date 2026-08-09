export type ProjectIdentitySource = {
  project?: string
  projectPath?: string
  projectIdentity?: string
}

/// Normalize an aggregation identity without applying case folding on a
/// case-sensitive filesystem. Path separators are normalized everywhere so
/// provider-specific Windows spellings still converge.
export function normalizeProjectIdentity(identity: string, platform = process.platform): string {
  const normalized = identity.trim().replace(/\\/g, '/')
  const withoutTrailingSlash = normalized.replace(/\/+$/, '')
  const stable = withoutTrailingSlash || normalized
  const containsWindowsRoot = stable.split('\n').some(root => /^[A-Za-z]:\//.test(root))
  return platform === 'darwin' || platform === 'win32' || containsWindowsRoot
    ? stable.toLowerCase()
    : stable
}

export function projectIdentityOf(source: ProjectIdentitySource, fallback = ''): string {
  return source.projectIdentity || source.projectPath || source.project || fallback
}

/// Cross-provider paths historically ignored leading slashes so Claude's
/// absolute paths and Codex's sanitized paths could merge. Keep that rule for
/// path identities while preserving case on case-sensitive platforms.
export function crossProviderProjectKey(source: ProjectIdentitySource): string {
  const identity = normalizeProjectIdentity(projectIdentityOf(source))
  const path = identity.replace(/^\/+/, '')
  return path.includes('/') ? path : (source.project ?? identity).toLowerCase()
}
