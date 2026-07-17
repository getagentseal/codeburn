import type { ReactNode } from 'react'

/** Dash0-style card: optional `.phead` title strip + `.pbody` content. */
export function Panel({
  title,
  right,
  rightLink,
  className,
  children,
}: {
  title?: ReactNode
  right?: ReactNode
  /** Render the `right` slot as a lavender action link (`.r.link`, e.g. "See all ›"). */
  rightLink?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={className ? `panel ${className}` : 'panel'}>
      {title !== undefined && (
        <div className="phead">
          <b>{title}</b>
          {right !== undefined && <span className={rightLink ? 'r link' : 'r'}>{right}</span>}
        </div>
      )}
      <div className="pbody">
        {children}
      </div>
    </div>
  )
}
