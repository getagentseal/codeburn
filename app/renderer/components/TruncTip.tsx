import { createElement, useId, useRef, useState, type ReactNode } from 'react'
import { AnchoredSurface } from './AnchoredSurface'
import { useEscape } from '../hooks/useEscape'

/** An element that shows its full text in the shared tooltip surface, on hover
 *  or focus, only while its text is cut off by an ellipsis. */
export function TruncTip({ as = 'span', text, children, ...rest }: { as?: string; text: string; children?: ReactNode } & Record<string, unknown>) {
  const ref = useRef<HTMLElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const id = useId()
  useEscape(open, () => setOpen(false))
  const show = () => {
    const el = ref.current
    if (el && el.scrollWidth > el.clientWidth) setOpen(true)
  }
  return (
    <>
      {createElement(as, { ...rest, ref, 'aria-describedby': open ? id : undefined, onMouseEnter: show, onMouseLeave: () => setOpen(false), onFocus: show, onBlur: () => setOpen(false) }, children ?? text)}
      {open && <AnchoredSurface anchor={ref} surfaceRef={surfaceRef} id={id} className="pop-menu usd-pop trunc-pop" role="tooltip">{text}</AnchoredSurface>}
    </>
  )
}
