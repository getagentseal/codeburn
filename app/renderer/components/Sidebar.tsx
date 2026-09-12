import { useEffect, useState, type ReactNode } from 'react'

import { codeburn } from '../lib/ipc'
import { isWindowsPlatform, shortcutLabel } from '../lib/platform'
import type { CompanionStatus } from '../lib/types'
import { AboutModal, SOCIALS } from './AboutModal'
import { FlameMark } from './FlameMark'

export type Section = 'overview' | 'sessions' | 'pullRequests' | 'spend' | 'optimize' | 'models' | 'compare' | 'periods' | 'plans' | 'settings' | 'plugins'

export const NAV_ITEMS: Array<{ id: Section; label: string; key: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', key: '1', icon: (
    <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>
  ) },
  { id: 'sessions', label: 'Sessions', key: '2', icon: (
    <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="4" rx="1"/><rect x="4" y="10" width="16" height="4" rx="1"/><rect x="4" y="16" width="16" height="4" rx="1"/></svg>
  ) },
  { id: 'pullRequests', label: 'Pull requests', key: '3', icon: (
    <svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
  ) },
  { id: 'spend', label: 'Spend', key: '4', icon: (
    <svg viewBox="0 0 24 24"><line x1="6" y1="20" x2="6" y2="13" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="9" /></svg>
  ) },
  { id: 'optimize', label: 'Optimize', key: '5', icon: (
    <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="3.4"/><path d="M10.5 3v1.7M10.5 16.3V18M3 10.5h1.7M16.3 10.5H18M5.3 5.3l1.2 1.2M14.5 14.5l1.2 1.2M15.7 5.3l-1.2 1.2M6.5 14.5l-1.2 1.2"/><line x1="15.5" y1="15.5" x2="20" y2="20"/></svg>
  ) },
  { id: 'models', label: 'Models', key: '6', icon: (
    <svg viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.3 7 12 12l8.7-5M12 22V12" /></svg>
  ) },
  { id: 'compare', label: 'Compare', key: '7', icon: (
    <svg viewBox="0 0 24 24"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/></svg>
  ) },
  { id: 'periods', label: 'Compare periods', key: '9', icon: (
    <svg viewBox="0 0 24 24"><rect x="3" y="5" width="7" height="14" rx="1"/><rect x="14" y="9" width="7" height="10" rx="1"/><path d="M3 3v18M14 3v18" opacity="0.4"/></svg>
  ) },
  { id: 'plans', label: 'Plans', key: '8', icon: (
    <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
  ) },
  { id: 'settings', label: 'Settings', key: ',', icon: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
  ) },
  { id: 'plugins', label: 'Plugins', key: '.', icon: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><path d="M12 2v6m0 8v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M2 12h6m8 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24"/></svg>
  ) },
]

export function Sidebar({
  active,
  onNavigate,
}: {
  active: Section
  onNavigate: (section: Section) => void
  status?: ReactNode
}) {
  const [aboutOpen, setAboutOpen] = useState(false)

  return (
    <>
      <nav className="sb">
        <div className="app"><FlameMark size={20} live /><b>CodeBurn</b></div>
        {NAV_ITEMS.map(item => (
          <div
            key={item.id}
            className={item.id === active ? 'ni on' : 'ni'}
            role="button"
            aria-current={item.id === active ? 'page' : undefined}
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
            {item.label}
            <span className="k">{shortcutLabel(item.key)}</span>
          </div>
        ))}
        <div className="push" />
        <CompanionSwitches />
        <div className="foot">
          <a className="about" href="#about" onClick={event => { event.preventDefault(); setAboutOpen(true) }}>About</a>
          <SocialGlyphs />
        </div>
      </nav>
      {aboutOpen ? <AboutModal onClose={() => setAboutOpen(false)} /> : null}
    </>
  )
}

/**
 * The row of brand glyphs in the corner, beside About.
 *
 * Windows is the one platform that gives that corner to something else: the two companion
 * switches sit above About, and a 186px sidebar has no room for both. Every other platform
 * keeps the glyphs it always had, since nothing replaced them there. About lists the same
 * links under Links on every platform.
 */
function SocialGlyphs() {
  if (isWindowsPlatform()) return null
  return (
    <div className="social">
      {SOCIALS.map(social => (
        <a
          key={social.label}
          href={social.url}
          title={social.label}
          aria-label={social.label}
          onClick={event => { event.preventDefault(); void codeburn.openExternal(social.url) }}
        >
          {social.icon}
        </a>
      ))}
    </div>
  )
}

/**
 * The two surfaces the Windows desktop app carries besides its own window: the tray app
 * ("Menu bar") and the Capacity Dock rail it draws ("Sidebar"). Both are on by default and
 * live above About, in the corner the social glyphs share on every other platform.
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
    const title = blocked ? 'The Capacity Dock needs the menu bar app' : hint
    return (
      <div className={blocked ? 'companion-row blocked' : 'companion-row'}>
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
      {row('menuBar', 'Menu bar', 'Show CodeBurn in the Windows notification area')}
      {row('sidebar', 'Sidebar', 'Show the Capacity Dock rail on the screen edge')}
      {/* Windows finishes an install it could not complete at the next restart, and until
          then the old tray app is what is on disk, so nothing was started. */}
      {status.restartRequired ? (
        <p className="companion-note">Restart Windows to finish installing the menu bar app.</p>
      ) : null}
    </div>
  )
}
