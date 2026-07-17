/**
 * Reflect document visibility onto <html> as the `page-hidden` class so CSS can
 * pause looping animations (the sidebar flame flicker, shimmers) while the window
 * is minimized/occluded — see plain.css. Applies the current state immediately and
 * returns a disposer. Safe when `document` is absent (SSR/tests without jsdom).
 */
export function installPageHiddenClass(): () => void {
  if (typeof document === 'undefined') return () => {}
  const sync = () => {
    document.documentElement.classList.toggle('page-hidden', document.visibilityState === 'hidden')
  }
  sync()
  document.addEventListener('visibilitychange', sync)
  return () => document.removeEventListener('visibilitychange', sync)
}
