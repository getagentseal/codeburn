import type { ReactNode } from 'react'

/** The canonical empty/placeholder note: muted text at one size. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="empty-note">{children}</p>
}
