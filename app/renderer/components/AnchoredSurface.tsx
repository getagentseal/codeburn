import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const EDGE = 8
const OFFSET = 6
const MAX_HEIGHT = 320
const MAX_WIDTH = 320
// Below this the menu would show barely two rows: use the space above instead.
const MIN_BELOW = 160

/**
 * Menu or popover rendered into document.body and positioned against its
 * trigger. The card anatomy clips its inner surface to keep the rounded
 * corners, which cut off any menu drawn inside it; a portal puts every anchored
 * surface above that clip. Opens under the trigger's left edge and flips above
 * it when the space below is too short to be usable.
 */
export function AnchoredSurface({
  anchor,
  surfaceRef,
  matchWidth = false,
  className,
  children,
  ...rest
}: {
  anchor: RefObject<HTMLElement | null>
  surfaceRef: RefObject<HTMLDivElement | null>
  /** Take the trigger's width (capped), rather than sizing to the content. */
  matchWidth?: boolean
  className?: string
  children: ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  const [box, setBox] = useState<React.CSSProperties | null>(null)

  useLayoutEffect(() => {
    const place = () => {
      const trigger = anchor.current
      const surface = surfaceRef.current
      if (!trigger || !surface) return
      const rect = trigger.getBoundingClientRect()
      const below = window.innerHeight - rect.bottom - OFFSET - EDGE
      const above = rect.top - OFFSET - EDGE
      const flip = below < MIN_BELOW && above > below
      const room = Math.max(0, flip ? above : below)
      const maxHeight = Math.min(MAX_HEIGHT, room)
      const width = matchWidth ? Math.min(Math.max(rect.width, 160), MAX_WIDTH) : surface.offsetWidth
      setBox({
        position: 'fixed',
        top: flip ? Math.max(EDGE, rect.top - OFFSET - Math.min(surface.offsetHeight, maxHeight)) : rect.bottom + OFFSET,
        left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE)),
        maxHeight,
        // `.pop-menu` is content-box, so an inline width renders 10px wider
        // than the figure the clamp above used. Border-box makes them agree and
        // keeps the edge gutter intact.
        ...(matchWidth ? { width, boxSizing: 'border-box' as const } : {}),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, matchWidth, surfaceRef])

  return createPortal(
    <div
      {...rest}
      ref={surfaceRef}
      className={className}
      // Measured on the first layout pass; keep it off-screen until then so the
      // unplaced frame never flashes at the top-left corner.
      style={box ?? { position: 'fixed', top: -9999, left: -9999, maxHeight: MAX_HEIGHT }}
    >
      {children}
    </div>,
    document.body,
  )
}
