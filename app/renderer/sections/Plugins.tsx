import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { showToast } from '../lib/toast'
import { PluginDetailsModal } from './PluginDetails'
import { InstallFlowModal } from './InstallFlow'
import styles from './Plugins.module.css'
import { isMacPlatform, isWindowsPlatform } from '../lib/platform'
import { Icon } from '../components/icons'
import { BarNav } from '../components/TopBar'
import { MenuBarCard } from './MenuBarCard'
import { TeamsAboutModal } from './MenuBarAbout'
import teamsArt from '../assets/teams-card-art.jpg'
import teamsArtLight from '../assets/teams-card-art-light.jpg'

// Placeholder until the real signup URL lands; swap this one constant before merge.
const TEAMS_BETA_URL = 'https://codeburn.app/teams'

interface PluginInfo {
  name: string
  version: string
  status: 'loaded' | 'rejected'
  reason?: string
  capabilities?: {
    commands: string[]
    syncAttributes: Array<{ key: string; disclosure: string }>
    payloadSections: string[]
    spanKinds: string[]
  }
}

/**
 * The plugin runtime has not shipped for Windows, so the CLI there never answers and the page
 * sat on "Loading plugins..." for good. This branch loads nothing at all: no CLI call, no
 * spinner, no timer, and none of the loader's hooks even mount, because the dispatcher below
 * returns before reaching them.
 */
function PluginsComingSoon() {
  return (
    <div className={styles.container}>
      <div className={styles.soon}>
        <Icon name="puzzle" className={styles.soonMark} />
        <div className={styles.soonTitle}>{t('plugins.comingSoon.title')}</div>
        <p className={styles.soonBody}>
          {t('plugins.comingSoon.body')}
        </p>
      </div>
    </div>
  )
}

/** The one plugin that is coming, as a card rather than a panel of prose. Nothing to install
 *  yet, so the control slot carries a label and the card explains itself instead. */
function TeamsCard() {
  const [about, setAbout] = useState(false)
  const description = t('plugins.teams.description')
  return (
    <div
      className={`${styles.row} ${styles.art}`}
      style={{ '--card-art': `url(${teamsArt})`, '--card-art-light': `url(${teamsArtLight})` } as CSSProperties}
      data-status="loaded"
    >
      <div className={`${styles.info} ${styles.teamsInfo}`}>
        <div className={styles.nameRow}>
          <div className={styles.name}>{t('plugins.teams.name')}</div>
          <button
            type="button"
            className={`ov-info ${styles.infoDot}`}
            aria-label={t('plugins.teams.aboutAria')}
            onClick={() => setAbout(true)}
          >
            <Icon name="info" />
          </button>
        </div>
        <div className={`${styles.reason} ${styles.reasonFull}`}>{description}</div>
        <button
          type="button"
          className={`set-text-button ${styles.betaLink}`}
          onClick={() => { void codeburn.openExternal(TEAMS_BETA_URL) }}
        >
          {t('plugins.teams.registerBeta')}
        </button>
      </div>
      <div className={styles.controls}>
        <span className={styles.pill}>{t('plugins.teams.pill')}</span>
      </div>
      {about && <TeamsAboutModal onClose={() => setAbout(false)} />}
    </div>
  )
}

export function PluginsSection() {
  // Decided before the loader renders rather than inside it, so its effects never run.
  return (
    <>
      <div className="bar"><BarNav /><h1 className="t">{t('plugins.title')}</h1></div>
      {isWindowsPlatform() ? <PluginsComingSoon /> : <PluginsList />}
    </>
  )
}

