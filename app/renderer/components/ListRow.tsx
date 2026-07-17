import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'

export { seriesColorForModel } from '../lib/modelSeries'

/**
 * A `.li` list row: optional rank `.no`, optional model series `.mdot`, a
 * title + sub line `.lx`, an optional right-aligned `.val`. When `onClick` is
 * provided the row becomes a keyboard-operable button and shows the trailing
 * chevron; without it the row is inert and the chevron is omitted (honest).
 * Pass `expanded` on an interactive row to reflect its open/closed state
 * (`aria-expanded`, which also rotates the chevron).
 */
export function ListRow({
  no,
  dotColor,
  title,
  sub,
  value,
  valueClass,
  onClick,
  expanded,
}: {
  no?: ReactNode
  dotColor?: string
  title: ReactNode
  sub?: ReactNode
  value?: ReactNode
  valueClass?: string
  onClick?: () => void
  expanded?: boolean
}) {
  const dot: CSSProperties | undefined = dotColor ? { background: dotColor } : undefined
  const interactive = onClick !== undefined
  const onKeyDown = interactive
    ? (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }
    : undefined
  return (
    <div
      className={interactive ? 'li li-clickable' : 'li'}
      {...(interactive ? { role: 'button', tabIndex: 0, onClick, onKeyDown } : {})}
      {...(interactive && expanded !== undefined ? { 'aria-expanded': expanded } : {})}
    >
      {no !== undefined && <span className="no">{no}</span>}
      {dotColor !== undefined && <span className="mdot" style={dot} />}
      <div className="lx">
        <b>{title}</b>
        {sub !== undefined && <span>{sub}</span>}
      </div>
      {value !== undefined && <span className={valueClass ? `val ${valueClass}` : 'val'}>{value}</span>}
      {interactive && <span className="chev">›</span>}
    </div>
  )
}
