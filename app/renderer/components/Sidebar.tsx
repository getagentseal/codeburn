import { useEffect, useState, type ReactNode } from 'react'

import { t } from '../i18n'
import { displayVersion, isIdeHost, isModifierChord, shortcutLabel } from '../lib/platform'
import { AboutModal } from './AboutModal'
import { Icon } from './icons'

export type Section = 'overview' | 'sessions' | 'pullRequests' | 'spend' | 'optimize' | 'models' | 'compare' | 'periods' | 'plans' | 'settings' | 'plugins'

type NavItem = { id: Section; label: string; key: string; icon: ReactNode }

/** Grouped by what the screen is for, not by shortcut: every key below is the
 *  one it has always been, only the order they are listed in changed.
 *  A function, not a module-level constant: it must re-read t() on every call
 *  so a language switch (which remounts the app subtree, not the module) is
 *  reflected. */
export function navGroups(): Array<{ label?: string; items: NavItem[] }> {
  return [
    {
      items: [{ id: 'overview', label: t('shell.nav.overview'), key: '1', icon: <Icon name="layout-dashboard" /> }],
    },
    {
      label: t('shell.navGroup.usage'),
      items: [
        { id: 'sessions', label: t('shell.nav.sessions'), key: '2', icon: <Icon name="list" /> },
        { id: 'pullRequests', label: t('shell.nav.pullRequests'), key: '3', icon: <Icon name="git-pull-request" /> },
        { id: 'spend', label: t('shell.nav.spend'), key: '4', icon: <Icon name="coins" /> },
        { id: 'models', label: t('shell.nav.models'), key: '6', icon: <Icon name="box" /> },
      ],
    },
    {
      label: t('shell.navGroup.insight'),
      items: [
        { id: 'optimize', label: t('shell.nav.optimize'), key: '5', icon: <Icon name="sparkles" /> },
        { id: 'compare', label: t('shell.nav.compare'), key: '7', icon: <Icon name="scale" /> },
        { id: 'periods', label: t('shell.nav.periods'), key: '9', icon: <Icon name="calendar-range" /> },
      ],
    },
    {
      label: t('shell.navGroup.account'),
      items: [
        { id: 'plans', label: t('shell.nav.plans'), key: '8', icon: <Icon name="credit-card" /> },
        { id: 'plugins', label: t('shell.nav.plugins'), key: '.', icon: <Icon name="puzzle" /> },
        { id: 'settings', label: t('shell.nav.settings'), key: ',', icon: <Icon name="settings" /> },
      ],
    },
  ]
}

export function Sidebar({
  active,
  onNavigate,
}: {
  active: Section
  onNavigate: (section: Section) => void
  status?: ReactNode
}) {
  // A count, not a flag: every open is a fresh key, so reopening the modal
  // mid-fade cancels the exit instead of being closed by its pending timer.
  const [aboutOpens, setAboutOpens] = useState(0)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  useEffect(() => { writeCollapsed(collapsed) }, [collapsed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isModifierChord(event) || event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      setCollapsed(value => !value)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <nav className={collapsed ? 'sb collapsed' : 'sb'}>
        <div className="app">
          <b className="flame-text">CodeBurn</b>
          <button
            type="button"
            className="sb-collapse"
            aria-label={collapsed ? t('shell.sidebar.expand') : t('shell.sidebar.collapse')}
            aria-expanded={!collapsed}
            data-tip={`${collapsed ? t('shell.sidebar.expand') : t('shell.sidebar.collapse')}${chord('B')}`}
            onClick={() => setCollapsed(value => !value)}
          >
            <Icon name={collapsed ? 'panel-left-open' : 'panel-left-close'} />
          </button>
        </div>
        {navGroups().map(group => (
          <div className="grp" key={group.label ?? 'top'}>
            {group.label ? <div className="grp-label">{group.label}</div> : null}
            {group.items.map(item => (
              <div
                key={item.id}
                className={item.id === active ? 'ni on' : 'ni'}
                role="button"
                aria-current={item.id === active ? 'page' : undefined}
                data-tip={`${item.label}${chord(item.key)}`}
                title={`${item.label}${chord(item.key)}`}
                tabIndex={0}
                onClick={() => onNavigate(item.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onNavigate(item.id)
                  }
                }}
              >
                {item.icon}
                <span className="ni-label">{item.label}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="push" />
        <div className="foot">
          <a className="about" href="#about" data-tip={t('shell.sidebar.about')} onClick={event => { event.preventDefault(); setAboutOpens(opens => opens + 1) }}>
            <Icon name="info" />
            <span className="ni-label">{t('shell.sidebar.about')}</span>
            <span className="ver">v{displayVersion()}</span>
          </a>
        </div>
      </nav>
      {aboutOpens > 0 ? <AboutModal openKey={String(aboutOpens)} onClose={() => setAboutOpens(0)} /> : null}
    </>
  )
}

/** The shortcut suffix for a tooltip; none in the IDE, which keeps those chords. */
function chord(key: string): string {
  return isIdeHost() ? '' : ` ${shortcutLabel(key)}`
}

const COLLAPSE_KEY = 'codeburn.sidebarCollapsed'

/** Read at first render, not in an effect, so a collapsed sidebar never paints
 *  wide for a frame before snapping shut. */
function readCollapsed(): boolean {
  try { return globalThis.localStorage?.getItem(COLLAPSE_KEY) === '1' } catch { return false }
}

function writeCollapsed(collapsed: boolean): void {
  try { globalThis.localStorage?.setItem(COLLAPSE_KEY, collapsed ? '1' : '0') } catch { /* storage can be unavailable */ }
}
