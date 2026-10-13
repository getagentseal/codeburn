import { useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { readSetting, writeSetting } from '../lib/settings'
import { StarIcon, XIcon } from './Icons'
import { t } from '../i18n/index'

const GITHUB_URL = 'https://github.com/getagentseal/codeburn'

export function StarBanner() {
  const [dismissed, setDismissed] = useState(() => readSetting('starBannerDismissed') === 'true')
  if (dismissed) return null

  const dismiss = () => {
    writeSetting('starBannerDismissed', 'true')
    setDismissed(true)
  }

  return (
    <div className="star-banner">
      <StarIcon size={10} className="star-banner-icon" />
      <button type="button" className="star-banner-link" onClick={() => openUrl(GITHUB_URL)}>
        <span>{t('Enjoying CodeBurn?')}</span>{' '}
        <span className="star-banner-cta">{t('Star us on GitHub')}</span>
      </button>
      <span className="star-banner-spacer" />
      <button type="button" className="star-banner-close" onClick={dismiss} title={t('Hide this banner')} aria-label={t('Hide this banner')}>
        <XIcon size={9} />
      </button>
    </div>
  )
}
