import { useState } from 'react'
import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { computeTipGroups, type TipGroup } from '../lib/tips'
import { plural } from '../lib/currency'
import { ArrowForward, ArrowUpRightCircleIcon, BulbIcon, CheckCircleIcon, ChevronRight, WarningIcon } from './Icons'
import { t } from '../i18n/index'

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
  onOpenTerminal: (args: string[]) => void
}

export function FindingsSection({ payload, currency, onOpenTerminal }: Props) {
  const [expanded, setExpanded] = useState(true)
  const groups = computeTipGroups(payload, currency)
  const totalSignals = groups.reduce((s, g) => s + g.items.length, 0)
  if (totalSignals === 0) return null

  return (
    <section className="findings-wrap">
      <div className="findings-card">
        <button type="button" className="findings-header" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
          <span className="findings-header-left">
            <BulbIcon size={11} className="findings-icon" />
            <span className="findings-title">{t('Tips for you')}</span>
          </span>
          <span className="findings-header-right">
            <span className="findings-count">{plural(totalSignals, 'signal')}</span>
            <ChevronRight size={9} className={`chevron ${expanded ? 'chevron-open' : ''}`} />
          </span>
        </button>

        {expanded && (
          <div className="findings-body">
            {groups.map(g => g.items.length > 0 && <TipsGroupView key={g.label} group={g} />)}
            {payload.optimize.findingCount > 0 && (
              <button type="button" className="findings-open-optimize" onClick={() => onOpenTerminal(['optimize'])}>
                <span>{t('Open Full Optimize')}</span>
                <ArrowForward size={9} />
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function GroupIcon({ icon }: { icon: string }) {
  if (icon === 'check') return <CheckCircleIcon size={10} />
  if (icon === 'up') return <ArrowUpRightCircleIcon size={10} />
  return <WarningIcon size={10} />
}

function TipsGroupView({ group }: { group: TipGroup }) {
  return (
    <div className="tips-group">
      <div className="tips-group-header">
        <GroupIcon icon={group.icon} />
        <span>{group.label}</span>
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
