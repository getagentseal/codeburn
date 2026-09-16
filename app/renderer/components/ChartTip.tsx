import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/// The app's cursor-following chart tooltip. It renders into `document.body`
/// so no chart has to fight its own overflow, and it clamps to the viewport
/// so a bar at the right or top edge still shows its whole tip.
export function ChartTip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const tipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const width = tipRef.current?.offsetWidth ?? 220
    const height = tipRef.current?.offsetHeight ?? 62
    const gutter = 8
    const cursorGap = 12
    let left = x + cursorGap
    if (left + width > window.innerWidth - gutter) left = x - width - cursorGap
    left = Math.max(gutter, Math.min(left, window.innerWidth - width - gutter))
    let top = y - height - cursorGap
    if (top < gutter) top = y + cursorGap
    top = Math.max(gutter, Math.min(top, window.innerHeight - height - gutter))
    setPosition({ left, top })
  }, [x, y])

  return createPortal(
    <div
      ref={tipRef}
      className={`chart-tip${position ? ' on' : ''}`}
      style={{ position: 'fixed', ...(position ?? { left: 0, top: 0 }) }}
      role="tooltip"
    >
      {children}
    </div>,
    document.body,
  )
}
