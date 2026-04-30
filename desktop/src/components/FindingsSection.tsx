import { useState } from 'react'
import type { MenubarPayload } from '../lib/payload'
import { computeTipGroups, type TipGroup } from '../lib/tips'
import { invoke } from '@tauri-apps/api/core'

type Props = {
  payload: MenubarPayload
}

export function FindingsSection({ payload }: Props) {
  const [expanded, setExpanded] = useState(true)
  const groups = computeTipGroups(payload)
  const totalSignals = groups.reduce((s, g) => s + g.items.length, 0)
  if (totalSignals === 0) return null

  return (
    <section className="findings-section">
      <button className="findings-header" onClick={() => setExpanded(!expanded)}>
        <div className="findings-header-left">
          <span className="findings-icon section-dot" />
          <span className="findings-title">Tips for you</span>
        </div>
        <div className="findings-header-right">
          <span className="findings-count">{totalSignals} signals</span>
          <span className={`chevron ${expanded ? 'chevron-open' : ''}`}>›</span>
        </div>
      </button>

      {expanded && (
        <div className="findings-body">
          {groups.map(g => g.items.length > 0 && (
            <TipsGroupView key={g.label} group={g} />
          ))}
          {payload.optimize.findingCount > 0 && (
            <button
              className="findings-open-optimize"
              onClick={() => invoke('open_terminal_command', { args: ['optimize'] }).catch(() => {})}
            >
              Open Full Optimize →
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function TipsGroupView({ group }: { group: TipGroup }) {
  return (
    <div className="tips-group">
      <div className="tips-group-header">
        <span className="tips-group-icon">{group.icon}</span>
        <span className="tips-group-label">{group.label}</span>
      </div>
      {group.items.map((item, i) => (
        <div key={i} className="tips-item">
          <span className="tips-bullet" />
          <span className="tips-text">{item.text}</span>
          {item.trailing && <span className="tips-trailing">{item.trailing}</span>}
        </div>
      ))}
    </div>
  )
}
