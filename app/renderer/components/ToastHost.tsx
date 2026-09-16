import { useEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { getToast, isPrimaryHost, registerToastHost, subscribeToasts, type Toast } from '../lib/toast'
import { DUR, motionClass, motionEnabled } from '../lib/motion'

/** Bottom-right toast surface for action feedback. One at a time, role=status,
 * rising from the edge when motion is on, auto-dismissed by the store. The
 * store drops a toast the instant it expires, so the host keeps the last one on
 * screen for --dur-base to fade it out. Ref-counted so only the primary host
 * paints even if more than one is mounted. */
export function ToastHost() {
  const idRef = useRef(0)
  const [, force] = useReducer((n: number) => n + 1, 0)
  const [leaving, setLeaving] = useState<Toast | null>(null)
  const shown = useRef<Toast | null>(null)

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

  useEffect(() => {
    const previous = shown.current
    shown.current = toast
    if (toast || !previous || !motionEnabled()) {
      setLeaving(null)
      return
    }
    setLeaving(previous)
    const timer = window.setTimeout(() => setLeaving(null), DUR.base)
    return () => window.clearTimeout(timer)
  }, [toast])

  const painted = toast ?? leaving
  if (typeof document === 'undefined' || !isPrimaryHost(idRef.current) || !painted) return null

  return createPortal(
    <div className="toast-host" aria-live="polite">
      <div
        key={painted.id}
        className={motionClass(`toast toast-${painted.kind}`, toast ? 'toast-in' : 'toast-out')}
        role="status"
      >
        {painted.text}
      </div>
    </div>,
    document.body,
  )
}
