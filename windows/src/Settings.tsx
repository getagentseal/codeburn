import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { EMPTY_QUOTA, subscribeQuota, summaryFor, type QuotaState } from './lib/quota'
import { cacheThemeAndAccent, subscribeSettings } from './lib/appSettings'
import { accentById, applyAccent } from './lib/accent'
import { applyTheme } from './lib/settings'
import { ProviderGlyph } from './providerIcons'
import { GeneralPane } from './settings/GeneralPane'
import { ProviderPane } from './settings/ProviderPane'
import { AboutPane } from './settings/AboutPane'
import { t } from './i18n'

/// The System Settings shell from mac/.../Views/SettingsView.swift: a fixed sidebar with a
/// provider search, General and About, then one row per provider that has a live quota
/// adapter, driving a detail pane on the right.

/// The fourteen readers `codeburn quota` registers, in the CLI's own order. Only a fallback: the
/// quota store's answer is what the sidebar normally lists, so a provider the CLI grows
/// appears here without a code change.
const KNOWN_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'kimi', name: 'Kimi' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'zai', name: 'Z.ai' },
  { id: 'grok', name: 'Grok' },
  { id: 'clinepass', name: 'ClinePass' },
  { id: 'devin', name: 'Devin' },
  { id: 'commandcode', name: 'Command Code' },
]

const MAIN_PANES = ['general', 'about']

export function Settings() {
  const [quota, setQuota] = useState<QuotaState>(EMPTY_QUOTA)
  const [pane, setPane] = useState('general')
  const [anchor, setAnchor] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => subscribeQuota(setQuota), [])

  // This window renders from the same tokens as the popover, so it follows a theme or an
  // accent changed anywhere else: the tray's theme item, or the popover's More menu. Its own
  // controls apply the change as they make it; this is what keeps it honest when it was not
  // the one that made it.
  useEffect(() => subscribeSettings(next => {
    applyTheme(next.theme === 'system' ? null : next.theme)
    applyAccent(accentById(next.accent))
    cacheThemeAndAccent(next)
  }), [])

  // Where the tray item or the popover asked for. Taken once on mount, because an event
  // emitted while this webview was still loading would have had nobody to hear it.
  useEffect(() => {
    invoke<string | null>('settings_section').then(applySection).catch(() => {})
    const unlisten = listen<string>('codeburn://settings-section', event => applySection(event.payload))
    return () => { unlisten.then(fn => fn()) }
  }, [])

  const applySection = (section: string | null) => {
    if (!section) return
    const [target, hash] = section.split('#')
    setPane(target || 'general')
    setAnchor(hash ?? null)
  }

  const providers = useMemo(() => {
    const live = quota.providers.map(p => ({ id: p.id, name: p.name }))
    return live.length > 0 ? live : KNOWN_PROVIDERS
  }, [quota.providers])

  const isConnected = (id: string) => {
    const summary = summaryFor(quota, id)
    return summary !== null && (summary.connection === 'connected' || summary.connection === 'stale')
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return providers
    return providers.filter(p => p.name.toLowerCase().includes(query))
  }, [providers, search])

  const paneTitle = pane === 'general'
    ? t('General')
    : pane === 'about'
      ? t('About')
      : providers.find(p => p.id === pane)?.name ?? t('Settings')

  // The mac names the window after the visible pane; so does this one.
  useEffect(() => {
    getCurrentWindow().setTitle(`${paneTitle} - CodeBurn`).catch(() => {})
  }, [paneTitle])

  // A deep link that names a pane which is not there (an older build, a provider the CLI
  // dropped) falls back to General rather than leaving the sidebar with no selection.
  const selected = MAIN_PANES.includes(pane) || providers.some(p => p.id === pane) ? pane : 'general'
  const connectedCount = providers.filter(p => isConnected(p.id)).length

  const choose = (id: string) => {
    setPane(id)
    setAnchor(null)
  }

  return (
    <div className="stg">
      <nav className="stg-sidebar" aria-label={t('Settings sections')}>
        <div className="stg-search">
          <input
            type="search"
            className="stg-search-field"
            placeholder={t('Search providers')}
            aria-label={t('Search providers')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <ul className="stg-list">
          <li>
            <SidebarRow
              label={t('General')}
              selected={selected === 'general'}
              onSelect={() => choose('general')}
              icon={<span className="stg-chip stg-chip-general" aria-hidden="true">CB</span>}
            />
          </li>
          <li>
            <SidebarRow
              label={t('About')}
              selected={selected === 'about'}
              onSelect={() => choose('about')}
              icon={<span className="stg-chip stg-chip-about" aria-hidden="true">i</span>}
            />
          </li>
        </ul>

        <div className="stg-list-header">
          <span>{t('Providers')}</span>
          <span className="stg-list-count">{t('%lld on', connectedCount)}</span>
        </div>
        <ul className="stg-list">
          {filtered.map(provider => (
            <li key={provider.id}>
              <SidebarRow
                label={provider.name}
                selected={selected === provider.id}
                dimmed={!isConnected(provider.id)}
                onSelect={() => choose(provider.id)}
                icon={<span className="stg-glyph"><ProviderGlyph id={provider.id} size={15} /></span>}
                trailing={isConnected(provider.id) ? <span className="stg-dot" aria-label={t('Connected')} /> : null}
              />
            </li>
          ))}
          {filtered.length === 0 && <li className="stg-list-empty">{t('No provider matches that.')}</li>}
        </ul>
      </nav>

      <main className="stg-detail">
        {selected === 'general' && <GeneralPane quota={quota} anchor={anchor} />}
        {selected === 'about' && <AboutPane anchor={anchor} />}
        {!MAIN_PANES.includes(selected) && (
          <ProviderPane
            key={selected}
            id={selected}
            name={providers.find(p => p.id === selected)?.name ?? selected}
            quota={quota}
          />
        )}
      </main>
    </div>
  )
}

function SidebarRow({ label, icon, selected, dimmed = false, trailing, onSelect }: {
  label: string
  icon: ReactNode
  selected: boolean
  dimmed?: boolean
  trailing?: ReactNode
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={`stg-row-btn ${selected ? 'stg-row-btn-active' : ''} ${dimmed ? 'stg-row-btn-dim' : ''}`}
      aria-current={selected ? 'page' : undefined}
      onClick={onSelect}
    >
      {icon}
      <span className="stg-row-name">{label}</span>
      {trailing}
    </button>
  )
}
