import type { ReactNode } from 'react'

/** The `.win` shell: sidebar + content area live inside as children. */
export function Window({ children }: { children: ReactNode }) {
  return <div className="win">{children}</div>
}
