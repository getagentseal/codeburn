/// Display copy for period session counts. Keep in lockstep with
/// `src/session-count-label.ts` (renderer does not import `src/`).
export type SessionCountBasis = 'identity' | 'partial'

export const SESSION_COUNT_HELP = 'Older session logs may be unavailable.'
export const COMBINED_SESSION_COUNT_HELP = 'Session identities are unavailable across devices.'
export const COMBINED_SESSION_COUNT_LABEL = 'Session count unavailable'

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

export function formatCombinedSessionCount(): string {
  return COMBINED_SESSION_COUNT_LABEL
}
