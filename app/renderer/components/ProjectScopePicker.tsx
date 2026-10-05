import { useEffect, useRef, useState } from 'react'

import { t } from '../i18n'
import { useEscape } from '../hooks/useEscape'
import { useQuickProjectScope } from '../lib/projectScope'
import { projectDisplayLines } from '../lib/projectDisplay'
import type { ProjectScopeOption } from '../lib/types'
import { AnchoredSurface } from './AnchoredSurface'
import { Icon } from './icons'

type PickerOption =
  | { kind: 'all' }
  | { kind: 'project'; option: ProjectScopeOption }

function optionLabel(option: PickerOption): string {
  return option.kind === 'all'
    ? t('shell.projectScope.all')
    : projectDisplayLines(option.option).primary
}

function optionPath(option: PickerOption): string | null {
  return option.kind === 'project' ? option.option.path : null
}

function optionPattern(option: PickerOption): string | null {
  return option.kind === 'project' ? projectDisplayLines(option.option).pattern : null
}

function accessibleOptionLabel(option: PickerOption): string {
  const label = optionLabel(option)
  const pattern = optionPattern(option)
  if (pattern) return `${label}, ${pattern}`
  return option.kind === 'project' ? `${label}, ${t('shell.projectScope.pathUnavailable')}` : label
}

function searchableText(option: ProjectScopeOption): string {
  return `${option.name} ${option.path ?? ''}`.toLocaleLowerCase()
}

