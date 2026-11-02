import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'

import { useEscape } from '../hooks/useEscape'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { DUR, useExitAnimation } from '../lib/motion'
import { isIdeHost } from '../lib/platform'
import { SOCIALS } from './AboutModal'
import { Splash } from './Splash'

const LAUNCH_COUNT_KEY = 'codeburn.launchCount'
const DONE_KEY = 'codeburn.starNudgeDone'
const REPO_URL = 'https://github.com/getagentseal/codeburn'
const GITHUB_MARK = SOCIALS.find(social => social.label === 'GitHub')?.icon

function read(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
}

function write(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value) } catch {}
}

export function countLaunch(): void {
  write(LAUNCH_COUNT_KEY, String((Number(read(LAUNCH_COUNT_KEY)) || 0) + 1))
}

export function StarNudge() {
  const [hidden, setHidden] = useState(() => isIdeHost() || read(DONE_KEY) === '1' || (Number(read(LAUNCH_COUNT_KEY)) || 0) < 3)
  return hidden ? null : <StarNudgeDialog onClose={() => setHidden(true)} />
}

export function SplashThenNudge({ hasData, hasError }: { hasData: boolean; hasError: boolean }) {
  const [splashDone, setSplashDone] = useState(false)
  const onDone = useCallback(() => setSplashDone(true), [])
  return (
    <>
      <Splash hasData={hasData} hasError={hasError} onDone={onDone} />
      {splashDone ? <StarNudge /> : null}
    </>
  )
}

function StarNudgeDialog({ onClose }: { onClose: () => void }) {
  const { closing, beginExit } = useExitAnimation(onClose, DUR.base, 'star')
  const done = () => {
    write(DONE_KEY, '1')
    beginExit()
  }

  useEscape(!closing, beginExit)

  return createPortal(
    <div className={closing ? 'about-modal-backdrop closing' : 'about-modal-backdrop'} onClick={beginExit}>
      <div
        className="about-modal star-nudge"
        role="dialog"
        aria-modal="true"
        aria-labelledby="star-nudge-title"
        onClick={event => event.stopPropagation()}
      >
        <span className="star-nudge-mark" aria-hidden="true">{GITHUB_MARK}</span>
        <h2 className="star-nudge-title" id="star-nudge-title">{t('shell.star.heading')}</h2>
        <p className="star-nudge-body">{t('shell.star.body')}</p>
        <div className="star-nudge-actions">
          <button type="button" className="btnp" onClick={done}>{t('shell.star.notNow')}</button>
          <button type="button" className="btnp btnp-primary" autoFocus onClick={() => { void codeburn.openExternal(REPO_URL); done() }}>{t('shell.star.action')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
