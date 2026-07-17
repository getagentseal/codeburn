import type { RefObject } from 'react'

import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

/** True while the vitest suite is running; animations stay off so tests observe
 * the final, settled DOM rather than an in-flight tween. `process` is undefined
 * in the packaged renderer, so the typeof guard keeps this false there. */
function underTest(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST)
}

/** Reads the user's reduced-motion preference. This is the real gate the tests
 * exercise (via a matchMedia mock); it is safe when matchMedia is absent. */
export function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** The single switch every animation path checks first. Off under vitest, when
 * matchMedia is unavailable, or when the user asked for reduced motion. */
export function motionEnabled(): boolean {
  if (underTest()) return false
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return !reducedMotion()
}

/** Append `animated` to `base` only when motion is on, so a class-based
 * (CSS keyframe) animation never renders under reduced motion or in tests. */
export function motionClass(base: string, animated: string): string {
  return motionEnabled() ? `${base} ${animated}` : base
}

/**
 * Grow bars up from their baseline (scaleY 0 → 1, bottom-anchored) with a short
 * stagger, capped so the whole sweep stays under 400ms regardless of bar count.
 * Runs on mount and whenever `deps` change (a filter switch) but NOT on the 30s
 * poll re-render, because callers pass a stable filter key — not the data — as
 * the dependency.
 */
export function useBarGrowIn(scope: RefObject<HTMLElement | null>, selector: string, deps: unknown[]): void {
  useGSAP(() => {
    if (!motionEnabled()) return
    const bars = gsap.utils.toArray<HTMLElement>(selector, scope.current)
    if (!bars.length) return
    const each = Math.min(0.02, 0.26 / Math.max(1, bars.length - 1))
    gsap.from(bars, {
      scaleY: 0,
      transformOrigin: 'bottom',
      duration: 0.14,
      ease: 'power1.out',
      stagger: each,
    })
  }, { scope, dependencies: deps })
}
