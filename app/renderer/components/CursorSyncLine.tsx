import { localeTag, t } from '../i18n'
import type { CursorSyncStatus } from '../lib/types'

const ERROR_KEYS: Record<string, string> = {
  login: 'plans.cursorSync.login',
  network: 'plans.cursorSync.network',
  export: 'plans.cursorSync.export',
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: 'auto' })
  if (minutes < 60) return rtf.format(-minutes, 'minute')
  if (minutes < 24 * 60) return rtf.format(-Math.floor(minutes / 60), 'hour')
  return rtf.format(-Math.floor(minutes / (24 * 60)), 'day')
}

/** The one line the apps show for the sync; null when it is off. */
export function cursorSyncLine(status: CursorSyncStatus, now = Date.now()): { text: string; warn: boolean } | null {
  if (status.state === 'off') return null
  if (status.errorCode) return { text: t(ERROR_KEYS[status.errorCode] ?? ERROR_KEYS.export!), warn: true }
  const at = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : NaN
  if (!Number.isFinite(at)) return { text: t('plans.cursorSync.notYet'), warn: false }
  const elapsed = Math.max(0, now - at)
  return { text: elapsed < 60_000 ? t('plans.cursorSync.justNow') : t('plans.cursorSync.synced', { ago: ago(elapsed) }), warn: false }
}

export function CursorSyncLine({ status }: { status?: CursorSyncStatus }) {
  const line = status ? cursorSyncLine(status) : null
  if (!line) return null
  return <p className={line.warn ? 'cursor-sync-line warn' : 'cursor-sync-line'}>{line.text}</p>
}
