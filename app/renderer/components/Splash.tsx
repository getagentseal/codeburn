import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { FlameMark } from './FlameMark'
import { ProviderLogo } from './ProviderLogo'
import { motionClass, motionEnabled, reducedMotion } from '../lib/motion'
import { codeburn } from '../lib/ipc'
import type { ScanProgressEvent } from '../lib/types'
import { BUILD_STAMP } from '../lib/build'
import { version } from '../../package.json'
import loaderVideo from '../assets/splash-loader.webm'

const MIN_ON_SCREEN_MS = 600
const CROSSFADE_MS = 250

type Phase = 'lit' | 'out' | 'done'
type ProvStatus = 'pending' | 'active' | 'done'

type Progress = {
  /** Detected providers, in the order the CLI reports them. */
  order: string[]
  status: Record<string, ProvStatus>
  claudeDone: number
  claudeTotal: number
  /** True only for a genuine cold hydration (the CLI's `providers` event carries
   *  `cold: true`). A warm launch's incremental re-parse of a few changed files
   *  emits the same providers/tick stream WITHOUT this, so it never reveals the
   *  indexing detail. */
  cold: boolean
}

const EMPTY: Progress = { order: [], status: {}, claudeDone: 0, claudeTotal: 0, cold: false }

function reduceProgress(state: Progress, event: ScanProgressEvent): Progress {
  switch (event.kind) {
    case 'providers': {
      const status: Record<string, ProvStatus> = {}
      for (const p of event.providers) status[p] = state.status[p] ?? 'pending'
      return { ...state, order: event.providers, status, cold: state.cold || event.cold === true }
    }
    case 'provider': {
      const order = state.order.includes(event.provider) ? state.order : [...state.order, event.provider]
      // 'skipped' (a permission-locked provider) is terminal like 'done' so it
      // settles the strip instead of showing as perpetually active.
      const next: ProvStatus = event.state === 'done' || event.state === 'skipped' ? 'done' : 'active'
      return { ...state, order, status: { ...state.status, [event.provider]: next } }
    }
    case 'tick':
      return { ...state, claudeDone: event.done, claudeTotal: event.total }
    case 'done': {
      const status = { ...state.status }
      for (const p of state.order) status[p] = 'done'
      return { ...state, status }
    }
  }
}

function providerLabel(id: string): string {
  return id.split(/[-\s]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

/**
 * Compact first-run indexing status: one line of copy (with a live counter when
 * Claude is parsing), a small horizontal strip of provider logos (dim = pending,
 * lit = active, settled = done), and one muted note. Deliberately no per-provider
 * text rows -- a machine with 12 providers must not turn the splash into a list.
 */
function SplashStatus({ progress }: { progress: Progress }) {
  const active = progress.order.find(id => progress.status[id] === 'active') ?? null
  const counter = active === 'claude' && progress.claudeTotal > 0
    ? ` · ${progress.claudeDone.toLocaleString('en-US')}/${progress.claudeTotal.toLocaleString('en-US')}`
    : ''
  const line = active ? `Indexing ${providerLabel(active)}${counter}` : 'Indexing your usage history…'
  return (
    <div className="splash-status">
      <div className="splash-status-line">{line}</div>
      {progress.order.length > 0 && (
        <div className="splash-prov-strip">
          {progress.order.map(id => (
            <span key={id} className={`splash-prov ${progress.status[id] ?? 'pending'}`} title={providerLabel(id)}>
              <ProviderLogo provider={id} size={15} />
            </span>
          ))}
        </div>
      )}
      <div className="splash-status-note">One-time scan · future launches are instant</div>
    </div>
  )
}

/**
 * Full-window branded startup loader -- the same scanning moment as the menubar
 * app's ignite-while-loading flame. Mounts once with the app and stays up while
 * the FIRST overview fetch has neither data nor error. On first data it holds a
 * floor of MIN_ON_SCREEN_MS (so a warm cache does not flash-blink) then
 * crossfades out. A first-fetch error dismisses it instantly, so the user is
 * never trapped behind branding; reduced motion swaps instantly with no fade.
 * A `done` latch means later loading states -- polls, filter changes -- never
 * bring it back.
 *
 * On a genuinely cold first run the overview warmup streams per-provider scan
 * progress (main.ts forwards the CLI's stderr) and the leading `providers` event
 * carries `cold: true`; that — and only that — reveals the compact indexing
 * status block (see SplashStatus). A warm launch's incremental re-parse emits the
 * same provider/tick stream without the cold flag, so the splash stays a plain
 * flame and dismisses the moment data arrives.
 */
export function Splash({ hasData, hasError }: { hasData: boolean; hasError: boolean }) {
  const [phase, setPhase] = useState<Phase>('lit')
  const [progress, setProgress] = useState<Progress>(EMPTY)
  const [reveal, setReveal] = useState(false)
  const shownAt = useRef(Date.now())
  const done = useRef(false)

  // Subscribe once to cold-start progress. `codeburn` is undefined outside the
  // Electron preload (e.g. unit tests); guard so the splash still renders.
  useEffect(() => {
    if (!codeburn || typeof codeburn.onProgress !== 'function') return
    return codeburn.onProgress(event => setProgress(prev => reduceProgress(prev, event)))
  }, [])

  // Only a genuine cold hydration reveals the indexing detail. Warm launches
  // never set `cold`, so the strip stays hidden and the flame dismisses fast.
  useEffect(() => { if (progress.cold) setReveal(true) }, [progress.cold])

  useEffect(() => {
    if (done.current) return
    if (!hasData && !hasError) return

    // First resolution of the first fetch. An error or a reduced-motion
    // preference swaps instantly; otherwise honor the on-screen floor first.
    if (hasError || reducedMotion()) {
      done.current = true
      setPhase('done')
      return
    }
    const wait = Math.max(0, MIN_ON_SCREEN_MS - (Date.now() - shownAt.current))
    const timer = setTimeout(() => setPhase('out'), wait)
    return () => clearTimeout(timer)
  }, [hasData, hasError])

  useEffect(() => {
    if (phase !== 'out') return
    const timer = setTimeout(() => {
      done.current = true
      setPhase('done')
    }, CROSSFADE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  if (phase === 'done' || typeof document === 'undefined') return null

  const base = phase === 'out' ? 'splash splash-out' : 'splash'
  const showDetail = reveal && phase === 'lit'
  return createPortal(
    <div className={motionClass(base, 'splash-lit')} aria-hidden="true">
      {motionEnabled() ? (
        // The animated burn as VP9-with-alpha, floating directly on the splash
        // gradient while the first scan runs. Static mark under reduced motion.
        <video className="splash-video" src={loaderVideo} width={232} height={232} autoPlay muted loop playsInline />
      ) : (
        <div className="splash-mark">
          <FlameMark size={76} />
        </div>
      )}
      <div className="splash-word">CodeBurn</div>
      <div className="splash-version">v{version}</div>
      <div className="splash-build">{BUILD_STAMP}</div>
      {showDetail && <SplashStatus progress={progress} />}
    </div>,
    document.body,
  )
}
