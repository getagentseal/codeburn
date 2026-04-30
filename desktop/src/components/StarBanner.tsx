import { useState } from 'react'

const STORAGE_KEY = 'codeburn.starBannerDismissed'
const GITHUB_URL = 'https://github.com/getagentseal/codeburn'

export function StarBanner() {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  })

  if (dismissed) return null

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    setDismissed(true)
  }

  return (
    <div className="star-banner">
      <span className="star-banner-icon">*</span>
      <a
        className="star-banner-link"
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>Enjoying CodeBurn?</span>{' '}
        <span className="star-banner-cta">Star us on GitHub</span>
      </a>
      <span style={{ flex: 1 }} />
      <button className="star-banner-close" onClick={dismiss} title="Hide this banner">
        ×
      </button>
    </div>
  )
}
