import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useEscape } from '../hooks/useEscape'
import { AnchoredSurface } from './AnchoredSurface'
import { Icon } from './icons'

export type DropdownOption = { value: string; label: string; muted?: boolean; note?: string; title?: string }

/** A query box above the options. The caller filters `options` on `value`. */
export type DropdownSearch = { value: string; onChange: (query: string) => void; placeholder: string; ariaLabel: string }

export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  width,
  renderIcon,
  footer,
  search,
  onOpen,
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
  search?: DropdownSearch
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const menuId = `${id}-menu`
  const selected = options.find(option => option.value === value)
  // A search can filter the selected option out; the trigger keeps its name.
  const lastSelected = useRef<DropdownOption | undefined>(undefined)
  if (selected) lastSelected.current = selected
  const last = lastSelected.current
  const label = selected?.label ?? (last && last.value === value ? last.label : value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // With a search box, index -1 is the box itself.
  useEffect(() => {
    if (!open) return
    if (activeIndex < 0) searchRef.current?.focus()
    else optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  useEscape(open, () => close(true))

  const show = (index = selectedIndex) => {
    setActiveIndex(search ? -1 : index)
    setOpen(true)
    onOpen?.()
  }
  const close = (restoreFocus = false) => {
    setOpen(false)
    search?.onChange('')
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
    setActiveIndex(current => search && current + offset < 0 ? -1 : (current + offset + options.length) % options.length)
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
        <span className="dropdown-label">{label}</span>
        <Icon name="chevron-down" className="dropdown-chevron" />
      </button>
      {open && (
        <AnchoredSurface anchor={triggerRef} surfaceRef={menuRef} matchWidth id={menuId} className="pop-menu dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {search && (
            <input
              ref={searchRef}
              className="pop-search"
              type="search"
              aria-label={search.ariaLabel}
              placeholder={search.placeholder}
              value={search.value}
              onChange={event => search.onChange(event.target.value)}
              onFocus={() => setActiveIndex(-1)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  if (options.length > 0) setActiveIndex(0)
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  choose(0)
                } else if (event.key === 'Tab') {
                  close()
                }
              }}
            />
          )}
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={node => { optionRefs.current[index] = node }}
              type="button"
              title={option.title}
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
