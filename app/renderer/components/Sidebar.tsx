import { useState, type ReactNode } from 'react'

import { codeburn } from '../lib/ipc'
import { AboutModal, type SocialLink } from './AboutModal'
import { FlameMark } from './FlameMark'

export type Section = 'overview' | 'sessions' | 'pullRequests' | 'spend' | 'optimize' | 'models' | 'compare' | 'plans' | 'settings'

export const NAV_ITEMS: Array<{ id: Section; label: string; key: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', key: '⌘1', icon: (
    <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>
  ) },
  { id: 'sessions', label: 'Sessions', key: '⌘2', icon: (
    <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="4" rx="1"/><rect x="4" y="10" width="16" height="4" rx="1"/><rect x="4" y="16" width="16" height="4" rx="1"/></svg>
  ) },
  { id: 'pullRequests', label: 'Pull requests', key: '⌘3', icon: (
    <svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
  ) },
  { id: 'spend', label: 'Spend', key: '⌘4', icon: (
    <svg viewBox="0 0 24 24"><line x1="6" y1="20" x2="6" y2="13" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="9" /></svg>
  ) },
  { id: 'optimize', label: 'Optimize', key: '⌘5', icon: (
    <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="3.4"/><path d="M10.5 3v1.7M10.5 16.3V18M3 10.5h1.7M16.3 10.5H18M5.3 5.3l1.2 1.2M14.5 14.5l1.2 1.2M15.7 5.3l-1.2 1.2M6.5 14.5l-1.2 1.2"/><line x1="15.5" y1="15.5" x2="20" y2="20"/></svg>
  ) },
  { id: 'models', label: 'Models', key: '⌘6', icon: (
    <svg viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.3 7 12 12l8.7-5M12 22V12" /></svg>
  ) },
  { id: 'compare', label: 'Compare', key: '⌘7', icon: (
    <svg viewBox="0 0 24 24"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/></svg>
  ) },
  { id: 'plans', label: 'Plans', key: '⌘8', icon: (
    <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
  ) },
  { id: 'settings', label: 'Settings', key: '⌘,', icon: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
  ) },
]

const SOCIALS: SocialLink[] = [
  { label: 'GitHub', url: 'https://github.com/getagentseal/codeburn', icon: <svg viewBox="0 0 24 24"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" /></svg> },
  { label: 'Discord', url: 'https://discord.com/invite/w2sw8mCqep', icon: <svg viewBox="0 0 24 24"><path d="M20.32 4.37A19.8 19.8 0 0 0 15.45 3c-.21.38-.46.9-.63 1.31a18.3 18.3 0 0 0-5.47 0C8.71 3.9 8.45 3.38 8.24 3a19.7 19.7 0 0 0-4.88 1.37C.86 8.75.05 13.02.45 17.23a19.9 19.9 0 0 0 6 3.03c.48-.66.91-1.36 1.28-2.11-.7-.26-1.37-.58-2-.96.17-.12.33-.25.49-.38a14.2 14.2 0 0 0 12.16 0c.16.14.32.26.49.38-.63.38-1.31.7-2 .96.37.75.8 1.45 1.28 2.11a19.8 19.8 0 0 0 6-3.03c.47-4.87-.8-9.1-3.83-12.86zM8.02 14.65c-1.18 0-2.15-1.08-2.15-2.41 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41zm7.96 0c-1.18 0-2.15-1.08-2.15-2.41 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41z" /></svg> },
  { label: 'X', url: 'https://x.com/_codeburn', icon: <svg viewBox="0 0 24 24"><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.63 7.58H.49l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93zm-1.29 19.5h2.04L6.49 3.24H4.3l13.31 17.41z" /></svg> },
  { label: 'YouTube', url: 'https://www.youtube.com/@codeburnn', icon: <svg viewBox="0 0 24 24"><path d="M23.5 6.2a3.02 3.02 0 0 0-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.56A3.02 3.02 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3.02 3.02 0 0 0 2.12 2.14C4.5 20.5 12 20.5 12 20.5s7.5 0 9.38-.56A3.02 3.02 0 0 0 23.5 17.8 31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8zM9.55 15.57V8.43L15.82 12l-6.27 3.57z" /></svg> },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/showcase/codeburnn/', icon: <svg viewBox="0 0 256 256"><path fill="currentColor" d="M218.123 218.127h-37.931v-59.403c0-14.165-.253-32.4-19.728-32.4-19.756 0-22.779 15.434-22.779 31.369v60.43h-37.93V95.967h36.413v16.694h.51a39.907 39.907 0 0 1 35.928-19.733c38.445 0 45.533 25.288 45.533 58.186l-.016 67.013ZM56.955 79.27c-12.157.002-22.014-9.852-22.016-22.009-.002-12.157 9.851-22.014 22.008-22.016 12.157-.003 22.014 9.851 22.016 22.008A22.013 22.013 0 0 1 56.955 79.27m18.966 138.858H37.95V95.967h37.97v122.16ZM237.033.018H18.89C8.58-.098.125 8.161-.001 18.471v219.053c.122 10.315 8.576 18.582 18.89 18.474h218.144c10.336.128 18.823-8.139 18.966-18.474V18.454c-.147-10.33-8.635-18.588-18.966-18.453" /></svg> },
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
            <span className="k">{item.key}</span>
          </div>
        ))}
        <div className="push" />
        <div className="foot">
          <a className="about" href="#about" onClick={event => { event.preventDefault(); setAboutOpen(true) }}>About</a>
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
        </div>
      </nav>
      {aboutOpen ? <AboutModal socials={SOCIALS} onClose={() => setAboutOpen(false)} /> : null}
    </>
  )
}
