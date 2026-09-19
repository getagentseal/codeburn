import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { codeburn } from '../lib/ipc'
import backdrop from '../assets/onboarding-bg.jpg'
import flame from '../assets/onboarding-flame.png'
import { version } from '../../package.json'
import { t } from '../i18n'

const COLLECT_URL = 'https://www.codeburn.app/telemetry'

type Screen = {
  titleKey: string
  bodyKey: string
}

const SCREENS: Screen[] = [
  { titleKey: 'onboarding.screens.dashboard.title', bodyKey: 'onboarding.screens.dashboard.body' },
  { titleKey: 'onboarding.screens.localFirst.title', bodyKey: 'onboarding.screens.localFirst.body' },
  { titleKey: 'onboarding.screens.findWaste.title', bodyKey: 'onboarding.screens.findWaste.body' },
]

/**
 * First-launch screens: three feature screens, then the telemetry consent
 * screen, over the drifting brand backdrop. The toggle's initial position comes
 * from the region default (EU/EEA/UK/CH off, elsewhere on) and nothing is
 * transmitted until the user finishes here. Skip jumps to the consent screen
 * rather than past it, so the choice is always made. Rendered only while the
 * main process reports `onboarded: false`.
 */
export function Onboarding({ defaultEnabled, onDone }: { defaultEnabled: boolean; onDone: (enabled: boolean) => void }) {
  const [step, setStep] = useState(0)
  const [enabled, setEnabled] = useState(defaultEnabled)
  const last = SCREENS.length // consent screen index
  const isConsent = step === last

  const advance = useCallback(() => setStep(value => Math.min(value + 1, SCREENS.length)), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setStep(SCREENS.length); return }
      // Enter on a focused control belongs to that control, not to us.
      if (event.key === 'Enter' && (event.target as HTMLElement | null)?.closest?.('button')) return
      if (event.key === 'Enter' || event.key === 'ArrowRight') {
        if (isConsent) onDone(enabled)
        else advance()
      }
      if (event.key === 'ArrowLeft') setStep(value => Math.max(value - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, enabled, isConsent, onDone])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="onboard" role="dialog" aria-label={t('onboarding.dialog.ariaLabel')}>
      <img className="onboard-bg" src={backdrop} alt="" aria-hidden />
      <div className="onboard-grain" aria-hidden />
      <div className="onboard-veil" aria-hidden />

      <div className="onboard-col">
        <span className="onboard-lockup" aria-hidden>
          <img className="onboard-flame" src={flame} alt="" draggable={false} />
          <b className="flame-text">CodeBurn</b>
        </span>

        <div className="onboard-step" key={step}>
          {isConsent ? (
            <>
              <h2 className="onboard-title">{t('onboarding.consent.title')}</h2>
              <p className="onboard-body">
                {t('onboarding.consent.body')}
              </p>
              <div className="onboard-consent">
                <span id="onboard-consent-label">{t('onboarding.consent.label')}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-labelledby="onboard-consent-label"
                  className={enabled ? 'switch on' : 'switch'}
                  onClick={() => setEnabled(value => !value)}
                >
                  <span className="switch-knob" />
                </button>
              </div>
              <button type="button" className="onboard-link" onClick={() => { void codeburn.openExternal?.(COLLECT_URL) }}>
                {t('onboarding.consent.dataLink')}
              </button>
              {document.documentElement.dataset.platform === 'darwin' && (
                <p className="onboard-hint">
                  {t('onboarding.consent.hint')}
                </p>
              )}
            </>
          ) : (
            <>
              <h2 className="onboard-title">{t(SCREENS[step].titleKey)}</h2>
              <p className="onboard-body">{t(SCREENS[step].bodyKey)}</p>
            </>
          )}
        </div>

        <div className="onboard-progress" aria-hidden>
          {[...SCREENS, null].map((_, index) => (
            <span key={index} className={index <= step ? 'onboard-seg on' : 'onboard-seg'} />
          ))}
        </div>

        <div className="onboard-controls">
          {isConsent ? (
            <button type="button" className="onboard-btn primary" onClick={() => onDone(enabled)}>{t('onboarding.button.getStarted')}</button>
          ) : (
            <button type="button" className="onboard-btn primary" onClick={advance}>{t('onboarding.button.next')}</button>
          )}
          {step > 0 && (
            <button type="button" className="onboard-quiet" onClick={() => setStep(value => value - 1)}>{t('onboarding.button.back')}</button>
          )}
          {!isConsent && (
            <button type="button" className="onboard-quiet" onClick={() => setStep(SCREENS.length)}>{t('onboarding.button.skip')}</button>
          )}
        </div>
      </div>

      <div className="onboard-version">v{version}</div>
    </div>,
    document.body,
  )
}
