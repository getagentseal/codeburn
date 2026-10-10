import { WarningIcon } from './Icons'
import { t } from '../i18n/index'

/// Port of FetchErrorOverlay in mac/.../Views/MenuBarContent.swift. Shown in place of the
/// loading overlay when the fetch failed and there is nothing cached to fall back on, so a
/// failed CLI run reads as a failure with a way out rather than an endless spinner.

const MAX_MESSAGE = 240

type Props = {
  message: string
  periodLabel: string
  onRetry: () => void
}

export function FetchErrorOverlay({ message, periodLabel, onRetry }: Props) {
  const trimmed = message.trim()
  const shown = trimmed.length <= MAX_MESSAGE ? trimmed : `${trimmed.slice(0, MAX_MESSAGE)}…`

  return (
    <div className="fetch-error-overlay" role="alert">
      <div className="fetch-error-content">
        <WarningIcon size={28} className="fetch-error-icon" />
        <div className="fetch-error-title">Couldn't load {periodLabel}</div>
        <div className="fetch-error-message">{shown}</div>
        <button type="button" className="btn btn-prominent" onClick={onRetry}>{t('Retry')}</button>
      </div>
    </div>
  )
}
