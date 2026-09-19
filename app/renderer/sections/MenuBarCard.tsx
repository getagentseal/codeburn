import { useState } from 'react'
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { Icon } from '../components/icons'
import { codeburn } from '../lib/ipc'
import type { MacMenubarStatus } from '../lib/types'
import { MenuBarAboutModal } from './MenuBarAbout'
import styles from './Plugins.module.css'
import menubarArt from '../assets/menubar-card-art.jpg'
import menubarArtLight from '../assets/menubar-card-art-light.jpg'

/** The menubar app and the desktop app already share the CLI, the cache and the config, so the
 *  card has no link step: install, open, and the one switch the app draws a window for. */
const POLL_MS = 4000

type Action = 'install' | 'open' | 'dock' | 'quit' | 'uninstall' | 'update' | 'settings'

/**
 * Polls only while this card is mounted (the Plugins page unmounts on navigation) and only
 * while the window is showing, so a backgrounded app costs nothing. No global timer, and the
 * poll never sets state to a value equal to the one held, so a still machine re-renders zero
 * times (PR 1352).
 */
function useMacMenubarStatus(): [MacMenubarStatus | null, (next: MacMenubarStatus) => void, () => void] {
  const [status, setStatus] = useState<MacMenubarStatus | null>(null)
  const held = useRef<string>('')

  const apply = (next: MacMenubarStatus) => {
    const key = JSON.stringify(next)
    if (key === held.current) return
    held.current = key
    setStatus(next)
  }

  const refresh = () => {
    void codeburn?.macMenubarStatus?.().then(apply).catch(() => {})
  }

  useEffect(() => {
    let live = true
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void codeburn?.macMenubarStatus?.().then(next => { if (live) apply(next) }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { live = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [status, apply, refresh]
}

export function MenuBarCard({ art = menubarArt, artLight = menubarArtLight }: { art?: string; artLight?: string } = {}) {
  const [status, apply, refresh] = useMacMenubarStatus()
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Quit and Uninstall confirm in the card, the same way removing a plugin does on this page.
  const [confirming, setConfirming] = useState<'quit' | 'uninstall' | null>(null)
  // What the install is doing right now, from the CLI's own narration. An install takes about
  // half a minute, most of it an 8 MB download, and a button that only says "Installing…" for
  // that long reads as a hang.
  const [phase, setPhase] = useState<string | null>(null)
  const [about, setAbout] = useState(false)

  if (!status?.supported) return null

  const act = async (kind: Action, call: () => Promise<void>) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    setPhase(null)
    try {
      await call()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(null)
      setPhase(null)
      setConfirming(null)
      refresh()
    }
  }

  const runInstall = (kind: 'install' | 'update') => act(kind, async () => {
    const stop = codeburn.onMacMenubarProgress?.(setPhase)
    try {
      const result = await codeburn.macMenubarInstall?.()
      if (!result) return
      // What landed decides the card, so a release older than this build can drive still comes
      // back as the outdated state rather than a cheerful Running.
      apply(result.status)
      if (!result.ok) setError(result.error ?? 'The menu bar app could not be installed.')
    } finally {
      stop?.()
    }
  })

  const install = () => runInstall('install')

  const update = () => runInstall('update')

  const settings = () => act('settings', async () => {
    const result = await codeburn.macMenubarSettings?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not open its settings.')
  })

  const open = () => act('open', async () => {
    const next = await codeburn.macMenubarOpen?.()
    if (next) apply(next)
  })

  const toggleDock = () => act('dock', async () => {
    const next = await codeburn.macMenubarSetDock?.(!status.dock)
    if (next) apply(next)
  })

  const quit = () => act('quit', async () => {
    const result = await codeburn.macMenubarQuit?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not be quit.')
  })

  const uninstall = () => act('uninstall', async () => {
    const result = await codeburn.macMenubarUninstall?.()
    if (!result) return
    apply(result.status)
    if (!result.ok) setError(result.error ?? 'The menu bar app could not be removed.')
  })

  return (
    <div
      className={`${styles.row} ${styles.art}`}
      style={{
        '--card-art': `url(${art})`,
        '--card-art-light': `url(${artLight})`,
        // The light wordmark was drawn near-black; this holds it back to roughly the
        // contrast the dark art gives it, without flattening the apricot haze behind it.
        '--art-light-wash': .84,
      } as CSSProperties}
      data-status="loaded"
    >
      <div className={`${styles.info} ${styles.menubarInfo}`}>
        <div className={styles.nameRow}>
          <div className={styles.name}>Menu bar</div>
          <button
            type="button"
            className={`ov-info ${styles.infoDot}`}
            aria-label="What the menu bar app does"
            onClick={() => setAbout(true)}
          >
            <Icon name="info" />
          </button>
        </div>
        <div className={`${styles.reason} ${styles.reasonFull}`}>
          Spend and quotas in your Mac&apos;s menu bar.
        </div>
        {/* One note row, always present, so the card is the same height in every state. An
            error answers something the person just pressed, so it wins over the hint. */}
        <div className={styles.note} data-kind={error ? 'error' : 'hint'} title={error ?? undefined}>
          {error ?? (status.outdated ? 'Update the menu bar to use this' : '')}
        </div>
        {/* The status line rides the bottom-left of the card, clear of the wordmark baked into
            the artwork's bottom-right. */}
        <div className={styles.caps}>
          {status.running && (
            <span className={styles.running}><span className={styles.runningDot} />Running</span>
          )}
          {status.version && <span>v{status.version}</span>}
        </div>
      </div>
      <div className={styles.controls}>
        {status.installed && (
          <label className={styles.dockToggle}>
            <span>Capacity Dock</span>
            <button
              type="button"
              role="switch"
              aria-checked={status.dock}
              aria-label="Capacity Dock"
              disabled={busy !== null || !status.running || status.outdated}
              title={status.outdated
                ? 'Update the menu bar to use this'
                : status.running ? 'Show the Capacity Dock rail on the screen edge' : 'Open the menu bar app to use the Capacity Dock'}
              className={status.dock ? 'switch sm on' : 'switch sm'}
              onClick={toggleDock}
            >
              <span className="switch-knob" />
            </button>
          </label>
        )}
        <div className={styles.actions}>
          {status.installed ? (
            <>
              {status.outdated && status.canInstall && (
                <button className={`btnp ${styles.primary}`} onClick={update} disabled={busy !== null}>
                  {busy === 'update' ? `${phase ?? 'Updating'}\u2026` : 'Update'}
                </button>
              )}
              {/* Icon-only, all visible: no window to bring forward while it is up, so Open
                  shows only while it is down; Settings, Quit and Uninstall while it is up. */}
              {!status.running && (
                <button
                  type="button"
                  className={`btnp ${styles.iconBtn}`}
                  aria-label="Open"
                  title="Open the menu bar app"
                  disabled={busy !== null}
                  onClick={open}
                >
                  <Icon name="arrow-up-right" />
                </button>
              )}
              {status.running && (
                <button
                  type="button"
                  className={`btnp ${styles.iconBtn}`}
                  aria-label="Settings"
                  title={status.outdated ? 'Update the menu bar to use this' : "Open the menu bar app's own Settings window"}
                  disabled={busy !== null || status.outdated}
                  onClick={settings}
                >
                  <Icon name="settings" />
                </button>
              )}
              {/* Destructive, so a light guard: the first click arms the icon (it swaps to a
                  check), a second confirms, and moving focus away disarms it. */}
              {status.running && (
                <button
                  type="button"
                  className={confirming === 'quit' ? `btnp ${styles.iconBtn} ${styles.confirming}` : `btnp ${styles.iconBtn}`}
                  aria-label={confirming === 'quit' ? 'Confirm quit' : 'Quit'}
                  title={status.outdated ? 'Update the menu bar to use this' : confirming === 'quit' ? 'Click again to quit' : 'Quit'}
                  disabled={busy !== null || status.outdated}
                  onClick={() => (confirming === 'quit' ? quit() : setConfirming('quit'))}
                  onBlur={() => setConfirming(current => (current === 'quit' ? null : current))}
                >
                  <Icon name={confirming === 'quit' ? 'circle-check' : 'x'} />
                </button>
              )}
              <button
                type="button"
                className={confirming === 'uninstall' ? `btnp ${styles.iconBtn} ${styles.confirming}` : `btnp ${styles.iconBtn}`}
                aria-label={confirming === 'uninstall' ? 'Confirm uninstall' : 'Uninstall'}
                title={status.outdated ? 'Update the menu bar to use this' : confirming === 'uninstall' ? 'Click again to uninstall' : 'Uninstall'}
                disabled={busy !== null || status.outdated}
                onClick={() => (confirming === 'uninstall' ? uninstall() : setConfirming('uninstall'))}
                onBlur={() => setConfirming(current => (current === 'uninstall' ? null : current))}
              >
                <Icon name={confirming === 'uninstall' ? 'circle-check' : 'trash-2'} />
              </button>
            </>
          ) : status.canInstall ? (
            <button className={`btnp ${styles.primary}`} onClick={install} disabled={busy !== null}>
              {busy === 'install' ? `${phase ?? 'Installing'}\u2026` : 'Install'}
            </button>
          ) : (
            <span className={styles.website}>Get the menu bar from the website</span>
          )}
        </div>
      </div>
      {about && <MenuBarAboutModal onClose={() => setAbout(false)} />}
    </div>
  )
}
