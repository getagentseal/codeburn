import { useEffect, useState } from 'react'
import { codeburn } from '../lib/ipc'
import { showToast } from '../lib/toast'
import { PluginDetailsModal } from './PluginDetails'
import { InstallFlowModal } from './InstallFlow'
import styles from './Plugins.module.css'
import { isWindowsPlatform } from '../lib/platform'
import { Icon } from '../components/icons'
import { BarNav } from '../components/TopBar'

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
        <div className={styles.soonTitle}>Plugins are coming to Windows</div>
        <p className={styles.soonBody}>
          They arrive in a later Windows release; on macOS and Linux they are available today.
        </p>
      </div>
    </div>
  )
}

export function PluginsSection() {
  // Decided before the loader renders rather than inside it, so its effects never run.
  return (
    <>
      <div className="bar"><BarNav /><h1 className="t">Plugins</h1></div>
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
      showToast(result.ok ? 'Plugin verified' : (result.stderr || 'Verification failed'), result.ok ? 'ok' : 'error')
      if (result.ok) void loadPlugins()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function removePlugin(name: string) {
    setRemoving(name)
    try {
      const result = await codeburn.pluginRemove(name)
      showToast(result.ok ? `Removed ${name}` : (result.stderr || 'Removal failed'), result.ok ? 'ok' : 'error')
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
    return <div className={styles.container}>Loading plugins…</div>
  }

  return (
    <div className={styles.container}>
      {error && <div className={styles.error}>{error}</div>}
      {plugins.length === 0 ? (
        <div className={`card ${styles.empty}`}>
          <h2 className={styles.emptyTitle}>Coming soon</h2>
          <div className={styles.emptyBodyPanel}>
          <p className={styles.emptyBody}>
            Plugins will let CodeBurn do more than count. The first one ships with CodeBurn Teams: it sends your session outcomes, retries and kind of work to your team dashboard, and nothing else.
          </p>
          <p className={styles.emptyBody}>Until then, everything on the other screens stays local to this machine.</p>
          <p className={styles.emptyFooter}>
            Have a plugin file already? <button type="button" className="set-text-button" onClick={() => setShowInstallFlow(true)}>Install it</button>
          </p>
          </div>
        </div>
      ) : (
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
                      <span>commands {plugin.capabilities.commands.length}</span>
                    )}
                    {plugin.capabilities.syncAttributes.length > 0 && (
                      <span>fields {plugin.capabilities.syncAttributes.length}</span>
                    )}
                    {plugin.capabilities.payloadSections.length > 0 && (
                      <span>sections {plugin.capabilities.payloadSections.length}</span>
                    )}
                  </div>
                )}
              </div>
              {plugin.status === 'loaded' && (
                <div className={styles.actions}>
                  <button className="btnp" onClick={() => setDetailsPlugin(plugin.name)} title="View plugin details">
                    Details
                  </button>
                  <button className="btnp" onClick={() => void verifyPlugin(plugin.name)} title="Verify plugin signature">
                    Verify
                  </button>
                  {confirming === plugin.name ? (
                    <span style={{ display: 'flex', gap: 'var(--sp-1)', alignItems: 'center' }}>
                      <span style={{ fontSize: 'var(--fs-body)', color: 'var(--mut)' }}>Remove {plugin.name}?</span>
                      <button className="btnp" onClick={() => void removePlugin(plugin.name)} disabled={removing === plugin.name} style={{ fontSize: 'var(--fs-label)' }}>
                        {removing === plugin.name ? 'Removing…' : 'Yes'}
                      </button>
                      <button className="btnp" onClick={() => setConfirming(null)} style={{ fontSize: 'var(--fs-label)' }}>
                        No
                      </button>
                    </span>
                  ) : (
                    <button className="btnp" onClick={() => setConfirming(plugin.name)} title="Remove plugin">
                      Remove
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
          Install plugin
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
