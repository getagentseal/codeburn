import { useEffect, useState, type ReactNode } from 'react'

import { version } from '../../package.json'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { isModifierChord, shortcutLabel } from '../lib/platform'
import type { CompanionStatus } from '../lib/types'
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
            data-tip={`${collapsed ? t('shell.sidebar.expand') : t('shell.sidebar.collapse')} ${shortcutLabel('B')}`}
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
                data-tip={`${item.label} ${shortcutLabel(item.key)}`}
                title={`${item.label} ${shortcutLabel(item.key)}`}
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
        <CompanionSwitches />
        <div className="foot">
          <a className="about" href="#about" data-tip={t('shell.sidebar.about')} onClick={event => { event.preventDefault(); setAboutOpens(opens => opens + 1) }}>
            <Icon name="info" />
            <span className="ni-label">{t('shell.sidebar.about')}</span>
            <span className="ver">v{version}</span>
          </a>
        </div>
      </nav>
      {aboutOpens > 0 ? <AboutModal openKey={String(aboutOpens)} onClose={() => setAboutOpens(0)} /> : null}
    </>
  )
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

/**
 * The two surfaces the Windows desktop app carries besides its own window: the tray app
 * ("Menu bar") and the Capacity Dock rail it draws ("Sidebar"). Both are on by default and
 * live above About.
 *
 * Nothing renders until the main process says this build has a tray app staged, which is why
 * there is no placeholder row and no disabled switch: on macOS, on Linux, and in a dev build
 * with nothing staged, the corner is exactly what it always was.
 */
function CompanionSwitches() {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [busy, setBusy] = useState<'menuBar' | 'sidebar' | null>(null)

  useEffect(() => {
    let live = true
    // `codeburn` is the preload bridge, absent in a plain browser and under tests, and
    // `companionStatus` is absent on a preload that predates these two switches.
    void codeburn?.companionStatus?.()
      .then(next => { if (live) setStatus(next) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  if (!status?.supported) return null

  // Every setter answers with the whole status, so a switch shows what took rather than what
  // was asked for: an install the person cancelled at the UAC prompt leaves it where it was.
  const toggle = (key: 'menuBar' | 'sidebar') => {
    if (busy) return
    const call = key === 'menuBar' ? codeburn.setMenuBarEnabled : codeburn.setSidebarEnabled
    if (!call) return
    setBusy(key)
    void call.call(codeburn, !status[key])
      .then(setStatus)
      .catch(() => {})
      .finally(() => setBusy(null))
  }

  // The rail is a window of the tray app, and every setting it reads belongs to the tray app,
  // so there is no rail without one. With Menu bar off the Sidebar switch has nothing to
  // control and says so, rather than looking available and turning the tray app on underneath.
  const railBlocked = !status.menuBar

  const row = (key: 'menuBar' | 'sidebar', label: string, hint: string) => {
    const blocked = key === 'sidebar' && railBlocked
    const title = blocked ? t('shell.sidebar.railBlocked') : hint
    return (
      <div className={blocked ? 'companion-row blocked' : 'companion-row'} data-tip={label}>
        <span className="companion-label" title={title}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={status[key]}
          aria-label={label}
          title={title}
          disabled={busy !== null || blocked}
          className={status[key] ? 'switch sm on' : 'switch sm'}
          onClick={() => toggle(key)}
        >
          <span className="switch-knob" />
        </button>
      </div>
    )
  }

  return (
    <div className="companion">
      {row('menuBar', t('shell.sidebar.menuBar'), t('shell.sidebar.menuBarHint'))}
      {row('sidebar', t('shell.sidebar.dockLabel'), t('shell.sidebar.dockHint'))}
      {/* Windows finishes an install it could not complete at the next restart, and until
          then the old tray app is what is on disk, so nothing was started. */}
      {status.restartRequired ? (
        <p className="companion-note">{t('shell.sidebar.restartRequired')}</p>
      ) : null}
    </div>
  )
}
