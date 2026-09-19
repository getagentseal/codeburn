import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Icon, type IconName } from '../components/icons'
import { useEscape } from '../hooks/useEscape'
import { t } from '../i18n'
import { MENUBAR_QUOTA_PROVIDERS } from '../lib/menubarProviders'
import { isMacPlatform } from '../lib/platform'
import styles from './Plugins.module.css'

type Line = { icon: IconName; key: string }

const MENU_BAR: Line[] = [
  { icon: 'coins', key: 'plugins.menuBar.about.spend' },
  { icon: 'chart-column', key: 'plugins.menuBar.about.panel' },
  { icon: 'refresh-cw', key: 'plugins.menuBar.about.refresh' },
  { icon: 'settings', key: 'plugins.menuBar.about.settings' },
]

const CAPACITY_DOCK: Line[] = [
  { icon: 'panel-right', key: 'plugins.capacityDock.about.rail' },
  { icon: 'circle-check', key: 'plugins.capacityDock.about.tileFill' },
  { icon: 'search', key: 'plugins.capacityDock.about.hover' },
  { icon: 'sliders-horizontal', key: 'plugins.capacityDock.about.settings' },
]

function Column({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <div className={styles.aboutCol}>
      <h3 className={styles.aboutColTitle}>{title}</h3>
      <ul className={styles.aboutLines}>
        {lines.map(line => (
          <li key={line.key}>
            <Icon name={line.icon} className={styles.aboutLineIcon} />
            <span>{t(line.key)}</span>
          </li>
        ))}
      </ul>
      <div className={styles.aboutWorks}>
        <span className={styles.aboutWorksLabel}>{t('plugins.menuBar.worksWith')}</span>
        <span>{MENUBAR_QUOTA_PROVIDERS.join(', ')}</span>
      </div>
    </div>
  )
}

/** What a plugin card's info dot opens: a centred, focus-trapped dialog portaled out of the
 *  card so the card's own layout never has to make room for it. Both cards share this shell. */
function AboutModalShell({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)

  useEscape(true, onClose)

  useEffect(() => {
    close.current?.focus()
  }, [])

  // Tab stays inside the dialog while it is up: the card behind it is not reachable.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const stops = dialog.current?.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
    if (!stops || stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  // The window chrome is draggable on darwin; an overlay on top of it must not be.
  const noDrag = (isMacPlatform() ? { WebkitAppRegion: 'no-drag' } : {}) as CSSProperties

  return createPortal(
    <div className={styles.modalBackdrop} style={noDrag} onClick={onClose}>
      <div
        ref={dialog}
        className={styles.aboutModal}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={event => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <button ref={close} className={styles.modalClose} onClick={onClose} aria-label={t('plugins.about.close')}><Icon name="x" /></button>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** What the menu bar app and its Capacity Dock actually do, as two columns of plain lines. */
export function MenuBarAboutModal({ onClose }: { onClose: () => void }) {
  return (
    <AboutModalShell label={t('plugins.menuBar.aboutAria')} onClose={onClose}>
      <div className={styles.aboutCols}>
        <Column title={t('plugins.menuBar.name')} lines={MENU_BAR} />
        <Column title={t('plugins.menuBar.capacityDock')} lines={CAPACITY_DOCK} />
      </div>
    </AboutModalShell>
  )
}

const TEAMS_PLANNED: Line[] = [
  { icon: 'layout-dashboard', key: 'plugins.teams.about.dashboard' },
  { icon: 'lock', key: 'plugins.teams.about.privacy' },
  { icon: 'chart-column', key: 'plugins.teams.about.visibility' },
  { icon: 'shield', key: 'plugins.teams.about.perSeat' },
]

/** What the Teams plugin will do, as one column of plain lines. */
export function TeamsAboutModal({ onClose }: { onClose: () => void }) {
  return (
    <AboutModalShell label={t('plugins.teams.name')} onClose={onClose}>
      <div className={styles.aboutCol}>
        <h3 className={styles.aboutColTitle}>{t('plugins.teams.name')}</h3>
        <ul className={styles.aboutLines}>
          {TEAMS_PLANNED.map(line => (
            <li key={line.key}>
              <Icon name={line.icon} className={styles.aboutLineIcon} />
              <span>{t(line.key)}</span>
            </li>
          ))}
        </ul>
      </div>
    </AboutModalShell>
  )
}
