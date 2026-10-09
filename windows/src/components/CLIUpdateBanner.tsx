import { useEffect, useState } from 'react'

import { EMPTY_UPDATE, subscribeUpdate, type UpdateState } from '../lib/update'
import { ArrowUpRightCircleIcon, CheckIcon, CopyIcon } from './Icons'
import { t } from '../i18n/index'

/// Port of CLIUpdateBanner in mac/.../Views/MenuBarContent.swift: a strip under the footer
/// when the installed codeburn is behind the latest release. One way out of it now, the one
/// the mac also offers: the command itself, copyable, to run in a terminal. The tray app
/// does not run npm on the reader's behalf; see src-tauri/src/update.rs for why.

export function CLIUpdateBanner() {
  const [update, setUpdate] = useState<UpdateState>(EMPTY_UPDATE)
  const [copied, setCopied] = useState(false)
  useEffect(() => subscribeUpdate(setUpdate), [])

  const status = update.status
  if (!status?.cliUpdateAvailable) return null
  const command = status.cliUpdateCommand

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="cli-banner">
      <span className="cli-banner-icon" aria-hidden="true"><ArrowUpRightCircleIcon size={11} /></span>
      <span className="cli-banner-text">CLI v{status.latestCliVersion} available, run</span>
      <button
        type="button"
        className="cli-banner-copy"
        title={t('Copy the update command to the clipboard')}
        aria-label={`Copy ${command} to the clipboard`}
        onClick={copy}
      >
        <code>{command}</code>
        {copied ? <CheckIcon size={9} /> : <CopyIcon size={9} />}
      </button>
      <span className="cli-banner-spacer" />
    </div>
  )
}
