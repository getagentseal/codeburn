import { useEffect, useReducer, useRef } from 'react'
import { createPortal } from 'react-dom'

import { getToast, isPrimaryHost, registerToastHost, subscribeToasts } from '../lib/toast'
import { motionClass } from '../lib/motion'

/** Bottom-right toast surface for action feedback. One at a time, role=status,
 * slide-in when motion is on, auto-dismissed by the store. Ref-counted so only
 * the primary host paints even if more than one is mounted. */
export function ToastHost() {
  const idRef = useRef(0)
  const [, force] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    const { id, release } = registerToastHost()
    idRef.current = id
    const unsubscribe = subscribeToasts(force)
    force()
    return () => {
      release()
      unsubscribe()
    }
  }, [])

  const toast = getToast()
  if (typeof document === 'undefined' || !isPrimaryHost(idRef.current) || !toast) return null

  return createPortal(
    <div className="toast-host" aria-live="polite">
      <div key={toast.id} className={motionClass(`toast toast-${toast.kind}`, 'toast-in')} role="status">
        {toast.text}
      </div>
    </div>,
    document.body,
  )
}
