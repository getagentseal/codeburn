import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'

export type Provider = 'all' | 'claude' | 'cursor' | 'codex' | 'copilot' | 'opencode' | 'pi'

const ALL_PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'all',      label: 'All'      },
  { id: 'claude',   label: 'Claude'   },
  { id: 'cursor',   label: 'Cursor'   },
  { id: 'codex',    label: 'Codex'    },
  { id: 'copilot',  label: 'Copilot'  },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'pi',       label: 'Pi'       },
]

type Props = {
  selected: Provider
  onSelect: (p: Provider) => void
  payload: MenubarPayload
  currency: CurrencyState
}

export function AgentTabStrip({ selected, onSelect, payload, currency }: Props) {
  const detected = payload.current.providers
  const visible = ALL_PROVIDERS.filter(
    p => p.id === 'all' || p.id in detected,
  )

  if (visible.length <= 1) return null

  return (
    <nav className="agent-tabs">
      {visible.map(p => {
        const cost = p.id === 'all' ? 0 : (detected[p.id] ?? 0)
        return (
          <button
            key={p.id}
            className={`tab ${selected === p.id ? 'tab-active' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="tab-label">{p.label}</span>
            {cost > 0 && (
              <span className="tab-cost">{formatCompactCurrency(cost, currency)}</span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
