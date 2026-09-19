import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useEscape } from '../hooks/useEscape'
import { AnchoredSurface } from './AnchoredSurface'
import { Icon } from './icons'

export type DropdownOption = { value: string; label: string; muted?: boolean; note?: string }

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  width,
  renderIcon,
  footer,
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  ariaLabel: string
  id: string
  width?: React.CSSProperties['width']
  /** Optional leading glyph (e.g. a provider logo) shown in the trigger and each option. */
  renderIcon?: (value: string) => ReactNode
  /** Optional non-interactive note pinned below the options in the open menu. */
  footer?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = `${id}-menu`
  const selected = options.find(option => option.value === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  useEscape(open, () => close(true))

  const show = (index = selectedIndex) => {
    setActiveIndex(index)
    setOpen(true)
  }
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }
  const choose = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    close(true)
  }
  const move = (offset: number) => {
    if (options.length === 0) return
    setActiveIndex(current => (current + offset + options.length) % options.length)
  }

  return (
    <div className="pop-wrap dropdown" ref={wrapRef} style={{ width: 'max-content', minWidth: width }}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className="pop dropdown-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => open ? close() : show()}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (open) choose(activeIndex)
            else show()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show(event.key === 'ArrowDown' ? selectedIndex : Math.max(0, options.length - 1))
          }
        }}
      >
        {renderIcon?.(value)}
        <span className="dropdown-label">{selected?.label ?? value}</span>
        <Icon name="chevron-down" className="dropdown-chevron" />
      </button>
      {open && (
        <AnchoredSurface anchor={triggerRef} surfaceRef={menuRef} matchWidth id={menuId} className="pop-menu dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={node => { optionRefs.current[index] = node }}
              type="button"
              className={`pop-item${option.value === value ? ' on' : ''}${option.muted ? ' muted' : ''}`}
              role="option"
              aria-selected={option.value === value}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => choose(index)}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  move(event.key === 'ArrowDown' ? 1 : -1)
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  setActiveIndex(event.key === 'Home' ? 0 : options.length - 1)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  choose(index)
                } else if (event.key === 'Tab') {
                  close()
                }
              }}
            >
              {renderIcon?.(option.value)}
              <span className="pop-item-label">{option.label}</span>
              {option.note && <span className="pop-item-note">{option.note}</span>}
            </button>
          ))}
          {footer && <div className="dropdown-foot">{footer}</div>}
        </AnchoredSurface>
      )}
    </div>
  )
}
