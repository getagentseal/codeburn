import { useState } from 'react'

import { t } from '../i18n'
import { updateDownloadUrl, useUpdateStatus } from '../hooks/useUpdateStatus'
import { codeburn } from '../lib/ipc'
import type { UpdateStatus } from '../lib/types'

const DISMISS_KEY = 'codeburn.updateDismissed'

function readDismissed(): string | null {
  try { return globalThis.localStorage?.getItem(DISMISS_KEY) ?? null } catch { return null }
}

/** The one button an available update gets: Update, then Restart to update where the
 *  install can replace itself, else Download, which opens the release via openExternal. */
export function UpdateAction({ status, downloadLabel }: { status: UpdateStatus; downloadLabel: string }) {
  if (status.install === 'downloading') return <span>{t('shared.update.downloading')}</span>
  if (status.install === 'ready') {
    return <button type="button" className="set-text-button" onClick={() => { void codeburn.installUpdate?.() }}>{t('shared.update.restart')}</button>
  }
  if (status.install === 'available' && codeburn.downloadUpdate) {
    return <button type="button" className="set-text-button" onClick={() => { void codeburn.downloadUpdate?.() }}>{t('shared.update.install')}</button>
  }
  const tag = status.tag
  if (!tag) return null
  return <button type="button" className="set-text-button" onClick={() => { void codeburn.openExternal(updateDownloadUrl(tag)) }}>{downloadLabel}</button>
}

/**
 * Subtle, dismissible "update available" nudge, in the budget-banner visual
 * language. Dismiss persists per release tag (codeburn.updateDismissed), so the
 * same version never nags twice but the next release shows fresh. Nothing
 * downloads until the reader clicks.
 */
export function UpdateBanner() {
  const status = useUpdateStatus()
  const [dismissedTag, setDismissedTag] = useState<string | null>(readDismissed)

  if (!status || !status.updateAvailable || !status.tag) return null
  if (dismissedTag === status.tag) return null

  const tag = status.tag
  const dismiss = () => {
    try { globalThis.localStorage?.setItem(DISMISS_KEY, tag) } catch { /* storage can be unavailable */ }
    setDismissedTag(tag)
  }

  return (
    <div role="status" className="update-banner">
      <span>
        {t('shell.update.available', { version: status.latestVersion ?? '' })}{' '}
        <UpdateAction status={status} downloadLabel={t('shell.action.download')} />
      </span>
      <button type="button" className="set-text-button" onClick={dismiss}>{t('shell.action.dismiss')}</button>
    </div>
  )
}
