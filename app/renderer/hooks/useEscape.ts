import { useEffect } from 'react'

/** Escape closes the overlay. One document-level listener for every overlay in
 *  the app so a dropdown, popover, calendar, drawer and modal all behave alike. */
export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEscape()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [active, onEscape])
}