export function ProjectScopePicker() {
  const {
    quickScope,
    catalog,
    catalogRevision,
    catalogLoading,
    catalogError,
    loadCatalog,
    retryCatalog,
    selectProject,
    clearProjectScope,
  } = useQuickProjectScope()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [selectionError, setSelectionError] = useState(false)
  const [selectingId, setSelectingId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = 'project-scope-menu'

  const projectOptions = catalog?.options ?? []
  const needle = query.trim().toLocaleLowerCase()
  const filteredProjects = needle
    ? projectOptions.filter(option => searchableText(option).includes(needle))
    : projectOptions
  const options: PickerOption[] = [
    { kind: 'all' },
    ...filteredProjects.map(option => ({ kind: 'project' as const, option })),
  ]

  const selectedLabel = quickScope.kind === 'all'
    ? t('shell.projectScope.all')
    : projectDisplayLines(quickScope).primary
  const selectedPath = quickScope.kind === 'project' ? quickScope.path : null
  const selectedPattern = quickScope.kind === 'project' ? projectDisplayLines(quickScope).pattern : null
  const selectedAccessible = selectedPath
    ? `${selectedLabel}, ${selectedPattern ?? selectedPath}`
    : quickScope.kind === 'project'
    ? `${selectedLabel}, ${t('shell.projectScope.pathUnavailable')}`
    : selectedLabel
  const triggerAccessibleLabel = t('shell.projectScope.trigger', { project: selectedAccessible })

  const close = (restoreFocus = false) => {
    setOpen(false)
    setQuery('')
    setActiveIndex(0)
    setSelectionError(false)
    setSelectingId(null)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const openPicker = () => {
    setOpen(true)
    setQuery('')
    setActiveIndex(0)
    setSelectionError(false)
    if (!catalog && !catalogLoading && !catalogError) void loadCatalog()
  }

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!wrapRef.current?.contains(target) && !surfaceRef.current?.contains(target)) close()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEscape(open, () => close(true))

  const previousCatalogRevision = useRef<string | null>(null)
  useEffect(() => {
    const reloading = previousCatalogRevision.current !== null && catalogLoading && catalog === null
    const changed = previousCatalogRevision.current !== null
      && catalogRevision !== null
      && catalogRevision !== previousCatalogRevision.current
    if (open && (reloading || changed)) close(true)
    previousCatalogRevision.current = catalogRevision
  }, [catalog, catalogLoading, catalogRevision, open])

  const focusOption = (index: number) => {
    const next = Math.max(0, Math.min(index, options.length - 1))
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
  }

  const moveOption = (offset: number) => {
    if (options.length === 0) return
    const next = (activeIndex + offset + options.length) % options.length
    focusOption(next)
  }

  const choose = async (option: PickerOption) => {
    if (catalogLoading || catalogError || selectingId !== null) return
    if (option.kind === 'all') {
      clearProjectScope()
      close(true)
      return
    }

    setSelectionError(false)
    setSelectingId(option.option.id)
    const selected = await selectProject(option.option.id)
    setSelectingId(null)
    if (selected) close(true)
    else setSelectionError(true)
  }

  const retry = async () => {
    setSelectionError(false)
    const next = await retryCatalog()
    if (!next) setSelectionError(true)
  }

  const hasNoPermittedProjects = catalog != null && projectOptions.length === 0
  const hasNoMatches = catalog != null && projectOptions.length > 0 && needle.length > 0 && filteredProjects.length === 0
  const showError = !catalogLoading && (catalogError != null || selectionError)

  return (
    <div className="pop-wrap dropdown project-scope-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="pop dropdown-trigger project-scope-trigger"
        aria-label={triggerAccessibleLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        title={selectedPath ?? undefined}
        onClick={() => open ? close() : openPicker()}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) openPicker()
            else focusOption(event.key === 'ArrowDown' ? 0 : options.length - 1)
          }
        }}
      >
        <Icon name="folder" />
        <span className="dropdown-label project-scope-trigger-label">{selectedLabel}</span>
        <Icon name="chevron-down" className="dropdown-chevron" />
      </button>
      {open && (
        <AnchoredSurface
          anchor={triggerRef}
          surfaceRef={surfaceRef}
          matchWidth
          id={menuId}
          className="pop-menu dropdown-menu project-scope-menu"
          role="listbox"
          aria-label={t('shell.projectScope.trigger', { project: t('shell.projectScope.all') })}
          aria-busy={catalogLoading}
        >
          <label className="sr-only" htmlFor="project-scope-search">{t('shell.projectScope.search')}</label>
          <input
            ref={searchRef}
            id="project-scope-search"
            className="project-scope-search"
            type="search"
            role="searchbox"
            placeholder={t('shell.projectScope.search')}
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusOption(0)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                focusOption(options.length - 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close(true)
              }
            }}
          />

          <div className="project-scope-options">
            {options.map((option, index) => {
              const path = optionPath(option)
              const pattern = optionPattern(option)
              const projectId = option.kind === 'project' ? option.option.id : null
              const isSelected = option.kind === 'all'
                ? quickScope.kind === 'all'
                : quickScope.kind === 'project' && quickScope.id === projectId
              const disabled = catalogLoading || catalogError != null || selectingId !== null
              return (
                <button
                  key={option.kind === 'all' ? 'all' : option.option.id}
                  ref={node => { optionRefs.current[index] = node }}
                  type="button"
                  className={`pop-item project-scope-option${isSelected ? ' on' : ''}`}
                  role="option"
                  aria-label={accessibleOptionLabel(option)}
                  aria-selected={isSelected}
                  tabIndex={index === activeIndex ? 0 : -1}
                  title={path ?? undefined}
                  disabled={disabled}
                  onClick={() => void choose(option)}
                  onFocus={() => setActiveIndex(index)}
                  onKeyDown={event => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      moveOption(event.key === 'ArrowDown' ? 1 : -1)
                    } else if (event.key === 'Home' || event.key === 'End') {
                      event.preventDefault()
                      focusOption(event.key === 'Home' ? 0 : options.length - 1)
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      void choose(option)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      close(true)
                    } else if (event.key === 'Tab') {
                      close()
                    }
                  }}
                >
                  <span className="project-scope-option-copy">
                    <span className="project-scope-option-name">{optionLabel(option)}</span>
                    {option.kind === 'project' && (
                      <span className="project-scope-option-path">
                        {pattern ?? t('shell.projectScope.pathUnavailable')}
                      </span>
                    )}
                  </span>
                  {isSelected && <span className="project-scope-option-check" aria-hidden="true">✓</span>}
                </button>
              )
            })}
          </div>

          {catalogLoading && <p className="project-scope-status" role="status">{t('shell.projectScope.loading')}</p>}
          {showError && (
            <div className="project-scope-status project-scope-error" role="alert">
              <span>{t('shell.projectScope.loadError')}</span>
              <button type="button" className="project-scope-retry" onClick={() => void retry()}>{t('shell.projectScope.retry')}</button>
            </div>
          )}
          {!catalogLoading && !showError && hasNoPermittedProjects && (
            <p className="project-scope-status" role="status">{t('shell.projectScope.noPermitted')}</p>
          )}
          {!catalogLoading && !showError && !hasNoPermittedProjects && hasNoMatches && (
            <p className="project-scope-status" role="status">{t('shell.projectScope.noMatches')}</p>
          )}
          {!catalogLoading && !showError && catalog != null && (
            <div className="project-scope-footer">{t('shell.projectScope.footer')}</div>
          )}
        </AnchoredSurface>
      )}
    </div>
  )
}
