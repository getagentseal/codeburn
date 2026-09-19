import { useEffect, useState } from 'react'
import { useEscape } from '../hooks/useEscape'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import styles from './Plugins.module.css'
import { Icon } from '../components/icons'

interface PluginManifest {
  name: string
  version: string
  description?: string
  commands?: Array<{ name: string; description?: string }>
  syncAttributes?: Array<{ key: string; disclosure: string; description?: string }>
  spanKinds?: string[]
  payloadSections?: string[]
  [key: string]: unknown
}

interface PluginDetailsProps {
  pluginName: string
  onClose: () => void
}

export function PluginDetailsModal({ pluginName, onClose }: PluginDetailsProps) {
  const [manifest, setManifest] = useState<PluginManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadPluginDetails()
  }, [pluginName])

  async function loadPluginDetails() {
    try {
      setLoading(true)
      const result = await codeburn.pluginInfo(pluginName)
      setManifest(result as PluginManifest)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEscape(true, onClose)

  if (loading) {
    return (
      <div className={styles.modalBackdrop} onClick={onClose}>
        <div className={styles.modal} onClick={e => e.stopPropagation()}>
          <button className={styles.modalClose} onClick={onClose}><Icon name="x" /></button>
          <div className={styles.modalContent}>{t('plugins.details.loading')}</div>
        </div>
      </div>
    )
  }

  if (error || !manifest) {
    return (
      <div className={styles.modalBackdrop} onClick={onClose}>
        <div className={styles.modal} onClick={e => e.stopPropagation()}>
          <button className={styles.modalClose} onClick={onClose}><Icon name="x" /></button>
          <div className={styles.modalContent}>
            <div className={styles.error}>{error || t('plugins.details.loadFailed')}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <button className={styles.modalClose} onClick={onClose}><Icon name="x" /></button>
        <div className={styles.modalContent}>
          <h2>{manifest.name}@{manifest.version}</h2>
          {manifest.description && <p className={styles.description}>{manifest.description}</p>}

          {manifest.commands && manifest.commands.length > 0 && (
            <section className={styles.section}>
              <h3>{t('plugins.details.commands')}</h3>
              <ul>
                {manifest.commands.map((cmd: any) => (
                  <li key={cmd.name}>
                    <strong>{cmd.name}</strong>
                    {cmd.description && <p>{cmd.description}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {manifest.syncAttributes && manifest.syncAttributes.length > 0 && (
            <section className={styles.section}>
              <h3>{t('plugins.details.syncFields')}</h3>
              <ul>
                {manifest.syncAttributes.map((attr: any) => (
                  <li key={attr.key}>
                    <strong>{attr.key}</strong>
                    <p className={styles.disclosure}>{attr.disclosure}</p>
                    {attr.description && <p>{attr.description}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {manifest.spanKinds && manifest.spanKinds.length > 0 && (
            <section className={styles.section}>
              <h3>{t('plugins.details.spanKinds')}</h3>
              <ul>
                {manifest.spanKinds.map((kind: string) => (
                  <li key={kind}>{kind}</li>
                ))}
              </ul>
            </section>
          )}

          {manifest.payloadSections && manifest.payloadSections.length > 0 && (
            <section className={styles.section}>
              <h3>{t('plugins.details.payloadSections')}</h3>
              <ul>
                {manifest.payloadSections.map((section: string) => (
                  <li key={section}>{section}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
