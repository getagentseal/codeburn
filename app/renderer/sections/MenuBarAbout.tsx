import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Icon, type IconName } from '../components/icons'
import { useEscape } from '../hooks/useEscape'
import { MENUBAR_QUOTA_PROVIDERS } from '../lib/menubarProviders'
import { isMacPlatform } from '../lib/platform'
import styles from './Plugins.module.css'

type Line = { icon: IconName; text: string }

const MENU_BAR: Line[] = [
  { icon: 'coins', text: "Shows today's spend and per-provider quotas in the menu bar" },
  { icon: 'chart-column', text: 'Opens a panel with session counts, cost and the providers you used' },
  { icon: 'refresh-cw', text: 'Refreshes on its own schedule, whether or not the desktop app is open' },
  { icon: 'settings', text: 'Has its own Settings window for refresh cadence, currency and language' },
]

const CAPACITY_DOCK: Line[] = [
  { icon: 'panel-right', text: 'A slim rail on the screen edge with one tile per provider showing remaining quota; drag it to any edge' },
  { icon: 'circle-check', text: 'A tile empties as quota is spent and fills again when the window resets' },
  { icon: 'search', text: 'Hovering a tile shows the numbers behind it; clicking one opens that provider' },
  { icon: 'sliders-horizontal', text: "Which providers get a tile is set in the menu bar app's Settings" },
]

function Column({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <div className={styles.aboutCol}>
      <h3 className={styles.aboutColTitle}>{title}</h3>
      <ul className={styles.aboutLines}>
        {lines.map(line => (
          <li key={line.text}>
            <Icon name={line.icon} className={styles.aboutLineIcon} />
            <span>{line.text}</span>
          </li>
        ))}
      </ul>
      <div className={styles.aboutWorks}>
        <span className={styles.aboutWorksLabel}>Works with</span>
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
        <button ref={close} className={styles.modalClose} onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** What the menu bar app and its Capacity Dock actually do, as two columns of plain lines. */
export function MenuBarAboutModal({ onClose }: { onClose: () => void }) {
  return (
    <AboutModalShell label="What the menu bar app does" onClose={onClose}>
      <div className={styles.aboutCols}>
        <Column title="Menu bar" lines={MENU_BAR} />
        <Column title="Capacity Dock" lines={CAPACITY_DOCK} />
      </div>
    </AboutModalShell>
  )
}

const TEAMS_PLANNED: Line[] = [
  { icon: 'layout-dashboard', text: "A shared team dashboard of everyone's session outcomes, retries and kind of work" },
  { icon: 'lock', text: 'Only outcomes and counts leave each machine, never your code or prompts' },
  { icon: 'chart-column', text: 'See where time and spend go across the team, per project and per model' },
  { icon: 'shield', text: 'Per seat, each member keeps their own local data' },
]

/** What the Teams plugin will do, as one column of plain lines. */
export function TeamsAboutModal({ onClose }: { onClose: () => void }) {
  return (
    <AboutModalShell label="Teams" onClose={onClose}>
      <div className={styles.aboutCol}>
        <h3 className={styles.aboutColTitle}>Teams</h3>
        <ul className={styles.aboutLines}>
          {TEAMS_PLANNED.map(line => (
            <li key={line.text}>
              <Icon name={line.icon} className={styles.aboutLineIcon} />
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </AboutModalShell>
  )
}
