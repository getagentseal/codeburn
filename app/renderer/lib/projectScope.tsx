import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

import { codeburn } from './ipc'
import type { ProjectScopeCatalog, ProjectScopeOption } from './types'

export type DesktopProjectScopeKey = string

export type QuickProjectScope =
  | { kind: 'all' }
  | ({ kind: 'project' } & ProjectScopeOption)

export type QuickProjectScopeContextValue = {
  quickScope: QuickProjectScope
  projectId: string | null
  projectScopeKey: DesktopProjectScopeKey
  projectScopeSelected: boolean
  catalog: ProjectScopeCatalog | null
  catalogRevision: string | null
  catalogLoading: boolean
  catalogError: unknown | null
  loadCatalog: () => Promise<ProjectScopeCatalog | null>
  refreshCatalog: () => Promise<ProjectScopeCatalog | null>
  retryCatalog: () => Promise<ProjectScopeCatalog | null>
  selectProject: (projectId: string) => Promise<boolean>
  clearProjectScope: () => void
}

const ALL_SCOPE: QuickProjectScope = { kind: 'all' }

const defaultContext: QuickProjectScopeContextValue = {
  quickScope: ALL_SCOPE,
  projectId: null,
  projectScopeKey: 'all',
  projectScopeSelected: false,
  catalog: null,
  catalogRevision: null,
  catalogLoading: false,
  catalogError: null,
  loadCatalog: async () => null,
  refreshCatalog: async () => null,
  retryCatalog: async () => null,
  selectProject: async () => false,
  clearProjectScope: () => {},
}

const QuickProjectScopeContext = createContext<QuickProjectScopeContextValue>(defaultContext)

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** `all` is the unscoped sentinel; every concrete ID is namespaced and encoded. */
export function desktopProjectScopeKey(id: string | null | undefined): DesktopProjectScopeKey {
  return id == null ? 'all' : `project:${base64Url(id)}`
}

function optionScope(option: ProjectScopeOption): QuickProjectScope {
  return { kind: 'project', ...option }
}

export function QuickProjectScopeProvider({ children }: { children: ReactNode }) {
  const [quickScope, setQuickScope] = useState<QuickProjectScope>(ALL_SCOPE)
  const [catalog, setCatalog] = useState<ProjectScopeCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<unknown | null>(null)
  const catalogRef = useRef<ProjectScopeCatalog | null>(null)
  const catalogRequestRef = useRef(0)
  const selectionRequestRef = useRef(0)

  const applyCatalog = useCallback((next: ProjectScopeCatalog) => {
    catalogRef.current = next
    setCatalog(next)
    setQuickScope(current => {
      if (current.kind === 'all') return current
      const refreshed = next.options.find(option => option.id === current.id)
      if (refreshed) return optionScope(refreshed)
      return ALL_SCOPE
    })
  }, [])

  const loadCatalog = useCallback(async (): Promise<ProjectScopeCatalog | null> => {
    const request = ++catalogRequestRef.current
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      if (typeof codeburn.getProjectScopeCatalog !== 'function') throw new Error('Project scope catalog is unavailable')
      const next = await codeburn.getProjectScopeCatalog()
      if (catalogRequestRef.current !== request) return catalogRef.current
      applyCatalog(next)
      return next
    } catch (error) {
      if (catalogRequestRef.current === request) {
        setCatalogError(error)
      }
      return null
    } finally {
      if (catalogRequestRef.current === request) setCatalogLoading(false)
    }
  }, [applyCatalog])

  const refreshCatalog = useCallback(async (): Promise<ProjectScopeCatalog | null> => {
    catalogRef.current = null
    setCatalog(null)
    return loadCatalog()
  }, [loadCatalog])

  const selectProject = useCallback(async (projectId: string): Promise<boolean> => {
    const request = ++selectionRequestRef.current
    const currentCatalog = catalogRef.current ?? await loadCatalog()
    if (!currentCatalog || selectionRequestRef.current !== request) return false

    try {
      if (typeof codeburn.validateProjectScope !== 'function') throw new Error('Project scope validation is unavailable')
      const selected = await codeburn.validateProjectScope(projectId, currentCatalog.revision)
      if (selectionRequestRef.current !== request) return false
      if (catalogRef.current?.revision !== currentCatalog.revision) {
        await refreshCatalog()
        return false
      }
      setQuickScope(optionScope(selected))
      return true
    } catch {
      // A stale revision or hidden option fails closed while the fresh catalog
      // is retrieved; the error state leaves retry available to the picker.
      if (selectionRequestRef.current === request) {
        await refreshCatalog()
      }
      return false
    }
  }, [loadCatalog, refreshCatalog])

  const clearProjectScope = useCallback(() => {
    selectionRequestRef.current++
    setQuickScope(ALL_SCOPE)
  }, [])

  const projectId = quickScope.kind === 'project' ? quickScope.id : null
  const value = useMemo<QuickProjectScopeContextValue>(() => ({
    quickScope,
    projectId,
    projectScopeKey: desktopProjectScopeKey(projectId),
    projectScopeSelected: quickScope.kind === 'project',
    catalog,
    catalogRevision: catalog?.revision ?? null,
    catalogLoading,
    catalogError,
    loadCatalog,
    refreshCatalog,
    retryCatalog: refreshCatalog,
    selectProject,
    clearProjectScope,
  }), [catalog, catalogError, catalogLoading, clearProjectScope, loadCatalog, projectId, quickScope, refreshCatalog, selectProject])

  return <QuickProjectScopeContext.Provider value={value}>{children}</QuickProjectScopeContext.Provider>
}

export function useQuickProjectScope(): QuickProjectScopeContextValue {
  return useContext(QuickProjectScopeContext)
}
