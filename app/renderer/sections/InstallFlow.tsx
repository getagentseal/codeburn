import { useState } from 'react'
import { useEscape } from '../hooks/useEscape'
import { codeburn } from '../lib/ipc'
import { showToast } from '../lib/toast'
import styles from './Plugins.module.css'
import { Icon } from '../components/icons'
import { t } from '../i18n'

interface InstallFlowProps {
  onClose: () => void
  onSuccess?: () => void
}

type Step = 1 | 2 | 3

export function InstallFlowModal({ onClose, onSuccess }: InstallFlowProps) {
  const [step, setStep] = useState<Step>(1)
  const [source, setSource] = useState<'org' | 'folder'>('org')
  const [orgInput, setOrgInput] = useState('')
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installName, setInstallName] = useState('')
  const [installVersion, setInstallVersion] = useState('')

  useEscape(step === 1, onClose)

  const chooseFolder = async () => {
    const selected = await codeburn.chooseDirectory()
    if (selected) setFolderPath(selected)
  }

  const proceedToInstall = () => {
    if (source === 'org' && !orgInput.trim()) {
      showToast(t('onboarding.installFlow.toastOrgRequired'), 'error')
      return
    }
    if (source === 'folder' && !folderPath) {
      showToast(t('onboarding.installFlow.toastFolderRequired'), 'error')
      return
    }
    setStep(2)
  }

  const performInstall = async () => {
    setInstalling(true)
    setInstallError(null)
    try {
      const pluginSource = source === 'org' ? orgInput.trim() : folderPath!
      const result = await codeburn.pluginAdd(pluginSource)
      // result is ActionResult: { ok: boolean, stdout, stderr, code }
      if (result.ok) {
        const match = result.stdout.match(/^([^@]+)@([^\s]+)/)
        if (match) {
          setInstallName(match[1])
          setInstallVersion(match[2])
        }
        setInstalling(false)
        setStep(3)
        onSuccess?.()
      } else {
        // CLI failed: display stderr verbatim
        const stderr = result.stderr || t('onboarding.installFlow.installFailedFallback')
        if (stderr.includes('no-sync-config')) {
          setInstallError(`${stderr}\n\n${t('onboarding.installFlow.syncHint')}`)
        } else {
          setInstallError(stderr)
        }
        setInstalling(false)
      }
    } catch (err) {
      // Bridge error (envelope rejected)
      const message = err instanceof Error ? err.message : String(err)
      setInstallError(message)
      setInstalling(false)
    }
  }

  const handleClose = () => {
    if (step === 3 || !installing) {
      onClose()
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={handleClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <button className={styles.modalClose} onClick={handleClose}><Icon name="x" /></button>
        <div className={styles.modalContent}>
          {step === 1 && (
            <>
              <h2>{t('onboarding.installFlow.title')}</h2>
              <div style={{ marginTop: '1.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem' }}>
                  <input
                    type="radio"
                    name="source"
                    value="org"
                    checked={source === 'org'}
                    onChange={() => setSource('org')}
                    style={{ marginRight: '0.5rem' }}
                  />
                  {t('onboarding.installFlow.sourceOrgLabel')}
                </label>
                {source === 'org' && (
                  <input
                    type="text"
                    placeholder={t('onboarding.installFlow.orgPlaceholder')}
                    value={orgInput}
                    onChange={e => setOrgInput(e.target.value)}
                    style={{
                      marginLeft: '1.5rem',
                      marginBottom: '1rem',
                      padding: '0.5rem',
                      border: '1px solid var(--line)',
                      borderRadius: '4px',
                      width: '100%',
                      boxSizing: 'border-box',
                    }}
                  />
                )}

                <label style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem' }}>
                  <input
                    type="radio"
                    name="source"
                    value="folder"
                    checked={source === 'folder'}
                    onChange={() => setSource('folder')}
                    style={{ marginRight: '0.5rem' }}
                  />
                  {t('onboarding.installFlow.sourceFolderLabel')}
                </label>
                {source === 'folder' && (
                  <div style={{ marginLeft: '1.5rem', marginBottom: '1rem' }}>
                    <div style={{ marginBottom: '0.5rem', color: 'var(--mut)' }}>
                      {folderPath || t('onboarding.installFlow.noFolderSelected')}
                    </div>
                    <button className="btnp" onClick={() => void chooseFolder()}>
                      {t('onboarding.installFlow.chooseFolder')}
                    </button>
                  </div>
                )}
              </div>

              <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button className="btnp" onClick={onClose}>
                  {t('onboarding.installFlow.cancel')}
                </button>
                <button className="btnp btnp-primary" onClick={proceedToInstall}>
                  {t('onboarding.installFlow.next')}
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2>{installError ? t('onboarding.installFlow.installationFailed') : t('onboarding.installFlow.installingTitle')}</h2>
              {!installError && (
                <div style={{ marginTop: '2rem', textAlign: 'center' }}>
                  <div style={{ marginBottom: '1.5rem' }}>
                    <div className={styles.spinner} />
                  </div>
                  <p>{t('onboarding.installFlow.installingFrom', { source: source === 'org' ? orgInput : (folderPath ?? '') })}</p>
                </div>
              )}
              {installError && (
                <div style={{ marginTop: '1.5rem' }}>
                  <div className={styles.error}>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.875rem' }}>
                      {installError}
                    </pre>
                  </div>
                </div>
              )}
              <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                {!installError && !installing && (
                  <>
                    <button className="btnp" onClick={onClose}>
                      {t('onboarding.installFlow.cancel')}
                    </button>
                    <button className="btnp btnp-primary" onClick={() => void performInstall()}>
                      {t('onboarding.installFlow.install')}
                    </button>
                  </>
                )}
                {installing && !installError && (
                  <button className="btnp" onClick={onClose} disabled>
                    {t('onboarding.installFlow.cancel')}
                  </button>
                )}
                {installError && (
                  <>
                    <button className="btnp" onClick={() => { setStep(1); setInstallError(null) }}>
                      {t('onboarding.installFlow.back')}
                    </button>
                    <button className="btnp" onClick={onClose}>
                      {t('onboarding.installFlow.cancel')}
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2>{t('onboarding.installFlow.completeTitle')}</h2>
              <div style={{ marginTop: '1.5rem' }}>
                <div style={{ padding: '1rem', background: 'var(--fill)', borderRadius: '4px', marginBottom: '1.5rem' }}>
                  <p>{t('onboarding.installFlow.installedLabel')} <strong>{installName}@{installVersion}</strong></p>
                  <p style={{ fontSize: '0.875rem', color: 'var(--mut)', marginTop: '0.5rem' }}>
                    {t('onboarding.installFlow.signatureVerified')}
                  </p>
                </div>
              </div>
              <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button className="btnp" onClick={onClose}>
                  {t('onboarding.installFlow.close')}
                </button>
                <button className="btnp btnp-primary" onClick={onClose}>
                  {t('onboarding.installFlow.viewDetails')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
