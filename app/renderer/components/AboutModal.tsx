import { useState, type MouseEvent, type ReactNode } from 'react'

import { version } from '../../package.json'
import { FlameMark } from './FlameMark'
import { Icon } from './icons'
import { BUILD_STAMP } from '../lib/build'
import { useEscape } from '../hooks/useEscape'
import { updateDownloadUrl, useUpdateStatus } from '../hooks/useUpdateStatus'
import { codeburn } from '../lib/ipc'
import { DUR, useExitAnimation } from '../lib/motion'

export type SocialLink = {
  label: string
  url: string
  icon: ReactNode
}

/** Where CodeBurn lives on the web. These used to sit as a row of glyphs in the sidebar's
 *  bottom corner, which is where the two Windows switches are now; About was already listing
 *  them under Links, so that is the one place they appear. */
export const SOCIALS: SocialLink[] = [
  { label: 'GitHub', url: 'https://github.com/getagentseal/codeburn', icon: <svg viewBox="0 0 24 24"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" /></svg> },
  { label: 'Discord', url: 'https://discord.com/invite/w2sw8mCqep', icon: <svg viewBox="0 0 24 24"><path d="M20.32 4.37A19.8 19.8 0 0 0 15.45 3c-.21.38-.46.9-.63 1.31a18.3 18.3 0 0 0-5.47 0C8.71 3.9 8.45 3.38 8.24 3a19.7 19.7 0 0 0-4.88 1.37C.86 8.75.05 13.02.45 17.23a19.9 19.9 0 0 0 6 3.03c.48-.66.91-1.36 1.28-2.11-.7-.26-1.37-.58-2-.96.17-.12.33-.25.49-.38a14.2 14.2 0 0 0 12.16 0c.16.14.32.26.49.38-.63.38-1.31.7-2 .96.37.75.8 1.45 1.28 2.11a19.8 19.8 0 0 0 6-3.03c.47-4.87-.8-9.1-3.83-12.86zM8.02 14.65c-1.18 0-2.15-1.08-2.15-2.41 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41zm7.96 0c-1.18 0-2.15-1.08-2.15-2.41 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41z" /></svg> },
  { label: 'X', url: 'https://x.com/_codeburn', icon: <svg viewBox="0 0 24 24"><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.63 7.58H.49l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93zm-1.29 19.5h2.04L6.49 3.24H4.3l13.31 17.41z" /></svg> },
  { label: 'YouTube', url: 'https://www.youtube.com/@codeburnn', icon: <svg viewBox="0 0 24 24"><path d="M23.5 6.2a3.02 3.02 0 0 0-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.56A3.02 3.02 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3.02 3.02 0 0 0 2.12 2.14C4.5 20.5 12 20.5 12 20.5s7.5 0 9.38-.56A3.02 3.02 0 0 0 23.5 17.8 31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8zM9.55 15.57V8.43L15.82 12l-6.27 3.57z" /></svg> },
  { label: 'LinkedIn', url: 'https://www.linkedin.com/showcase/codeburnn/', icon: <svg viewBox="0 0 256 256"><path fill="currentColor" d="M218.123 218.127h-37.931v-59.403c0-14.165-.253-32.4-19.728-32.4-19.756 0-22.779 15.434-22.779 31.369v60.43h-37.93V95.967h36.413v16.694h.51a39.907 39.907 0 0 1 35.928-19.733c38.445 0 45.533 25.288 45.533 58.186l-.016 67.013ZM56.955 79.27c-12.157.002-22.014-9.852-22.016-22.009-.002-12.157 9.851-22.014 22.008-22.016 12.157-.003 22.014 9.851 22.016 22.008A22.013 22.013 0 0 1 56.955 79.27m18.966 138.858H37.95V95.967h37.97v122.16ZM237.033.018H18.89C8.58-.098.125 8.161-.001 18.471v219.053c.122 10.315 8.576 18.582 18.89 18.474h218.144c10.336.128 18.823-8.139 18.966-18.474V18.454c-.147-10.33-8.635-18.588-18.966-18.453" /></svg> },
]

function openExternal(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault()
  void codeburn.openExternal(url)
}

export function AboutModal({ socials = SOCIALS, openKey, onClose }: { socials?: SocialLink[]; openKey: string; onClose: () => void }) {
  const status = useUpdateStatus()
  const [checked, setChecked] = useState(false)
  const { closing, beginExit } = useExitAnimation(onClose, DUR.base, openKey)

  useEscape(true, beginExit)

  return (
    <div className={closing ? 'about-modal-backdrop closing' : 'about-modal-backdrop'} onClick={beginExit}>
      <div
        className="about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-modal-title"
        onClick={event => event.stopPropagation()}
      >
        <button className="about-modal-close" type="button" aria-label="Close About" onClick={beginExit}><Icon name="x" /></button>
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
                  <Icon name="arrow-up-right" className="about-modal-external" />
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