function PluginsList() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailsPlugin, setDetailsPlugin] = useState<string | null>(null)
  const [showInstallFlow, setShowInstallFlow] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    void loadPlugins()
  }, [])

  async function loadPlugins() {
    try {
      setLoading(true)
      const result = await codeburn.pluginList()
      setPlugins(result as PluginInfo[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err))
      setPlugins([])
    } finally {
      setLoading(false)
    }
  }

  async function verifyPlugin(name: string) {
    try {
      const result = await codeburn.pluginVerify(name)
      showToast(result.ok ? t('plugins.list.toastVerified') : (result.stderr || t('plugins.list.toastVerifyFailed')), result.ok ? 'ok' : 'error')
      if (result.ok) void loadPlugins()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removePlugin(name: string) {
    setRemoving(name)
    try {
      const result = await codeburn.pluginRemove(name)
      showToast(result.ok ? t('plugins.list.toastRemoved', { name }) : (result.stderr || t('plugins.list.toastRemoveFailed')), result.ok ? 'ok' : 'error')
      if (result.ok) {
        setConfirming(null)
        void loadPlugins()
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setRemoving(null)
    }
  }

  if (loading) {
    return <div className={styles.container}>{t('plugins.list.loading')}</div>
  }

  return (
    <div className={styles.container}>
      {error && <div className={styles.error}>{error}</div>}
      {/* The macOS menubar app is a companion, not a CLI plugin, so it sits above the list and
          renders whether or not there are plugins. Nothing is rendered off darwin. */}
      <div className={styles.artGrid}>
        {isMacPlatform() && <MenuBarCard />}
        <TeamsCard />
      </div>
      {plugins.length > 0 && (
        <div className={styles.list}>
          {plugins.map(plugin => (
            <div key={plugin.name} className={styles.row} data-status={plugin.status}>
              <div className={styles.info}>
                <div className={styles.name}>{plugin.name}@{plugin.version}</div>
                {plugin.status === 'rejected' && (
                  <div className={styles.reason}>{plugin.reason}</div>
                )}
                {plugin.capabilities && (
                  <div className={styles.caps}>
                    {plugin.capabilities.commands.length > 0 && (
                      <span>{t('plugins.list.commandsCount', { count: plugin.capabilities.commands.length })}</span>
                    )}
                    {plugin.capabilities.syncAttributes.length > 0 && (
                      <span>{t('plugins.list.fieldsCount', { count: plugin.capabilities.syncAttributes.length })}</span>
                    )}
                    {plugin.capabilities.payloadSections.length > 0 && (
                      <span>{t('plugins.list.sectionsCount', { count: plugin.capabilities.payloadSections.length })}</span>
                    )}
                  </div>
                )}
              </div>
              {plugin.status === 'loaded' && (
                <div className={styles.actions}>
                  <button className="btnp" onClick={() => setDetailsPlugin(plugin.name)} title={t('plugins.list.detailsTitle')}>
                    {t('plugins.list.detailsButton')}
                  </button>
                  <button className="btnp" onClick={() => void verifyPlugin(plugin.name)} title={t('plugins.list.verifyTitle')}>
                    {t('plugins.list.verifyButton')}
                  </button>
                  {confirming === plugin.name ? (
                    <span style={{ display: 'flex', gap: 'var(--sp-1)', alignItems: 'center' }}>
                      <span style={{ fontSize: 'var(--fs-body)', color: 'var(--mut)' }}>{t('plugins.list.confirmRemove', { name: plugin.name })}</span>
                      <button className="btnp" onClick={() => void removePlugin(plugin.name)} disabled={removing === plugin.name} style={{ fontSize: 'var(--fs-label)' }}>
                        {removing === plugin.name ? t('plugins.list.removing') : t('plugins.list.confirmYes')}
                      </button>
                      <button className="btnp" onClick={() => setConfirming(null)} style={{ fontSize: 'var(--fs-label)' }}>
                        {t('plugins.list.confirmNo')}
                      </button>
                    </span>
                  ) : (
                    <button className="btnp" onClick={() => setConfirming(plugin.name)} title={t('plugins.list.removeTitle')}>
                      {t('plugins.list.removeButton')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {plugins.length > 0 && (
        <button className="btnp btnp-primary" onClick={() => setShowInstallFlow(true)} style={{ marginTop: 'var(--sp-6)' }}>
          {t('plugins.list.installButton')}
        </button>
      )}

      {detailsPlugin && (
        <PluginDetailsModal
          pluginName={detailsPlugin}
          onClose={() => setDetailsPlugin(null)}
        />
      )}

      {showInstallFlow && (
        <InstallFlowModal
          onClose={() => setShowInstallFlow(false)}
          onSuccess={() => {
            void loadPlugins()
            setShowInstallFlow(false)
          }}
        />
      )}
    </div>
  )
}
