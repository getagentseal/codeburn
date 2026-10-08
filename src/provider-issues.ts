import { isBlockedDatabaseError, isSqliteBusyError } from './sqlite.js'

/// A provider whose data could not be read, as enums only: never the error
/// message, which can carry a path. Emitted on the menubar-json payload so the
/// desktop app can report `provider_read_fail`; the CLI itself sends nothing.
export type ProviderIssue = {
  provider: string
  stage: 'locate' | 'parse'
  kind: 'eacces' | 'busy' | 'enoent' | 'malformed' | 'error'
}

// Process-wide on purpose: a file that failed to parse is cached as failed and
// not read again, so a per-run list would lose it on the next poll.
const issues = new Map<string, ProviderIssue>()

export function providerIssueKind(err: unknown): ProviderIssue['kind'] {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM' || isBlockedDatabaseError(err)) return 'eacces'
  if (isSqliteBusyError(err)) return 'busy'
  if (code === 'ENOENT') return 'enoent'
  if (err instanceof SyntaxError) return 'malformed'
  return 'error'
}

export function recordProviderIssue(provider: string, stage: ProviderIssue['stage'], err: unknown): void {
  issues.set(`${provider}:${stage}`, { provider, stage, kind: providerIssueKind(err) })
}

/** With `kind`, clears only an entry of that kind: a permission error that Full Disk
 *  Access has since fixed, but not a malformed file that is still cached as failed. */
export function clearProviderIssue(provider: string, stage: ProviderIssue['stage'], kind?: ProviderIssue['kind']): void {
  const key = `${provider}:${stage}`
  if (kind === undefined || issues.get(key)?.kind === kind) issues.delete(key)
}

export function providerIssues(): ProviderIssue[] {
  return [...issues.values()]
}
