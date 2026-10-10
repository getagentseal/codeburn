import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ClaudeConfigOption } from '../lib/payload'
import { CheckIcon, ChevronDown, PersonCircleIcon } from './Icons'
import { t } from '../i18n/index'

/// Port of ScopeSegmentedControl in mac/.../Views/MenuBarContent.swift. Local is this
/// machine; Combined adds every paired device the CLI can reach. The Claude config picker
/// sits beside it and only appears when the CLI reports more than one config directory.

export type Scope = 'local' | 'combined'

const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: 'local', label: 'Local' },
  { id: 'combined', label: 'Combined' },
]

type Props = {
  scope: Scope
  onScope: (scope: Scope) => void
  configs: ClaudeConfigOption[]
  selectedConfigId: string | null
  onConfig: (id: string | null) => void
}

export function ScopeControl({ scope, onScope, configs, selectedConfigId, onConfig }: Props) {
  const radios = useRef<HTMLElement>(null)
  const activeIndex = Math.max(0, SCOPES.findIndex(s => s.id === scope))

  // One tab stop, arrow keys between the two, as the radio-group pattern asks; the period
  // strip above does the same.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : 0
    if (step === 0) return
    event.preventDefault()
    const index = (activeIndex + step + SCOPES.length) % SCOPES.length
    onScope(SCOPES[index].id)
    radios.current?.querySelectorAll('button')[index]?.focus()
  }

  return (
    <div className="scope-wrap">
      <nav className="scope-tabs" role="radiogroup" aria-label={t('Scope')} ref={radios} onKeyDown={onKeyDown}>
        {SCOPES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            className={`period ${scope === s.id ? 'period-active' : ''}`}
            aria-checked={scope === s.id}
            tabIndex={i === activeIndex ? 0 : -1}
            onClick={() => onScope(s.id)}
          >
            {t(s.label)}
          </button>
        ))}
      </nav>
      {configs.length > 1 && (
        <ConfigPicker configs={configs} selectedId={selectedConfigId} onSelect={onConfig} />
      )}
    </div>
  )
}

function ConfigPicker({ configs, selectedId, onSelect }: {
  configs: ClaudeConfigOption[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const label = configs.find(c => c.id === selectedId)?.label ?? t('All')

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (id: string | null) => { onSelect(id); setOpen(false) }

  return (
    <div className="config-picker" ref={ref}>
      <button
        type="button"
        className="config-button"
        title={t('Claude config')}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <PersonCircleIcon size={10} />
        <span className="config-label">{label}</span>
        <ChevronDown size={8} />
      </button>
      {open && (
        <div className="config-menu" role="menu">
          <button type="button" className="config-item" role="menuitem" onClick={() => choose(null)}>
            <span className="config-check">{selectedId === null && <CheckIcon size={9} />}</span>
            All
          </button>
          <div className="config-sep" />
          {configs.map(option => (
            <button
              key={option.id}
              type="button"
              className="config-item"
              role="menuitem"
              title={option.path}
              onClick={() => choose(option.id)}
            >
              <span className="config-check">{selectedId === option.id && <CheckIcon size={9} />}</span>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
