import type { ReactNode } from 'react'

/** The canonical empty/placeholder note: muted text at one size. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p style={{ color: 'var(--mut)', margin: 0, fontSize: 12 }}>{children}</p>
}
