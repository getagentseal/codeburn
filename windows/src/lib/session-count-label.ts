/// Display copy for period session counts. Keep in lockstep with
/// `src/session-count-label.ts`. The English sentences are catalog keys.
import { t } from '../i18n'

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
    if (sessions <= 0) return t('Session count unavailable')
    return sessions === 1 ? t('At least 1 session') : t('At least %lld sessions', sessions)
  }
  if (sessions === 1) return t('1 session')
  return t('%lld sessions', sessions)
}

export function formatCompactSessionCount(
  sessions: number,
  basis: SessionCountBasis | undefined,
): string {
  if (!sessionCountIsExact(basis)) {
    if (sessions <= 0) return t('Unavailable')
    return t('≥%lld sess', sessions)
  }
  return t('%lld sess', sessions)
}

export function formatSessionAveragePlaceholder(): string {
  return '—'
}

export function formatCombinedSessionCount(): string {
  return t(COMBINED_SESSION_COUNT_LABEL)
}
