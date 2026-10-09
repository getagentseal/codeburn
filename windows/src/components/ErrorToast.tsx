import { useEffect, useRef } from 'react'
import { XIcon } from './Icons'
import { t } from '../i18n/index'

const AUTO_DISMISS_MS = 8_000

type Props = {
  message: string
  onDismiss: () => void
}

export function ErrorToast({ message, onDismiss }: Props) {
  // Keep the latest handler in a ref so re-renders of the parent do not restart the timer.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    const id = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [message])

  return (
    <div className="error-toast" role="alert">
      <span className="error-toast-text">{message}</span>
      <button type="button" className="error-toast-close" onClick={onDismiss} aria-label={t('Dismiss')}>
        <XIcon size={9} />
      </button>
    </div>
  )
}
