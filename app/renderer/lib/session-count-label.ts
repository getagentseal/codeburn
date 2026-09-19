import { localeTag, t } from '../i18n'

/// Display copy for period session counts. Keep in lockstep with
/// `src/session-count-label.ts` (renderer does not import `src/`).
export type SessionCountBasis = 'identity' | 'partial'

// Functions (not consts) so each call resolves against the active locale.
export function sessionCountHelp(): string {
  return t('common.session.help')
}

export function combinedSessionCountHelp(): string {
  return t('common.session.combinedHelp')
}

export function sessionCountIsExact(basis: SessionCountBasis | undefined): boolean {
  return basis === 'identity'
}

export function formatSessionCount(
  sessions: number,
  basis: SessionCountBasis | undefined,
): string {
  if (!sessionCountIsExact(basis)) {
    if (sessions <= 0) return t('common.session.unavailable')
    return sessions === 1
      ? t('common.session.atLeastOne')
      : t('common.session.atLeastN', { count: sessions.toLocaleString(localeTag()) })
  }
  if (sessions === 1) return t('common.session.one')
  return t('common.session.n', { count: sessions.toLocaleString(localeTag()) })
}

export function formatCombinedSessionCount(): string {
  return t('common.session.unavailable')
}
