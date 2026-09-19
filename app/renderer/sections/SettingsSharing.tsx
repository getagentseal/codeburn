import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { showToast } from '../lib/toast'

interface SyncAutoStatus {
  enabled: boolean
  cadence?: 'daily' | 'hourly'
  attribution?: boolean
  fingerprint?: string
  acceptedAt?: string
  currentMatches?: boolean
  receipts?: Array<{ result: string; timestamp: string }>
}

export function SharingPane() {
  const [syncStatus, setSyncStatus] = useState<SyncAutoStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [cadence, setCadence] = useState<'daily' | 'hourly'>('daily')
  const [attribution, setAttribution] = useState(false)
  const [disclosureText, setDisclosureText] = useState('')
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    void loadSyncStatus()
  }, [])

  async function loadSyncStatus() {
    try {
      setLoading(true)
      const status = await codeburn.syncAutoStatus()
      setSyncStatus(status as SyncAutoStatus)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleSetupStart() {
    setShowSetup(true)
    setCadence('daily')
    setAttribution(false)
  }

  async function handleAccept() {
    setAccepting(true)
    try {
      await codeburn.syncAutoEnable(cadence, attribution, true)
      showToast(t('settings.sharing.enabledToast'), 'ok')
      void loadSyncStatus()
      setShowSetup(false)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setAccepting(false)
    }
  }

  async function handleCancel() {
    setShowSetup(false)
  }

  async function handleDisable() {
    try {
      const result = await codeburn.syncAutoDisable()
      if (result.ok) {
        showToast(t('settings.sharing.disabledToast'), 'ok')
        void loadSyncStatus()
      } else {
        showToast(result.stderr || t('settings.sharing.disableFailed'), 'error')
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  if (loading) {
    return (
      <section className="set-p on">
        <div><h3 className="set-h">{t('settings.sharing.heading')}</h3><p className="set-sub">{t('settings.sharing.subtitle')}</p></div>
        <p className="set-cap">{t('settings.sharing.loadingStatus')}</p>
      </section>
    )
  }

  const isConfigured = syncStatus?.enabled

  if (!isConfigured && !showSetup) {
    return (
      <section className="set-p on">
        <div><h3 className="set-h">{t('settings.sharing.heading')}</h3><p className="set-sub">{t('settings.sharing.subtitle')}</p></div>
        <div className="card">
          <div className="about-sec set-last-sec">
            <p className="set-cap">{t('settings.sharing.notConfigured')}</p>
            <button className="btnp btnp-primary" onClick={() => void handleSetupStart()} style={{ marginTop: '1rem' }}>
              {t('settings.sharing.setupButton')}
            </button>
          </div>
        </div>
      </section>
    )
  }

  if (showSetup) {
    return (
      <section className="set-p on">
        <div><h3 className="set-h">{t('settings.sharing.heading')}</h3><p className="set-sub">{t('settings.sharing.subtitle')}</p></div>
        <div className="card">
          <div className="about-sec">
            <div className="about-row">
              <label className="tx" htmlFor="settings-sync-cadence">{t('settings.sharing.cadenceLabel')}</label>
              <span className="r">
                <select
                  id="settings-sync-cadence"
                  value={cadence}
                  onChange={e => setCadence(e.target.value as 'daily' | 'hourly')}
                  style={{
                    padding: '0.5rem',
                    border: '1px solid var(--line)',
                    borderRadius: '4px',
                    background: 'var(--panel)',
                    color: 'var(--ink)',
                    fontFamily: 'inherit',
                  }}
                >
                  <option value="daily">{t('settings.sharing.daily')}</option>
                  <option value="hourly">{t('settings.sharing.hourly')}</option>
                </select>
              </span>
            </div>
          </div>
          <div className="about-sec">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
              <input
                type="checkbox"
                checked={attribution}
                onChange={e => setAttribution(e.target.checked)}
                style={{ marginTop: '0.25rem', cursor: 'pointer' }}
              />
              <div>
                <div style={{ fontWeight: 600 }}>{t('settings.sharing.attributionLabel')}</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--mut)' }}>{t('settings.sharing.attributionDetail')}</div>
              </div>
            </label>
          </div>
          <div className="about-sec set-last-sec">
            <div style={{
              background: 'var(--fill)',
              border: '1px solid var(--line)',
              borderRadius: '4px',
              padding: '1rem',
              marginBottom: '1rem',
              fontFamily: 'monospace',
              fontSize: 'var(--fs-meta)',
              color: 'var(--ink)',
              maxHeight: '200px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {t('settings.sharing.disclosure')}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btnp" onClick={() => void handleCancel()} disabled={accepting}>
                {t('settings.action.cancel')}
              </button>
              <button className="btnp btnp-primary" onClick={() => void handleAccept()} disabled={accepting}>
                {accepting ? t('settings.sharing.accepting') : t('settings.sharing.acceptButton')}
              </button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="set-p on">
      <div><h3 className="set-h">{t('settings.sharing.heading')}</h3><p className="set-sub">{t('settings.sharing.subtitle')}</p></div>
      {error && <div className={`set-error`} style={{ marginBottom: '1rem' }}>{error}</div>}
      <div className="card">
        <div className="about-sec">
          <div className="about-row">
            <span className="tx">{t('settings.sharing.statusLabel')}</span>
            <span className="r" style={{ fontWeight: 600, color: 'var(--ok)' }}>{t('settings.sharing.enabledStatus')}</span>
          </div>
          <div className="about-row">
            <span className="tx">{t('settings.sharing.cadenceLabel')}</span>
            <span className="r">{syncStatus?.cadence === 'hourly' ? t('settings.sharing.hourly') : t('settings.sharing.daily')}</span>
          </div>
          <div className="about-row">
            <span className="tx">{t('settings.sharing.attributionRowLabel')}</span>
            <span className="r">{syncStatus?.attribution ? t('settings.sharing.enabledStatus') : t('settings.sharing.disabledStatus')}</span>
          </div>
          {syncStatus?.fingerprint && (
            <div className="about-row">
              <span className="tx">{t('settings.sharing.fingerprintLabel')}</span>
              <span className="r" style={{ fontFamily: 'monospace', fontSize: 'var(--fs-meta)', color: 'var(--mut)' }}>
                {syncStatus.fingerprint.split(':').slice(0, 2).join(':')}:…:{syncStatus.fingerprint.split(':').slice(-1)[0]}
              </span>
            </div>
          )}
          {syncStatus?.acceptedAt && (
            <div className="about-row">
              <span className="tx">{t('settings.sharing.acceptedAtLabel')}</span>
              <span className="r" style={{ fontSize: '0.875rem', color: 'var(--mut)' }}>
                {new Date(syncStatus.acceptedAt).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>

        {syncStatus?.currentMatches === false && (
          <div className="about-sec" style={{ background: 'var(--warn)', padding: '0.75rem 1rem', borderRadius: '4px', marginBottom: '1rem' }}>
            <div style={{ color: 'var(--ink)', fontWeight: 600, marginBottom: '0.5rem' }}>{t('settings.sharing.driftTitle')}</div>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>{t('settings.sharing.driftDetail')}</p>
            <button className="btnp" onClick={() => setShowSetup(true)} style={{ marginTop: '0.75rem' }}>
              {t('settings.sharing.reviewButton')}
            </button>
          </div>
        )}

        {syncStatus?.receipts && syncStatus.receipts.length > 0 && (
          <div className="about-sec">
            <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>{t('settings.sharing.recentSyncsTitle')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {syncStatus.receipts.slice(0, 5).map((receipt, i) => (
                <div key={i} style={{ fontSize: '0.875rem', color: 'var(--mut)', borderTop: i > 0 ? '1px solid var(--line)' : undefined, paddingTop: i > 0 ? '0.5rem' : undefined }}>
                  <span>{receipt.result}</span>
                  <span style={{ display: 'block', fontSize: 'var(--fs-meta)', marginTop: '0.25rem' }}>
                    {new Date(receipt.timestamp).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="about-sec set-last-sec">
          <button
            className="btnp"
            onClick={() => void handleDisable()}
            style={{
              background: 'var(--bad)',
              color: 'white',
              border: 'none',
              padding: '0.5rem 1rem',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            {t('settings.sharing.stopButton')}
          </button>
        </div>
      </div>
    </section>
  )
}
