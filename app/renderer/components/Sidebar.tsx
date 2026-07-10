import type { ReactNode } from 'react'

export type Section = 'overview' | 'spend' | 'optimize' | 'models' | 'plans' | 'settings'

export const NAV_ITEMS: Array<{ id: Section; label: string; key: string }> = [
  { id: 'overview', label: 'Overview', key: '⌘1' },
  { id: 'spend', label: 'Spend', key: '⌘2' },
  { id: 'optimize', label: 'Optimize', key: '⌘3' },
  { id: 'models', label: 'Models', key: '⌘4' },
  { id: 'plans', label: 'Plans', key: '⌘5' },
  { id: 'settings', label: 'Settings', key: '⌘,' },
]

export function Sidebar({
  active,
  onNavigate,
  status,
}: {
  active: Section
  onNavigate: (section: Section) => void
  status?: ReactNode
}) {
  return (
    <nav className="sb">
      <div className="lights"><i /><i /><i /></div>
      <div className="app"><b>CodeBurn</b></div>
      {NAV_ITEMS.map(item => (
        <div
          key={item.id}
          className={item.id === active ? 'ni on' : 'ni'}
          role="button"
          tabIndex={0}
          onClick={() => onNavigate(item.id)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') onNavigate(item.id)
          }}
        >
          {item.label}
          <span className="k">{item.key}</span>
        </div>
      ))}
      <div className="push" />
      <div className="status">{status}</div>
    </nav>
  )
}
