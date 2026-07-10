import type { ReactNode } from 'react'

export type HintItem = { k?: string; label: ReactNode }

/** The `.hint` footer strip: keycap hints on the left, optional right-aligned note. */
export function Hint({ items, right }: { items: HintItem[]; right?: ReactNode }) {
  return (
    <div className="hint">
      {items.map((item, i) => (
        <span key={i}>
          {item.k && <span className="k">{item.k}</span>}
          {item.label}
        </span>
      ))}
      {right !== undefined && <span className="r">{right}</span>}
    </div>
  )
}
