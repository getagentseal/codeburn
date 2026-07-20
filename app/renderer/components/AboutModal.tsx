import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'

import { version } from '../../package.json'
import { FlameMark } from './FlameMark'
import { BUILD_STAMP } from '../lib/build'
import { updateDownloadUrl, useUpdateStatus } from '../hooks/useUpdateStatus'
import { codeburn } from '../lib/ipc'

export type SocialLink = {
  label: string
  url: string
  icon: ReactNode
}

function openExternal(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault()
  void codeburn.openExternal(url)
}

export function AboutModal({ socials, onClose }: { socials: SocialLink[]; onClose: () => void }) {
  const status = useUpdateStatus()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="about-modal-backdrop" onClick={onClose}>
      <div
        className="about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-modal-title"
        onClick={event => event.stopPropagation()}
      >
        <button className="about-modal-close" type="button" aria-label="Close About" onClick={onClose}>×</button>
        <div className="about-modal-grid">
          <div className="about-modal-hero">
            <span className="about-modal-logo" aria-hidden="true"><FlameMark size={52} /></span>
            <div className="about-modal-name" id="about-modal-title">CodeBurn</div>
            <div className="about-modal-version">v{version}</div>
            <div className="about-modal-build">{BUILD_STAMP}</div>
            <div className="about-modal-tagline">Know where every token goes, across every AI coding tool.</div>
          </div>
          <div className="about-modal-side">
            <div className="about-modal-section">
              <div className="about-modal-section-title">Links</div>
              {socials.map(social => (
                <a
                  className="about-modal-link"
                  href={social.url}
                  key={social.label}
                  onClick={event => openExternal(event, social.url)}
                >
                  {social.icon}
                  <span>{social.label}</span>
                  <span className="about-modal-external" aria-hidden="true">↗</span>
                </a>
              ))}
            </div>
            <div className="about-modal-section about-modal-updates">
              <div className="about-modal-section-title">Updates</div>
              <button
                className="about-modal-update-button"
                type="button"
                onClick={() => setChecked(true)}
              >
                Check for updates
              </button>
              {checked && (
                <p className="about-modal-update-note" role="status">
                  {status?.updateAvailable && status.tag ? (
                    <>
                      Update available: {status.latestVersion} ·{' '}
                      <button
                        type="button"
                        className="set-text-button"
                        onClick={() => { void codeburn.openExternal(updateDownloadUrl(status.tag!)) }}
                      >
                        Download
                      </button>
                    </>
                  ) : status?.latestVersion ? (
                    "You're on the latest version"
                  ) : (
                    'Unable to check right now'
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="about-modal-credit">Developed by Resham Joshi · github.com/iamtoruk</div>
      </div>
    </div>
  )
}
