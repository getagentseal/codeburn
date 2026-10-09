import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'

import { t } from '../i18n'
import {
  TELEMETRY_DOCS_URL, completeTelemetryConsent, telemetryStatus, type TelemetryStatus,
} from '../lib/telemetry'

/// The one-time consent notice, in the spirit of the desktop app's onboarding screen
/// (app/renderer/components/Onboarding.tsx). It is shown once, on a tray installed on its
/// own: with the desktop app beside it, that app asked the question and this one is bound by
/// the answer. Nothing is recorded or sent until one of these two buttons is pressed.

export function TelemetryNotice({ onDecided }: { onDecided?: (status: TelemetryStatus) => void }) {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)

  useEffect(() => {
    let live = true
    void telemetryStatus().then(next => { if (live) setStatus(next) })
    return () => { live = false }
  }, [])

  if (!status || status.onboarded || status.source !== 'app') return null

  const answer = (enabled: boolean) => {
    void completeTelemetryConsent(enabled).then(next => {
      if (!next) return
      setStatus(next)
      onDecided?.(next)
    })
  }

  return (
    <section className="consent" aria-label={t('Anonymous telemetry')}>
      <h3 className="consent-title">{t('Help improve CodeBurn')}</h3>
      <p className="consent-body">
        Share anonymous usage statistics: which parts of the app get opened, how the Capacity
        Dock is used, and errors. The daily report includes the names of the models, tools,
        skills and MCP servers you use alongside the bucketed counts. Never your prompts, your
        code, or your project and file names.
      </p>
      <button type="button" className="consent-link" onClick={() => { void openUrl(TELEMETRY_DOCS_URL) }}>
        What data we collect
      </button>
      <div className="consent-actions">
        <button type="button" className="btn" onClick={() => answer(false)}>{t('Decline')}</button>
        <button type="button" className="btn btn-prominent" onClick={() => answer(true)}>{t('Accept')}</button>
      </div>
    </section>
  )
}
