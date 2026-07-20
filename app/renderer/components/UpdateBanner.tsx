import { useState } from 'react'

import { updateDownloadUrl, useUpdateStatus } from '../hooks/useUpdateStatus'
import { codeburn } from '../lib/ipc'

const DISMISS_KEY = 'codeburn.updateDismissed'

function readDismissed(): string | null {
  try { return globalThis.localStorage?.getItem(DISMISS_KEY) ?? null } catch { return null }
}

/**
 * Subtle, dismissible "update available" nudge, in the budget-banner visual
 * language. Dismiss persists per release tag (codeburn.updateDismissed), so the
 * same version never nags twice but the next release shows fresh. Download opens
 * the release page via the https-only openExternal bridge. Never auto-installs.
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
        Update available: CodeBurn {status.latestVersion} ·{' '}
        <button type="button" className="set-text-button" onClick={() => { void codeburn.openExternal(updateDownloadUrl(tag)) }}>Download</button>
      </span>
      <button type="button" className="set-text-button" onClick={dismiss}>Dismiss</button>
    </div>
  )
}
