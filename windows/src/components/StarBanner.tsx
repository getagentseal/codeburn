import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { t, useI18nRevision } from '../lib/i18n'
import { readSetting, writeSetting } from '../lib/settings'

const GITHUB_URL = 'https://github.com/getagentseal/codeburn'

function starNudgeShows(): boolean {
  if (readSetting('starNudgeDone') === 'true' || readSetting('starBannerDismissed') === 'true') return false
  return (Number(readSetting('starNudgeOpens')) || 0) >= 3
}

export function StarBanner() {
  const [shown, setShown] = useState(starNudgeShows)
  useI18nRevision()

  useEffect(() => {
    const unlisten = listen('codeburn://shown', () => {
      writeSetting('starNudgeOpens', String((Number(readSetting('starNudgeOpens')) || 0) + 1))
      setShown(starNudgeShows())
    })
    return () => { unlisten.then(fn => fn()) }
  }, [])

  if (!shown) return null

  const done = () => {
    writeSetting('starNudgeDone', 'true')
    setShown(false)
  }

  return (
    <section className="star-banner" aria-label={t('Enjoying CodeBurn?')}>
      <h3 className="star-banner-title">{t('Enjoying CodeBurn?')}</h3>
      <p className="star-banner-body">{t('If it has been helping you, a star on GitHub would mean a lot. It keeps the project free and open.')}</p>
      <div className="star-banner-actions">
        <button type="button" className="btn" onClick={done}>{t('Not now')}</button>
        <button type="button" className="btn btn-prominent" onClick={() => { void openUrl(GITHUB_URL); done() }}>{t('Star on GitHub')}</button>
      </div>
    </section>
  )
}
