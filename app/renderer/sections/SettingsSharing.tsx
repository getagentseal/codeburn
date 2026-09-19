import { useEffect, useState } from 'react'
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
      showToast('Automatic sync enabled', 'ok')
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
        showToast('Automatic sync disabled', 'ok')
        void loadSyncStatus()
      } else {
        showToast(result.stderr || 'Failed to disable sync', 'error')
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  if (loading) {
    return (
      <section className="set-p on">
        <div><h3 className="set-h">Automatic sync</h3><p className="set-sub">Share your session data automatically with your team.</p></div>
        <p className="set-cap">Loading sync status…</p>
      </section>
    )
  }

  const isConfigured = syncStatus?.enabled

  if (!isConfigured && !showSetup) {
    return (
      <section className="set-p on">
        <div><h3 className="set-h">Automatic sync</h3><p className="set-sub">Share your session data automatically with your team.</p></div>
        <div className="card">
          <div className="about-sec set-last-sec">
            <p className="set-cap">Not configured. Set up automatic sync to share your session data.</p>
            <button className="btnp btnp-primary" onClick={() => void handleSetupStart()} style={{ marginTop: '1rem' }}>
              Set up automatic sync
            </button>
          </div>
        </div>
      </section>
    )
  }

  if (showSetup) {
    return (
      <section className="set-p on">
        <div><h3 className="set-h">Automatic sync</h3><p className="set-sub">Share your session data automatically with your team.</p></div>
        <div className="card">
          <div className="about-sec">
            <div className="about-row">
              <label className="tx" htmlFor="settings-sync-cadence">Cadence</label>
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
                  <option value="daily">Daily</option>
                  <option value="hourly">Hourly</option>
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
                <div style={{ fontWeight: 600 }}>Include work-unit attribution</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--mut)' }}>Share detailed work-unit data with your team</div>
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
              This setup enables automatic sync of your CodeBurn session data with your organization's team dashboard. Your data will be shared according to the cadence you select. By accepting, you agree to automatic sharing.
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btnp" onClick={() => void handleCancel()} disabled={accepting}>
                Cancel
              </button>
              <button className="btnp btnp-primary" onClick={() => void handleAccept()} disabled={accepting}>
                {accepting ? 'Accepting…' : 'Accept exactly this'}
              </button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="set-p on">
      <div><h3 className="set-h">Automatic sync</h3><p className="set-sub">Share your session data automatically with your team.</p></div>
      {error && <div className={`set-error`} style={{ marginBottom: '1rem' }}>{error}</div>}
      <div className="card">
        <div className="about-sec">
          <div className="about-row">
            <span className="tx">Status</span>
            <span className="r" style={{ fontWeight: 600, color: 'var(--ok)' }}>Enabled</span>
          </div>
          <div className="about-row">
            <span className="tx">Cadence</span>
            <span className="r">{syncStatus?.cadence === 'hourly' ? 'Hourly' : 'Daily'}</span>
          </div>
          <div className="about-row">
            <span className="tx">Attribution</span>
            <span className="r">{syncStatus?.attribution ? 'Enabled' : 'Disabled'}</span>
          </div>
          {syncStatus?.fingerprint && (
            <div className="about-row">
              <span className="tx">Fingerprint</span>
              <span className="r" style={{ fontFamily: 'monospace', fontSize: 'var(--fs-meta)', color: 'var(--mut)' }}>
                {syncStatus.fingerprint.split(':').slice(0, 2).join(':')}:…:{syncStatus.fingerprint.split(':').slice(-1)[0]}
              </span>
            </div>
          )}
          {syncStatus?.acceptedAt && (
            <div className="about-row">
              <span className="tx">Accepted at</span>
              <span className="r" style={{ fontSize: '0.875rem', color: 'var(--mut)' }}>
                {new Date(syncStatus.acceptedAt).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>

        {syncStatus?.currentMatches === false && (
          <div className="about-sec" style={{ background: 'var(--warn)', padding: '0.75rem 1rem', borderRadius: '4px', marginBottom: '1rem' }}>
            <div style={{ color: 'var(--ink)', fontWeight: 600, marginBottom: '0.5rem' }}>Configuration drift detected</div>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>Your current sync settings differ from the last accepted configuration.</p>
            <button className="btnp" onClick={() => setShowSetup(true)} style={{ marginTop: '0.75rem' }}>
              Review and re-accept
            </button>
          </div>
        )}

        {syncStatus?.receipts && syncStatus.receipts.length > 0 && (
          <div className="about-sec">
            <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Recent syncs</div>
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
            Stop automatic sync
          </button>
        </div>
      </div>
    </section>
  )
}
