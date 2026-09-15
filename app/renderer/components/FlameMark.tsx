import { useMemo } from 'react'

import { motionEnabled } from '../lib/motion'
// Pre-scaled 192px cut of the original 880px flame art (53kB vs 712kB, and a 147kB RGBA
// decode instead of 3.1MB). The mark never renders above 76 CSS px, so the
// browser was downscaling the 880px original on every mount; this cut is the
// same art resampled once with lanczos and verified side-by-side at 20/52/76px.
import flame from '../assets/flame-mark.png'

/**
 * Brand flame mark: the exact approved icon art (app/build/icon.png minus the
 * squircle), so the splash, sidebar, About dialog and dock icon are literally
 * one image. `live` gives the mark an all-but-imperceptible idle flicker; the
 * phase is randomized once per mount so a row of flames never metronomes. All
 * motion is gated by motionEnabled().
 */
export function FlameMark({ size = 20, live = false }: { size?: number; live?: boolean }) {
  // Random negative delay so the loop starts mid-cycle at a different point each
  // mount. Computed once; only takes effect when the flicker class is present.
  const flickerStyle = useMemo(() => ({ animationDelay: `-${(Math.random() * 4 + 1).toFixed(2)}s` }), [])
  const flicker = live && motionEnabled()

  return (
    <img
      className={flicker ? 'flamemark fm-flicker' : 'flamemark'}
      style={flicker ? flickerStyle : undefined}
      src={flame}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
