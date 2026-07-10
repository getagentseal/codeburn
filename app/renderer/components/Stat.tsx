import type { ReactNode } from 'react'

export type StatTone = 'info' | 'bad' | 'hot' | 'ok'

/** A `.panel.stat` metric card: label strip + big value + tinted delta line. */
export function Stat({
  label,
  value,
  delta,
  tone,
}: {
  label: ReactNode
  value: ReactNode
  delta?: ReactNode
  tone?: StatTone
}) {
  return (
    <div className="panel stat">
      <div className="phead"><b>{label}</b></div>
      <div className="pbody">
        <div className="v">{value}</div>
        {delta !== undefined && <div className={tone ? `d ${tone}` : 'd'}>{delta}</div>}
      </div>
    </div>
  )
}
