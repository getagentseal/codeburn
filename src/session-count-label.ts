/// Shared session-count phrasing for CLI, MCP, and tests.
/// Exact unique counts come only from surviving source identities with no
/// unknown cache contribution. Everything else is a lower bound.
export type SessionCountBasis = 'identity' | 'partial'

export const SESSION_COUNT_HELP = 'Older session logs may be unavailable.'

export function sessionCountIsExact(basis: SessionCountBasis | undefined): boolean {
  return basis === 'identity'
}

export function formatSessionCount(
  sessions: number,
  basis: SessionCountBasis | undefined,
): string {
  if (!sessionCountIsExact(basis)) {
    if (sessions <= 0) return 'Session count unavailable'
    return sessions === 1 ? 'At least 1 session' : `At least ${sessions.toLocaleString('en-US')} sessions`
  }
  if (sessions === 1) return '1 session'
  return `${sessions.toLocaleString('en-US')} sessions`
}
