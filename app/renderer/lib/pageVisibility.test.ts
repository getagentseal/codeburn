// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'

import { installPageHiddenClass } from './pageVisibility'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

afterEach(() => {
  document.documentElement.classList.remove('page-hidden')
  delete (document as unknown as { visibilityState?: unknown }).visibilityState
})

describe('installPageHiddenClass', () => {
  it('toggles the page-hidden class on <html> as visibility changes, and stops after dispose', () => {
    setVisibility('visible')
    const dispose = installPageHiddenClass()
    expect(document.documentElement.classList.contains('page-hidden')).toBe(false)

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.classList.contains('page-hidden')).toBe(true)

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.classList.contains('page-hidden')).toBe(false)

    dispose()
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    // Disposed: the class is no longer maintained.
    expect(document.documentElement.classList.contains('page-hidden')).toBe(false)
  })

  it('reflects an already-hidden window immediately on install', () => {
    setVisibility('hidden')
    const dispose = installPageHiddenClass()
    expect(document.documentElement.classList.contains('page-hidden')).toBe(true)
    dispose()
  })
})
