import type { ReactNode } from 'react'

/** A `.panel.stat` metric card: label strip + big value + delta line. */
export function Stat({
  label,
  value,
  delta,
}: {
  label: ReactNode
  value: ReactNode
  delta?: ReactNode
}) {
  return (
    <div className="panel stat">
      <div className="phead"><b>{label}</b></div>
      <div className="pbody">
        <div className="v">{value}</div>
        {delta !== undefined && <div className="d">{delta}</div>}
      </div>
    </div>
  )
}
